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
        "is_content_collapsible",
        lambda *, content_html, context: False,
    )
    monkeypatch.setattr(
        snapshot_module,
        "render_note_content_with_embeds",
        lambda **kwargs: kwargs["content_html"],
    )

    state = snapshot_module.build_view_state(
        editing_note_id=None, find_reveal_note_id=None,
        search=None,
        sort_mode="normal", date_filter=None,
        client_known_note_ids=set(), previous_root_ids=[],
        visible_top_root_id=None,
        visible_bottom_root_id=None,
        is_untagged_view=False,
        start_at_list_end=False,
    )

    assert len(state.structure) == note_count
    assert store.get_children_calls == note_count + 1
    assert store.get_note_calls == note_count


def _band(*, count, known, top, bottom, editing):
    roots = [f"root-{index}" for index in range(count)]
    index_map = {root_id: index for index, root_id in enumerate(roots)}
    top_id = None
    if top is not None:
        top_id = f"root-{top}"
    bottom_id = None
    if bottom is not None:
        bottom_id = f"root-{bottom}"
    return snapshot_module._determine_root_band(
        ordered_root_ids=roots, root_index_map=index_map,
        client_known_note_ids={f"root-{index}" for index in known},
        visible_top_root_id=top_id, visible_bottom_root_id=bottom_id,
        editing_root_index=editing, start_at_list_end=False,
    )


def test_band_starts_at_top_without_viewport_or_warm_view():
    margin = snapshot_module.ROOT_BAND_MARGIN
    assert _band(count=1000, known=(), top=None, bottom=None, editing=None) == (0, margin)
    assert _band(count=10, known=(), top=None, bottom=None, editing=None) == (0, 9)
    assert _band(count=0, known=(), top=None, bottom=None, editing=None) == (0, -1)


def test_band_surrounds_visible_roots_by_margin():
    margin = snapshot_module.ROOT_BAND_MARGIN
    assert _band(count=1000, known=(), top=500, bottom=504, editing=None) == (500 - margin, 504 + margin)
    assert _band(count=1000, known=(), top=3, bottom=5, editing=None) == (0, 5 + margin)
    assert _band(count=520, known=(), top=500, bottom=510, editing=None) == (500 - margin, 519)


def test_band_edges_stay_put_while_viewport_moves_inside():
    # Both edges are between half and twice the margin from the visible roots.
    assert _band(count=1000, known=range(400, 601), top=480, bottom=484, editing=None) == (400, 600)


def test_band_edge_moves_out_when_viewport_nears_it():
    margin = snapshot_module.ROOT_BAND_MARGIN
    # The bottom edge is within half the margin of the viewport, so it moves out;
    # the top edge is still within twice the margin, so it stays.
    assert _band(count=1000, known=range(430, 601), top=580, bottom=584, editing=None) == (430, 584 + margin)


def test_band_unloads_edge_left_far_behind():
    margin = snapshot_module.ROOT_BAND_MARGIN
    # The top edge is more than twice the margin above the viewport: pull it in.
    assert _band(count=1000, known=range(400, 661), top=580, bottom=584, editing=None) == (580 - margin, 660)


def test_band_far_jump_rebuilds_around_viewport():
    margin = snapshot_module.ROOT_BAND_MARGIN
    assert _band(count=1000, known=range(0, 150), top=800, bottom=805, editing=None) == (800 - margin, 805 + margin)


def test_band_keeps_warm_window_when_visible_roots_are_unknown():
    assert _band(count=1000, known=range(300, 451), top=None, bottom=None, editing=None) == (300, 450)
    # Visible roots that no longer exist count as unknown.
    roots = [f"root-{index}" for index in range(1000)]
    index_map = {root_id: index for index, root_id in enumerate(roots)}
    assert snapshot_module._determine_root_band(
        ordered_root_ids=roots, root_index_map=index_map,
        client_known_note_ids={f"root-{index}" for index in range(300, 451)},
        visible_top_root_id="deleted-root", visible_bottom_root_id="deleted-root",
        editing_root_index=None, start_at_list_end=False,
    ) == (300, 450)


def test_band_recentres_on_edited_root_outside_it():
    margin = snapshot_module.ROOT_BAND_MARGIN
    assert _band(count=1000, known=range(400, 601), top=480, bottom=484, editing=0) == (0, margin)


def _band_at_list_end(*, count, known, top):
    roots = [f"root-{index}" for index in range(count)]
    index_map = {root_id: index for index, root_id in enumerate(roots)}
    top_id = None
    if top is not None:
        top_id = f"root-{top}"
    return snapshot_module._determine_root_band(
        ordered_root_ids=roots, root_index_map=index_map,
        client_known_note_ids={f"root-{index}" for index in known},
        visible_top_root_id=top_id, visible_bottom_root_id=top_id,
        editing_root_index=None, start_at_list_end=True,
    )


def test_go_to_bottom_loads_the_band_ending_at_the_last_root():
    margin = snapshot_module.ROOT_BAND_MARGIN
    # Whatever was loaded and seen before, the band ends at the last root.
    assert _band_at_list_end(count=1000, known=range(0, 150), top=20) == (999 - margin, 999)
    assert _band_at_list_end(count=1000, known=(), top=None) == (999 - margin, 999)
    # A short list is loaded whole.
    assert _band_at_list_end(count=10, known=(), top=None) == (0, 9)
    assert _band_at_list_end(count=0, known=(), top=None) == (0, -1)
