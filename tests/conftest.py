"""Isolate application imports and subprocesses from personal namespace storage."""

import os
from tempfile import TemporaryDirectory

for _key in tuple(os.environ):
    if _key.startswith('METALIST_') or _key in {'TEST_MODE', 'API_PREFIX', 'V1_API_PREFIX'}:
        del os.environ[_key]

_test_data = TemporaryDirectory(prefix='metalist-pytest-')
os.environ['METALIST_DATA_DIRECTORY'] = _test_data.name


def pytest_unconfigure(config):
    _test_data.cleanup()
