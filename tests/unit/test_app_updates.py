from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest

from app.api.middleware.auth import AuthMiddleware
from app.api.routes.app_updates import router
from app.services import app_updates, app_update_worker, self_update
from app.services.client_state_service import _validate_client_preferences, ClientStateValidationError


@pytest.fixture
def installation(monkeypatch, tmp_path):
    monkeypatch.setattr(app_updates, 'jobs_directory', lambda: tmp_path / 'jobs')
    monkeypatch.setattr(app_updates, 'update_executable', lambda: Path('/tools/metalist'))
    monkeypatch.setattr(app_update_worker, 'update_executable', app_updates.update_executable)
    monkeypatch.setattr(app_updates, '__version__', '0.6.2')
    monkeypatch.setattr(app_updates, '_fetch_latest_pypi_version', lambda: '0.6.3')
    return tmp_path


def test_every_check_contacts_pypi_even_when_installation_is_unsupported(monkeypatch):
    monkeypatch.setattr(app_updates, '__version__', '0.6.2')
    fetch = Mock(side_effect=['0.6.3', '0.6.4'])
    monkeypatch.setattr(app_updates, '_fetch_latest_pypi_version', fetch)
    monkeypatch.setattr(app_updates, 'update_executable', Mock(side_effect=app_updates.AppUpdateRejected('Source checkout')))
    first, second = app_updates.check_for_update(), app_updates.check_for_update()
    assert first['target_version'] == '0.6.3'
    assert second['target_version'] == '0.6.4'
    assert not first['supported'] and first['update_available']
    assert fetch.call_count == 2


def test_check_is_public_uncached_and_does_not_make_install_public(installation):
    app = FastAPI()
    app.include_router(router, prefix='/api2')
    app.add_middleware(AuthMiddleware)
    with TestClient(app) as client:
        response = client.get('/api2/auth/app-update/check')
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-store'
        assert response.json()['target_version'] == '0.6.3'
        assert client.post('/api2/auth/app-update', json={'target_version': '0.6.3'}).status_code == 401


def test_failed_pypi_check_has_visible_retryable_status(installation, monkeypatch):
    monkeypatch.setattr(app_updates, '_fetch_latest_pypi_version', Mock(side_effect=httpx.ReadTimeout('slow')))
    app = FastAPI()
    app.include_router(router, prefix='/api2')
    with TestClient(app) as client:
        response = client.get('/api2/auth/app-update/check')
    assert response.status_code == 503
    assert 'try again' in response.json()['detail']


def test_internal_update_check_errors_propagate(installation, monkeypatch):
    monkeypatch.setattr(app_updates, '_fetch_latest_pypi_version', Mock(side_effect=AssertionError('bug')))
    with pytest.raises(AssertionError, match='bug'):
        app_updates.check_for_update()


def test_concurrent_namespaces_cannot_start_two_updates(installation):
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(app_updates.create_update_job, '0.6.3') for _ in range(4)]
    assert sum(future.exception() is None for future in futures) == 1
    assert all(future.exception() is None or isinstance(future.exception(), app_updates.AppUpdateRejected) for future in futures)


def test_worker_pins_reviewed_release_and_retains_admission_through_install(installation, monkeypatch):
    record = app_updates.create_update_job('0.6.3')
    scheduler = Mock(return_value=SimpleNamespace(update_scheduled=True, message='Restarting'))
    monkeypatch.setattr(app_update_worker, 'schedule_self_update', scheduler)
    app_update_worker.run_update(record['job_id'])
    assert scheduler.call_args.kwargs['expected_target_version'] == '0.6.3'
    assert app_updates.read_job(record['job_id'])['status'] == 'installing'
    with pytest.raises(app_updates.AppUpdateRejected, match='already'):
        app_updates.create_update_job('0.6.3')
    monkeypatch.setattr(app_updates, '__version__', '0.6.3')
    assert app_updates.read_job(record['job_id'])['status'] == 'complete'
    assert app_updates.create_update_job('0.6.4')['target_version'] == '0.6.4'


def test_preflight_failure_records_failure_and_does_not_swallow_bug(installation, monkeypatch):
    record = app_updates.create_update_job('0.6.3')
    monkeypatch.setattr(app_update_worker, 'schedule_self_update', Mock(side_effect=AssertionError('preflight bug')))
    with pytest.raises(AssertionError, match='preflight bug'):
        app_update_worker.run_update(record['job_id'])
    assert app_updates.read_job(record['job_id'])['status'] == 'failed'
    assert app_updates.create_update_job('0.6.3')['job_id'] != record['job_id']


def test_detached_worker_preserves_lan_settings_and_clears_child_identity(installation, monkeypatch):
    for key, value in {'METALIST_HOST': '0.0.0.0', 'METALIST_ALLOWED_HOSTS': '10.0.0.31',
                       'METALIST_NAMESPACE': 'work', 'METALIST_PORT': '9000',
                       'METALIST_HTTPS_PORT': '9443', 'METALIST_ORCHESTRATED_CHILD': '1'}.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(app_updates, '_is_process_running', lambda *, pid: True)
    popen = Mock()
    monkeypatch.setattr(app_updates.subprocess, 'Popen', popen)
    record = app_updates.create_update_job('0.6.3')
    app_updates.launch_update_job(record['job_id'])
    arguments = popen.call_args
    assert arguments.args[0][1:] == ['-m', 'app.services.app_update_worker', record['job_id']]
    environment = arguments.kwargs['env']
    assert environment['METALIST_HOST'] == '0.0.0.0'
    assert environment['METALIST_ALLOWED_HOSTS'] == '10.0.0.31'
    assert 'METALIST_NAMESPACE' not in environment
    assert 'METALIST_HTTPS_PORT' not in environment
    assert 'METALIST_PORT' not in environment
    assert 'METALIST_ORCHESTRATED_CHILD' not in environment


def test_job_id_cannot_escape_job_directory(installation):
    for job_id in ('../private', '../../data.json', 'not-a-uuid'):
        with pytest.raises(app_updates.AppUpdateRejected):
            app_updates.read_job(job_id)


def test_update_pin_change_aborts_before_stopping_namespaces(monkeypatch):
    monkeypatch.setattr(self_update, '_fetch_latest_pypi_version', lambda: '0.6.4')
    stop = Mock(side_effect=AssertionError('must not stop'))
    monkeypatch.setattr(self_update, 'stop_all_namespace_processes_for_update', stop)
    with pytest.raises(RuntimeError, match='release changed'):
        self_update.schedule_self_update(current_version='0.6.2', metalist_executable='/tools/metalist',
                                        current_pid=1234, platform_name='darwin', environ={}, expected_target_version='0.6.3')
    stop.assert_not_called()


def test_notification_preference_requires_a_release_version():
    assert _validate_client_preferences({'pref.update_notice_version': '0.6.3'}) == {'pref.update_notice_version': '0.6.3'}
    with pytest.raises(ClientStateValidationError):
        _validate_client_preferences({'pref.update_notice_version': 'garbage'})
