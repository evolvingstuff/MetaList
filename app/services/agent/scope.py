"""Freeze the active MetaList view into an immutable agent evidence boundary."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Literal, Mapping

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from typing_extensions import Self

from app.services.agent.cloud_privacy import CloudPrivacyBoundary
from app.services.agent.cloud_privacy import CloudPrivacyEvaluator
from app.services.agent.cloud_privacy import cloud_privacy_evaluator
from app.services.agent.cloud_privacy import disclosable_search_query
from app.services.content_formatting import extract_note_text_for_agent
from app.services.root_date_filter import RootDateFilter
from app.services.note_store import NoteRecord
from app.services.note_store import NoteStore
from app.services.note_store import store as note_store
from app.services.root_sorting import normalize_sort_mode
from app.services.search_index import extract_ordered_tags_for_search
from app.services.snapshot import ResolvedViewScope
from app.services.snapshot import resolve_view_scope_membership
from app.services.tab_state import MAX_TAB_ID_LENGTH
from app.utils.time_units import MS_PER_SECOND

_SEARCH_QUERY_MAX_LENGTH = 8_000
_SORT_MODE_MAX_LENGTH = 64
_REFERENCE_ROOT_IDS_MAX_COUNT = 100
_SCOPE_LABEL_MAX_LENGTH = 512
# How many outside-the-roots note ids the scope error message lists.
_MISSING_NOTE_IDS_SHOWN = 12


class AgentScopeDescriptor(BaseModel):
    """Required flat description of the browser view at Send time."""

    model_config = ConfigDict(extra="forbid")

    scope_kind: Literal["search", "all_notes", "untagged", "reference"]
    active_tab_id: str = Field(..., min_length=1, max_length=MAX_TAB_ID_LENGTH)
    scope_tab_id: str = Field(..., min_length=1, max_length=MAX_TAB_ID_LENGTH)
    search_query: str = Field(..., max_length=_SEARCH_QUERY_MAX_LENGTH)
    sort_mode: str = Field(..., min_length=1, max_length=_SORT_MODE_MAX_LENGTH)
    reference_root_ids: list[str] = Field(..., max_length=_REFERENCE_ROOT_IDS_MAX_COUNT)
    label: str = Field(..., min_length=1, max_length=_SCOPE_LABEL_MAX_LENGTH)

    @field_validator("active_tab_id", "scope_tab_id", "label")
    @classmethod
    def reject_blank_required_text(cls, value: str) -> str:
        if value.strip() == "":
            raise ValueError("Scope text fields must not be blank")
        return value

    @field_validator("sort_mode")
    @classmethod
    def validate_sort_mode(cls, value: str) -> str:
        return normalize_sort_mode(value)

    @field_validator("reference_root_ids")
    @classmethod
    def validate_reference_root_ids(cls, values: list[str]) -> list[str]:
        if any(not isinstance(value, str) or value.strip() == "" for value in values):
            raise ValueError("Reference root ids must be non-empty strings")
        normalized = [value.strip() for value in values]
        if len(set(normalized)) != len(normalized):
            raise ValueError("Reference root ids must be unique")
        return normalized

    @model_validator(mode="after")
    def validate_cross_fields(self) -> Self:
        if self.scope_kind == "search" and self.search_query.strip() == "":
            raise ValueError("search scope requires non-empty search_query")
        if self.scope_kind == "search" and self.label != self.search_query:
            raise ValueError("search scope label must equal search_query")
        if self.scope_kind in {"all_notes", "untagged"} and self.search_query != "":
            raise ValueError(f"{self.scope_kind} requires empty search_query")
        if self.scope_kind == "all_notes" and self.label != "All notes":
            raise ValueError("all_notes scope label must be All notes")
        if self.scope_kind == "untagged" and self.label != "Untagged notes":
            raise ValueError("untagged scope label must be Untagged notes")
        if self.scope_kind == "reference":
            if self.search_query.strip() == "":
                raise ValueError("reference scope requires non-empty search_query")
            if len(self.reference_root_ids) == 0:
                raise ValueError("reference scope requires reference_root_ids")
            if self.label != "Reference source":
                raise ValueError("reference scope label must be Reference source")
        elif len(self.reference_root_ids) != 0:
            raise ValueError("Only reference scope accepts reference_root_ids")
        return self

@dataclass(slots=True, eq=False)
class TextExtractionMeter:
    """How many of a snapshot's notes had their text extracted, and how long it
    took, so the chat can say which step paid for it."""

    note_count: int
    duration_ms: float

    @classmethod
    def start(cls) -> TextExtractionMeter:
        return cls(note_count=0, duration_ms=0.0)

    def record(self, duration_ms: float) -> None:
        assert duration_ms >= 0.0
        self.note_count += 1
        self.duration_ms += duration_ms

    def reading(self) -> tuple[int, float]:
        return self.note_count, self.duration_ms


def describe_text_extraction(*, before: tuple[int, float], after: tuple[int, float]) -> str:
    """' · text extracted for N notes in X s' for a step that extracted text, else ''."""
    note_count = after[0] - before[0]
    assert note_count >= 0
    if note_count == 0:
        return ""
    noun = "notes"
    if note_count == 1:
        noun = "note"
    duration_ms = after[1] - before[1]
    # Like the chat's step durations: milliseconds under a second.
    duration_text = f"{duration_ms / MS_PER_SECOND:.1f} s"
    if duration_ms < MS_PER_SECOND:
        duration_text = f"{round(duration_ms)} ms"
    return f" · text extracted for {note_count:,} {noun} in {duration_text}"


@dataclass(slots=True, eq=False)
class NoteText:
    """A frozen note's text for the agent, extracted the first time a tool reads it.

    The snapshot keeps the note's HTML as of Send (note records are immutable, so
    an edit afterwards does not change it); extracting every note's text up front
    made each message pay for the whole view, even when no note was read."""

    content_html: str
    tags_text: str
    extracted_text: str | None
    meter: TextExtractionMeter | None

    @classmethod
    def from_html(cls, *, content_html: str, tags_text: str, meter: TextExtractionMeter) -> NoteText:
        if not isinstance(content_html, str) or not isinstance(tags_text, str):
            raise TypeError("NoteText needs the note's HTML and tags")
        if not isinstance(meter, TextExtractionMeter):
            raise TypeError("NoteText from HTML needs the snapshot's extraction meter")
        return cls(content_html=content_html, tags_text=tags_text, extracted_text=None, meter=meter)

    @classmethod
    def from_text(cls, text: str) -> NoteText:
        """Already-extracted text (fixtures and eval cases)."""
        if not isinstance(text, str):
            raise TypeError("NoteText text must be a string")
        return cls(content_html="", tags_text="", extracted_text=text, meter=None)

    def text(self) -> str:
        if self.extracted_text is None:
            assert self.meter is not None, "Text to extract always comes with the snapshot's meter"
            started_at = time.perf_counter()
            text, is_redacted = extract_note_text_for_agent(content_html=self.content_html, tags=self.tags_text)
            if is_redacted:
                raise RuntimeError("Privacy boundary admitted an @password note into agent scope")
            self.extracted_text = text
            self.meter.record((time.perf_counter() - started_at) * MS_PER_SECOND)
        return self.extracted_text


@dataclass(frozen=True, slots=True)
class FrozenScopedNote:
    note_id: str
    parent_id: str
    root_note_id: str
    note_text: NoteText
    explicit_tags_text: str
    explicit_tag_terms: tuple[str, ...]
    proposed_tags_text: str
    proposed_tag_terms: tuple[str, ...]
    created_at: str
    updated_at: str
    order_index: int

    @property
    def content_text(self) -> str:
        return self.note_text.text()


@dataclass(frozen=True, slots=True)
class FrozenScopedTreeNode:
    note_id: str
    parent_id: str
    root_note_id: str
    child_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SelectedTreeNote:
    note_id: str
    parent_id: str
    content_text: str
    tags: str


# The model learns only that a note is private, never which privacy setting hides it.
_MODEL_UNAVAILABLE_REASON = {"blacklisted": "private", "not_whitelisted": "private",
                             "password_protected": "private", "username_protected": "private",
                             "search_redacted": "search_redacted",
                             "not_found": "not_found", "unspecified": "unspecified"}
# The same, in plain words the model can repeat to the user.
_MODEL_UNAVAILABLE_DESCRIPTION = {
    "private": "The user is editing a note you cannot see: they keep it private from the AI.",
    "search_redacted": "The user is editing a note you cannot see: it is excluded by the current search.",
    "not_found": "The note the user had selected no longer exists.",
    "unspecified": "The user is editing a note you cannot see.",
}


@dataclass(frozen=True, slots=True)
class SelectedNoteContext:
    status: Literal["none", "available", "unavailable"]
    note_id: str
    tree_notes: tuple[SelectedTreeNote, ...]
    unavailable_reason: str

    def __post_init__(self) -> None:
        assert isinstance(self.tree_notes, tuple)
        if self.status == "unavailable":
            assert self.unavailable_reason in {"not_found", "search_redacted", "blacklisted", "password_protected",
                                               "username_protected", "not_whitelisted", "unspecified"}
        else:
            assert self.unavailable_reason == ""
        if self.status != "available":
            assert self.status in {"none", "unavailable"}
            assert self.note_id == "" and self.tree_notes == ()
            return
        assert self.tree_notes and self.tree_notes[0].parent_id == ""
        seen = set()
        for index, note in enumerate(self.tree_notes):
            assert note.note_id and note.note_id not in seen
            assert index == 0 or note.parent_id in seen
            seen.add(note.note_id)
        assert self.note_id in seen

    def as_payload(self) -> dict[str, object]:
        if self.status != "available":
            payload = {"status": self.status, "has_selection": self.status != "none"}
            if self.status == "unavailable":
                reason = _MODEL_UNAVAILABLE_REASON[self.unavailable_reason]
                payload["reason"] = reason
                payload["description"] = _MODEL_UNAVAILABLE_DESCRIPTION[reason]
            return payload
        return {"status": self.status, "has_selection": True, "note_id": self.note_id,
                "root_note_id": self.tree_notes[0].note_id,
                "tree_notes": [{"note_id": note.note_id, "parent_id": note.parent_id,
                    "content_text": note.content_text, "tags": note.tags,
                    "is_selected": note.note_id == self.note_id} for note in self.tree_notes]}

    @property
    def reference_note_ids(self) -> tuple[str, ...]:
        if self.status == "available":
            return tuple(note.note_id for note in self.tree_notes)
        return ()



# No note was selected when the chat was opened.
NO_SELECTED_NOTE = SelectedNoteContext(status="none", note_id="", tree_notes=(), unavailable_reason="")


@dataclass(frozen=True, slots=True)
class ScopedSearchSnapshot:
    run_id: str
    session_key: str
    descriptor: AgentScopeDescriptor
    created_at: str
    ordered_root_ids: tuple[str, ...]
    ordered_note_ids: tuple[str, ...]
    notes_by_id: Mapping[str, FrozenScopedNote]
    tree_nodes_by_id: Mapping[str, FrozenScopedTreeNode]
    # The record of every note in tree_nodes_by_id as of Send (records are immutable).
    # Bulk tagging sends these, never the live notes: the privacy rules judged the
    # notes at Send, and an edit afterwards must not reach the AI unjudged.
    note_records_at_send: Mapping[str, NoteRecord]
    # The view's search as the AI is shown it: a term only when the AI can see a note
    # it picks out, judged at Send (cloud_privacy.disclosable_search_query). The
    # descriptor keeps the search as typed, for the server's own searches.
    disclosable_search_query: str
    # The tab's date range filter at Send (None: every date), for the server's own
    # searches of this view later in the run.
    date_filter: RootDateFilter | None
    # The tab's Files filter at Send (None: every note), as the date range.
    file_filter: str | None
    # How long freezing took, shown on the chat's first activity line.
    preparation_ms: float
    # Note text extracted on first read during the run (NoteText).
    text_extraction: TextExtractionMeter
    selected_note: SelectedNoteContext

    @property
    def disclosable_label(self) -> str:
        """The view's label as the AI is shown it (a search view's label is its search)."""
        if self.descriptor.scope_kind == "search":
            return self.disclosable_search_query
        return self.descriptor.label

    @property
    def note_count(self) -> int:
        return len(self.ordered_note_ids)

    @property
    def result_tree_count(self) -> int:
        return len(self.ordered_root_ids)


class ScopedSearchSnapshotFactory:
    def __init__(
        self,
        *,
        notes: NoteStore,
        view_scope_resolver: Callable[..., ResolvedViewScope],
        privacy_evaluator: CloudPrivacyEvaluator,
    ) -> None:
        self._notes = notes
        self._view_scope_resolver = view_scope_resolver
        self._privacy_evaluator = privacy_evaluator

    def freeze(
        self,
        *,
        descriptor: AgentScopeDescriptor,
        authoritative_search_query: str,
        authoritative_sort_mode: str,
        authoritative_date_filter: RootDateFilter | None,
        authoritative_file_filter: str | None,
        run_id: str,
        session_key: str,
        privacy_boundary: CloudPrivacyBoundary,
        selected_note_id: str,
        authoritative_active_search_query: str,
        authoritative_active_sort_mode: str,
        authoritative_active_date_filter: RootDateFilter | None,
        authoritative_active_file_filter: str | None,
    ) -> ScopedSearchSnapshot:
        started_at = time.perf_counter()
        text_extraction = TextExtractionMeter.start()
        if descriptor.search_query != authoritative_search_query:
            raise ValueError("Active tab search query changed before Send")
        if descriptor.sort_mode != normalize_sort_mode(authoritative_sort_mode):
            raise ValueError("Active tab sort mode changed before Send")
        if run_id == "" or session_key == "":
            raise ValueError("Frozen agent scope requires run and session ids")

        resolved = self._view_scope_resolver(
            search=descriptor.search_query,
            sort_mode=descriptor.sort_mode,
            date_filter=authoritative_date_filter,
            file_filter=authoritative_file_filter,
            is_untagged_view=descriptor.scope_kind == "untagged",
        )
        selected_view = resolved
        if selected_note_id and descriptor.active_tab_id != descriptor.scope_tab_id:
            selected_view = self._view_scope_resolver(
                search=authoritative_active_search_query,
                sort_mode=authoritative_active_sort_mode,
                date_filter=authoritative_active_date_filter,
                file_filter=authoritative_active_file_filter,
                is_untagged_view=False,
            )
        selected_note = self._freeze_selected_note(selected_note_id, selected_view, privacy_boundary)
        candidate_ids = set(resolved.matched_note_ids)
        hidden_candidate_ids = self._privacy_evaluator.hidden_note_ids(
            note_ids=tuple(candidate_ids),
            boundary=privacy_boundary,
        )
        visible_candidate_ids = candidate_ids - hidden_candidate_ids
        ordered_candidate_ids = self._ordered_candidate_ids(
            ordered_root_ids=resolved.ordered_root_ids,
            candidate_ids=visible_candidate_ids,
        )
        frozen_notes: dict[str, FrozenScopedNote] = {}
        included_root_ids: list[str] = []
        seen_root_ids: set[str] = set()
        for note_id in ordered_candidate_ids:
            record = self._notes.get_note(note_id)
            root_note_id = self._root_note_id(note_id)
            if root_note_id not in seen_root_ids:
                seen_root_ids.add(root_note_id)
                included_root_ids.append(root_note_id)
            explicit_tags = extract_ordered_tags_for_search(record.tags)
            proposed_tags = extract_ordered_tags_for_search(record.proposed_tags)
            parent_id = ""
            if record.parent_id is not None:
                parent_id = record.parent_id
            frozen_notes[note_id] = FrozenScopedNote(
                note_id=note_id,
                parent_id=parent_id,
                root_note_id=root_note_id,
                note_text=NoteText.from_html(content_html=record.content, tags_text=record.tags, meter=text_extraction),
                explicit_tags_text=record.tags,
                explicit_tag_terms=explicit_tags,
                proposed_tags_text=record.proposed_tags,
                proposed_tag_terms=proposed_tags,
                created_at=self._timestamp_text(record, "created_at"),
                updated_at=self._timestamp_text(record, "updated_at"),
                order_index=len(frozen_notes),
            )
        ordered_note_ids = tuple(frozen_notes)
        tree_nodes = self._freeze_tree_nodes(
            evidence_note_ids=ordered_note_ids,
            ordered_root_ids=tuple(included_root_ids),
        )
        assert set(ordered_note_ids).issubset(candidate_ids)
        assert set(included_root_ids).issubset(set(resolved.ordered_root_ids))
        if descriptor.scope_kind == "reference":
            if not set(descriptor.reference_root_ids).issubset(candidate_ids):
                raise ValueError("Reference ids do not match the resolved reference scope")
            descriptor_root_ids = {
                self._root_note_id(note_id)
                for note_id in descriptor.reference_root_ids
            }
            if descriptor_root_ids != set(included_root_ids):
                if not set(included_root_ids).issubset(descriptor_root_ids):
                    raise ValueError(
                        "Reference roots do not match the resolved reference scope"
                    )
        return ScopedSearchSnapshot(
            run_id=run_id,
            session_key=session_key,
            descriptor=descriptor,
            created_at=datetime.now(timezone.utc).isoformat(),
            ordered_root_ids=tuple(included_root_ids),
            ordered_note_ids=ordered_note_ids,
            notes_by_id=MappingProxyType(frozen_notes),
            tree_nodes_by_id=MappingProxyType(tree_nodes),
            note_records_at_send=self._records_at_send(tree_nodes),
            disclosable_search_query=self._disclosable_search_query(descriptor, privacy_boundary),
            date_filter=authoritative_date_filter,
            file_filter=authoritative_file_filter,
            preparation_ms=(time.perf_counter() - started_at) * MS_PER_SECOND,
            text_extraction=text_extraction,
            selected_note=selected_note,
        )

    def _records_at_send(self, note_ids: Mapping[str, FrozenScopedTreeNode]) -> Mapping[str, NoteRecord]:
        return MappingProxyType({note_id: self._notes.get_note(note_id) for note_id in note_ids})

    def _disclosable_search_query(self, descriptor: AgentScopeDescriptor, boundary: CloudPrivacyBoundary) -> str:
        return disclosable_search_query(
            descriptor.search_query,
            finds_visible_note=lambda search: self._finds_visible_note(
                search=search, sort_mode=descriptor.sort_mode, boundary=boundary),
        )

    def _finds_visible_note(self, *, search: str, sort_mode: str, boundary: CloudPrivacyBoundary) -> bool:
        resolved = self._view_scope_resolver(
            search=search, sort_mode=sort_mode, date_filter=None, file_filter=None, is_untagged_view=False,
        )
        return self._privacy_evaluator.has_visible_note(note_ids=tuple(resolved.matched_note_ids), boundary=boundary)

    def _freeze_selected_note(
        self, note_id: str, visible_scope: ResolvedViewScope, boundary: CloudPrivacyBoundary,
    ) -> SelectedNoteContext:
        if note_id == "":
            return SelectedNoteContext("none", "", (), unavailable_reason="")
        if not self._notes.has_note(note_id):
            return SelectedNoteContext("unavailable", "", (), "not_found")
        exclusion_reason = self._privacy_evaluator.exclusion_reason(note_id=note_id, boundary=boundary)
        if exclusion_reason:
            return SelectedNoteContext("unavailable", "", (), exclusion_reason)
        if note_id not in visible_scope.allowed_note_ids:
            return SelectedNoteContext("unavailable", "", (), "search_redacted")
        tree_ids = self._selected_tree_note_ids(self._root_note_id(note_id), visible_scope.allowed_note_ids)
        if note_id not in tree_ids:
            return SelectedNoteContext("unavailable", "", (), "search_redacted")
        hidden_ids = self._privacy_evaluator.hidden_note_ids(note_ids=tree_ids, boundary=boundary)
        tree_notes = []
        for tree_id in tree_ids:
            if tree_id in hidden_ids:
                continue
            record = self._notes.get_note(tree_id)
            content_text, is_redacted = extract_note_text_for_agent(content_html=record.content, tags=record.tags)
            assert not is_redacted, "Selected tree must pass the disclosure boundary"
            parent_id = ""
            if record.parent_id is not None:
                parent_id = record.parent_id
            tree_notes.append(SelectedTreeNote(tree_id, parent_id, content_text, record.tags))
        return SelectedNoteContext("available", note_id, tuple(tree_notes), unavailable_reason="")

    def _selected_tree_note_ids(self, root_id: str, allowed_note_ids: frozenset[str]) -> tuple[str, ...]:
        ordered = []
        seen = set()
        stack = [root_id]
        while stack:
            note_id = stack.pop()
            assert note_id not in seen, "Hierarchy cycle in selected tree"
            seen.add(note_id)
            # UI reveal/edit state cannot admit a search-excluded branch.
            if note_id not in allowed_note_ids:
                continue
            ordered.append(note_id)
            stack.extend(reversed(self._notes.get_children(note_id)))
        return tuple(ordered)

    def _freeze_tree_nodes(
        self,
        *,
        evidence_note_ids: tuple[str, ...],
        ordered_root_ids: tuple[str, ...],
    ) -> dict[str, FrozenScopedTreeNode]:
        structure_ids: set[str] = set()
        for evidence_note_id in evidence_note_ids:
            current_id = evidence_note_id
            path_ids: set[str] = set()
            while True:
                if current_id in path_ids:
                    raise RuntimeError(f"Hierarchy cycle detected at {current_id}")
                path_ids.add(current_id)
                structure_ids.add(current_id)
                record = self._notes.get_note(current_id)
                if record.parent_id is None:
                    break
                current_id = record.parent_id
        ordered_structure_ids = self._ordered_candidate_ids(
            ordered_root_ids=ordered_root_ids,
            candidate_ids=structure_ids,
        )
        tree_nodes: dict[str, FrozenScopedTreeNode] = {}
        for note_id in ordered_structure_ids:
            record = self._notes.get_note(note_id)
            parent_id = ""
            if record.parent_id is not None:
                parent_id = record.parent_id
            child_ids = tuple(
                child_id
                for child_id in self._notes.get_children(note_id)
                if child_id in structure_ids
            )
            tree_nodes[note_id] = FrozenScopedTreeNode(
                note_id=note_id,
                parent_id=parent_id,
                root_note_id=self._root_note_id(note_id),
                child_ids=child_ids,
            )
        if set(ordered_root_ids) != {
            note_id
            for note_id, node in tree_nodes.items()
            if node.parent_id == ""
        }:
            raise RuntimeError("Frozen scope roots do not match tree structure")
        return tree_nodes

    def _ordered_candidate_ids(
        self,
        *,
        ordered_root_ids: tuple[str, ...],
        candidate_ids: set[str],
    ) -> list[str]:
        ordered: list[str] = []
        visited: set[str] = set()
        stack = list(reversed(ordered_root_ids))
        while stack:
            note_id = stack.pop()
            if note_id in visited:
                raise RuntimeError(f"Hierarchy cycle detected at {note_id}")
            visited.add(note_id)
            if note_id in candidate_ids:
                ordered.append(note_id)
            children = self._notes.get_children(note_id)
            stack.extend(reversed(children))
        missing = candidate_ids - visited
        if missing:
            raise RuntimeError(f"Scoped notes are outside resolved roots: {sorted(missing)[:_MISSING_NOTE_IDS_SHOWN]}")
        return ordered

    def _root_note_id(self, note_id: str) -> str:
        visited: set[str] = set()
        current = self._notes.get_note(note_id)
        while current.parent_id is not None:
            if current.id in visited:
                raise RuntimeError(f"Hierarchy cycle detected at {current.id}")
            visited.add(current.id)
            current = self._notes.get_note(current.parent_id)
        return current.id

    @staticmethod
    def _timestamp_text(record: NoteRecord, attribute_name: str) -> str:
        value = getattr(record, attribute_name)
        if value is None:
            return ""
        if not isinstance(value, datetime):
            raise TypeError(f"{attribute_name} must be datetime or None")
        return value.isoformat()


scoped_search_snapshot_factory = ScopedSearchSnapshotFactory(
    notes=note_store,
    view_scope_resolver=resolve_view_scope_membership,
    privacy_evaluator=cloud_privacy_evaluator,
)
