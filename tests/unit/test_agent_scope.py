from __future__ import annotations

from datetime import datetime, timezone
from dataclasses import replace

import pytest
from pydantic import ValidationError

from app.services import snapshot as view_snapshot
import app.services.agent.scope as scope_module
from app.services.agent.context import AgentContextBuilder
from app.services.agent.note_aliases import NoteAliases
from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS
from app.services.agent.web_settings import DEFAULT_AGENT_WEB_SETTINGS
from app.services.agent.cloud_privacy import CloudPrivacyBoundary
from app.services.agent.cloud_privacy import CloudPrivacyEvaluator
from app.services.agent.cloud_privacy import CloudPrivacyPolicy
from app.services.agent.cloud_privacy import EMPTY_CLOUD_PRIVACY_POLICY
from app.services.agent.scope import AgentScopeDescriptor
from app.services.agent.scope import ScopedSearchSnapshotFactory
from app.services.note_store import NoteRecord
from app.services.content_formatting import extract_note_text_for_agent
from app.services.link_titles import link_title_store
from app.services.search_index import SearchIndex, SearchRecord
from app.services.snapshot import ResolvedViewScope


# What the model is told about a selected note it cannot see: a coarse reason
# and the same in plain words (never which privacy setting hides it).
_UNAVAILABLE_DESCRIPTIONS = {
    "private": "The user is editing a note you cannot see: they keep it private from the AI.",
    "search_redacted": "The user is editing a note you cannot see: it is excluded by the current search.",
    "not_found": "The note the user had selected no longer exists.",
}


def _unavailable(reason: str) -> dict[str, object]:
    return {"status": "unavailable", "has_selection": True, "reason": reason,
            "description": _UNAVAILABLE_DESCRIPTIONS[reason]}



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
        reference_root_ids=[],
        label="useful-tag",
    )


def _local_privacy_boundary() -> CloudPrivacyBoundary:
    return CloudPrivacyBoundary(
        provider="openai",
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
            accepted_tags_provider=lambda note_id: notes.records[note_id].tag_terms,
        ),
    )


def test_scope_descriptor_requires_all_flat_fields() -> None:
    payload = _descriptor().model_dump()
    del payload["active_tab_id"]

    with pytest.raises(ValidationError):
        AgentScopeDescriptor.model_validate(payload)


@pytest.mark.parametrize("selected_id,expected", [
    ("", "none"), ("match", "available"), ("secret", "unavailable"),
    ("secret-child", "unavailable"), ("gray", "unavailable"), ("missing", "unavailable"),
])
def test_selected_note_is_frozen_and_privacy_filtered(selected_id, expected) -> None:
    notes = _FakeNotes()
    ids = frozenset({"match", "secret", "secret-child"})
    resolved = ResolvedViewScope(filter_active=True, allowed_note_ids=ids | {"root"},
        matched_note_ids=ids, ordered_root_ids=("root",), total_root_count=1)
    snapshot = _factory(notes, lambda **kwargs: resolved).freeze(
        authoritative_active_search_query="useful-tag",
        authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        descriptor=_descriptor(), authoritative_search_query="useful-tag", authoritative_sort_mode="normal", authoritative_date_filter=None,
        run_id="selected-run", session_key="session-1", privacy_boundary=_local_privacy_boundary(),
        selected_note_id=selected_id,
    )
    selected = snapshot.selected_note
    assert selected.status == expected
    if expected == "available":
        notes.records["match"] = replace(notes.records["match"], content="Changed later")
        assert next(n for n in selected.tree_notes if n.note_id == "match").content_text == "lorem ipsum evidence"
        assert selected.reference_note_ids == ("root", "match")
    else:
        payload = {"status": expected, "has_selection": selected_id != ""}
        if expected == "unavailable":
            # The model sees only "private"; the specific setting stays internal.
            payload = _unavailable({"secret": "private", "secret-child": "private",
                "gray": "search_redacted", "missing": "not_found"}[selected_id])
            assert selected.unavailable_reason == {"secret": "password_protected", "secret-child": "password_protected",
                "gray": "search_redacted", "missing": "not_found"}[selected_id]
        assert selected.as_payload() == payload
        assert selected.reference_note_ids == ()


def test_selected_note_in_reference_view_does_not_expand_origin_scope() -> None:
    notes = _FakeNotes()
    def resolve(*, search, **kwargs):
        ids = frozenset({"gray" if search == "gray" else "match"})
        return ResolvedViewScope(filter_active=True, allowed_note_ids=ids | {"root"},
            matched_note_ids=ids, ordered_root_ids=("root",), total_root_count=1)
    snapshot = _factory(notes, resolve).freeze(
        descriptor=_descriptor().model_copy(update={"active_tab_id": "reference-tab"}),
        authoritative_search_query="useful-tag", authoritative_sort_mode="normal", authoritative_date_filter=None,
        authoritative_active_search_query="gray", authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        run_id="selected-run", session_key="session-1", privacy_boundary=_local_privacy_boundary(),
        selected_note_id="gray",
    )
    assert snapshot.ordered_note_ids == ("match",)
    assert snapshot.selected_note.note_id == "gray"
    assert next(n for n in snapshot.selected_note.tree_notes if n.note_id == "gray").content_text == "gray bar text"
    assert snapshot.selected_note.reference_note_ids == ("root", "gray")


@pytest.mark.parametrize("restriction", ["search", "blacklist"])
def test_cached_titles_are_frozen_with_parent_and_never_read_for_excluded_notes(monkeypatch, restriction):
    notes = _FakeNotes()
    notes.records["root"] = replace(notes.records["root"], content="https://example.test/paper")
    notes.records["gray"] = replace(notes.records["gray"], content="https://private.test/hidden")
    titles = {"https://example.test/paper": "Do Transformers Need Three Projections?"}
    lookups = []
    def lookup(url):
        assert url != "https://private.test/hidden", "Excluded URL cannot reach the title cache"
        lookups.append(url)
        return titles[url]
    monkeypatch.setattr(link_title_store, "get_ok_title", lookup)
    ids = frozenset({"root", "match"})
    boundary = _local_privacy_boundary()
    if restriction == "blacklist":
        ids |= {"gray"}
        boundary = _cloud_privacy_boundary(CloudPrivacyPolicy(whitelist_tags=(), whitelist_phrases=(),
            blacklist_tags=("gray-exclusive",), blacklist_phrases=()))
    resolved = ResolvedViewScope(filter_active=True, allowed_note_ids=ids,
        matched_note_ids=ids, ordered_root_ids=("root",), total_root_count=1)
    snapshot = _factory(notes, lambda **kwargs: resolved).freeze(
        descriptor=_descriptor(), authoritative_search_query="useful-tag", authoritative_sort_mode="normal", authoritative_date_filter=None,
        authoritative_active_search_query="useful-tag", authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        run_id="selected-run", session_key="session-1", privacy_boundary=boundary, selected_note_id="match")
    assert lookups
    payload = snapshot.selected_note.as_payload()
    assert "Do Transformers Need Three Projections?" in str(payload)
    assert "Do Transformers Need Three Projections?" in snapshot.notes_by_id["root"].content_text
    assert payload["note_id"] == "match"
    assert "private.test" not in str(payload)
    titles["https://example.test/paper"] = "Changed after Send"
    assert snapshot.selected_note.as_payload() == payload


def test_selected_note_respects_cloud_blacklist() -> None:
    notes = _FakeNotes()
    ids = frozenset({"match"})
    resolved = ResolvedViewScope(filter_active=True, allowed_note_ids=ids | {"root"},
        matched_note_ids=ids, ordered_root_ids=("root",), total_root_count=1)
    policy = CloudPrivacyPolicy(whitelist_tags=(), whitelist_phrases=(),
        blacklist_tags=("useful-tag",), blacklist_phrases=())
    snapshot = _factory(notes, lambda **kwargs: resolved).freeze(
        authoritative_active_search_query="useful-tag",
        authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        descriptor=_descriptor(), authoritative_search_query="useful-tag", authoritative_sort_mode="normal", authoritative_date_filter=None,
        run_id="selected-run", session_key="session-1", privacy_boundary=_cloud_privacy_boundary(policy),
        selected_note_id="match",
    )
    assert snapshot.selected_note.as_payload() == _unavailable("private")
    assert snapshot.selected_note.unavailable_reason == "blacklisted"


@pytest.mark.parametrize("tags,phrases,whitelist,reason", [
    (("project-foo",), (), (), "blacklisted"),
    ((), ("root heading",), (), "blacklisted"),
    ((), (), ("unmatched",), "not_whitelisted"),
    (("useful-tag",), (), ("unmatched",), "blacklisted"),
])
def test_selected_block_reason_includes_ancestors_without_exposing_rule(tags, phrases, whitelist, reason):
    notes = _FakeNotes()
    ids = frozenset(notes.records)
    resolved = ResolvedViewScope(filter_active=True, allowed_note_ids=ids,
        matched_note_ids=ids, ordered_root_ids=("root",), total_root_count=1)
    boundary = _cloud_privacy_boundary(CloudPrivacyPolicy(whitelist_tags=whitelist, whitelist_phrases=(),
        blacklist_tags=tags, blacklist_phrases=phrases))
    snapshot = _factory(notes, lambda **kwargs: resolved).freeze(
        descriptor=_descriptor(), authoritative_search_query="useful-tag", authoritative_sort_mode="normal", authoritative_date_filter=None,
        authoritative_active_search_query="useful-tag", authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        run_id="selected-run", session_key="session-1", privacy_boundary=boundary, selected_note_id="match")
    assert snapshot.selected_note.as_payload() == _unavailable("private")
    assert snapshot.selected_note.unavailable_reason == reason
    assert snapshot.selected_note.reference_note_ids == ()


@pytest.mark.parametrize("selected_id", ["root", "match", "gray"])
@pytest.mark.parametrize("restriction", ["search", "blacklist"])
def test_selected_tree_never_discloses_redacted_children_even_when_selected(selected_id, restriction):
    notes = _FakeNotes()
    notes.records["gray-child"] = replace(notes.records["gray"], id="gray-child", parent_id="gray",
        content="HIDDEN_DESCENDANT_CONTENT", tags="hidden-descendant-tag")
    notes.children.update({"gray": ["gray-child"], "gray-child": []})
    allowed = frozenset(notes.records)
    boundary = _local_privacy_boundary()
    if restriction == "search":
        # Revealing/editing a gray placeholder does not alter server membership.
        allowed -= {"gray", "gray-child"}
    else:
        boundary = _cloud_privacy_boundary(CloudPrivacyPolicy(whitelist_tags=(), whitelist_phrases=(),
            blacklist_tags=("gray-exclusive",), blacklist_phrases=()))
    resolved = ResolvedViewScope(filter_active=True, allowed_note_ids=allowed,
        matched_note_ids=allowed, ordered_root_ids=("root",), total_root_count=1)
    snapshot = _factory(notes, lambda **kwargs: resolved).freeze(
        descriptor=_descriptor(), authoritative_search_query="useful-tag", authoritative_sort_mode="normal", authoritative_date_filter=None,
        authoritative_active_search_query="useful-tag", authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        run_id="selected-run", session_key="session-1", privacy_boundary=boundary, selected_note_id=selected_id)
    payload = snapshot.selected_note.as_payload()
    if selected_id == "gray":
        expected_reason = {"blacklist": "private", "search": "search_redacted"}[restriction]
        assert payload == _unavailable(expected_reason)
        assert snapshot.selected_note.reference_note_ids == ()
    else:
        assert [node["note_id"] for node in payload["tree_notes"]] == ["root", "match"]
        assert [node["note_id"] for node in payload["tree_notes"] if node["is_selected"]] == [selected_id]
        assert snapshot.selected_note.reference_note_ids == ("root", "match")
    for withheld in ("gray", "gray bar text", "gray-exclusive", "HIDDEN_DESCENDANT_CONTENT", "hidden-descendant-tag"):
        assert withheld not in str(payload)
    builder = AgentContextBuilder()
    agent = builder.build_agent_messages(earlier_actions=[], canonical_messages=[{"role": "user", "content": "Summarize the selected note."}],
        skills=DEFAULT_AGENT_SKILLS, web_settings=DEFAULT_AGENT_WEB_SETTINGS, snapshot=snapshot, available_urls=(),
        note_aliases=NoteAliases.from_snapshot(snapshot))
    for messages in (agent,):
        for withheld in ("gray-child", "gray bar text", "gray-exclusive", "HIDDEN_DESCENDANT_CONTENT", "hidden-descendant-tag"):
            assert withheld not in str(messages)


@pytest.mark.parametrize("search", ["useful-tag", "-gray-exclusive", '-"gray bar text"'])
@pytest.mark.parametrize("selected_id", ["root", "match", "gray"])
def test_selection_respects_real_search_membership(monkeypatch, search, selected_id):
    notes = _FakeNotes()
    index = SearchIndex()
    index.rebuild([SearchRecord(note_id=note.id, content_text=note.content, tags=note.tags,
        tag_terms=note.tag_terms) for note in notes.records.values()],
        raw_tag_terms_by_id={note.id: note.tag_terms for note in notes.records.values()},
        progress_update=lambda _: None, progress_interval=1000)
    monkeypatch.setattr(view_snapshot, "note_store", notes)
    monkeypatch.setattr(view_snapshot, "search_index", index)
    snapshot = _factory(notes, view_snapshot.resolve_view_scope_membership).freeze(
        descriptor=_descriptor().model_copy(update={"search_query": search, "label": search}),
        authoritative_search_query=search, authoritative_sort_mode="normal", authoritative_date_filter=None,
        authoritative_active_search_query=search, authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        run_id="selected-run", session_key="session-1", privacy_boundary=_local_privacy_boundary(), selected_note_id=selected_id)
    if selected_id == "gray":
        assert snapshot.selected_note.as_payload() == _unavailable("search_redacted")
    else:
        assert snapshot.selected_note.reference_note_ids == ("root", "match")
        assert [node["note_id"] for node in snapshot.selected_note.as_payload()["tree_notes"] if node["is_selected"]] == [selected_id]


@pytest.mark.parametrize("selected_id", ["root", "match"])
def test_selected_note_includes_entire_containing_tree_and_highlights_editing_node(selected_id):
    notes = _FakeNotes()
    notes.records["match"] = replace(notes.records["match"], content="<p>https://example.test/paper</p>", is_collapsed=True)
    notes.records["abstract"] = replace(notes.records["gray"], id="abstract", parent_id="match",
        content="<p>Shared projections reduce cache memory by half.</p>", tags="abstract", tag_terms=frozenset({"abstract"}))
    notes.records["detail"] = replace(notes.records["gray"], id="detail", parent_id="abstract",
        content="<p>Quality decreases by 3.1 percent.</p>", tags="measurement", tag_terms=frozenset({"measurement"}))
    notes.children.update({"match": ["abstract"], "abstract": ["detail"], "detail": []})
    notes.records["unrelated-root"] = replace(notes.records["root"], id="unrelated-root", content="UNRELATED_CONTENT")
    notes.children["unrelated-root"] = []
    ids = frozenset({"match"})
    resolved = ResolvedViewScope(filter_active=True, allowed_note_ids=frozenset(notes.records),
        matched_note_ids=ids, ordered_root_ids=("root",), total_root_count=1)
    snapshot = _factory(notes, lambda **kwargs: resolved).freeze(
        descriptor=_descriptor(), authoritative_search_query="useful-tag", authoritative_sort_mode="normal", authoritative_date_filter=None,
        authoritative_active_search_query="useful-tag", authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        run_id="selected-run", session_key="session-1", privacy_boundary=_local_privacy_boundary(), selected_note_id=selected_id)
    payload = snapshot.selected_note.as_payload()
    assert payload["root_note_id"] == "root" and payload["note_id"] == selected_id
    assert [node["note_id"] for node in payload["tree_notes"]] == ["root", "match", "abstract", "detail", "gray"]
    by_id = {node["note_id"]: node for node in payload["tree_notes"]}
    assert by_id["root"]["content_text"] == "Root heading"
    assert by_id["root"]["tags"] == "project-foo"
    assert by_id["abstract"]["content_text"] == "Shared projections reduce cache memory by half."
    assert by_id["detail"]["parent_id"] == "abstract"
    assert by_id["detail"]["tags"] == "measurement"
    assert by_id["match"]["tags"] == "rare-tag useful-tag"
    assert by_id["gray"]["content_text"] == "gray bar text"
    assert [node["note_id"] for node in payload["tree_notes"] if node["is_selected"]] == [selected_id]
    assert snapshot.selected_note.reference_note_ids == ("root", "match", "abstract", "detail", "gray")
    assert "UNRELATED_CONTENT" not in str(payload)
    assert snapshot.ordered_note_ids == ("match",)
    notes.records["abstract"] = replace(notes.records["abstract"], content="Changed after Send")
    assert snapshot.selected_note.as_payload() == payload


@pytest.mark.parametrize("cloud_policy", [False, True])
def test_selected_subtree_omits_password_and_cloud_excluded_branches(cloud_policy):
    notes = _FakeNotes()
    ids = frozenset(notes.records)
    resolved = ResolvedViewScope(filter_active=True, allowed_note_ids=ids,
        matched_note_ids=ids, ordered_root_ids=("root",), total_root_count=1)
    boundary = _local_privacy_boundary()
    if cloud_policy:
        boundary = _cloud_privacy_boundary(CloudPrivacyPolicy(whitelist_tags=(), whitelist_phrases=(),
            blacklist_tags=("gray-exclusive",), blacklist_phrases=()))
    snapshot = _factory(notes, lambda **kwargs: resolved).freeze(
        descriptor=_descriptor(), authoritative_search_query="useful-tag", authoritative_sort_mode="normal", authoritative_date_filter=None,
        authoritative_active_search_query="useful-tag", authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        run_id="selected-run", session_key="session-1", privacy_boundary=boundary, selected_note_id="root")
    payload = snapshot.selected_note.as_payload()
    expected = ["root", "match", "gray"]
    if cloud_policy:
        expected = ["root", "match"]
    assert [node["note_id"] for node in payload["tree_notes"]] == expected
    assert "secret" not in str(payload) and "credential" not in str(payload)


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
        selected_note_id="",
        authoritative_active_search_query="useful-tag",
        authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        descriptor=_descriptor(),
        authoritative_search_query="useful-tag",
        authoritative_sort_mode="normal", authoritative_date_filter=None,
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
        selected_note_id="",
        authoritative_active_search_query="useful-tag",
        authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        descriptor=descriptor,
        authoritative_search_query="",
        authoritative_sort_mode="normal", authoritative_date_filter=None,
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
            accepted_tags_provider=lambda note_id: notes.records[note_id].tag_terms,
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
        selected_note_id="",
        authoritative_active_search_query="useful-tag",
        authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        descriptor=descriptor,
        authoritative_search_query="",
        authoritative_sort_mode="normal", authoritative_date_filter=None,
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
            selected_note_id="",
            authoritative_active_search_query="useful-tag",
            authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
            descriptor=_descriptor(),
            authoritative_search_query="different-tag",
            authoritative_sort_mode="normal", authoritative_date_filter=None,
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
        accepted_tags_provider=lambda note_id: notes.records[note_id].tag_terms,
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
        accepted_tags_provider=lambda note_id: notes.records[note_id].tag_terms,
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
        accepted_tags_provider=lambda note_id: effective_tags[note_id],
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


def test_freezing_a_view_extracts_no_note_text_until_a_note_is_read(monkeypatch) -> None:
    # A question that reads no notes (help, general knowledge) must not pay for
    # the whole view: text is extracted when a tool first reads a note, from the
    # HTML as it was at Send.
    calls: list[str] = []
    real_extract = scope_module.extract_note_text_for_agent

    def counting_extract(*, content_html: str, tags: str):
        calls.append(content_html)
        return real_extract(content_html=content_html, tags=tags)

    monkeypatch.setattr(scope_module, "extract_note_text_for_agent", counting_extract)
    notes = _FakeNotes()
    ids = frozenset({"match", "secret", "secret-child"})
    resolved = ResolvedViewScope(filter_active=True, allowed_note_ids=ids | {"root"},
        matched_note_ids=ids, ordered_root_ids=("root",), total_root_count=1)
    snapshot = _factory(notes, lambda **kwargs: resolved).freeze(
        authoritative_active_search_query="useful-tag", authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        descriptor=_descriptor(), authoritative_search_query="useful-tag", authoritative_sort_mode="normal", authoritative_date_filter=None,
        run_id="lazy-run", session_key="session-1", privacy_boundary=_local_privacy_boundary(),
        selected_note_id="",
    )

    assert calls == []
    assert snapshot.preparation_ms >= 0.0
    notes.records["match"] = replace(notes.records["match"], content="Changed later")
    assert snapshot.notes_by_id["match"].content_text == "lorem ipsum evidence"
    assert snapshot.notes_by_id["match"].content_text == "lorem ipsum evidence"
    assert len(calls) == 1


def test_a_step_says_how_much_note_text_it_extracted() -> None:
    describe = scope_module.describe_text_extraction
    assert describe(before=(10, 500.0), after=(10, 500.0)) == ""
    assert describe(before=(0, 0.0), after=(1, 40.0)) == " · text extracted for 1 note in 40 ms"
    assert describe(before=(0, 0.0), after=(1_613, 38.4)) == " · text extracted for 1,613 notes in 38 ms"
    assert describe(before=(5, 100.0), after=(45_485, 3_900.0)) == " · text extracted for 45,480 notes in 3.8 s"


@pytest.mark.parametrize("content, cached_title", [
    # The phrase is only in a link's address, which the label hides; the AI is sent the address.
    ('<p>See the <a href="https://files.example/acme-merger/plan">data room</a></p>', None),
    # The phrase is only in the cached title of a linked page; the AI is sent the title.
    ("<p>See https://files.example/room</p>", "Acme-merger data room"),
])
def test_cloud_privacy_judges_the_text_the_ai_is_sent(monkeypatch, content, cached_title) -> None:
    """A blacklisted phrase anywhere in what would be sent hides the note, not
    only in the note's visible text."""
    monkeypatch.setattr(link_title_store, "get_ok_title", lambda url: cached_title)
    notes = _FakeNotes()
    notes.records["gray"] = replace(notes.records["gray"], content=content)
    sent_text, _ = extract_note_text_for_agent(content_html=content, tags=notes.records["gray"].tags)
    assert "acme-merger" in sent_text.casefold(), "the phrase is in what the AI would be sent"
    evaluator = CloudPrivacyEvaluator(
        notes=notes,
        effective_tags_provider=lambda note_id: notes.records[note_id].tag_terms,
        accepted_tags_provider=lambda note_id: notes.records[note_id].tag_terms,
    )
    policy = CloudPrivacyPolicy(
        whitelist_tags=(), whitelist_phrases=(), blacklist_tags=(), blacklist_phrases=("acme-merger",),
    )

    hidden = evaluator.hidden_note_ids(note_ids=("gray",), boundary=_cloud_privacy_boundary(policy))

    assert hidden == frozenset({"gray"})


def test_the_ai_is_not_sent_a_search_term_whose_notes_it_cannot_see() -> None:
    """`diary` finds only a private note, so the AI is shown the search without it;
    the server still searches as typed."""
    notes = _FakeNotes()
    query = "travel OR diary"
    matched_by_search = {query: {"match", "secret"}, "travel": {"match"}, "diary": {"secret"}}
    searched = []
    def resolve(*, search, **kwargs):
        searched.append(search)
        matched = frozenset(matched_by_search[search])
        return ResolvedViewScope(filter_active=True, allowed_note_ids=matched | {"root"},
            matched_note_ids=matched, ordered_root_ids=("root",), total_root_count=1)
    snapshot = _factory(notes, resolve).freeze(
        descriptor=_descriptor().model_copy(update={"search_query": query, "label": query}),
        authoritative_search_query=query, authoritative_sort_mode="normal", authoritative_date_filter=None,
        authoritative_active_search_query=query, authoritative_active_sort_mode="normal", authoritative_active_date_filter=None,
        run_id="private-search-run", session_key="session-1",
        privacy_boundary=_cloud_privacy_boundary(EMPTY_CLOUD_PRIVACY_POLICY), selected_note_id="",
    )
    agent = AgentContextBuilder().build_agent_messages(earlier_actions=[],
        canonical_messages=[{"role": "user", "content": "What is in this view?"}],
        skills=DEFAULT_AGENT_SKILLS, web_settings=DEFAULT_AGENT_WEB_SETTINGS, snapshot=snapshot,
        available_urls=(), note_aliases=NoteAliases.from_snapshot(snapshot))

    assert searched[0] == query
    assert snapshot.ordered_note_ids == ("match",)
    assert snapshot.disclosable_search_query == "travel OR [private]"
    assert snapshot.disclosable_label == "travel OR [private]"
    sent = "\n".join(str(message["content"]) for message in agent)
    assert "diary" not in sent
    assert "travel OR [private]" in sent
