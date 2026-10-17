"""The session's encryption service is cached for the active token. A request
filling that cache and a lock clearing it can overlap; the lock must win, and
no request ever sees a service whose key is not set yet."""

import threading

import pytest

import app.utils.encryption as encryption
from app.services.tokens import token_service

DEK = bytes(range(32))
TOKEN = "token-in-flight"
# How long the lock is given to clear the key while the request is paused; the
# fixed cache makes it wait for the request instead, so this is how long it waits.
CLEAR_WAIT_SECONDS = 0.5
JOIN_SECONDS = 5


@pytest.fixture(autouse=True)
def clear_cached_service():
    encryption.clear_encryption_key()
    yield
    encryption.clear_encryption_key()


def test_a_lock_during_a_cache_fill_leaves_no_key_in_memory(monkeypatch):
    has_key = threading.Event()
    resume = threading.Event()

    def get_dek_then_pause(token):
        assert token == TOKEN
        has_key.set()
        assert resume.wait(JOIN_SECONDS)
        return DEK

    monkeypatch.setattr(token_service, "get_dek", get_dek_then_pause)
    request = threading.Thread(target=encryption.get_encryption_service_with_token, args=(TOKEN,))
    request.start()
    assert has_key.wait(JOIN_SECONDS)
    lock = threading.Thread(target=encryption.clear_encryption_key)
    lock.start()
    lock.join(CLEAR_WAIT_SECONDS)
    resume.set()
    request.join(JOIN_SECONDS)
    lock.join(JOIN_SECONDS)
    assert not request.is_alive() and not lock.is_alive()
    assert encryption.get_encryption_service() is None, "the lock cleared the key, and the request put it back"


def test_a_cached_service_is_published_only_with_its_key(monkeypatch):
    seen_without_key = []
    real_service = encryption.EncryptionService

    class WatchedService(real_service):
        def __setattr__(self, name, value):
            if name == "dek" and value:
                # Just before the key is set: another request must not find this service yet.
                current = encryption._encryption_service
                if current is self:
                    seen_without_key.append(name)
            super().__setattr__(name, value)

    monkeypatch.setattr(encryption, "EncryptionService", WatchedService)
    monkeypatch.setattr(token_service, "get_dek", lambda token: DEK)
    service = encryption.get_encryption_service_with_token(TOKEN)
    assert service is not None and service.dek == DEK
    assert seen_without_key == [], "the service was the shared one before its key was set"
    encryption.set_session_dek(DEK)
    assert seen_without_key == [], "set_session_dek shared the service before its key was set"
