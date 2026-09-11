from datetime import datetime, timezone
from types import SimpleNamespace

import app.services.snapshot as snapshot_module


class _CountingChainStore:
    def __init__(self, note_count: int) -> None:
        self.get_children_calls = 0
        self.get_note_calls = 0
        self._records = {}
        self._children = {None: ["note-0"]}
        timestamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for index in range(note_count):
            note_id = f"note-{index}"
            if index == 0:
                parent_id = None
            else:
                parent_id = f"note-{index - 1}"
            if index == note_count - 1:
                child_ids = []
            else:
                child_ids = [f"note-{index + 1}"]
            self._children[note_id] = child_ids
            self._records[note_id] = SimpleNamespace(
                id=note_id,
                parent_id=parent_id,
                is_collapsed=False,
                content=f"<p>{note_id}</p>",
                tags="",
                proposed_tags="",
                proposed_tag_terms=frozenset(),
                created_at=timestamp,
                updated_at=timestamp,
            )

    def get_children(self, parent_id):
        self.get_children_calls += 1
        return list(self._children[parent_id])

    def get_note(self, note_id):
        self.get_note_calls += 1
        return self._records[note_id]

    def has_backlinks(self, note_id: str) -> bool:
        return False

    def has_note(self, note_id):
        return note_id in self._records

    def get_inherited_non_meta_tag_terms(self, note_id):
        assert note_id in self._records
        return frozenset()


def test_snapshot_reads_each_hierarchy_branch_once(monkeypatch):
    note_count = 24
    store = _CountingChainStore(note_count)
    monkeypatch.setattr(snapshot_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "get_all_locks", lambda: {})
    monkeypatch.setattr(
        snapshot_module,
        "extract_collapsed_preview_source_html",
        lambda _content: "",
    )
    monkeypatch.setattr(
        snapshot_module,
        "render_note_content_with_embeds",
        lambda **kwargs: kwargs["content_html"],
    )

    state = snapshot_module.build_view_state(
        editing_note_id=None,
        search=None,
        sort_mode="normal",
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )

    assert len(state.structure) == note_count
    assert store.get_children_calls == note_count + 1
    assert store.get_note_calls == note_count


def test_stale_anchor_extends_from_last_known_root():
    ordered_root_ids = [f"root-{index}" for index in range(120)]
    root_index_map = {
        root_id: index
        for index, root_id in enumerate(ordered_root_ids)
    }

    window_end = snapshot_module._determine_root_window_end(
        ordered_root_ids=ordered_root_ids,
        root_index_map=root_index_map,
        client_known_note_ids={"root-49"},
        seen_root_indices=set(),
        editing_note_id=None,
        anchor_root_id="deleted-root",
    )

    assert window_end == 99
