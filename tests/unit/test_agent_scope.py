from __future__ import annotations

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.services.agent.cloud_privacy import CloudPrivacyBoundary
from app.services.agent.cloud_privacy import CloudPrivacyEvaluator
from app.services.agent.cloud_privacy import CloudPrivacyPolicy
from app.services.agent.cloud_privacy import EMPTY_CLOUD_PRIVACY_POLICY
from app.services.agent.scope import AgentScopeDescriptor
from app.services.agent.scope import ScopedSearchSnapshotFactory
from app.services.note_store import NoteRecord
from app.services.snapshot import ResolvedViewScope


class _FakeNotes:
    def __init__(self) -> None:
        timestamp = datetime(2026, 8, 29, tzinfo=timezone.utc)
        self.records = {
            "root": NoteRecord(
                id="root",
                parent_id=None,
                prev_id=None,
                next_id=None,
                is_collapsed=False,
                content="<p>Root heading</p>",
                tags="project-foo",
                proposed_tags="",
                tag_terms=frozenset({"project-foo"}),
                non_meta_tag_terms=frozenset({"project-foo"}),
                proposed_tag_terms=frozenset(),
                proposed_non_meta_tag_terms=frozenset(),
                created_at=timestamp,
                updated_at=timestamp,
            ),
            "match": NoteRecord(
                id="match",
                parent_id="root",
                prev_id=None,
                next_id="gray",
                is_collapsed=False,
                content="<p>lorem ipsum evidence</p>",
                tags="rare-tag useful-tag",
                proposed_tags="machine-learning",
                tag_terms=frozenset({"useful-tag", "rare-tag"}),
                non_meta_tag_terms=frozenset({"useful-tag", "rare-tag"}),
                proposed_tag_terms=frozenset({"machine-learning"}),
                proposed_non_meta_tag_terms=frozenset({"machine-learning"}),
                created_at=timestamp,
                updated_at=timestamp,
            ),
            "gray": NoteRecord(
                id="gray",
                parent_id="root",
                prev_id="match",
                next_id="secret",
                is_collapsed=False,
                content="<p>gray bar text</p>",
                tags="gray-exclusive",
                proposed_tags="",
                tag_terms=frozenset({"gray-exclusive"}),
                non_meta_tag_terms=frozenset({"gray-exclusive"}),
                proposed_tag_terms=frozenset(),
                proposed_non_meta_tag_terms=frozenset(),
                created_at=timestamp,
                updated_at=timestamp,
            ),
            "secret": NoteRecord(
                id="secret",
                parent_id="root",
                prev_id="gray",
                next_id=None,
                is_collapsed=False,
                content="<p>credential value</p>",
                tags="@password secret-exclusive",
                proposed_tags="",
                tag_terms=frozenset({"@password", "secret-exclusive"}),
                non_meta_tag_terms=frozenset({"secret-exclusive"}),
                proposed_tag_terms=frozenset(),
                proposed_non_meta_tag_terms=frozenset(),
                created_at=timestamp,
                updated_at=timestamp,
            ),
            "secret-child": NoteRecord(
                id="secret-child",
                parent_id="secret",
                prev_id=None,
                next_id=None,
                is_collapsed=False,
                content="<p>descendant credential context</p>",
                tags="public-looking",
                proposed_tags="",
                tag_terms=frozenset({"public-looking"}),
                non_meta_tag_terms=frozenset({"public-looking"}),
                proposed_tag_terms=frozenset(),
                proposed_non_meta_tag_terms=frozenset(),
                created_at=timestamp,
                updated_at=timestamp,
            ),
        }
        self.children = {
            "": ["root"],
            "root": ["match", "gray", "secret"],
            "match": [],
            "gray": [],
            "secret": ["secret-child"],
            "secret-child": [],
        }

    def get_note(self, note_id: str) -> NoteRecord:
        return self.records[note_id]

    def get_children(self, parent_id: str | None) -> list[str]:
        key = ""
        if parent_id is not None:
            key = parent_id
        return list(self.children[key])

    def has_note(self, note_id: str) -> bool:
        return note_id in self.records

    def list_note_ids(self) -> list[str]:
        return list(self.records)


def _descriptor() -> AgentScopeDescriptor:
    return AgentScopeDescriptor(
        scope_kind="search",
        active_tab_id="tab-1",
        scope_tab_id="tab-1",
        search_query="useful-tag",
        sort_mode="normal",
        date_filter_active=False,
        date_filter_metric="",
        date_filter_start="",
        date_filter_end="",
        reference_root_ids=[],
        label="useful-tag",
    )


def _local_privacy_boundary() -> CloudPrivacyBoundary:
    return CloudPrivacyBoundary(
        provider="ollama",
        apply_cloud_policy=False,
        policy=EMPTY_CLOUD_PRIVACY_POLICY,
    )


def _cloud_privacy_boundary(policy: CloudPrivacyPolicy) -> CloudPrivacyBoundary:
    return CloudPrivacyBoundary(
        provider="openai",
        apply_cloud_policy=True,
        policy=policy,
    )


def _factory(notes: _FakeNotes, resolver) -> ScopedSearchSnapshotFactory:
    return ScopedSearchSnapshotFactory(
        notes=notes,
        view_scope_resolver=resolver,
        privacy_evaluator=CloudPrivacyEvaluator(
            notes=notes,
            effective_tags_provider=lambda note_id: notes.records[note_id].tag_terms,
        ),
    )


def test_scope_descriptor_requires_all_flat_fields() -> None:
    payload = _descriptor().model_dump()
    del payload["active_tab_id"]

    with pytest.raises(ValidationError):
        AgentScopeDescriptor.model_validate(payload)


def test_scope_descriptor_requires_originating_scope_tab() -> None:
    payload = _descriptor().model_dump()
    del payload["scope_tab_id"]

    with pytest.raises(ValidationError):
        AgentScopeDescriptor.model_validate(payload)


def test_scope_descriptor_rejects_all_notes_with_search_text() -> None:
    payload = _descriptor().model_dump()
    payload["scope_kind"] = "all_notes"

    with pytest.raises(ValidationError, match="all_notes requires empty search_query"):
        AgentScopeDescriptor.model_validate(payload)


def test_frozen_scope_uses_matches_not_render_only_ancestors_or_gray_bars() -> None:
    resolved = ResolvedViewScope(
        filter_active=True,
        allowed_note_ids=frozenset({"root", "match"}),
        matched_note_ids=frozenset({"match"}),
        ordered_root_ids=("root",),
        total_root_count=1,
    )
    notes = _FakeNotes()
    factory = _factory(notes, lambda **_arguments: resolved)

    snapshot = factory.freeze(
        descriptor=_descriptor(),
        authoritative_search_query="useful-tag",
        authoritative_sort_mode="normal",
        authoritative_date_filter={},
        run_id="run-1",
        session_key="session-1",
        privacy_boundary=_local_privacy_boundary(),
    )

    assert snapshot.ordered_note_ids == ("match",)
    assert set(snapshot.notes_by_id) == {"match"}
    assert tuple(snapshot.tree_nodes_by_id) == ("root", "match")
    assert snapshot.tree_nodes_by_id["root"].child_ids == ("match",)
    assert snapshot.notes_by_id["match"].explicit_tag_terms == (
        "rare-tag",
        "useful-tag",
    )
    assert snapshot.notes_by_id["match"].proposed_tags_text == "machine-learning"
    assert snapshot.notes_by_id["match"].proposed_tag_terms == ("machine-learning",)


def test_frozen_scope_excludes_protected_notes_and_their_tags() -> None:
    resolved = ResolvedViewScope(
        filter_active=False,
        allowed_note_ids=frozenset(
            {"root", "match", "gray", "secret", "secret-child"}
        ),
        matched_note_ids=frozenset(
            {"root", "match", "gray", "secret", "secret-child"}
        ),
        ordered_root_ids=("root",),
        total_root_count=1,
    )
    descriptor = _descriptor().model_copy(
        update={"scope_kind": "all_notes", "search_query": "", "label": "All notes"}
    )
    notes = _FakeNotes()
    factory = _factory(notes, lambda **_arguments: resolved)

    snapshot = factory.freeze(
        descriptor=descriptor,
        authoritative_search_query="",
        authoritative_sort_mode="normal",
        authoritative_date_filter={},
        run_id="run-1",
        session_key="session-1",
        privacy_boundary=_local_privacy_boundary(),
    )

    assert "secret" not in snapshot.notes_by_id
    assert "secret-child" not in snapshot.notes_by_id
    assert snapshot.ordered_note_ids == ("root", "match", "gray")


def test_frozen_cloud_scope_filters_notes_before_counts_and_tree_payload() -> None:
    resolved = ResolvedViewScope(
        filter_active=False,
        allowed_note_ids=frozenset({"root", "match", "gray"}),
        matched_note_ids=frozenset({"root", "match", "gray"}),
        ordered_root_ids=("root",),
        total_root_count=1,
    )
    notes = _FakeNotes()
    factory = ScopedSearchSnapshotFactory(
        notes=notes,
        view_scope_resolver=lambda **_arguments: resolved,
        privacy_evaluator=CloudPrivacyEvaluator(
            notes=notes,
            effective_tags_provider=lambda note_id: notes.records[note_id].tag_terms,
        ),
    )
    descriptor = _descriptor().model_copy(
        update={"scope_kind": "all_notes", "search_query": "", "label": "All notes"}
    )
    policy = CloudPrivacyPolicy(
        whitelist_tags=(),
        whitelist_phrases=(),
        blacklist_tags=("gray-exclusive",),
        blacklist_phrases=(),
    )

    snapshot = factory.freeze(
        descriptor=descriptor,
        authoritative_search_query="",
        authoritative_sort_mode="normal",
        authoritative_date_filter={},
        run_id="run-cloud",
        session_key="session-cloud",
        privacy_boundary=_cloud_privacy_boundary(policy),
    )

    assert snapshot.note_count == 2
    assert snapshot.result_tree_count == 1
    assert snapshot.ordered_note_ids == ("root", "match")
    assert "gray" not in snapshot.notes_by_id
    assert "gray" not in snapshot.tree_nodes_by_id


def test_frozen_scope_rejects_stale_client_view_state() -> None:
    notes = _FakeNotes()
    factory = _factory(
        notes,
        lambda **_arguments: pytest.fail("resolver must not run"),
    )

    with pytest.raises(ValueError, match="search query changed before Send"):
        factory.freeze(
            descriptor=_descriptor(),
            authoritative_search_query="different-tag",
            authoritative_sort_mode="normal",
            authoritative_date_filter={},
            run_id="run-1",
            session_key="session-1",
            privacy_boundary=_local_privacy_boundary(),
        )


def test_scope_descriptor_rejects_spoofed_label() -> None:
    payload = _descriptor().model_dump()
    payload["label"] = "Something else"

    with pytest.raises(ValidationError, match="label must equal search_query"):
        AgentScopeDescriptor.model_validate(payload)


def test_cloud_privacy_whitelist_uses_or_semantics_and_blacklist_wins() -> None:
    notes = _FakeNotes()
    evaluator = CloudPrivacyEvaluator(
        notes=notes,
        effective_tags_provider=lambda note_id: notes.records[note_id].tag_terms,
    )
    policy = CloudPrivacyPolicy(
        whitelist_tags=("project-foo", "useful-tag"),
        whitelist_phrases=("gray bar",),
        blacklist_tags=("rare-tag",),
        blacklist_phrases=(),
    )
    hidden = evaluator.hidden_note_ids(
        note_ids=("match", "gray"),
        boundary=_cloud_privacy_boundary(policy),
    )

    assert hidden == frozenset({"match"})


def test_cloud_privacy_hidden_ancestor_hides_whitelisted_descendant() -> None:
    notes = _FakeNotes()
    evaluator = CloudPrivacyEvaluator(
        notes=notes,
        effective_tags_provider=lambda note_id: notes.records[note_id].tag_terms,
    )
    policy = CloudPrivacyPolicy(
        whitelist_tags=("useful-tag",),
        whitelist_phrases=(),
        blacklist_tags=(),
        blacklist_phrases=(),
    )

    hidden = evaluator.hidden_note_ids(
        note_ids=("match",),
        boundary=_cloud_privacy_boundary(policy),
    )

    assert hidden == frozenset({"match"})


def test_cloud_privacy_uses_effective_inherited_and_ontology_tags() -> None:
    notes = _FakeNotes()
    effective_tags = {
        "root": frozenset({"project-foo", "NN", "neural-network"}),
        "match": frozenset(
            {"project-foo", "NN", "neural-network", "useful-tag", "rare-tag"}
        ),
    }
    evaluator = CloudPrivacyEvaluator(
        notes=notes,
        effective_tags_provider=lambda note_id: effective_tags[note_id],
    )
    policy = CloudPrivacyPolicy(
        whitelist_tags=(),
        whitelist_phrases=(),
        blacklist_tags=("neural-network",),
        blacklist_phrases=(),
    )

    hidden = evaluator.hidden_note_ids(
        note_ids=("match",),
        boundary=_cloud_privacy_boundary(policy),
    )

    assert hidden == frozenset({"match"})
