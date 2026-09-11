"""Freeze the active MetaList view into an immutable agent evidence boundary."""

from __future__ import annotations

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
from app.services.content_formatting import extract_note_text_for_agent
from app.services.note_store import NoteRecord
from app.services.note_store import NoteStore
from app.services.note_store import store as note_store
from app.services.root_sorting import normalize_sort_mode
from app.services.search_index import extract_ordered_tags_for_search
from app.services.snapshot import ResolvedViewScope
from app.services.snapshot import resolve_view_scope_membership


class AgentScopeDescriptor(BaseModel):
    """Required flat description of the browser view at Send time."""

    model_config = ConfigDict(extra="forbid")

    scope_kind: Literal["search", "all_notes", "untagged", "reference"]
    active_tab_id: str = Field(..., min_length=1, max_length=128)
    scope_tab_id: str = Field(..., min_length=1, max_length=128)
    search_query: str = Field(..., max_length=8_000)
    sort_mode: str = Field(..., min_length=1, max_length=64)
    reference_root_ids: list[str] = Field(..., max_length=100)
    label: str = Field(..., min_length=1, max_length=512)

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

@dataclass(frozen=True, slots=True)
class FrozenScopedNote:
    note_id: str
    parent_id: str
    root_note_id: str
    content_text: str
    explicit_tags_text: str
    explicit_tag_terms: tuple[str, ...]
    proposed_tags_text: str
    proposed_tag_terms: tuple[str, ...]
    created_at: str
    updated_at: str
    order_index: int


@dataclass(frozen=True, slots=True)
class FrozenScopedTreeNode:
    note_id: str
    parent_id: str
    root_note_id: str
    child_ids: tuple[str, ...]


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
        run_id: str,
        session_key: str,
        privacy_boundary: CloudPrivacyBoundary,
    ) -> ScopedSearchSnapshot:
        if descriptor.search_query != authoritative_search_query:
            raise ValueError("Active tab search query changed before Send")
        if descriptor.sort_mode != normalize_sort_mode(authoritative_sort_mode):
            raise ValueError("Active tab sort mode changed before Send")
        if run_id == "" or session_key == "":
            raise ValueError("Frozen agent scope requires run and session ids")

        resolved = self._view_scope_resolver(
            search=descriptor.search_query,
            sort_mode=descriptor.sort_mode,
            is_untagged_view=descriptor.scope_kind == "untagged",
        )
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
            content_text, content_is_redacted = extract_note_text_for_agent(
                content_html=record.content,
                tags=record.tags,
            )
            if content_is_redacted:
                raise RuntimeError(
                    "Privacy boundary admitted an @password note into agent scope"
                )
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
                content_text=content_text,
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
        )

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
            raise RuntimeError(f"Scoped notes are outside resolved roots: {sorted(missing)[:12]}")
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
