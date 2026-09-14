"""Release harness setup must remain unattended and preserve TLS verification."""
import hashlib
import importlib.util
import json
from pathlib import Path
import ssl
import subprocess
from types import SimpleNamespace

import pytest


_spec = importlib.util.spec_from_file_location('release_smoke_setup', Path(__file__).resolve().parents[2] / 'scripts/smoke_installed_package.py')
assert _spec is not None and _spec.loader is not None
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)


@pytest.fixture
def edge_setup(tmp_path, monkeypatch):
    executable = tmp_path / 'programs/Microsoft/Edge/Application/msedge.exe'
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b'fixture')
    certificate = tmp_path / 'certificate.pem'
    certificate.write_text(ssl.DER_cert_to_PEM_cert(b'fixture certificate'))
    environment = {'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_TEMP': str(tmp_path),
                   'ProgramFiles': str(tmp_path / 'programs')}
    monkeypatch.setattr(smoke, 'os', SimpleNamespace(name='nt', environ=environment))
    monkeypatch.setattr(smoke.shutil, 'which', lambda name: '/fixture/node')
    return {'directory': tmp_path, 'certificate': certificate, 'host': '10.0.0.5',
            'profiles': [('first', 8000, 8443), ('second', 8001, 8444)]}


def test_edge_uses_unattended_machine_trust_and_removes_only_its_certificate(edge_setup, monkeypatch):
    commands = []
    def run(command, **options):
        if '-user' in command:
            raise subprocess.TimeoutExpired(command, 30)
        commands.append(command)
    monkeypatch.setattr(smoke.subprocess, 'run', run)
    smoke._verify_edge_startup(**edge_setup)
    assert commands[0] == ['certutil', '-addstore', 'Root', str(edge_setup['certificate'])]
    assert commands[1][-2:] == ['https://10.0.0.5:8443', 'https://10.0.0.5:8444']
    thumbprint = hashlib.sha1(b'fixture certificate', usedforsecurity=False).hexdigest()
    assert commands[2] == ['certutil', '-delstore', 'Root', thumbprint]
    diagnostics = json.loads((edge_setup['directory'] / 'metalist-edge-results/setup-results.json').read_text())
    assert diagnostics['passed'] is True


def test_edge_failure_still_removes_trust_and_keeps_diagnostics(edge_setup, monkeypatch):
    commands = []
    def run(command, **options):
        commands.append(command)
        if command[0] != 'certutil':
            raise subprocess.CalledProcessError(1, command)
    monkeypatch.setattr(smoke.subprocess, 'run', run)
    with pytest.raises(subprocess.CalledProcessError):
        smoke._verify_edge_startup(**edge_setup)
    assert commands[-1][:3] == ['certutil', '-delstore', 'Root']
    diagnostics = json.loads((edge_setup['directory'] / 'metalist-edge-results/setup-results.json').read_text())
    assert diagnostics == {'stage': 'running Edge startup checks', 'passed': False}


def test_trust_setup_failure_produces_artifact_before_browser_launch(edge_setup, monkeypatch):
    def fail(command, **options):
        raise subprocess.TimeoutExpired(command, 30)
    monkeypatch.setattr(smoke.subprocess, 'run', fail)
    with pytest.raises(subprocess.TimeoutExpired):
        smoke._verify_edge_startup(**edge_setup)
    diagnostics = json.loads((edge_setup['directory'] / 'metalist-edge-results/setup-results.json').read_text())
    assert diagnostics == {'stage': 'trusting generated certificate', 'passed': False}
