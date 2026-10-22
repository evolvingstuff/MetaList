from __future__ import annotations

from pathlib import Path
from io import StringIO
import os
import subprocess
import threading

import app.security.authenticated_logging as authenticated_logging
from app.security.authenticated_logging import EncryptedLogSink
from app.security.authenticated_logging import EncryptedTextStream
from app.security.authenticated_logging import decrypt_log_record
from app.security.authenticated_logging import decrypt_log_records


def test_encrypted_log_sink_never_persists_plaintext(tmp_path: Path) -> None:
    log_path = tmp_path / "default-server.auth.log.enc"
    dek = b"l" * 32
    secret = "private note body: routing number 021000021"
    sink = EncryptedLogSink(path=log_path, dek=dek)

    sink.write(secret)
    sink.close()

    persisted = log_path.read_bytes()
    assert secret.encode("utf-8") not in persisted
    assert decrypt_log_records(path=log_path, dek=dek) == [secret]


def test_encrypted_log_sink_uses_a_fresh_nonce_for_identical_records(tmp_path: Path) -> None:
    log_path = tmp_path / "default-server.auth.log.enc"
    dek = b"n" * 32
    sink = EncryptedLogSink(path=log_path, dek=dek)

    sink.write("same record")
    sink.write("same record")
    sink.close()

    encrypted_lines = log_path.read_bytes().splitlines()
    assert len(encrypted_lines) == 2
    assert encrypted_lines[0] != encrypted_lines[1]
    assert decrypt_log_records(path=log_path, dek=dek) == ["same record", "same record"]


def test_encrypted_log_file_is_owner_only(tmp_path: Path) -> None:
    log_path = tmp_path / "default-server.auth.log.enc"
    sink = EncryptedLogSink(path=log_path, dek=b"p" * 32)

    sink.write("record")
    sink.close()

    if os.name == "nt":
        acl = subprocess.run(
            ["icacls", str(log_path)],
            capture_output=True,
            check=True,
            encoding="utf-8",
            timeout=30,
        ).stdout.casefold()
        assert "everyone:" not in acl
        assert "builtin\\users:" not in acl
        assert "authenticated users:" not in acl
    else:
        assert log_path.stat().st_mode & 0o777 == 0o600


def test_authenticated_stdout_stream_never_writes_plaintext() -> None:
    destination = StringIO()
    dek = b"s" * 32
    secret = "decrypted runtime value"
    stream = EncryptedTextStream(destination=destination, dek=dek)

    stream.write(secret)

    persisted = destination.getvalue()
    assert secret not in persisted
    assert decrypt_log_record(envelope=persisted.encode("ascii"), dek=dek) == secret


def test_a_stream_closing_during_a_write_waits_for_it(monkeypatch):
    """Logout closes the encrypted stdout while another thread may be writing to
    it: the write either finishes before the close or finds the stream closed,
    and nothing reaches the process stream after the close."""
    join_seconds = 5
    # How long the close is given to finish while the write is paused in encryption.
    close_wait_seconds = 0.5
    events = []

    class Destination:
        def write(self, text):
            events.append("write")

        def flush(self):
            events.append("flush")

    real_encrypt = authenticated_logging.encrypt_log_record
    encrypting = threading.Event()
    may_finish = threading.Event()

    def encrypt_then_pause(*, plaintext, dek):
        encrypting.set()
        assert may_finish.wait(join_seconds)
        return real_encrypt(plaintext=plaintext, dek=dek)

    monkeypatch.setattr(authenticated_logging, "encrypt_log_record", encrypt_then_pause)
    stream = EncryptedTextStream(destination=Destination(), dek=bytes(range(32)))
    writer = threading.Thread(target=stream.write, args=("a line\n",))
    writer.start()
    assert encrypting.wait(join_seconds)
    closer = threading.Thread(target=stream.close)
    closer.start()
    closer.join(close_wait_seconds)
    may_finish.set()
    writer.join(join_seconds)
    closer.join(join_seconds)
    assert not writer.is_alive() and not closer.is_alive()
    assert events == ["write", "flush", "flush"], "the write reached the stream after it was closed"


def test_a_sink_closing_during_a_write_waits_for_it(tmp_path: Path, monkeypatch) -> None:
    """Logout closes the encrypted log file while another thread may be writing to
    it: the write either finishes before the close (its record is kept) or finds the
    sink closed. It used to check and encrypt outside the lock, so a close in between
    shut the file under it and the write failed on a closed file."""
    join_seconds = 5
    # How long the close is given to finish while the write is paused in encryption.
    close_wait_seconds = 0.5
    dek = bytes(range(32))
    path = tmp_path / "server.log.enc"
    writer_errors: list[BaseException] = []

    real_encrypt = authenticated_logging.encrypt_log_record
    encrypting = threading.Event()
    may_finish = threading.Event()

    def encrypt_then_pause(*, plaintext, dek):
        encrypting.set()
        assert may_finish.wait(join_seconds)
        return real_encrypt(plaintext=plaintext, dek=dek)

    monkeypatch.setattr(authenticated_logging, "encrypt_log_record", encrypt_then_pause)
    # The writer thread's failure is the evidence: record it instead of printing it.
    monkeypatch.setattr(threading, "excepthook", lambda hook_args: writer_errors.append(hook_args.exc_value))
    sink = EncryptedLogSink(path=path, dek=dek)
    writer = threading.Thread(target=sink.write, args=("a line\n",))
    writer.start()
    assert encrypting.wait(join_seconds)
    closer = threading.Thread(target=sink.close)
    closer.start()
    closer.join(close_wait_seconds)
    assert closer.is_alive(), "the close did not wait for the write under way"
    may_finish.set()
    writer.join(join_seconds)
    closer.join(join_seconds)
    assert not writer.is_alive() and not closer.is_alive()
    assert writer_errors == [], f"the write failed because the sink closed under it: {writer_errors!r}"
    assert decrypt_log_records(path=path, dek=dek) == ["a line\n"]
