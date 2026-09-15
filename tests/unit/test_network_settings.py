import json

import pytest

from app.network_settings import apply_network_settings


def test_lan_launch_is_remembered_by_plain_cli_and_children(tmp_path):
    configured = {
        'METALIST_DATA_DIRECTORY': str(tmp_path), 'METALIST_HOST': '0.0.0.0',
        'METALIST_ALLOWED_HOSTS': '10.0.0.31', 'METALIST_SHELL_ENABLED': '1',
    }
    apply_network_settings(environ=configured, persist=True)
    path = tmp_path / 'network-settings.json'
    original = path.read_bytes()
    for persist in (True, False):
        fresh = {'METALIST_DATA_DIRECTORY': str(tmp_path)}
        apply_network_settings(environ=fresh, persist=persist)
        assert fresh['METALIST_HOST'] == '0.0.0.0'
        assert fresh['METALIST_ALLOWED_HOSTS'] == '10.0.0.31'
        assert 'METALIST_SHELL_ENABLED' not in fresh
        assert path.read_bytes() == original


def test_fresh_install_keeps_loopback_defaults_without_creating_settings(tmp_path):
    environ = {'METALIST_DATA_DIRECTORY': str(tmp_path)}
    apply_network_settings(environ=environ, persist=True)
    assert 'METALIST_HOST' not in environ
    assert not (tmp_path / 'network-settings.json').exists()


def test_explicit_loopback_override_is_saved_and_does_not_affect_another_data_root(tmp_path):
    environ = {'METALIST_DATA_DIRECTORY': str(tmp_path / 'first'), 'METALIST_HOST': '0.0.0.0'}
    apply_network_settings(environ=environ, persist=True)
    environ['METALIST_HOST'] = '127.0.0.1'
    apply_network_settings(environ=environ, persist=True)
    fresh = {'METALIST_DATA_DIRECTORY': str(tmp_path / 'first')}
    apply_network_settings(environ=fresh, persist=False)
    assert fresh['METALIST_HOST'] == '127.0.0.1'
    other = {'METALIST_DATA_DIRECTORY': str(tmp_path / 'second')}
    apply_network_settings(environ=other, persist=False)
    assert 'METALIST_HOST' not in other


@pytest.mark.parametrize('key,value', [('METALIST_HOST', ''), ('METALIST_ALLOWED_HOSTS', '*')])
def test_invalid_override_does_not_replace_saved_settings(tmp_path, key, value):
    environ = {'METALIST_DATA_DIRECTORY': str(tmp_path), 'METALIST_HOST': '10.0.0.31'}
    apply_network_settings(environ=environ, persist=True)
    original = (tmp_path / 'network-settings.json').read_bytes()
    environ[key] = value
    with pytest.raises(RuntimeError):
        apply_network_settings(environ=environ, persist=True)
    assert (tmp_path / 'network-settings.json').read_bytes() == original


@pytest.mark.parametrize('payload', [
    '{', '[]', '{"version": 2, "environment": {}}',
    json.dumps({'version': 1, 'environment': {'METALIST_SHELL_ENABLED': '1'}}),
    json.dumps({'version': 1, 'environment': {'METALIST_HOST': None}}),
])
def test_corrupt_or_unknown_settings_fail_instead_of_silently_changing_binding(tmp_path, payload):
    path = tmp_path / 'network-settings.json'
    path.write_text(payload)
    with pytest.raises((ValueError, RuntimeError)):
        apply_network_settings(environ={'METALIST_DATA_DIRECTORY': str(tmp_path)}, persist=True)
    assert path.read_text() == payload
