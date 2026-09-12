"""Build one ordered, token-bounded evidence payload from a frozen scope."""

from __future__ import annotations

from dataclasses import dataclass

from app.services.agent.evidence_serialization import EvidenceNoteTokenSource
from app.services.agent.evidence_serialization import EvidenceTreeTokenSource
from app.services.agent.evidence_serialization import estimate_cached_root_tree_tokens
from app.services.agent.evidence_serialization import serialize_evidence_note_payload
from app.services.agent.evidence_serialization import serialize_evidence_result_trees
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.token_estimation import estimate_input_tokens


@dataclass(frozen=True, slots=True)
class InvestigationEvidencePayload:
    """The run's single evidence payload."""

    evidence_note_ids: tuple[str, ...]
    result_tree_ids: tuple[str, ...]
    result_trees: tuple[dict[str, object], ...]
    returned_approximate_token_count: int


@dataclass(frozen=True, slots=True)
class RootPrefixRetention:
    original_note_count: int
    original_result_tree_count: int
    retained_note_count: int
    retained_result_tree_count: int
    retained_approximate_token_count: int
    retained_root_ids: tuple[str, ...]
    dropped_root_ids: tuple[str, ...]


class InvestigationState:
    """Run-local frozen scope reduced once to an ordered complete-root prefix."""

    def __init__(
        self,
        *,
        snapshot: ScopedSearchSnapshot,
        settings: AgentRetrievalSettings,
    ) -> None:
        if not isinstance(snapshot, ScopedSearchSnapshot):
            raise TypeError("InvestigationState requires ScopedSearchSnapshot")
        if not isinstance(settings, AgentRetrievalSettings):
            raise TypeError("InvestigationState requires AgentRetrievalSettings")
        self._snapshot = snapshot
        self._settings = settings
        self._retained_root_ids = snapshot.ordered_root_ids
        self._retained_note_ids = snapshot.ordered_note_ids
        self._retention_was_applied = False
        self._structure_by_root: dict[str, list[EvidenceTreeTokenSource]] = {
            root_id: [] for root_id in snapshot.ordered_root_ids
        }
        for note_id, node in snapshot.tree_nodes_by_id.items():
            self._structure_by_root[node.root_note_id].append(EvidenceTreeTokenSource(
                note_id=note_id, parent_id=node.parent_id, child_ids=node.child_ids,
            ))

    @classmethod
    def start(
        cls,
        *,
        snapshot: ScopedSearchSnapshot,
        settings: AgentRetrievalSettings,
    ) -> InvestigationState:
        return cls(snapshot=snapshot, settings=settings)

    @property
    def snapshot(self) -> ScopedSearchSnapshot:
        return self._snapshot

    def retain_root_prefix_within_token_budget(self) -> RootPrefixRetention:
        if self._retention_was_applied:
            raise RuntimeError("Evidence root-prefix retention may run only once")
        self._retention_was_applied = True
        note_ids_by_root_id = self._note_ids_by_root_id()
        retained_root_ids: list[str] = []
        retained_token_count = 0
        for root_id in self._snapshot.ordered_root_ids:
            root_token_count = self._full_root_token_cost(
                root_id=root_id,
                note_ids=note_ids_by_root_id[root_id],
            )
            if retained_token_count + root_token_count > (
                self._settings.max_page_approximate_tokens
            ):
                break
            retained_root_ids.append(root_id)
            retained_token_count += root_token_count
        if self._snapshot.ordered_root_ids and not retained_root_ids:
            first_root_id = self._snapshot.ordered_root_ids[0]
            first_root_tokens = self._full_root_token_cost(
                root_id=first_root_id,
                note_ids=note_ids_by_root_id[first_root_id],
            )
            raise ValueError(
                "The first complete result tree requires approximately "
                f"{first_root_tokens:,} tokens, exceeding the configured single "
                "evidence payload limit of "
                f"{self._settings.max_page_approximate_tokens:,} tokens"
            )
        retained_root_ids_tuple = tuple(retained_root_ids)
        retained_root_id_set = set(retained_root_ids_tuple)
        retained_note_ids = tuple(
            note_id
            for note_id in self._snapshot.ordered_note_ids
            if self._snapshot.notes_by_id[note_id].root_note_id
            in retained_root_id_set
        )
        self._retained_root_ids = retained_root_ids_tuple
        self._retained_note_ids = retained_note_ids
        return RootPrefixRetention(
            original_note_count=self._snapshot.note_count,
            original_result_tree_count=self._snapshot.result_tree_count,
            retained_note_count=len(retained_note_ids),
            retained_result_tree_count=len(retained_root_ids_tuple),
            retained_approximate_token_count=retained_token_count,
            retained_root_ids=retained_root_ids_tuple,
            dropped_root_ids=self._snapshot.ordered_root_ids[
                len(retained_root_ids_tuple) :
            ],
        )

    def current_scope_payload(self) -> InvestigationEvidencePayload:
        if not self._retention_was_applied:
            raise RuntimeError("Retain the token-bounded evidence prefix first")
        result_trees = self._serialize_full_result_trees()
        token_count = estimate_input_tokens(result_trees)
        if token_count > self._settings.max_page_approximate_tokens:
            raise RuntimeError(
                "Serialized evidence payload exceeded its precomputed token budget"
            )
        return InvestigationEvidencePayload(
            evidence_note_ids=self._retained_note_ids,
            result_tree_ids=self._retained_root_ids,
            result_trees=result_trees,
            returned_approximate_token_count=token_count,
        )

    def _note_ids_by_root_id(self) -> dict[str, list[str]]:
        note_ids_by_root_id: dict[str, list[str]] = {
            root_id: [] for root_id in self._snapshot.ordered_root_ids
        }
        for note_id in self._snapshot.ordered_note_ids:
            root_id = self._snapshot.notes_by_id[note_id].root_note_id
            if root_id not in note_ids_by_root_id:
                raise RuntimeError("Frozen note refers to an unordered root")
            note_ids_by_root_id[root_id].append(note_id)
        return note_ids_by_root_id

    def _full_root_token_cost(self, *, root_id: str, note_ids: list[str]) -> int:
        evidence_notes = tuple(
            EvidenceNoteTokenSource(
                note_id=note_id,
                content_text=self._snapshot.notes_by_id[note_id].content_text,
                explicit_tag_terms=(
                    self._snapshot.notes_by_id[note_id].explicit_tag_terms
                ),
                proposed_tag_terms=(
                    self._snapshot.notes_by_id[note_id].proposed_tag_terms
                ),
                created_at=self._snapshot.notes_by_id[note_id].created_at,
                updated_at=self._snapshot.notes_by_id[note_id].updated_at,
            )
            for note_id in note_ids
        )
        structure_nodes = tuple(self._structure_by_root[root_id])
        return estimate_cached_root_tree_tokens(
            root_id=root_id,
            evidence_notes=evidence_notes,
            structure_nodes=structure_nodes,
        )

    def _serialize_full_result_trees(self) -> tuple[dict[str, object], ...]:
        serialized_by_id = {
            note_id: serialize_evidence_note_payload(
                note_id=note.note_id,
                content_text=note.content_text,
                explicit_tag_terms=note.explicit_tag_terms,
                proposed_tag_terms=note.proposed_tag_terms,
                created_at=note.created_at,
                updated_at=note.updated_at,
            )
            for note_id in self._retained_note_ids
            for note in (self._snapshot.notes_by_id[note_id],)
        }
        return serialize_evidence_result_trees(
            root_ids=self._retained_root_ids,
            evidence_payloads_by_id=serialized_by_id,
            parent_id_by_id={
                note_id: node.parent_id
                for note_id, node in self._snapshot.tree_nodes_by_id.items()
            },
            child_ids_by_id={
                note_id: node.child_ids
                for note_id, node in self._snapshot.tree_nodes_by_id.items()
            },
        )
