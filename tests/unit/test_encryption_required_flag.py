"""Only the changes that turn encryption on or off set the "encryption
required" flag. Reading the settings never does: a read can see the row from
before a password change commits, and must not undo the change's flag."""

from types import SimpleNamespace

import pytest

import app.services.auth_service as auth_service_module
from app.security.encryption import is_encryption_required, set_encryption_required


class _Session:
    def connection(self):
        return SimpleNamespace()


@pytest.fixture(autouse=True)
def restore_flag():
    before = is_encryption_required()
    yield
    set_encryption_required(before)


@pytest.mark.parametrize("committed_row, flag_set_by_the_change", [
    # A password is being set: the change marked encryption required, the row still says off.
    ({"encryption_enabled": 0, "encrypted_dek": None}, True),
    # A password is being removed: the change marked it not required, the row still says on.
    ({"encryption_enabled": 1, "encrypted_dek": b"wrapped"}, False),
    # No settings row yet.
    (None, True),
])
def test_reading_the_settings_leaves_the_flag_as_the_change_set_it(monkeypatch, committed_row, flag_set_by_the_change):
    monkeypatch.setattr(auth_service_module, "fetch_settings", lambda connection: committed_row)
    set_encryption_required(flag_set_by_the_change)
    auth_service_module.AuthService(_Session()).get_settings()
    assert is_encryption_required() is flag_set_by_the_change
