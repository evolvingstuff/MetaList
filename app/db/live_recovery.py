"""Durable rollback journal for changes to a live namespace database set.

This owns temporary transaction files, never historical backup archives. The
ready manifest is durable before the first live write. An absent committed
marker means startup restores the entire original set, including absent files.
"""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
from threading import RLock

# OS-specific locking modules are selected at import time.
if os.name == 'nt':
    import msvcrt
else:
    import fcntl


_lock = RLock()
_active: set[Path] = set()


def _targets(database_path: Path) -> tuple[Path, Path]:
    return database_path, database_path.with_name(f'{database_path.stem}.files{database_path.suffix}')


def _directory(database_path: Path) -> Path:
    return database_path.with_name(f'.{database_path.name}.recovery')


def _sync_directory(path: Path) -> None:
    if os.name == 'nt':
        return  # Windows file flushes are used; directories cannot be opened this way.
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _sync_file(path: Path) -> None:
    with path.open('rb') as handle:
        os.fsync(handle.fileno())


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_sqlite(source: Path, target: Path) -> None:
    source_connection = sqlite3.connect(f'{source.resolve().as_uri()}?mode=ro', uri=True)
    destination = sqlite3.connect(target)
    try:
        destination.execute('PRAGMA synchronous=FULL')
        source_connection.backup(destination)
        destination.commit()
        check = destination.execute('PRAGMA integrity_check').fetchone()
        if check != ('ok',):
            raise RuntimeError('Live recovery database integrity check failed')
        destination.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    finally:
        destination.close()
        source_connection.close()
    _sync_file(target)


@contextmanager
def _process_lock(database_path: Path):
    database_path.parent.mkdir(parents=True, exist_ok=True)
    path = database_path.with_name(f'.{database_path.name}.recovery.lock')
    with path.open('a+b') as handle:
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


def _recover_locked(database_path: Path) -> None:
    directory = _directory(database_path)
    finished = directory.with_name(f'{directory.name}.finished')
    if finished.exists():
        shutil.rmtree(finished)
    if not directory.exists():
        return
    manifest_path = directory / 'ready.json'
    if manifest_path.exists() and not (directory / 'committed').exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest['version'] != 1 or len(manifest['files']) != 2:
            raise RuntimeError('Unsupported live recovery manifest')
        targets = _targets(database_path)
        # Validate the entire recovery set before restoring either database.
        for index, entry in enumerate(manifest['files']):
            if entry['name'] != targets[index].name:
                raise RuntimeError('Live recovery manifest target mismatch')
            if entry['existed'] and _digest(directory / f'{index}.sqlite') != entry['sha256']:
                raise RuntimeError('Live recovery image checksum mismatch')
        for index, entry in enumerate(manifest['files']):
            target = targets[index]
            if entry['existed']:
                _copy_sqlite(directory / f'{index}.sqlite', target)
            else:
                for path in (target, Path(f'{target}-wal'), Path(f'{target}-shm')):
                    path.unlink(missing_ok=True)
        _sync_directory(database_path.parent)
    # Only this module's temporary transaction directory is removed.
    directory.rename(finished)
    _sync_directory(database_path.parent)
    shutil.rmtree(finished)
    _sync_directory(database_path.parent)


def recover_pending_change(database_path: Path) -> None:
    database_path = database_path.resolve()
    with _lock:
        directory = _directory(database_path)
        if database_path in _active:
            return
        if not directory.exists() and not directory.with_name(f'{directory.name}.finished').exists():
            return
        with _process_lock(database_path):
            _recover_locked(database_path)


def recover_pending_namespaces(namespaces_directory: Path) -> None:
    if not namespaces_directory.exists():
        return
    for directory in namespaces_directory.iterdir():
        if directory.is_dir():
            recover_pending_change(directory / f'{directory.name}.metalist.db')


class LiveDatabaseRecovery:
    def __init__(self, database_path: Path):
        self.database_path = database_path.resolve()
        self._file_lock = _process_lock(self.database_path)
        self._finished = False

    def begin(self) -> None:
        _lock.acquire()
        file_lock_acquired = False
        try:
            if self.database_path in _active:
                raise RuntimeError('Live database change already active')
            self._file_lock.__enter__()
            file_lock_acquired = True
            _recover_locked(self.database_path)
            directory = _directory(self.database_path)
            directory.mkdir(mode=0o700)
            entries = []
            for index, target in enumerate(_targets(self.database_path)):
                existed = target.exists()
                digest = ''
                if existed:
                    image = directory / f'{index}.sqlite'
                    with image.open('xb'):
                        pass
                    _copy_sqlite(target, image)
                    digest = _digest(image)
                entries.append({'name': target.name, 'existed': existed, 'sha256': digest})
            with (directory / 'preparing.json').open('x') as handle:
                json.dump({'version': 1, 'files': entries}, handle)
                handle.flush()
                os.fsync(handle.fileno())
            (directory / 'preparing.json').rename(directory / 'ready.json')
            _sync_directory(directory)
            _sync_directory(directory.parent)
            _active.add(self.database_path)
        # lint: allow-PY001 rationale="release transaction locks before propagating snapshot I/O failure"
        except BaseException:
            if file_lock_acquired:
                self._file_lock.__exit__(None, None, None)
            _lock.release()
            raise

    def commit(self) -> None:
        assert not self._finished
        directory = _directory(self.database_path)
        for target in _targets(self.database_path):
            for path in (target, Path(f'{target}-wal')):
                if path.exists():
                    _sync_file(path)
        with (directory / 'committed').open('xb') as handle:
            handle.flush()
            os.fsync(handle.fileno())
        _sync_directory(directory)
        self._finish()

    def rollback(self) -> None:
        if self._finished:
            return
        self._finish()

    def _finish(self) -> None:
        try:
            _recover_locked(self.database_path)
        finally:
            self._finished = True
            _active.discard(self.database_path)
            self._file_lock.__exit__(None, None, None)
            _lock.release()


@contextmanager
def recoverable_change(database_path: Path):
    change = LiveDatabaseRecovery(database_path)
    change.begin()
    try:
        yield
        change.commit()
    finally:
        change.rollback()


class MemoryDatabaseRecovery:
    """The same all-or-old semantics for the test harness's two shared memory DBs."""

    def __init__(self):
        self._connections = []
        self._finished = False

    def begin(self) -> None:
        for uri in ('file:metalist_memory?mode=memory&cache=shared', 'file:metalist_files_memory?mode=memory&cache=shared'):
            live = sqlite3.connect(uri, uri=True)
            original = sqlite3.connect(':memory:')
            live.backup(original)
            self._connections.append((live, original))

    def commit(self) -> None:
        self._close()

    def rollback(self) -> None:
        if self._finished:
            return
        for live, original in self._connections:
            original.backup(live)
        self._close()

    def _close(self) -> None:
        self._finished = True
        for live, original in self._connections:
            live.close()
            original.close()
