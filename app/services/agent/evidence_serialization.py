"""Shared serialization for token-counted hierarchical agent evidence."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache

from app.services.agent.token_estimation import estimate_input_tokens


@dataclass(frozen=True, slots=True)
class EvidenceNoteTokenSource:
    note_id: str
    content_text: str
    explicit_tag_terms: tuple[str, ...]
    proposed_tag_terms: tuple[str, ...]
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class EvidenceTreeTokenSource:
    note_id: str
    parent_id: str
    child_ids: tuple[str, ...]


def estimate_cached_root_tree_tokens(
    *,
    root_id: str,
    evidence_notes: tuple[EvidenceNoteTokenSource, ...],
    structure_nodes: tuple[EvidenceTreeTokenSource, ...],
) -> int:
    if root_id == "":
        raise ValueError("Evidence root id must not be empty")
    if not evidence_notes:
        return 0
    return _estimate_cached_root_tree_tokens(
        root_id=root_id,
        evidence_notes=tuple(sorted(evidence_notes, key=lambda note: note.note_id)),
        structure_nodes=tuple(sorted(structure_nodes, key=lambda node: node.note_id)),
    )


@lru_cache(maxsize=32_768)
def _estimate_cached_root_tree_tokens(
    *,
    root_id: str,
    evidence_notes: tuple[EvidenceNoteTokenSource, ...],
    structure_nodes: tuple[EvidenceTreeTokenSource, ...],
) -> int:
    evidence_payloads_by_id = {
        note.note_id: serialize_evidence_note_payload(
            note_id=note.note_id,
            content_text=note.content_text,
            explicit_tag_terms=note.explicit_tag_terms,
            proposed_tag_terms=note.proposed_tag_terms,
            created_at=note.created_at,
            updated_at=note.updated_at,
        )
        for note in evidence_notes
    }
    parent_id_by_id = {
        node.note_id: node.parent_id for node in structure_nodes
    }
    child_ids_by_id = {
        node.note_id: node.child_ids for node in structure_nodes
    }
    result_trees = serialize_evidence_result_trees(
        root_ids=(root_id,),
        evidence_payloads_by_id=evidence_payloads_by_id,
        parent_id_by_id=parent_id_by_id,
        child_ids_by_id=child_ids_by_id,
    )
    if len(result_trees) != 1:
        raise RuntimeError("Evidence root token estimate must serialize one tree")
    return estimate_input_tokens(result_trees)


def serialize_evidence_note_payload(
    *,
    note_id: str,
    content_text: str,
    explicit_tag_terms: tuple[str, ...],
    proposed_tag_terms: tuple[str, ...],
    created_at: str,
    updated_at: str,
) -> dict[str, object]:
    if note_id == "":
        raise ValueError("Evidence note id must not be empty")
    payload: dict[str, object] = {
        "note_id": note_id,
        "content_text": content_text,
        "created_at": created_at,
        "updated_at": updated_at,
    }
    if explicit_tag_terms:
        payload["tags"] = list(explicit_tag_terms)
    if proposed_tag_terms:
        payload["proposed_tags"] = list(proposed_tag_terms)
    return payload


def serialize_evidence_result_trees(
    *,
    root_ids: tuple[str, ...],
    evidence_payloads_by_id: Mapping[str, dict[str, object]],
    parent_id_by_id: Mapping[str, str],
    child_ids_by_id: Mapping[str, tuple[str, ...]],
) -> tuple[dict[str, object], ...]:
    evidence_note_ids = set(evidence_payloads_by_id)
    included_structure_ids = _structure_ids_for_evidence(
        evidence_note_ids=evidence_note_ids,
        parent_id_by_id=parent_id_by_id,
    )
    expected_root_ids = tuple(
        root_id for root_id in root_ids if root_id in included_structure_ids
    )
    return tuple(
        _serialize_result_tree(
            note_id=root_id,
            evidence_note_ids=evidence_note_ids,
            included_structure_ids=included_structure_ids,
            evidence_payloads_by_id=evidence_payloads_by_id,
            child_ids_by_id=child_ids_by_id,
            path=frozenset(),
        )
        for root_id in expected_root_ids
    )


def _structure_ids_for_evidence(
    *,
    evidence_note_ids: set[str],
    parent_id_by_id: Mapping[str, str],
) -> set[str]:
    included_ids = set(evidence_note_ids)
    for evidence_note_id in evidence_note_ids:
        current_id = evidence_note_id
        path_ids: set[str] = set()
        while parent_id_by_id[current_id] != "":
            if current_id in path_ids:
                raise RuntimeError(f"Hierarchy cycle detected at {current_id}")
            path_ids.add(current_id)
            current_id = parent_id_by_id[current_id]
            included_ids.add(current_id)
    return included_ids


def _serialize_result_tree(
    *,
    note_id: str,
    evidence_note_ids: set[str],
    included_structure_ids: set[str],
    evidence_payloads_by_id: Mapping[str, dict[str, object]],
    child_ids_by_id: Mapping[str, tuple[str, ...]],
    path: frozenset[str],
) -> dict[str, object]:
    if note_id in path:
        raise RuntimeError(f"Hierarchy cycle detected at {note_id}")
    child_path = path.union({note_id})
    child_payloads = [
        _serialize_result_tree(
            note_id=child_id,
            evidence_note_ids=evidence_note_ids,
            included_structure_ids=included_structure_ids,
            evidence_payloads_by_id=evidence_payloads_by_id,
            child_ids_by_id=child_ids_by_id,
            path=child_path,
        )
        for child_id in child_ids_by_id[note_id]
        if child_id in included_structure_ids
    ]
    if note_id not in evidence_note_ids:
        return {
            "note_id": note_id,
            "is_evidence": False,
            "children": child_payloads,
        }
    payload = dict(evidence_payloads_by_id[note_id])
    if child_payloads:
        payload["children"] = child_payloads
    return payload
