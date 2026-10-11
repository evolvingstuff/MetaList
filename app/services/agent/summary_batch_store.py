"""Finished batches of a whole-view summary that failed, kept to continue it.

A whole-view summary runs many batches, each a full evidence payload. When one
fails (or the user stops the run), the batches that finished are kept here, in
memory, for the chat session. If the user then asks to continue ("try that
again"), the agent says so (`summarize_view(continues_failed_summary=true)`) and
only the batches without a kept result run, with the original question.

A kept batch is reused only for exactly the same batch: the key covers the
batch's notes and their content, the selected-note context, the model and
thinking level, and the prompts and summary skill (`summary_batch_key`). Kept
batches are dropped after a successful summary, and cleared with the chat
(Clear Chat, a privacy-boundary change, login and logout), like web evidence.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from threading import Lock
from types import MappingProxyType
from typing import Mapping

from app.services.agent.investigation import InvestigationEvidencePayload
from app.services.agent.prompt_settings import AgentPromptSet
from app.services.agent.skill_settings import AgentSkill
from app.services.agent.staged_summary import SummaryBatchResult


@dataclass(frozen=True, slots=True)
class KeptSummaryBatches:
    """The question the failed summary answered, and its finished batches by key."""

    request: str
    results: Mapping[str, SummaryBatchResult]

    def __post_init__(self) -> None:
        if not isinstance(self.request, str) or self.request.strip() == "":
            raise ValueError("A kept summary needs the question it answered")
        if not self.results:
            raise ValueError("A kept summary needs at least one finished batch")
        for key, result in self.results.items():
            if not isinstance(key, str) or len(key) != 64:
                raise ValueError("Kept summary batch keys are SHA-256 hex digests")
            if not isinstance(result, SummaryBatchResult):
                raise TypeError("Kept summary batches must be SummaryBatchResult")


def summary_batch_key(
    *,
    model: str,
    thinking_level: str,
    prompts: AgentPromptSet,
    skill: AgentSkill,
    selected_note_payload: dict[str, object],
    evidence_payload: InvestigationEvidencePayload,
) -> str:
    """Everything that shapes a batch's findings, apart from the question."""
    if not isinstance(model, str) or model == "" or not isinstance(thinking_level, str) or thinking_level == "":
        raise ValueError("A summary batch key needs the model and thinking level")
    material = {
        "model": model,
        "thinking_level": thinking_level,
        "system_prompt": prompts.system_prompt,
        "final_response_prompt": prompts.final_response_prompt,
        "skill": skill.content,
        "selected_note": selected_note_payload,
        "root_ids": list(evidence_payload.result_tree_ids),
        "result_trees": list(evidence_payload.result_trees),
    }
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class SummaryBatchStore:
    def __init__(self) -> None:
        self._kept: dict[str, KeptSummaryBatches] = {}
        self._lock = Lock()

    def keep(self, *, session_key: str, request: str, results: dict[str, SummaryBatchResult]) -> None:
        """Replace the session's kept batches with this failed summary's."""
        _validate_session_key(session_key)
        kept = KeptSummaryBatches(request=request, results=MappingProxyType(dict(results)))
        with self._lock:
            self._kept[session_key] = kept

    def kept(self, *, session_key: str) -> KeptSummaryBatches | None:
        _validate_session_key(session_key)
        with self._lock:
            if session_key not in self._kept:
                return None
            return self._kept[session_key]

    def clear_session(self, *, session_key: str) -> None:
        _validate_session_key(session_key)
        with self._lock:
            self._kept.pop(session_key, None)

    def reset(self) -> None:
        with self._lock:
            self._kept.clear()


def _validate_session_key(session_key: str) -> None:
    if not isinstance(session_key, str) or session_key == "":
        raise ValueError("session_key must be a non-empty string")


summary_batch_store = SummaryBatchStore()
