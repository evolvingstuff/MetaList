"""Isolate application imports and subprocesses from personal namespace storage, and keep
tests away from the user's running MetaList servers."""

import os
import sys
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

for _key in tuple(os.environ):
    if _key.startswith('METALIST_') or _key in {'TEST_MODE', 'API_PREFIX', 'V1_API_PREFIX'}:
        del os.environ[_key]

_test_data = TemporaryDirectory(prefix='metalist-pytest-')
os.environ['METALIST_DATA_DIRECTORY'] = _test_data.name

# The scripts that start a MetaList server. A test may start one only through a stand-in.
_METALIST_SERVER_SCRIPTS = frozenset({'main.py', 'serve_namespace.py'})
# Signal 0 only asks whether a process exists.
_EXISTENCE_PROBE = 0
_REAL_POPEN = subprocess.Popen
_REAL_KILL = os.kill
# Process groups are POSIX only: Windows has no os.killpg to guard (or to call).
_HAS_PROCESS_GROUPS = sys.platform != 'win32'


def pytest_unconfigure(config):
    _test_data.cleanup()


@pytest.fixture(autouse=True)
def _no_real_metalist_servers(monkeypatch):
    """A test that forgets to stub process control must fail, not reach a real server:
    on 2026-10-19 the launch-all tests, left without their stubs by a refactor, stopped
    the user's running servers on ports 8000 and 8001 and started new ones. A test may
    signal only processes it started, and may not start a MetaList server. A test that
    stubs os.kill or subprocess.Popen itself replaces these guards."""
    started: set[int] = set()
    if _HAS_PROCESS_GROUPS:
        real_killpg = os.killpg

    class _GuardedPopen(_REAL_POPEN):
        def __init__(self, args, *popen_args, **popen_kwargs):
            words = [args]
            if isinstance(args, (list, tuple)):
                words = list(args)
            if any(Path(str(word)).name in _METALIST_SERVER_SCRIPTS for word in words):
                raise AssertionError(f'A unit test tried to start a MetaList server ({args}): stub the launch')
            super().__init__(args, *popen_args, **popen_kwargs)
            started.add(self.pid)

    def _guarded_kill(pid, signal_number):
        if signal_number != _EXISTENCE_PROBE and pid not in started:
            raise AssertionError(
                f'A unit test tried to signal process {pid}, which it did not start: stub the process '
                'control (a real MetaList server may be listening there)'
            )
        return _REAL_KILL(pid, signal_number)

    def _guarded_killpg(process_group, signal_number):
        if signal_number != _EXISTENCE_PROBE and process_group not in started:
            raise AssertionError(f'A unit test tried to signal process group {process_group}, which it did not start')
        return real_killpg(process_group, signal_number)

    monkeypatch.setattr(subprocess, 'Popen', _GuardedPopen)
    monkeypatch.setattr(os, 'kill', _guarded_kill)
    if _HAS_PROCESS_GROUPS:
        monkeypatch.setattr(os, 'killpg', _guarded_killpg)
