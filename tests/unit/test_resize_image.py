from __future__ import annotations

from dataclasses import dataclass

import app.usecases.resize_image as resize_module
from app.security.note_html import sanitize_note_html
from app.services.image_size_formatting import ImageSizeMutationResult


@dataclass
class _Record:
    id: str
    content: str
    tags: str


class _FakeStore:
    def __init__(self, record: _Record) -> None:
        self._record = record

    def get(self, note_id: str) -> _Record:
        if note_id != self._record.id:
            raise KeyError(note_id)
        return self._record


def test_cmd_resize_image_updates_note_and_records_undo(monkeypatch) -> None:
    record = _Record(id="note-1", content='<img src="one.png">', tags="foo")
    monkeypatch.setattr(resize_module, "store", _FakeStore(record))
    monkeypatch.setattr(resize_module, "generate_new_uuid", lambda: "uuid-resized")
    captured = {"update": None, "undo": None}

    def _fake_apply_update_content(note_id: str, content: str, tags: str, token: str) -> None:
        captured["update"] = (note_id, content, tags, token)
        # As a save does: the note is stored cleaned.
        record.content = sanitize_note_html(content)
        record.tags = tags

    def _fake_record_update(*args, **kwargs) -> None:
        captured["undo"] = (args, kwargs)

    monkeypatch.setattr(resize_module, "apply_update_content", _fake_apply_update_content)
    monkeypatch.setattr("app.services.undo_state.record_update", _fake_record_update)

    result = resize_module.CmdResizeImage(
        note_id="note-1",
        source_kind="inline",
        occurrence_index=0,
        action="bigger",
        token="token",
        client_id="client",
        undo_context="tab:1|search:|epoch:0",
        viewport={"scrollY": 0, "scrollAnchor": None},
    ).execute()

    assert captured["update"] == (
        "note-1",
        '{<img src="one.png">}',
        "foo {@size=1.25}",
        "token",
    )
    assert captured["undo"] is not None
    assert captured["undo"][1]["before"] == '<img src="one.png">'
    assert captured["undo"][1]["after_tags"] == "foo {@size=1.25}"
    assert result == {
        "status": "updated",
        "content": '{<img src="one.png">}',
        "tags": "foo {@size=1.25}",
        "sizeFactor": "1.25",
        "editingImageSizes": [1.25],
        "updateUUID": "uuid-resized",
    }


def test_the_resized_note_is_sent_back_as_stored_not_before_cleaning(monkeypatch) -> None:
    # The editor puts the response into the page as HTML: it must be what the save
    # stored, cleaned, never the resize's own uncleaned result.
    record = _Record(id="note-1", content='<img src="one.png">', tags="")
    monkeypatch.setattr(resize_module, "store", _FakeStore(record))
    monkeypatch.setattr(resize_module, "generate_new_uuid", lambda: "uuid-resized")
    uncleaned = '<img src="one.png" onerror="steal()">'
    monkeypatch.setattr(resize_module, "apply_image_size_action", lambda **_kwargs: ImageSizeMutationResult(
        content_html=uncleaned, tags="{@size=1.25}", size_factor="1.25", changed=True,
    ))

    def _store_cleaned(note_id: str, content: str, tags: str, token: str) -> None:
        record.content = sanitize_note_html(content)
        record.tags = tags

    monkeypatch.setattr(resize_module, "apply_update_content", _store_cleaned)
    monkeypatch.setattr("app.services.undo_state.record_update", lambda *args, **kwargs: None)

    result = resize_module.CmdResizeImage(
        note_id="note-1", source_kind="inline", occurrence_index=0, action="bigger", token="token",
        client_id="client", undo_context="tab:1|search:|epoch:0", viewport={"scrollY": 0, "scrollAnchor": None},
    ).execute()

    assert result["content"] == sanitize_note_html(uncleaned) == record.content
    assert "onerror" not in result["content"]
