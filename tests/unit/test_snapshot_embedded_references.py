from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from datetime import datetime, timezone
import re
import sqlite3
from typing import Dict, List, Optional

import pytest

from app.db.link_titles_sql import insert_link_title_row
from app.db.schema import initialize_schema
from app.services.link_titles import link_title_store
from app.services.snapshot import build_view_state


@dataclass
class _Note:
    id: str
    parent_id: Optional[str]
    prev_id: Optional[str]
    next_id: Optional[str]
    is_collapsed: bool
    content: str
    tags: str
    created_at: datetime = datetime(2026, 1, 1, tzinfo=timezone.utc)
    updated_at: datetime = datetime(2026, 1, 2, tzinfo=timezone.utc)
    proposed_tags: str = ""
    proposed_tag_terms: frozenset[str] = frozenset()


class _FakeNoteStore:
    def __init__(self, *, notes: Dict[str, _Note], children_by_parent: Dict[Optional[str], List[str]]):
        self._notes = notes
        self._children_by_parent = children_by_parent

    def has_note(self, note_id: str) -> bool:
        return note_id in self._notes

    def get_note(self, note_id: str) -> _Note:
        return self._notes[note_id]

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        return list(self._children_by_parent.get(parent_id, []))

    def get_inherited_non_meta_tag_terms(self, note_id: str) -> frozenset[str]:
        assert note_id in self._notes
        return frozenset()


HOST_ID = "11111111-1111-1111-1111-111111111111"
TARGET_ID = "22222222-2222-2222-2222-222222222222"
CHILD_ID = "33333333-3333-3333-3333-333333333333"
OTHER_ID = "44444444-4444-4444-4444-444444444444"
MISSING_ID = "99999999-9999-9999-9999-999999999999"


def _bootstrap_cached_link_title(*, url: str, title: str) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    now = datetime.now(timezone.utc)
    insert_link_title_row(
        connection,
        url=url,
        url_encryption_nonce=None,
        url_encryption_tag=None,
        title=title,
        title_encryption_nonce=None,
        title_encryption_tag=None,
        status="ok",
        last_error_kind=None,
        last_checked_at=now,
        last_success_at=now,
        last_failure_at=None,
        next_check_after=None,
        failure_count=0,
        created_at=now,
        updated_at=now,
    )
    link_title_store.bootstrap(connection=connection)
    return connection


def _state_for(
    *,
    monkeypatch: pytest.MonkeyPatch,
    notes: Dict[str, _Note],
    children_by_parent: Dict[Optional[str], List[str]],
    **kwargs: object,
):
    editing_note_id = None
    if "editing_note_id" in kwargs:
        editing_note_id = kwargs["editing_note_id"]
    if editing_note_id is not None and not isinstance(editing_note_id, str):
        raise TypeError("editing_note_id must be a string or None")
    store = _FakeNoteStore(notes=notes, children_by_parent=children_by_parent)

    import app.services.snapshot as snapshot

    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})
    return build_view_state(
        editing_note_id=editing_note_id,
        search=None,
        sort_mode="normal",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )


def test_embed_reference_renders_as_block_and_includes_descendants(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        HOST_ID: _Note(HOST_ID, None, None, TARGET_ID, False, f"<div>blah ![[{TARGET_ID}]] yada</div>", ""),
        TARGET_ID: _Note(TARGET_ID, None, HOST_ID, None, False, "<div>embedded root</div>", ""),
        CHILD_ID: _Note(
            CHILD_ID,
            TARGET_ID,
            None,
            None,
            True,
            "<div>embedded child</div><div>embedded child hidden line</div>",
            "",
        ),
        OTHER_ID: _Note(OTHER_ID, CHILD_ID, None, None, False, "<div>embedded grandchild</div>", ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={
            None: [HOST_ID, TARGET_ID],
            TARGET_ID: [CHILD_ID],
            CHILD_ID: [OTHER_ID],
        },
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert state.payloads[HOST_ID]["flags"]["isCollapsible"] is True
    assert "note-embed-block" in rendered
    assert "note-reference-toggle" not in rendered
    assert f'data-embed-ref-id="{TARGET_ID}"' in rendered
    assert f'data-embed-note-id="{TARGET_ID}"' in rendered
    assert "embedded root" in rendered
    assert "embedded child" in rendered
    assert "embedded child hidden line" in rendered
    assert "embedded grandchild" in rendered
    assert 'class="note-embed-source-link"' in rendered
    assert 'class="note-reference-link-icon" aria-hidden="true" title="Link to reference source">&#8599;</span>' in rendered
    assert "note-reference-link-kind" not in rendered
    assert "Open referenced note:" not in rendered
    assert rendered.index("blah") < rendered.index("note-embed-block")
    assert rendered.index("note-embed-block") < rendered.index("yada")
    assert rendered.index("embedded child") < rendered.index("note-embed-source-link")


def test_view_rendering_never_exposes_remote_image_source_to_browser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote_url = "https://images.example/private-tracker.png"
    notes = {
        HOST_ID: _Note(
            HOST_ID,
            None,
            None,
            None,
            False,
            f'<div><img src="{remote_url}" alt="remote"></div>',
            "",
        ),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert remote_url not in rendered
    assert re.search(
        r'data-remote-image-proxy-src="/api2/remote-images/[A-Za-z0-9_-]{32}"',
        rendered,
    ) is not None
    assert re.search(r"<img[^>]+\ssrc=", rendered) is None


def test_embed_reference_ignores_collapsed_source_state_and_has_no_inner_toggle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        HOST_ID: _Note(HOST_ID, None, None, TARGET_ID, False, f"<div>![[{TARGET_ID}]]</div>", ""),
        TARGET_ID: _Note(
            TARGET_ID,
            None,
            HOST_ID,
            None,
            True,
            "<div>embedded first line</div><div>embedded hidden line</div>",
            "",
        ),
        CHILD_ID: _Note(CHILD_ID, TARGET_ID, None, None, False, "<div>embedded child</div>", ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID, TARGET_ID], TARGET_ID: [CHILD_ID]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert f'data-embed-note-id="{TARGET_ID}"' in rendered
    assert "data-is-collapsed" not in rendered
    assert "data-can-collapse" not in rendered
    assert "note-embed-collapse-toggle" not in rendered
    assert "Expand referenced note" not in rendered
    assert "Collapse referenced note" not in rendered
    assert "embedded first line" in rendered
    assert "embedded hidden line" in rendered
    assert "embedded child" in rendered


def test_collapsed_host_renders_note_embed_as_link_only(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        HOST_ID: _Note(
            HOST_ID,
            None,
            None,
            TARGET_ID,
            True,
            f"<div>![[{TARGET_ID}]]</div><div>hidden host line</div>",
            "",
        ),
        TARGET_ID: _Note(
            TARGET_ID,
            None,
            HOST_ID,
            None,
            False,
            "<div>referenced first line</div><div>referenced second line</div>",
            "",
        ),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID, TARGET_ID]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert "note-reference-link-mode" in rendered
    assert "note-reference-link" in rendered
    assert "note-reference-toggle" not in rendered
    assert "note-reference-link-icon" in rendered
    assert 'title="Link to reference source"' in rendered
    assert "note-reference-link-kind" not in rendered
    assert "note-embed-block" not in rendered
    assert "note-embed-node" not in rendered
    assert "referenced first line" in rendered
    assert "referenced second line" not in rendered
    assert "hidden host line" not in rendered


def test_embed_reference_missing_uuid_shows_missing_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        HOST_ID: _Note(HOST_ID, None, None, None, False, f"<div>![[{MISSING_ID}]]</div>", ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert "note-embed-missing" in rendered
    assert f"Missing reference: {MISSING_ID}" in rendered
    assert "note-reference-toggle" not in rendered


def test_link_reference_missing_uuid_shows_missing_marker_without_toggle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        HOST_ID: _Note(HOST_ID, None, None, None, False, f"<div>[[{MISSING_ID}]]</div>", ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert "note-embed-missing" in rendered
    assert f"Missing reference: {MISSING_ID}" in rendered
    assert "note-reference-toggle" not in rendered


def test_non_uuid_double_square_tokens_remain_literal_without_tags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        HOST_ID: _Note(
            HOST_ID,
            None,
            None,
            None,
            False,
            "<div>e.g. [[3]] with tag [[@counter]]</div>",
            "",
        ),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert "[[3]]" in rendered
    assert "[[@counter]]" in rendered
    assert "note-embed-missing" not in rendered
    assert "Missing reference:" not in rendered


def test_scoped_double_square_latex_is_not_treated_as_link_reference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        HOST_ID: _Note(
            HOST_ID,
            None,
            None,
            None,
            False,
            "<div>enqueue is [[$O(N)$]]</div>",
            "[[@LaTeX]]",
        ),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert "Missing reference: $O(N)$" not in rendered
    assert "note-embed-missing" not in rendered
    assert 'class="meta-latex meta-latex-inline"' in rendered
    assert '<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline">' in rendered


def test_embed_reference_cycle_shows_cycle_marker_and_stops(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        HOST_ID: _Note(HOST_ID, None, None, None, False, f"<div>![[{TARGET_ID}]]</div>", ""),
        TARGET_ID: _Note(TARGET_ID, None, None, None, False, f"<div>![[{HOST_ID}]]</div>", ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID, TARGET_ID]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert "note-embed-block" in rendered
    assert "note-embed-cycle" in rendered
    assert f"Circular reference: {HOST_ID}" in rendered


def test_plain_reference_renders_link_mode_preview(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        HOST_ID: _Note(HOST_ID, None, None, None, False, f"<div>prefix [[{TARGET_ID}]] suffix</div>", ""),
        TARGET_ID: _Note(TARGET_ID, None, None, None, False, "<div>linked first line</div><div>linked second line</div>", ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID, TARGET_ID]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert "note-reference-link-mode" in rendered
    assert "note-reference-link" in rendered
    assert "linked first line" in rendered
    assert "linked second line" not in rendered
    assert 'data-ref-mode="link"' in rendered
    assert "note-reference-toggle" not in rendered


def test_link_reference_renders_cached_standalone_url_title(monkeypatch: pytest.MonkeyPatch) -> None:
    url = "https://www.youtube.com/watch?v=abc123"
    connection = _bootstrap_cached_link_title(url=url, title="A Useful Video")
    try:
        notes = {
            HOST_ID: _Note(HOST_ID, None, None, None, False, f"<div>[[{TARGET_ID}]]</div>", ""),
            TARGET_ID: _Note(TARGET_ID, None, None, None, False, f"<div>{url}</div>", ""),
        }
        state = _state_for(
            monkeypatch=monkeypatch,
            notes=notes,
            children_by_parent={None: [HOST_ID, TARGET_ID]},
        )
    finally:
        link_title_store.reset()
        connection.close()

    rendered = state.payloads[HOST_ID]["content"]
    assert '<span class="note-reference-link-title">' in rendered
    assert '<span class="link-title-text">A Useful Video</span>' in rendered
    assert '<span class="link-title-domain"> · youtube.com</span>' in rendered
    assert url not in rendered


def test_link_reference_keeps_inline_url_preview_raw(monkeypatch: pytest.MonkeyPatch) -> None:
    url = "https://www.youtube.com/watch?v=abc123"
    connection = _bootstrap_cached_link_title(url=url, title="A Useful Video")
    try:
        notes = {
            HOST_ID: _Note(HOST_ID, None, None, None, False, f"<div>[[{TARGET_ID}]]</div>", ""),
            TARGET_ID: _Note(TARGET_ID, None, None, None, False, f"<div>Watch {url}</div>", ""),
        }
        state = _state_for(
            monkeypatch=monkeypatch,
            notes=notes,
            children_by_parent={None: [HOST_ID, TARGET_ID]},
        )
    finally:
        link_title_store.reset()
        connection.close()

    rendered = state.payloads[HOST_ID]["content"]
    assert f'<span class="note-reference-link-title">Watch {url}</span>' in rendered
    assert 'class="link-title-text"' not in rendered
    assert "A Useful Video" not in rendered


def test_link_mode_preview_strips_nested_reference_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    nested_ref_id = "69dc0ad7-6ad6-4be9-8ad8-7c30704e5c1a"
    notes = {
        HOST_ID: _Note(HOST_ID, None, None, None, False, f"<div>[[{TARGET_ID}]]</div>", ""),
        TARGET_ID: _Note(
            TARGET_ID,
            None,
            None,
            None,
            False,
            f"<div>blah ![[{nested_ref_id}]]</div><div>linked second line</div>",
            "",
        ),
        nested_ref_id: _Note(nested_ref_id, None, None, None, False, "<div>child</div>", ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID, TARGET_ID, nested_ref_id]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert "note-reference-link-mode" in rendered
    assert "blah" in rendered
    assert nested_ref_id not in rendered


def test_multiple_references_expose_stable_occurrence_indices(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        HOST_ID: _Note(HOST_ID, None, None, None, False, f"<div>[[{TARGET_ID}]] ![[{CHILD_ID}]] [[{TARGET_ID}]]</div>", ""),
        TARGET_ID: _Note(TARGET_ID, None, None, CHILD_ID, False, "<div>B</div>", ""),
        CHILD_ID: _Note(CHILD_ID, None, TARGET_ID, None, False, "<div>C</div>", ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID, TARGET_ID, CHILD_ID]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert rendered.count('data-ref-occurrence="0"') == 1
    assert rendered.count('data-ref-occurrence="1"') == 1
    assert rendered.count('data-ref-occurrence="2"') == 1


def test_edit_mode_keeps_literal_embed_token(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        HOST_ID: _Note(HOST_ID, None, None, TARGET_ID, False, f"<div>![[{TARGET_ID}]]</div>", ""),
        TARGET_ID: _Note(TARGET_ID, None, HOST_ID, None, False, "<div>embedded</div>", ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID, TARGET_ID]},
        editing_note_id=HOST_ID,
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert f"![[{TARGET_ID}]]" in rendered
    assert "note-embed-block" not in rendered


def test_view_mode_marks_inline_image_occurrences_for_context_actions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        HOST_ID: _Note(
            HOST_ID,
            None,
            None,
            None,
            False,
            '<div><img src="one.png"><img src="two.png"></div>',
            "",
        ),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID]},
    )

    rendered = state.payloads[HOST_ID]["content"]
    assert 'data-inline-image-occurrence="0"' in rendered
    assert 'data-inline-image-occurrence="1"' in rendered


def test_edit_mode_keeps_inline_images_free_of_render_only_occurrence_markers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = '<div><img src="one.png"></div>'
    notes = {
        HOST_ID: _Note(HOST_ID, None, None, None, False, content, ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: [HOST_ID]},
        editing_note_id=HOST_ID,
    )

    assert state.payloads[HOST_ID]["content"] == content


def test_embed_host_hash_changes_when_referenced_note_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        HOST_ID: _Note(HOST_ID, None, None, TARGET_ID, False, f"<div>![[{TARGET_ID}]]</div>", ""),
        TARGET_ID: _Note(TARGET_ID, None, HOST_ID, None, False, "<div>before</div>", ""),
    }
    children_by_parent = {None: [HOST_ID, TARGET_ID]}
    state_one = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent=children_by_parent,
    )
    first_hash = state_one.payloads[HOST_ID]["hash"]

    notes[TARGET_ID].content = "<div>after</div>"
    state_two = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent=children_by_parent,
    )
    second_hash = state_two.payloads[HOST_ID]["hash"]

    assert first_hash != second_hash
