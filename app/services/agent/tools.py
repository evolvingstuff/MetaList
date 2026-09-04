"""Read-only PKMS-domain tools exposed to the agent runtime."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum

from app.services.agent.actions import ReadNotesByIdAction
from app.services.agent.actions import SearchNotesAction
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.content_formatting import extract_note_text_for_agent
from app.services.note_store import NoteRecord
from app.services.note_store import NoteStore
from app.services.note_store import store as note_store
from app.services.search_index import SearchIndex
from app.services.search_index import search_index


class ToolPermission(str, Enum):
    READ = "read"


@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    description: str
    mutates: bool
    permission: ToolPermission


@dataclass(frozen=True, slots=True)
class ToolExecutionResult:
    action_name: str
    status_label: str
    payload: dict[str, object]


@dataclass(frozen=True, slots=True)
class _PreparedNoteDisclosure:
    record: NoteRecord
    root_note_id: str
    content_text: str
    content_is_redacted: bool


class ReadOnlyAgentToolRegistry:
    def __init__(self, *, notes: NoteStore, searches: SearchIndex) -> None:
        self._notes = notes
        self._searches = searches

    def spec_for(self, action: object) -> ToolSpec:
        if isinstance(action, SearchNotesAction):
            return ToolSpec(
                name="search_notes",
                description=(
                    "Search MetaList and return one ordered, token-bounded payload "
                    "of complete matching root groups"
                ),
                mutates=False,
                permission=ToolPermission.READ,
            )
        if isinstance(action, ReadNotesByIdAction):
            return ToolSpec(
                name="read_notes_by_id",
                description="Read full content from notes with already-known UUIDs",
                mutates=False,
                permission=ToolPermission.READ,
            )
        raise TypeError(f"No tool corresponds to action type {type(action).__name__}")

    def execute(
        self,
        action: object,
        *,
        settings: AgentRetrievalSettings,
    ) -> ToolExecutionResult:
        if not isinstance(settings, AgentRetrievalSettings):
            raise TypeError("Agent tool execution requires retrieval settings")
        if isinstance(action, SearchNotesAction):
            return self._search_notes(action, settings=settings)
        if isinstance(action, ReadNotesByIdAction):
            return self._read_notes_by_id(action, settings=settings)
        raise TypeError(f"Cannot execute action type {type(action).__name__}")

    def _search_notes(
        self,
        action: SearchNotesAction,
        *,
        settings: AgentRetrievalSettings,
    ) -> ToolExecutionResult:
        matched_ids = self._searches.query_note_ids(action.query)
        all_note_ids = self._notes.list_note_ids()
        assert matched_ids.issubset(set(all_note_ids))
        ordered_ids = self._ordered_matching_note_ids(
            matched_ids=matched_ids,
            all_note_ids=all_note_ids,
        )
        ordered_root_ids: list[str] = []
        note_ids_by_root_id: dict[str, list[str]] = {}
        for note_id in ordered_ids:
            root_note_id = self._resolve_root_note_id(note_id)
            if root_note_id not in note_ids_by_root_id:
                ordered_root_ids.append(root_note_id)
                note_ids_by_root_id[root_note_id] = []
            note_ids_by_root_id[root_note_id].append(note_id)

        retained_root_ids: list[str] = []
        retained_notes: list[dict[str, object]] = []
        for root_note_id in ordered_root_ids:
            root_notes = self._build_full_note_payloads(
                note_ids=note_ids_by_root_id[root_note_id],
            )
            candidate_notes = [*retained_notes, *root_notes]
            if estimate_input_tokens(candidate_notes) > (
                settings.max_page_approximate_tokens
            ):
                break
            retained_root_ids.append(root_note_id)
            retained_notes = candidate_notes
        if ordered_root_ids and not retained_root_ids:
            first_root_notes = self._build_full_note_payloads(
                note_ids=note_ids_by_root_id[ordered_root_ids[0]],
            )
            required_tokens = estimate_input_tokens(first_root_notes)
            raise ValueError(
                "The first complete search result requires approximately "
                f"{required_tokens:,} tokens, exceeding the configured evidence "
                f"limit of {settings.max_page_approximate_tokens:,} tokens"
            )

        returned_tokens = estimate_input_tokens(retained_notes)
        return ToolExecutionResult(
            action_name="search_notes",
            status_label="Searching notes",
            payload={
                "content_contract": {
                    "notes_are_content_bearing": True,
                    "note_content_field": "notes[].content_text",
                    "follow_up_read_required": False,
                    "instruction": (
                        "Read and synthesize notes[].content_text now. note_id is "
                        "only for citation and navigation."
                    ),
                },
                "query": action.query,
                "matched_count": len(ordered_root_ids),
                "matched_note_count": len(ordered_ids),
                "returned_count": len(retained_root_ids),
                "returned_note_count": len(retained_notes),
                "omitted_count": len(ordered_root_ids) - len(retained_root_ids),
                "omitted_note_count": len(ordered_ids) - len(retained_notes),
                "returned_approximate_token_count": returned_tokens,
                "notes": retained_notes,
            },
        )

    def _ordered_matching_note_ids(
        self,
        *,
        matched_ids: set[str],
        all_note_ids: list[str],
    ) -> list[str]:
        all_note_id_set = set(all_note_ids)
        if len(all_note_id_set) != len(all_note_ids):
            raise RuntimeError("NoteStore returned duplicate note ids")
        if not matched_ids.issubset(all_note_id_set):
            raise RuntimeError("SearchIndex returned an unknown note id")
        traversal_stack = [
            (root_id, None) for root_id in reversed(self._notes.get_children(None))
        ]
        visited_note_ids: set[str] = set()
        ordered_matching_ids: list[str] = []
        while traversal_stack:
            note_id, expected_parent_id = traversal_stack.pop()
            if note_id in visited_note_ids:
                raise RuntimeError(
                    f"Hierarchy cycle or duplicate detected while ordering {note_id}"
                )
            if note_id not in all_note_id_set:
                raise RuntimeError(
                    f"Hierarchy ordering contains unknown note id {note_id}"
                )
            record = self._notes.get_note(note_id)
            if record.parent_id != expected_parent_id:
                raise RuntimeError(
                    "Hierarchy ordering parent mismatch: "
                    f"note_id={note_id} expected={expected_parent_id} "
                    f"actual={record.parent_id}"
                )
            visited_note_ids.add(note_id)
            if note_id in matched_ids:
                ordered_matching_ids.append(note_id)
            traversal_stack.extend(
                (child_id, note_id)
                for child_id in reversed(self._notes.get_children(note_id))
            )
        if visited_note_ids != all_note_id_set:
            missing_ids = sorted(all_note_id_set - visited_note_ids)
            raise RuntimeError(
                "Hierarchy ordering did not reach every note: "
                f"missing={missing_ids[:12]}"
            )
        return ordered_matching_ids

    def _resolve_root_note_id(self, note_id: str) -> str:
        visited: set[str] = set()
        current_note_id = note_id
        while True:
            if current_note_id in visited:
                raise RuntimeError(
                    f"Hierarchy cycle detected while grouping search result {note_id}"
                )
            visited.add(current_note_id)
            record = self._notes.get_note(current_note_id)
            if record.parent_id is None:
                return current_note_id
            if not self._notes.has_note(record.parent_id):
                raise RuntimeError(
                    "Search result hierarchy contains a missing parent: "
                    f"note_id={current_note_id} parent_id={record.parent_id}"
                )
            current_note_id = record.parent_id

    def _build_full_note_payloads(
        self,
        *,
        note_ids: list[str],
    ) -> list[dict[str, object]]:
        payloads: list[dict[str, object]] = []
        for note_id in note_ids:
            record = self._notes.get_note(note_id)
            content_text, content_is_redacted = extract_note_text_for_agent(
                content_html=record.content,
                tags=record.tags,
            )
            payloads.append(
                self._build_note_payload(
                    prepared_note=_PreparedNoteDisclosure(
                        record=record,
                        root_note_id=self._resolve_root_note_id(note_id),
                        content_text=content_text,
                        content_is_redacted=content_is_redacted,
                    ),
                )
            )
        return payloads

    @staticmethod
    def _build_note_payload(
        *,
        prepared_note: _PreparedNoteDisclosure,
    ) -> dict[str, object]:
        record = prepared_note.record
        content_text = prepared_note.content_text
        disclosed_character_count = len(content_text)
        if prepared_note.content_is_redacted:
            disclosed_character_count = 0
        payload: dict[str, object] = {
            "note_id": record.id,
            "parent_id": record.parent_id or "",
            "root_note_id": prepared_note.root_note_id,
            "content_text": content_text,
            "content_character_count": disclosed_character_count,
            "content_is_redacted": prepared_note.content_is_redacted,
            "created_at": ReadOnlyAgentToolRegistry._timestamp_text(record.created_at),
            "updated_at": ReadOnlyAgentToolRegistry._timestamp_text(record.updated_at),
        }
        if record.tags:
            payload["tags"] = record.tags
        if record.proposed_tags:
            payload["proposed_tags"] = record.proposed_tags
        return payload

    @staticmethod
    def _timestamp_text(value: datetime | None) -> str:
        if value is None:
            return ""
        if not isinstance(value, datetime):
            raise TypeError(f"Note timestamp must be datetime or None, got {type(value)}")
        return value.isoformat()

    def _read_notes_by_id(
        self,
        action: ReadNotesByIdAction,
        *,
        settings: AgentRetrievalSettings,
    ) -> ToolExecutionResult:
        found_note_ids: list[str] = []
        missing_note_ids: list[str] = []
        for note_id in action.note_ids:
            if self._notes.has_note(note_id):
                found_note_ids.append(note_id)
            else:
                missing_note_ids.append(note_id)
        notes = self._build_full_note_payloads(note_ids=found_note_ids)
        token_count = estimate_input_tokens(notes)
        if token_count > settings.max_page_approximate_tokens:
            raise ValueError(
                "Requested full notes require approximately "
                f"{token_count:,} tokens, exceeding the configured evidence limit "
                f"of {settings.max_page_approximate_tokens:,} tokens"
            )
        count = len(notes)
        noun = "notes"
        if count == 1:
            noun = "note"
        return ToolExecutionResult(
            action_name="read_notes_by_id",
            status_label=f"Reading {count} {noun} by ID",
            payload={
                "notes": notes,
                "missing_note_ids": missing_note_ids,
                "returned_approximate_token_count": token_count,
            },
        )


read_only_agent_tools = ReadOnlyAgentToolRegistry(
    notes=note_store,
    searches=search_index,
)
