from __future__ import annotations

from types import MappingProxyType

import pytest

from app.services.agent.investigation import InvestigationState
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.scope import AgentScopeDescriptor
from app.services.agent.scope import FrozenScopedNote
from app.services.agent.scope import FrozenScopedTreeNode
from app.services.agent.scope import ScopedSearchSnapshot


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
        content_text=content,
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
        date_filter_active=False,
        date_filter_metric="",
        date_filter_start="",
        date_filter_end="",
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
    )


def test_single_payload_contains_full_nested_notes_without_per_note_limit() -> None:
    state = InvestigationState.start(
        snapshot=_snapshot(oversized_first_root=False),
        settings=AgentRetrievalSettings(max_page_approximate_tokens=24_000),
    )
    retention = state.retain_root_prefix_within_token_budget()
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
    retention = state.retain_root_prefix_within_token_budget()
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
        state.retain_root_prefix_within_token_budget()


def test_payload_requires_exactly_one_prior_retention_pass() -> None:
    state = InvestigationState.start(
        snapshot=_snapshot(oversized_first_root=False),
        settings=AgentRetrievalSettings(max_page_approximate_tokens=24_000),
    )
    with pytest.raises(RuntimeError, match="Retain"):
        state.current_scope_payload()
    state.retain_root_prefix_within_token_budget()
    with pytest.raises(RuntimeError, match="only once"):
        state.retain_root_prefix_within_token_budget()
