from __future__ import annotations

from types import MappingProxyType
from dataclasses import replace
from app.services.agent import investigation

import pytest

from app.services.agent.investigation import InvestigationState
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.scope import AgentScopeDescriptor, NO_SELECTED_NOTE
from app.services.agent.scope import FrozenScopedNote
from app.services.agent.scope import NoteText
from app.services.agent.scope import FrozenScopedTreeNode
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.scope import TextExtractionMeter


def _note(
    note_id: str,
    root_note_id: str,
    content: str,
    explicit_tags: tuple[str, ...],
    order_index: int,
) -> FrozenScopedNote:
    parent_id = root_note_id
    if note_id == root_note_id:
        parent_id = ""
    return FrozenScopedNote(
        note_id=note_id,
        parent_id=parent_id,
        root_note_id=root_note_id,
        note_text=NoteText.from_text(content),
        explicit_tags_text=" ".join(explicit_tags),
        explicit_tag_terms=explicit_tags,
        proposed_tags_text="",
        proposed_tag_terms=(),
        created_at="2026-08-29T00:00:00+00:00",
        updated_at="2026-08-29T00:00:00+00:00",
        order_index=order_index,
    )


def _descriptor() -> AgentScopeDescriptor:
    return AgentScopeDescriptor(
        scope_kind="all_notes",
        active_tab_id="tab-1",
        scope_tab_id="tab-1",
        search_query="",
        sort_mode="normal",
        reference_root_ids=[],
        label="All notes",
    )


def _snapshot(*, oversized_first_root: bool) -> ScopedSearchSnapshot:
    first_content = "alpha"
    if oversized_first_root:
        first_content = "alpha " * 20_000
    notes = {
        "a": _note("a", "a", first_content, ("foo",), 0),
        "a-child": _note("a-child", "a", "complete child content", ("bar",), 1),
        "b": _note("b", "b", "second root", (), 2),
        "c": _note("c", "c", "large trailing root " + ("! " * 8_000), (), 3),
    }
    nodes = {
        "a": FrozenScopedTreeNode(
            note_id="a",
            parent_id="",
            root_note_id="a",
            child_ids=("a-child",),
        ),
        "a-child": FrozenScopedTreeNode(
            note_id="a-child",
            parent_id="a",
            root_note_id="a",
            child_ids=(),
        ),
        "b": FrozenScopedTreeNode(
            note_id="b",
            parent_id="",
            root_note_id="b",
            child_ids=(),
        ),
        "c": FrozenScopedTreeNode(
            note_id="c",
            parent_id="",
            root_note_id="c",
            child_ids=(),
        ),
    }
    return ScopedSearchSnapshot(
        run_id="run-1",
        session_key="session-1",
        descriptor=_descriptor(),
        created_at="2026-08-29T00:00:00+00:00",
        ordered_root_ids=("a", "b", "c"),
        ordered_note_ids=("a", "a-child", "b", "c"),
        notes_by_id=MappingProxyType(notes),
        tree_nodes_by_id=MappingProxyType(nodes),
        note_records_at_send=MappingProxyType({}),
        disclosable_search_query=_descriptor().search_query,
        date_filter=None,
        preparation_ms=0.0, text_extraction=TextExtractionMeter.start(),
        selected_note=NO_SELECTED_NOTE,
    )


def test_single_payload_contains_full_nested_notes_without_per_note_limit() -> None:
    state = InvestigationState.start(
        snapshot=_snapshot(oversized_first_root=False),
        settings=AgentRetrievalSettings(max_page_approximate_tokens=24_000),
    )
    retention = state.retain_root_prefix_within_token_budget(reserved_approximate_tokens=0)
    payload = state.current_scope_payload()

    assert retention.retained_root_ids == ("a", "b", "c")
    assert payload.result_tree_ids == ("a", "b", "c")
    assert payload.evidence_note_ids == ("a", "a-child", "b", "c")
    assert payload.result_trees[0]["content_text"] == "alpha"
    assert payload.result_trees[0]["children"][0]["content_text"] == (
        "complete child content"
    )


def test_token_budget_keeps_only_a_leading_prefix_of_complete_roots() -> None:
    state = InvestigationState.start(
        snapshot=_snapshot(oversized_first_root=False),
        settings=AgentRetrievalSettings(max_page_approximate_tokens=500),
    )
    retention = state.retain_root_prefix_within_token_budget(reserved_approximate_tokens=0)
    payload = state.current_scope_payload()

    assert retention.retained_root_ids == ("a", "b")
    assert retention.dropped_root_ids == ("c",)
    assert payload.result_tree_ids == ("a", "b")
    assert payload.evidence_note_ids == ("a", "a-child", "b")
    assert payload.returned_approximate_token_count <= 500


def test_first_root_larger_than_budget_fails_instead_of_splitting_it() -> None:
    state = InvestigationState.start(
        snapshot=_snapshot(oversized_first_root=True),
        settings=AgentRetrievalSettings(max_page_approximate_tokens=500),
    )
    with pytest.raises(ValueError, match="first complete result tree"):
        state.retain_root_prefix_within_token_budget(reserved_approximate_tokens=0)


def test_complete_scope_batches_preserve_every_root_in_canonical_order() -> None:
    state = InvestigationState.start(
        snapshot=_snapshot(oversized_first_root=False),
        settings=AgentRetrievalSettings(max_page_approximate_tokens=8_200),
    )

    plan = state.plan_complete_root_batches(reserved_approximate_tokens=0)

    assert len(plan.batches) == 2
    assert tuple(
        root_id
        for batch in plan.batches
        for root_id in batch.result_tree_ids
    ) == ("a", "b", "c")
    assert tuple(
        note_id
        for batch in plan.batches
        for note_id in batch.evidence_note_ids
    ) == ("a", "a-child", "b", "c")
    assert all(
        batch.returned_approximate_token_count <= 8_200
        for batch in plan.batches
    )
    assert plan.result_tree_count == 3
    assert plan.note_count == 4


def test_complete_scope_batching_rejects_any_indivisible_oversized_root() -> None:
    state = InvestigationState.start(
        snapshot=_snapshot(oversized_first_root=True),
        settings=AgentRetrievalSettings(max_page_approximate_tokens=500),
    )
    with pytest.raises(ValueError, match="complete result tree a"):
        state.plan_complete_root_batches(reserved_approximate_tokens=0)


def test_payload_requires_exactly_one_prior_retention_pass() -> None:
    state = InvestigationState.start(
        snapshot=_snapshot(oversized_first_root=False),
        settings=AgentRetrievalSettings(max_page_approximate_tokens=24_000),
    )
    with pytest.raises(RuntimeError, match="Retain"):
        state.current_scope_payload()
    state.retain_root_prefix_within_token_budget(reserved_approximate_tokens=0)
    with pytest.raises(RuntimeError, match="only once"):
        state.retain_root_prefix_within_token_budget(reserved_approximate_tokens=0)


@pytest.mark.parametrize('root_count', [1000, 2000])
def test_root_retention_visits_structure_once(root_count, monkeypatch):
    class CountedNodes(dict):
        visits = 0
        def items(self):
            for entry in super().items():
                self.visits += 1
                yield entry
    roots = tuple(str(index) for index in range(root_count))
    notes = {root: _note(root, root, 'content', (), index) for index, root in enumerate(roots)}
    nodes = CountedNodes({root: FrozenScopedTreeNode(note_id=root, parent_id='', root_note_id=root, child_ids=()) for root in roots})
    snapshot = replace(_snapshot(oversized_first_root=False), ordered_root_ids=roots, ordered_note_ids=roots,
                       notes_by_id=notes, tree_nodes_by_id=nodes)
    monkeypatch.setattr(investigation, 'estimate_cached_root_tree_tokens', lambda **kwargs: 1)
    state = InvestigationState.start(snapshot=snapshot, settings=AgentRetrievalSettings(max_page_approximate_tokens=24000))
    assert state.retain_root_prefix_within_token_budget(reserved_approximate_tokens=0).retained_root_ids == roots
    assert nodes.visits == root_count
