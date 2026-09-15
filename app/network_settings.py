"""Machine network preferences shared by source and installed entrypoints.

Only an explicit bind address/allowed-host configuration opts into persistence.
Namespace ports, shell capability, credentials, and backups are not stored here.
"""
from __future__ import annotations

from collections.abc import MutableMapping
import json
import os
from pathlib import Path
from uuid import uuid4

from app.data_directory import resolve_data_directory
from app.security.request_hosts import resolve_allowed_request_hosts


_NETWORK_ENVIRONMENT_KEYS = frozenset({'METALIST_HOST', 'METALIST_ALLOWED_HOSTS'})


def _validate_network_environment(environment: object) -> dict[str, str]:
    if not isinstance(environment, dict) or not environment.keys() <= _NETWORK_ENVIRONMENT_KEYS:
        raise RuntimeError('Network settings must contain only bind-address and allowed-host preferences')
    if any(not isinstance(value, str) for value in environment.values()):
        raise RuntimeError('Network settings values must be strings')
    resolve_allowed_request_hosts(environ=environment)
    return dict(environment)


def _read_network_settings(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding='utf-8'))
    if (not isinstance(payload, dict) or set(payload) != {'version', 'environment'}
            or type(payload['version']) is not int or payload['version'] != 1):
        raise RuntimeError(f'Invalid network settings file: {path}')
    return _validate_network_environment(payload['environment'])


def _write_network_settings(path: Path, environment: dict[str, str]) -> None:
    assert path.name == 'network-settings.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.network-settings-{uuid4().hex}.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump({'version': 1, 'environment': environment}, stream, indent=2)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def apply_network_settings(*, environ: MutableMapping[str, str], persist: bool) -> None:
    path = resolve_data_directory(environ=environ) / 'network-settings.json'
    saved = _read_network_settings(path)
    configured = {key: environ[key] for key in _NETWORK_ENVIRONMENT_KEYS if key in environ}
    effective = _validate_network_environment(saved | configured)
    if persist and effective != saved:
        _write_network_settings(path, effective)
        print(f'[startup] Saved network settings: {path}', flush=True)
    environ.update(effective)
