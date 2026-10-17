import errno
from io import StringIO

import pytest
from loguru import logger

from app.security.authenticated_logging import decrypt_log_record
from app.security.authenticated_logging import decrypt_log_records
from app.services import diagnostics


def test_unexpected_error_keeps_exception_text_out_of_plaintext_log() -> None:
    records = []
    sink_id = logger.add(records.append, level="ERROR")
    try:
        with pytest.raises(TypeError) as captured:
            raise TypeError("PRIVATE_NOTE_CONTENT")
        diagnostics.log_unexpected_exception(
            context="HTTP request", exception=captured.value,
            request_id="a1b2c3d4", level="ERROR",
        )
    finally:
        logger.remove(sink_id)
    assert len(records) == 1
    assert records[0].record["exception"] is None
    assert "PRIVATE_NOTE_CONTENT" not in str(records[0])
    assert "error_type=TypeError" in str(records[0])
    assert records[0].record["extra"]["request_id"] == "a1b2c3d4"


def test_an_os_error_logs_its_number_but_never_its_message() -> None:
    # errno names the failure (EADDRINUSE here) and carries no data; the
    # message can hold a path, so it stays out of the plaintext log.
    records = []
    sink_id = logger.add(records.append, level="ERROR")
    try:
        with pytest.raises(OSError) as captured:
            raise OSError(errno.EADDRINUSE, "Address already in use", "PRIVATE_PATH")
        diagnostics.log_unexpected_exception(
            context="process", exception=captured.value, request_id="", level="CRITICAL",
        )
    finally:
        logger.remove(sink_id)
    assert len(records) == 1
    assert f"error_type=OSError errno={errno.EADDRINUSE} frames=" in str(records[0])
    assert "PRIVATE_PATH" not in str(records[0]) and "Address already" not in str(records[0])


def test_asyncio_error_uses_the_same_safe_loguru_boundary() -> None:
    records = []
    sink_id = logger.add(records.append, level="ERROR")
    try:
        with pytest.raises(RuntimeError) as captured:
            raise RuntimeError("PRIVATE_NOTE_CONTENT")
        diagnostics._handle_asyncio_exception(None, {"exception": captured.value})
    finally:
        logger.remove(sink_id)
    assert len(records) == 1
    assert "error_type=RuntimeError" in str(records[0])
    assert "PRIVATE_NOTE_CONTENT" not in str(records[0])


def test_recycle_direct_append_log_file_keeps_tail_for_oversized_log(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(diagnostics, "_DIRECT_APPEND_LOG_MAX_BYTES", 20)
    monkeypatch.setattr(diagnostics, "_DIRECT_APPEND_LOG_TAIL_BYTES", 8)
    log_path = tmp_path / "namespace-work.log"
    log_path.write_bytes(b"0123456789abcdefghijklmnopqrstuvwxyz")

    recycled = diagnostics.recycle_direct_append_log_file(path=log_path)

    contents = log_path.read_bytes()
    assert recycled is True
    assert contents.endswith(b"stuvwxyz")
    assert b"log compacted" in contents


def test_recycle_direct_append_log_file_leaves_small_log_unchanged(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(diagnostics, "_DIRECT_APPEND_LOG_MAX_BYTES", 100)
    log_path = tmp_path / "namespace-work.log"
    log_path.write_bytes(b"small log")

    recycled = diagnostics.recycle_direct_append_log_file(path=log_path)

    assert recycled is False
    assert log_path.read_bytes() == b"small log"


def test_assert_log_disk_usage_within_bounds_fails_when_total_exceeds_cap(
    tmp_path,
    monkeypatch,
) -> None:
    logs_directory = tmp_path / "logs"
    logs_directory.mkdir()
    (logs_directory / "namespace-work.log").write_bytes(b"1234567890")
    (logs_directory / "work-server.log").write_bytes(b"abcdefghij")
    monkeypatch.setattr(diagnostics, "resolve_runtime_logs_directory", lambda: logs_directory)
    monkeypatch.setattr(diagnostics, "_LOG_DIRECTORY_MAX_BYTES", 15)
    monkeypatch.setattr(diagnostics, "_DIRECT_APPEND_LOG_MAX_BYTES", 100)

    with pytest.raises(RuntimeError, match="Log directory exceeds disk bound"):
        diagnostics.assert_log_disk_usage_within_bounds()


def test_assert_log_disk_usage_within_bounds_fails_when_direct_append_file_stays_large(
    tmp_path,
    monkeypatch,
) -> None:
    logs_directory = tmp_path / "logs"
    logs_directory.mkdir()
    log_path = logs_directory / "namespace-work.log"
    log_path.write_bytes(b"1234567890")
    monkeypatch.setattr(diagnostics, "resolve_runtime_logs_directory", lambda: logs_directory)
    monkeypatch.setattr(diagnostics, "_DIRECT_APPEND_LOG_MAX_BYTES", 5)
    monkeypatch.setattr(diagnostics, "_DIRECT_APPEND_LOG_TAIL_BYTES", 8)
    monkeypatch.setattr(diagnostics, "_LOG_DIRECTORY_MAX_BYTES", 100)

    with pytest.raises(RuntimeError, match="Log file exceeds direct append cap"):
        diagnostics.assert_log_disk_usage_within_bounds()


def test_request_tracking_records_and_removes_active_request() -> None:
    diagnostics.begin_request(
        request_id="abc123",
        method="POST",
        path="/api2/notes/view",
        has_query=False,
        client="127.0.0.1",
        user_agent="pytest",
        started_at=100.0,
    )

    snapshot = diagnostics.snapshot_active_requests()
    assert "abc123" in snapshot
    assert snapshot["abc123"].path == "/api2/notes/view"
    assert snapshot["abc123"].has_query is False
    assert not hasattr(snapshot["abc123"], "query")

    duration_ms = diagnostics.finish_request(request_id="abc123", ended_at=100.25)

    assert duration_ms == 250.0
    assert "abc123" not in diagnostics.snapshot_active_requests()


def test_collect_slow_request_logs_rate_limits_repeated_reports() -> None:
    diagnostics.begin_request(
        request_id="slow1",
        method="PUT",
        path="/api2/notes/root/save",
        has_query=True,
        client="127.0.0.1",
        user_agent="pytest",
        started_at=10.0,
    )

    first_logs = diagnostics.collect_slow_request_logs(
        now=25.0,
        threshold_seconds=10.0,
    )
    repeated_logs = diagnostics.collect_slow_request_logs(
        now=30.0,
        threshold_seconds=10.0,
    )
    later_logs = diagnostics.collect_slow_request_logs(
        now=36.0,
        threshold_seconds=10.0,
    )
    diagnostics.finish_request(request_id="slow1", ended_at=40.0)

    assert len(first_logs) == 1
    assert first_logs[0].request_id == "slow1"
    assert first_logs[0].has_query is True
    assert not hasattr(first_logs[0], "query")
    assert first_logs[0].duration_seconds == 15.0
    assert repeated_logs == []
    assert len(later_logs) == 1


def test_authenticated_logging_encrypts_process_streams_and_diagnostic_sink(
    tmp_path,
    monkeypatch,
) -> None:
    dek = b"a" * 32
    secret = "decrypted note content must never persist as plaintext"
    plaintext_stdout = StringIO()
    plaintext_stderr = StringIO()
    monkeypatch.setattr(diagnostics, "resolve_runtime_logs_directory", lambda: tmp_path)
    monkeypatch.setattr(diagnostics, "_disable_plaintext_fault_logging", lambda: None)
    monkeypatch.setattr(diagnostics, "_enable_plaintext_fault_logging", lambda: None)
    monkeypatch.setattr(diagnostics.sys, "stdout", plaintext_stdout)
    monkeypatch.setattr(diagnostics.sys, "stderr", plaintext_stderr)

    encrypted_path = diagnostics.activate_authenticated_logging(namespace="work", dek=dek)
    try:
        print(secret)
        with pytest.raises(TypeError) as captured:
            raise TypeError(secret)
        diagnostics.log_unexpected_exception(
            context="HTTP request", exception=captured.value,
            request_id="", level="ERROR",
        )
        assert diagnostics._authenticated_log_sink is not None
        diagnostics._authenticated_log_sink.write(secret)
    finally:
        diagnostics.deactivate_authenticated_logging()

    stdout_bytes = plaintext_stdout.getvalue().encode("ascii")
    assert secret.encode("utf-8") not in stdout_bytes
    assert secret.encode("utf-8") not in plaintext_stderr.getvalue().encode("ascii")
    assert secret.encode("utf-8") not in encrypted_path.read_bytes()
    stdout_records = [
        decrypt_log_record(envelope=line, dek=dek)
        for line in stdout_bytes.splitlines()
    ]
    assert secret in stdout_records
    assert secret in decrypt_log_records(path=encrypted_path, dek=dek)
    assert any(
        "TypeError: " + secret in record
        for record in decrypt_log_records(path=encrypted_path, dek=dek)
    )
    assert diagnostics.sys.stdout is plaintext_stdout
    assert diagnostics.sys.stderr is plaintext_stderr


def test_a_second_request_with_an_id_already_in_flight_fails_loudly() -> None:
    """Two requests in flight under one id would share one tracking entry, and
    the second to finish would find none: starting the second one fails at once."""
    request = {"method": "GET", "path": "/api2/auth/status", "has_query": False,
               "client": "127.0.0.1", "user_agent": "pytest", "started_at": 1.0}
    diagnostics.begin_request(request_id="same-id", **request)
    try:
        with pytest.raises(RuntimeError, match="already in flight"):
            diagnostics.begin_request(request_id="same-id", **request)
    finally:
        diagnostics.finish_request(request_id="same-id", ended_at=2.0)
    assert "same-id" not in diagnostics.snapshot_active_requests()
