from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

import app.usecases.move as move_module
import app.usecases.update_content as update_content_module


@contextmanager
def _fake_begin_writer():
    yield object()


def test_apply_update_content_noops_when_content_and_tags_match(monkeypatch: pytest.MonkeyPatch) -> None:
    record = SimpleNamespace(
        content="<div>same</div>",
        tags="alpha",
        proposed_tags="",
        updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    calls: list[str] = []

    monkeypatch.setattr(update_content_module.store, "contains", lambda note_id: note_id == "note-a")
    monkeypatch.setattr(update_content_module.store, "get", lambda note_id: record)
    monkeypatch.setattr(update_content_module, "begin_writer", _fake_begin_writer)
    monkeypatch.setattr(
        update_content_module,
        "encrypt",
        lambda value, token: (_ for _ in ()).throw(AssertionError("no-op save must not encrypt")),
    )
    monkeypatch.setattr(
        update_content_module,
        "db_update_note_fields",
        lambda *args, **kwargs: calls.append("timestamped"),
    )
    monkeypatch.setattr(
        update_content_module,
        "db_update_note_fields_preserving_updated_at",
        lambda *args, **kwargs: calls.append("preserved"),
    )
    monkeypatch.setattr(
        update_content_module.store,
        "update_note_sources",
        lambda *args, **kwargs: calls.append("store"),
    )

    update_content_module.apply_update_content("note-a", "<div>same</div>", "alpha", "token")

    assert calls == []


def test_apply_update_content_preserves_updated_at_for_tag_only_change(monkeypatch: pytest.MonkeyPatch) -> None:
    original_updated_at = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
    record = SimpleNamespace(
        content="<div>same</div>",
        tags="alpha",
        proposed_tags="",
        updated_at=original_updated_at,
    )
    timestamped_calls: list[dict[str, object]] = []
    preserved_calls: list[dict[str, object]] = []
    store_calls: list[dict[str, object]] = []

    monkeypatch.setattr(update_content_module.store, "contains", lambda note_id: note_id == "note-a")
    monkeypatch.setattr(update_content_module.store, "get", lambda note_id: record)
    monkeypatch.setattr(update_content_module, "begin_writer", _fake_begin_writer)
    monkeypatch.setattr(update_content_module, "encrypt", lambda value, token: (f"enc:{value}", None, None))
    monkeypatch.setattr(
        update_content_module,
        "db_update_note_fields",
        lambda connection, note_id, **updates: timestamped_calls.append({"note_id": note_id, **updates}),
    )
    monkeypatch.setattr(
        update_content_module,
        "db_update_note_fields_preserving_updated_at",
        lambda connection, note_id, **updates: preserved_calls.append({"note_id": note_id, **updates}),
    )
    monkeypatch.setattr(
        update_content_module.store,
        "update_note_sources",
        lambda note_id, content, tags, proposed_tags, *, updated_at: store_calls.append(
            {
                "note_id": note_id,
                "content": content,
                "tags": tags,
                "proposed_tags": proposed_tags,
                "updated_at": updated_at,
            }
        ),
    )

    update_content_module.apply_update_content("note-a", "<div>same</div>", "beta", "token")

    assert timestamped_calls == []
    assert preserved_calls == [
        {
            "note_id": "note-a",
            "tags": "enc:beta",
            "tags_encryption_nonce": None,
            "tags_encryption_tag": None,
        }
    ]
    assert store_calls == [
        {
            "note_id": "note-a",
            "content": "<div>same</div>",
            "tags": "beta",
            "proposed_tags": "",
            "updated_at": original_updated_at,
        }
    ]


def test_apply_update_content_bumps_updated_at_for_body_change(monkeypatch: pytest.MonkeyPatch) -> None:
    original_updated_at = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
    next_updated_at = datetime(2026, 1, 2, 12, tzinfo=timezone.utc)
    record = SimpleNamespace(
        content="<div>old</div>",
        tags="alpha",
        proposed_tags="",
        updated_at=original_updated_at,
    )
    timestamped_calls: list[dict[str, object]] = []
    preserved_calls: list[dict[str, object]] = []
    store_calls: list[dict[str, object]] = []

    class FixedDateTime:
        @staticmethod
        def now(tz):
            assert tz is timezone.utc
            return next_updated_at

    monkeypatch.setattr(update_content_module.store, "contains", lambda note_id: note_id == "note-a")
    monkeypatch.setattr(update_content_module.store, "get", lambda note_id: record)
    monkeypatch.setattr(update_content_module, "begin_writer", _fake_begin_writer)
    monkeypatch.setattr(update_content_module, "datetime", FixedDateTime)
    monkeypatch.setattr(update_content_module, "encrypt", lambda value, token: (f"enc:{value}", None, None))
    monkeypatch.setattr(
        update_content_module,
        "db_update_note_fields",
        lambda connection, note_id, **updates: timestamped_calls.append({"note_id": note_id, **updates}),
    )
    monkeypatch.setattr(
        update_content_module,
        "db_update_note_fields_preserving_updated_at",
        lambda connection, note_id, **updates: preserved_calls.append({"note_id": note_id, **updates}),
    )
    monkeypatch.setattr(
        update_content_module.store,
        "update_note_sources",
        lambda note_id, content, tags, proposed_tags, *, updated_at: store_calls.append(
            {
                "note_id": note_id,
                "content": content,
                "tags": tags,
                "proposed_tags": proposed_tags,
                "updated_at": updated_at,
            }
        ),
    )

    update_content_module.apply_update_content(
        "note-a",
        "<div>new</div><script>alert(1)</script>",
        "alpha",
        "token",
    )

    assert preserved_calls == []
    assert timestamped_calls == [
        {
            "note_id": "note-a",
            "content": "enc:<div>new</div>",
            "encryption_nonce": None,
            "encryption_tag": None,
            "updated_at": next_updated_at,
        }
    ]
    assert store_calls == [
        {
            "note_id": "note-a",
            "content": "<div>new</div>",
            "tags": "alpha",
            "proposed_tags": "",
            "updated_at": next_updated_at,
        }
    ]


def test_apply_move_relinks_without_updated_at(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []
    moved: list[tuple[str, str | None, str | None]] = []

    monkeypatch.setattr(move_module, "begin_writer", _fake_begin_writer)
    monkeypatch.setattr(move_module, "_neighbors", lambda note_id: ("old-parent", "old-prev", "old-next"))
    monkeypatch.setattr(
        move_module,
        "db_update_links_preserving_updated_at",
        lambda connection, note_id, **updates: calls.append({"note_id": note_id, **updates}),
    )
    monkeypatch.setattr(
        move_module.store,
        "move_note",
        lambda note_id, parent_id, prev_id: moved.append((note_id, parent_id, prev_id)),
    )

    move_module.apply_move("note-a", "new-parent", "new-prev", "new-next")

    assert calls == [
        {"note_id": "old-prev", "next_id": "old-next"},
        {"note_id": "old-next", "prev_id": "old-prev"},
        {"note_id": "note-a", "parent_id": "new-parent", "prev_id": "new-prev", "next_id": "new-next"},
        {"note_id": "new-prev", "next_id": "note-a"},
        {"note_id": "new-next", "prev_id": "note-a"},
    ]
    assert all("updated_at" not in call for call in calls)
    assert moved == [("note-a", "new-parent", "new-prev")]
