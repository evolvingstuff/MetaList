"""Typed actions available to the read-only agent runtime."""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Annotated, Literal, Self, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator

from app.services.search_query import parse_search_query


@dataclass(frozen=True, slots=True)
class ScopedRouteConstraints:
    explicit_saved_notes_request: bool

    def __post_init__(self) -> None:
        if not isinstance(self.explicit_saved_notes_request, bool):
            raise TypeError("explicit_saved_notes_request must be bool")


_SCOPED_ROUTE_CONSTRAINTS: ContextVar[ScopedRouteConstraints | None] = ContextVar(
    "scoped_route_constraints",
    default=None,
)

_EXPLICIT_SAVED_NOTES_PATTERNS = (
    re.compile(r"\b(?:my|our)\s+(?:saved\s+)?notes?\b", re.IGNORECASE),
    re.compile(
        r"\b(?:summari[sz]e|search|find|review|read|inspect|analy[sz]e|"
        r"synthesi[sz]e)\b(?:\W+\w+){0,12}\W+notes?\b",
        re.IGNORECASE,
    ),
)
_SAVED_NOTES_EXCLUSION_PATTERN = re.compile(
    r"\b(?:without|do\s+not|don't|dont)\b.{0,48}"
    r"\b(?:use|using|search|read|consult|reference)\b.{0,48}"
    r"\b(?:my|our)?\s*(?:saved\s+)?notes?\b",
    re.IGNORECASE,
)


def request_explicitly_requires_saved_notes(user_message: str) -> bool:
    if not isinstance(user_message, str):
        raise TypeError("user_message must be a string")
    if user_message.strip() == "":
        raise ValueError("user_message must not be blank")
    if _SAVED_NOTES_EXCLUSION_PATTERN.search(user_message) is not None:
        return False
    return any(
        pattern.search(user_message) is not None
        for pattern in _EXPLICIT_SAVED_NOTES_PATTERNS
    )


@contextmanager
def bind_scoped_route_constraints(
    constraints: ScopedRouteConstraints,
) -> Iterator[None]:
    if not isinstance(constraints, ScopedRouteConstraints):
        raise TypeError("constraints must be ScopedRouteConstraints")
    token = _SCOPED_ROUTE_CONSTRAINTS.set(constraints)
    try:
        yield
    finally:
        _SCOPED_ROUTE_CONSTRAINTS.reset(token)


def _validate_agent_search_query(value: str) -> str:
    if value.strip() == "":
        raise ValueError("Agent search query must not be blank")
    if len(value) > 1_000:
        raise ValueError("Agent search query must not exceed 1000 characters")
    parsed = parse_search_query(value)
    for clause in parsed.clauses:
        if len(clause.required_tags) == 0 and len(clause.required_text) == 0:
            raise ValueError(
                "Every agent search clause must contain at least one positive term"
            )
    return value


class SearchNotesAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["search_notes"]
    query: str = Field(..., min_length=1, max_length=1_000)
    rationale: str = Field(..., min_length=1, max_length=2_000)

    @field_validator("query")
    @classmethod
    def validate_query(cls, value: str) -> str:
        return _validate_agent_search_query(value)

    @field_validator("rationale")
    @classmethod
    def reject_blank_rationale(cls, value: str) -> str:
        if value.strip() == "":
            raise ValueError("Agent action rationale must not be blank")
        return value


class ReadNotesByIdAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["read_notes_by_id"]
    note_ids: list[str] = Field(..., min_length=1, max_length=12)
    rationale: str = Field(..., min_length=1, max_length=2_000)

    @field_validator("note_ids")
    @classmethod
    def validate_note_ids(cls, values: list[str]) -> list[str]:
        if any(not isinstance(value, str) or value.strip() == "" for value in values):
            raise ValueError("read_notes_by_id note ids must be non-empty strings")
        normalized = [value.strip() for value in values]
        if len(set(normalized)) != len(normalized):
            raise ValueError("read_notes_by_id note ids must be unique")
        return normalized

    @field_validator("rationale")
    @classmethod
    def reject_blank_rationale(cls, value: str) -> str:
        if value.strip() == "":
            raise ValueError("Agent action rationale must not be blank")
        return value


class RespondAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["respond"]
    basis: str = Field(..., min_length=1, max_length=4_000)

    @field_validator("basis")
    @classmethod
    def reject_blank_basis(cls, value: str) -> str:
        if value.strip() == "":
            raise ValueError("Agent response basis must not be blank")
        return value


class SearchNotesIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["search_notes"]
    rationale: str = Field(..., min_length=1, max_length=4_000)

    @field_validator("rationale")
    @classmethod
    def reject_blank_rationale(cls, value: str) -> str:
        if value.strip() == "":
            raise ValueError("Agent action rationale must not be blank")
        return value


class ScopedRouteEnvelope(BaseModel):
    """High-level route for the user-bounded investigation architecture."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["respond", "investigate_current_scope", "tag_proposals"] = Field(
        ...,
        description=(
            "respond for requests answerable without the user's notes; "
            "investigate_current_scope only when the answer depends on evidence "
            "inside the frozen active MetaList result scope. "
            "tag_proposals ONLY for an explicit current user request to generate, "
            "accept, reject, or remove tag proposals. Questions about tagging, "
            "hypotheticals, and unrelated requests must never select tag_proposals."
        ),
    )
    reason: str = Field(..., min_length=1, max_length=4_000)

    @field_validator("reason")
    @classmethod
    def reject_blank_reason(cls, value: str) -> str:
        if value.strip() == "":
            raise ValueError("Scoped route reason must not be blank")
        return value

    @model_validator(mode="after")
    def enforce_explicit_saved_notes_request(self) -> Self:
        constraints = _SCOPED_ROUTE_CONSTRAINTS.get()
        if (
            constraints is not None
            and constraints.explicit_saved_notes_request
            and self.kind not in {"investigate_current_scope", "tag_proposals"}
        ):
            raise ValueError(
                "The user explicitly requests evidence from saved notes; choose "
                "investigate_current_scope, not respond"
            )
        return self


AgentAction = Annotated[
    Union[SearchNotesAction, ReadNotesByIdAction, RespondAction],
    Field(discriminator="kind"),
]
agent_action_adapter: TypeAdapter[AgentAction] = TypeAdapter(AgentAction)

AgentRouteAction = Annotated[
    Union[SearchNotesIntent, ReadNotesByIdAction, RespondAction],
    Field(discriminator="kind"),
]


class AgentRouteEnvelope(BaseModel):
    """Flat action-routing schema with no root unions or references."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["respond", "search_notes", "read_notes_by_id"]
    note_ids: list[str] = Field(..., max_length=12)
    reason: str = Field(..., min_length=1, max_length=4_000)

    @model_validator(mode="after")
    def validate_action_fields(self) -> Self:
        if self.kind == "read_notes_by_id":
            if len(self.note_ids) == 0:
                raise ValueError("read_notes_by_id requires at least one note id")
            normalized = [note_id.strip() for note_id in self.note_ids]
            if any(note_id == "" for note_id in normalized):
                raise ValueError("read_notes_by_id note ids must be non-empty strings")
            if len(set(normalized)) != len(normalized):
                raise ValueError("read_notes_by_id note ids must be unique")
        return self

    def to_action(self) -> AgentRouteAction:
        if self.kind == "search_notes":
            return SearchNotesIntent(kind=self.kind, rationale=self.reason)
        if self.kind == "read_notes_by_id":
            return ReadNotesByIdAction(
                kind=self.kind,
                note_ids=self.note_ids,
                rationale=self.reason,
            )
        assert self.kind == "respond"
        return RespondAction(kind=self.kind, basis=self.reason)


agent_route_envelope_adapter: TypeAdapter[AgentRouteEnvelope] = TypeAdapter(
    AgentRouteEnvelope
)


class SearchQueryEnvelope(BaseModel):
    """Structured single-payload search query generated by the Search skill."""

    model_config = ConfigDict(extra="forbid")

    search_query: str = Field(..., description="The focused MetaList query.")
    reason: str = Field(..., min_length=1, max_length=2_000)

    @field_validator("search_query")
    @classmethod
    def validate_search_query(cls, value: str) -> str:
        return _validate_agent_search_query(value)

    @field_validator("reason")
    @classmethod
    def reject_blank_reason(cls, value: str) -> str:
        if value.strip() == "":
            raise ValueError("Search query reason must not be blank")
        return value

    def to_action(self) -> SearchNotesAction:
        return SearchNotesAction(
            kind="search_notes",
            query=self.search_query,
            rationale=self.reason,
        )


search_query_envelope_adapter: TypeAdapter[SearchQueryEnvelope] = TypeAdapter(
    SearchQueryEnvelope
)


def agent_route_response_schema() -> dict[str, object]:
    schema = AgentRouteEnvelope.model_json_schema()
    assert schema["type"] == "object"
    return schema


def parse_agent_route_json(response_content: str) -> AgentRouteAction:
    envelope = agent_route_envelope_adapter.validate_json(response_content)
    return envelope.to_action()


def parse_search_query_json(response_content: str) -> SearchNotesAction:
    envelope = search_query_envelope_adapter.validate_json(response_content)
    return envelope.to_action()
