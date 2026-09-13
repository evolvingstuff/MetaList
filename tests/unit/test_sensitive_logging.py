from __future__ import annotations

import logging
from pathlib import Path

from app.security.validation_errors import summarize_validation_errors
from app.services import undo_state


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_search_context_logging_never_contains_search_text(caplog) -> None:
    undo_state.reset_all_undo_state()
    undo_state.maybe_reset_on_context('fixture', 'previous private search')
    with caplog.at_level(logging.DEBUG):
        undo_state.maybe_reset_on_context('fixture', 'current private search')
    assert 'previous private search' not in caplog.text
    assert 'current private search' not in caplog.text
    assert 'undo.stack reset' in caplog.text
    undo_state.reset_all_undo_state()



def test_validation_error_summary_discards_rejected_input_and_context() -> None:
    secret = "correct horse battery staple"
    summarized = summarize_validation_errors(
        [
            {
                "type": "string_too_short",
                "loc": ("body", "password"),
                "msg": "String should have at least 12 characters",
                "input": secret,
                "ctx": {"submitted": secret},
                "url": "https://errors.example.invalid/secret",
            }
        ]
    )

    assert summarized == [
        {
            "type": "string_too_short",
            "loc": ["body", "password"],
        }
    ]
    assert secret not in repr(summarized)


def test_server_search_telemetry_never_binds_plaintext_query() -> None:
    paths = (
        PROJECT_ROOT / "app" / "services" / "snapshot.py",
        PROJECT_ROOT / "app" / "services" / "search_index.py",
    )

    for path in paths:
        source = path.read_text(encoding="utf-8")
        assert "query=search" not in source, path


def test_uvicorn_access_log_is_disabled_because_request_targets_can_contain_searches() -> None:
    source = (PROJECT_ROOT / "main.py").read_text(encoding="utf-8")

    assert "access_log=False" in source
