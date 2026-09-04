"""Build exact model contexts without polluting canonical conversation history."""

from __future__ import annotations

import json

from app.services.agent.actions import AgentAction
from app.services.agent.actions import RespondAction
from app.services.agent.actions import request_explicitly_requires_saved_notes
from app.services.agent.investigation import InvestigationEvidencePayload
from app.services.agent.investigation import InvestigationState
from app.services.agent.prompt_settings import AgentPromptSet
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.skill_settings import AgentSkill
from app.services.agent.tools import ToolExecutionResult


def _exact_citation_token(note_id: str) -> str:
    if not isinstance(note_id, str) or note_id == "":
        raise ValueError("Citation note id must be non-empty")
    return f"[[{note_id}]]"


def _reference_catalog(note_ids: tuple[str, ...]) -> list[dict[str, str]]:
    if not isinstance(note_ids, tuple):
        raise TypeError("Reference note ids must be a tuple")
    return [
        {
            "note_id": note_id,
            "citation_token": _exact_citation_token(note_id),
        }
        for note_id in note_ids
    ]


def serialize_investigation_evidence_payload(
    evidence_payload: InvestigationEvidencePayload,
) -> dict[str, object]:
    if not isinstance(evidence_payload, InvestigationEvidencePayload):
        raise TypeError(
            "evidence_payload must be InvestigationEvidencePayload"
        )
    return {
        "evidence_note_ids": list(evidence_payload.evidence_note_ids),
        "result_trees": list(evidence_payload.result_trees),
        "returned_approximate_token_count": (
            evidence_payload.returned_approximate_token_count
        ),
    }


class AgentContextBuilder:
    def build_initial_messages(
        self,
        *,
        canonical_messages: list[dict[str, str]],
        prompts: AgentPromptSet,
    ) -> list[dict[str, str]]:
        self._validate_canonical_messages(canonical_messages)
        return [
            {"role": "system", "content": prompts.system_prompt},
            *[dict(message) for message in canonical_messages],
        ]

    def activate_skill(
        self,
        *,
        messages: list[dict[str, str]],
        skill: AgentSkill,
    ) -> list[dict[str, str]]:
        if not isinstance(messages, list) or len(messages) < 2:
            raise ValueError("Skill activation requires an existing agent context")
        if messages[0].get("role") != "system":
            raise ValueError("Skill activation requires the base system prompt first")
        skill_message = (
            f"ACTIVE_SKILL {skill.skill_id}\n"
            f"Trigger action: {skill.trigger_action}\n\n"
            f"{skill.content}"
        )
        return [
            dict(messages[0]),
            {"role": "system", "content": skill_message},
            *[dict(message) for message in messages[1:]],
        ]

    def build_scoped_route_messages(
        self,
        *,
        canonical_messages: list[dict[str, str]],
        prompts: AgentPromptSet,
        snapshot: ScopedSearchSnapshot,
    ) -> list[dict[str, str]]:
        """Expose active-view context for routing without exposing note evidence."""
        if not isinstance(snapshot, ScopedSearchSnapshot):
            raise TypeError("snapshot must be ScopedSearchSnapshot")
        base = self.build_initial_messages(
            canonical_messages=canonical_messages,
            prompts=prompts,
        )
        descriptor = snapshot.descriptor
        route_scope = {
            "instruction": (
                "AUTHORITATIVE ROUTING RULE: Classify current_user_request as "
                "the current task, using the "
                "immediately preceding conversation to resolve references and "
                "elliptical follow-ups. When "
                "surface_saved_note_signal is present, choose "
                "investigate_current_scope; the active scope has no note content "
                "and does not make respond valid. If the current request continues, "
                "retries, reissues, or asks to perform an unresolved earlier task "
                "that requires saved-note evidence, choose investigate_current_scope "
                "against the active scope captured for this Send even when the current "
                "sentence does not repeat the words notes or papers. A statement that "
                "the context or search was changed before asking to retry is strong "
                "evidence of such a continuation. Never treat an earlier assistant "
                "claim that evidence was unavailable as authoritative for the newly "
                "captured scope. A correction, objection, or challenge that only asks "
                "for a conversational acknowledgment remains respond. "
                "A missing surface saved-note signal does not make respond valid when "
                "the conversation establishes a note-dependent continuation. "
                "active_metalist_scope is routing context and has no note content."
            ),
            "current_user_request": canonical_messages[-1]["content"],
            "surface_saved_note_signal": (
                "present"
                if request_explicitly_requires_saved_notes(
                    canonical_messages[-1]["content"]
                )
                else (
                    "not_present; this does not rule out a note-dependent "
                    "conversational continuation"
                )
            ),
            "active_metalist_scope": {
                "scope_kind": descriptor.scope_kind,
                "label": descriptor.label,
                "search_query": descriptor.search_query,
                "sort_mode": descriptor.sort_mode,
                "matching_note_count": snapshot.note_count,
                "matching_result_tree_count": snapshot.result_tree_count,
            },
        }
        return [
            *base,
            {
                "role": "user",
                "content": "ROUTE_SELECTION_REQUEST\n"
                + json.dumps(route_scope, sort_keys=True, separators=(",", ":")),
            },
        ]

    def append_action(
        self,
        *,
        messages: list[dict[str, str]],
        action: AgentAction,
    ) -> list[dict[str, str]]:
        action_json = json.dumps(action.model_dump(), sort_keys=True, separators=(",", ":"))
        return [*messages, {"role": "assistant", "content": action_json}]

    def append_tool_result(
        self,
        *,
        messages: list[dict[str, str]],
        result: ToolExecutionResult,
        prompts: AgentPromptSet,
    ) -> list[dict[str, str]]:
        payload_json = json.dumps(result.payload, sort_keys=True, separators=(",", ":"))
        content = prompts.render_tool_result(
            action_name=result.action_name,
            payload_json=payload_json,
        )
        return [*messages, {"role": "user", "content": content}]

    def append_final_request(
        self,
        *,
        messages: list[dict[str, str]],
        action: RespondAction,
        prompts: AgentPromptSet,
        current_user_request: str,
    ) -> list[dict[str, str]]:
        if (
            not isinstance(current_user_request, str)
            or current_user_request.strip() == ""
        ):
            raise ValueError("Final response current_user_request must not be blank")
        with_action = self.append_action(messages=messages, action=action)
        payload = {
            "instruction": prompts.render_final_response_request(basis=action.basis),
            "current_user_request": current_user_request,
            "reference_catalog": [],
            "response_mode": "direct_without_note_evidence",
        }
        content = "FINAL_RESPONSE_REQUEST\n" + json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
        )
        return [*with_action, {"role": "user", "content": content}]

    def build_scoped_final_messages(
        self,
        *,
        canonical_messages: list[dict[str, str]],
        prompts: AgentPromptSet,
        state: InvestigationState,
        evidence_payload: InvestigationEvidencePayload,
        basis: str,
    ) -> tuple[list[dict[str, str]], tuple[str, ...]]:
        """Send one bounded evidence payload directly to final generation."""
        if not isinstance(evidence_payload, InvestigationEvidencePayload):
            raise TypeError(
                "evidence_payload must be InvestigationEvidencePayload"
            )
        if not isinstance(basis, str) or basis.strip() == "":
            raise ValueError("Scoped final basis must be non-empty")
        reference_note_ids = evidence_payload.evidence_note_ids
        base = self.build_initial_messages(
            canonical_messages=canonical_messages,
            prompts=prompts,
        )
        included_note_count = len(evidence_payload.evidence_note_ids)
        included_result_tree_count = len(evidence_payload.result_tree_ids)
        omitted_note_count = state.snapshot.note_count - included_note_count
        omitted_result_tree_count = (
            state.snapshot.result_tree_count - included_result_tree_count
        )
        if omitted_note_count < 0 or omitted_result_tree_count < 0:
            raise RuntimeError("Provided evidence counts exceed the frozen scope")
        final_payload = {
            "instruction": prompts.render_final_response_request(basis=basis),
            "frozen_scope": {
                "kind": state.snapshot.descriptor.scope_kind,
                "label": state.snapshot.descriptor.label,
                "search_query": state.snapshot.descriptor.search_query,
                "note_count": state.snapshot.note_count,
                "result_tree_count": state.snapshot.result_tree_count,
            },
            "evidence_coverage": {
                "included_note_count": included_note_count,
                "omitted_note_count": omitted_note_count,
                "included_result_tree_count": included_result_tree_count,
                "omitted_result_tree_count": omitted_result_tree_count,
            },
            "instruction_for_evidence": (
                f"The supplied evidence is {basis}, already grouped into ordered "
                f"root-note trees. It includes {included_note_count} notes in "
                f"{included_result_tree_count} result trees and omits "
                f"{omitted_note_count} notes in {omitted_result_tree_count} result "
                "trees from the frozen scope. The current user's exact request defines "
                "relevance; this payload is candidate evidence, not a checklist. Omit "
                "nodes that do not directly answer the request even if they share the "
                "scope topic. Cite supporting claims as [[note_id]], copying note_id "
                "from the same evidence object whose content_text supports the claim. "
                "Do not infer a citation from tree position or merely cite the "
                "enclosing root."
            ),
            "authoritative_result_trees": list(evidence_payload.result_trees),
        }
        return (
            [
                *base,
                {
                    "role": "user",
                    "content": "FINAL_RESPONSE_REQUEST\n"
                    + json.dumps(final_payload, sort_keys=True, separators=(",", ":")),
                },
            ],
            reference_note_ids,
        )

    @staticmethod
    def _validate_canonical_messages(messages: list[dict[str, str]]) -> None:
        if not isinstance(messages, list) or len(messages) == 0:
            raise ValueError("Canonical agent messages must be a non-empty list")
        for message in messages:
            if not isinstance(message, dict) or set(message) != {"role", "content"}:
                raise ValueError("Canonical agent message must contain role and content")
            if message["role"] not in {"user", "assistant"}:
                raise ValueError("Canonical agent message has unsupported role")
            if not isinstance(message["content"], str) or message["content"] == "":
                raise ValueError("Canonical agent message content must be non-empty")
        if messages[-1]["role"] != "user":
            raise ValueError("Canonical agent context must end with the current user message")
