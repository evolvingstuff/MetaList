from __future__ import annotations

from contextlib import contextmanager

import pytest

import app.usecases.collapse as collapse_module


def test_set_collapse_preserves_updated_at(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    @contextmanager
    def fake_begin_writer():
        yield object()

    def fake_update_links(connection, note_id: str, **updates) -> None:
        assert connection is not None
        calls.append({"note_id": note_id, **updates})

    collapsed: dict[str, bool] = {}
    monkeypatch.setattr(collapse_module, "begin_writer", fake_begin_writer)
    monkeypatch.setattr(collapse_module, "db_update_links_preserving_updated_at", fake_update_links)
    # Neither note is only a reference: each folds itself.
    monkeypatch.setattr(collapse_module, "shown_collapse_note_id", lambda note_id: note_id)
    monkeypatch.setattr(
        collapse_module.store,
        "set_collapsed",
        lambda note_id, value: collapsed.update({note_id: value}),
    )

    collapse_module.apply_set_collapse_bulk(["note-a", "note-b"], True)

    assert calls == [
        {"note_id": "note-a", "is_collapsed": True},
        {"note_id": "note-b", "is_collapsed": True},
    ]
    assert collapsed == {"note-a": True, "note-b": True}
