"""Application-owned update jobs; only the existing installed updater installs code."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
from uuid import UUID, uuid4

from app.data_directory import resolve_data_directory
from app.services.exception_capture import CapturedExceptionContext
from app.services.namespace_switcher import _is_process_running
from app.services.self_update import _fetch_latest_pypi_version, _release_version_key
from app.version import __version__


if os.name == 'nt':
    import msvcrt
else:
    import fcntl


class AppUpdateRejected(ValueError):
    """An update cannot be started in this installation or job state."""


def update_executable() -> Path:
    receipt = Path(sys.prefix) / 'uv-receipt.toml'
    if not receipt.is_file():
        raise AppUpdateRejected('In-app updates require a uv-installed copy of MetaList. This running copy is not a managed installation.')
    executable = Path(sysconfig.get_path('scripts')) / ('metalist.exe' if os.name == 'nt' else 'metalist')
    if not executable.is_file():
        raise AppUpdateRejected('The installed MetaList command is missing.')
    if shutil.which('uv') is None:
        raise AppUpdateRejected('The uv updater is not available on this server. Install uv before updating MetaList.')
    return executable


def check_for_update() -> dict[str, object]:
    # Always contact PyPI, including in source checkouts; eligibility only controls installation.
    target = _fetch_latest_pypi_version()
    available = _release_version_key(target) > _release_version_key(__version__)
    eligibility = CapturedExceptionContext(AppUpdateRejected,
        boundary='app/services/app_updates.py:check_for_update:eligibility')
    with eligibility:
        update_executable()
    supported = eligibility.captured_exception is None
    if available:
        message = f'Version {target} is available.'
    else:
        message = 'MetaList is up to date.'
    if not supported:
        message += f' {eligibility.captured_exception}'
    return {'supported': supported, 'update_available': available, 'current_version': __version__,
            'target_version': target, 'message': message}


def jobs_directory() -> Path:
    return resolve_data_directory(environ=os.environ) / 'update-jobs'


def job_path(job_id: str) -> Path:
    validation = CapturedExceptionContext(ValueError,
        boundary='app/services/app_updates.py:job_path:validation')
    with validation:
        normalized = str(UUID(job_id))
    if validation.captured_exception is not None:
        raise AppUpdateRejected('Invalid update job ID') from validation.captured_exception
    if normalized != job_id:
        raise AppUpdateRejected('Invalid update job ID')
    return jobs_directory() / f'{job_id}.json'


def write_job(record: dict[str, object]) -> None:
    path = job_path(str(record['job_id']))
    temporary = path.with_suffix(f'.{uuid4().hex}.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(record, stream)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_job(job_id: str) -> dict[str, object]:
    record = json.loads(job_path(job_id).read_text(encoding='utf-8'))
    assert isinstance(record, dict) and record['job_id'] == job_id
    assert record['status'] in {'queued', 'preparing', 'installing', 'complete', 'failed'}
    assert isinstance(record['pid'], int) and record['pid'] > 0
    _release_version_key(record['target_version'])
    if record['status'] == 'installing' and _release_version_key(__version__) >= _release_version_key(record['target_version']):
        record = dict(record, status='complete', message=f'MetaList {__version__} is ready. Reload to continue.')
    elif record['status'] in {'queued', 'preparing'} and not _is_process_running(pid=record['pid']):
        record = dict(record, status='failed', message='The update process stopped unexpectedly. See the update log.')
    return record


def _create_update_job_locked(target_version: str) -> dict[str, object]:
    update_executable()
    _release_version_key(target_version)
    if _release_version_key(target_version) <= _release_version_key(__version__):
        raise AppUpdateRejected('The selected release is not newer than the running version.')
    directory = jobs_directory()
    directory.mkdir(parents=True, exist_ok=True)
    active_path = directory / 'active.json'
    if active_path.is_file():
        active = json.loads(active_path.read_text(encoding='utf-8'))
        if read_job(active['job_id'])['status'] not in {'complete', 'failed'}:
            raise AppUpdateRejected('An update is already in progress. Wait for it to finish.')
        active_path.unlink()
    job_id = str(uuid4())
    record = {'job_id': job_id, 'status': 'queued', 'current_version': __version__,
              'target_version': target_version, 'pid': os.getpid(),
              'message': 'Preparing the update. All namespaces will restart.',
              'log_path': str(directory / f'{job_id}.log')}
    write_job(record)
    with active_path.open('x', encoding='utf-8') as stream:
        json.dump({'job_id': job_id}, stream)
    return record


def launch_update_job(job_id: str) -> None:
    record = read_job(job_id)
    assert record['status'] == 'queued'
    environment = dict(os.environ)
    # Restart every saved namespace, preserving LAN/TLS/data settings.
    for name in ('METALIST_NAMESPACE', 'METALIST_PORT', 'METALIST_HTTPS_PORT', 'METALIST_ORCHESTRATED_CHILD'):
        if name in environment:
            del environment[name]
    options: dict[str, object] = {'env': environment, 'stdin': subprocess.DEVNULL}
    if os.name == 'nt':
        options['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    else:
        options['start_new_session'] = True
    launch = CapturedExceptionContext(OSError,
        boundary='app/services/app_updates.py:launch_update_job:launch')
    with launch:
        with Path(str(record['log_path'])).open('xb') as log:
            subprocess.Popen([sys.executable, '-m', 'app.services.app_update_worker', job_id],
                             stdout=log, stderr=subprocess.STDOUT, **options)
    if launch.captured_exception is not None:
        write_job(dict(record, status='failed', message='Could not start the updater. The running version was not changed.'))
        release_update_job(job_id)
        raise launch.captured_exception


def release_update_job(job_id: str) -> None:
    with _job_lock():
        _release_update_job_locked(job_id)


def _release_update_job_locked(job_id: str) -> None:
    path = jobs_directory() / 'active.json'
    if path.is_file():
        active = json.loads(path.read_text(encoding='utf-8'))
        if active['job_id'] == job_id:
            path.unlink()


@contextmanager
def _job_lock():
    directory = jobs_directory()
    directory.mkdir(parents=True, exist_ok=True)
    # Stable cross-process lock: all namespaces share this installation's update admission.
    with (directory / 'admission.lock').open('a+b') as handle:
        if os.name == 'nt':
            if handle.tell() == 0:
                handle.write(b'0')
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == 'nt':
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def create_update_job(target_version: str) -> dict[str, object]:
    with _job_lock():
        return _create_update_job_locked(target_version)
