from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
import re
from typing import Annotated
from typing_extensions import TypedDict
from pydantic import ConfigDict, Field, with_config

from app.api.request_auth import get_request_auth_token
from app.api.transactions import transactional_route
from app.services.search_index import search_index
from app.services.note_store import store as note_store
from app.services.sync import generate_new_uuid
from app.services.view_cache import view_cache
from app.services.tag_ontology import RegexAtom, TagAtom, TextAtom, parse_rules_text
from app.services.ontology_rules_store import (
    build_direct_edge_rule_map,
    create_rule_line,
    delete_rule_line,
    extract_ontology_tags,
    get_ontology,
    list_rule_lines,
    update_rule_line,
)
from app.usecases.rename_tag import apply_rename_tag_everywhere
from app.usecases.delete_tag import apply_delete_tag_everywhere
from app.utils.text_utils import strip_html


def _maybe_bearer_token(request: Request) -> str:
    token = get_request_auth_token(request)
    if token is None:
        return ""
    return token


@with_config(ConfigDict(strict=True))
class RuleTextRequest(TypedDict):
    text: Annotated[str, Field(min_length=1, max_length=1024 * 1024)]


@with_config(ConfigDict(strict=True))
class RenameTagRequest(TypedDict):
    old: Annotated[str, Field(min_length=1, max_length=1024)]
    new: Annotated[str, Field(min_length=1, max_length=1024)]


@with_config(ConfigDict(strict=True))
class DeleteTagRequest(TypedDict):
    tag: Annotated[str, Field(min_length=1, max_length=1024)]


router = APIRouter(prefix="/ontology", tags=["ontology2"])


def _escape_search_phrase(phrase: str) -> str:
    return phrase.replace("\\", "\\\\").replace('"', '\\"')


def _compile_regex(pattern: str, flags: str) -> re.Pattern[str]:
    re_flags = 0
    if "i" in flags:
        re_flags |= re.IGNORECASE
    return re.compile(pattern, re_flags)


def _collect_candidate_note_ids_for_rules(rules: list) -> set[str]:
    candidates: set[str] = set()
    for rule in rules:
        tags: list[str] = []
        phrases: list[str] = []
        regexes: list[re.Pattern[str]] = []
        for atom in rule.lhs:
            if isinstance(atom, TagAtom):
                tags.append(atom.tag)
                continue
            if isinstance(atom, TextAtom):
                phrases.append(atom.phrase)
                continue
            if isinstance(atom, RegexAtom):
                regexes.append(_compile_regex(atom.pattern, atom.flags))
                continue
            raise TypeError(f"Unknown atom: {type(atom)}")

        query_parts: list[str] = []
        query_parts.extend(tags)
        for phrase in phrases:
            query_parts.append(f"\"{_escape_search_phrase(phrase)}\"")

        if query_parts:
            query = " ".join(query_parts)
            note_ids = search_index.query_note_ids(query)
        else:
            note_ids = set(note_store.list_note_ids())

        if regexes:
            filtered: set[str] = set()
            for note_id in note_ids:
                record = note_store.get_note(note_id)
                plaintext = strip_html(record.content)
                if all(regex.search(plaintext) for regex in regexes):
                    filtered.add(note_id)
            note_ids = filtered

        candidates.update(note_ids)
    return candidates


def _collect_candidate_note_ids_for_texts(texts: list[str], *, filename: str) -> set[str]:
    candidates: set[str] = set()
    for text in texts:
        rules = parse_rules_text(text=f"{text}\n", filename=filename)
        candidates.update(_collect_candidate_note_ids_for_rules(rules))
    return candidates


def _fuzzy_match(needle: str, haystack: str) -> bool:
    if not isinstance(needle, str):
        raise TypeError("needle must be a string")
    if not isinstance(haystack, str):
        raise TypeError("haystack must be a string")
    if needle == "":
        return True

    index = 0
    for ch in needle:
        index = haystack.find(ch, index)
        if index < 0:
            return False
        index += 1
    return True


@router.get("/rules")
def list_rules() -> dict:
    rules = [{"id": rule_id, "text": text} for rule_id, text in list_rule_lines()]
    return {"rules": rules}


@router.post("/rules")
@transactional_route
def create_rule(request: Request, payload: RuleTextRequest) -> dict:
    text = payload["text"]
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="text must be a string")
    if text.strip() == "":
        raise HTTPException(status_code=400, detail="text must be non-empty")
    candidate_note_ids: set[str] = set()
    if note_store.loaded:
        candidate_note_ids = _collect_candidate_note_ids_for_texts(
            [text],
            filename="ontology_rules:new",
        )
    token = _maybe_bearer_token(request)
    rule_id, normalized = create_rule_line(text=text, token=token)
    if note_store.loaded:
        note_store.rebuild_search_index_tag_terms_for_notes(candidate_note_ids)
        view_cache.clear()
        update_uuid = generate_new_uuid()
        return {"id": rule_id, "text": normalized, "updateUUID": update_uuid}
    return {"id": rule_id, "text": normalized}


@router.put("/rules/{rule_id}")
@transactional_route
def update_rule(request: Request, rule_id: int, payload: RuleTextRequest) -> dict:
    text = payload["text"]
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="text must be a string")
    if text.strip() == "":
        raise HTTPException(status_code=400, detail="text must be non-empty")

    existing_lines = list_rule_lines()
    existing_by_id = {existing_id for existing_id, _text in existing_lines}
    if rule_id not in existing_by_id:
        raise HTTPException(status_code=404, detail=f"Rule not found: {rule_id}")

    candidate_note_ids: set[str] = set()
    if note_store.loaded:
        old_text = None
        for existing_id, line in existing_lines:
            if existing_id == rule_id:
                old_text = line
                break
        if old_text is None:
            raise RuntimeError("Expected rule text for update")
        candidate_note_ids = _collect_candidate_note_ids_for_texts(
            [old_text, text],
            filename=f"ontology_rules:{rule_id}",
        )

    token = _maybe_bearer_token(request)
    updated_id, normalized = update_rule_line(rule_id=rule_id, text=text, token=token)
    if note_store.loaded:
        note_store.rebuild_search_index_tag_terms_for_notes(candidate_note_ids)
        view_cache.clear()
        update_uuid = generate_new_uuid()
        return {"id": updated_id, "text": normalized, "updateUUID": update_uuid}
    return {"id": updated_id, "text": normalized}


@router.delete("/rules/{rule_id}")
@transactional_route
def delete_rule(rule_id: int) -> dict:
    existing_lines = list_rule_lines()
    existing_by_id = {existing_id for existing_id, _text in existing_lines}
    if rule_id not in existing_by_id:
        raise HTTPException(status_code=404, detail=f"Rule not found: {rule_id}")

    candidate_note_ids: set[str] = set()
    if note_store.loaded:
        old_text = None
        for existing_id, line in existing_lines:
            if existing_id == rule_id:
                old_text = line
                break
        if old_text is None:
            raise RuntimeError("Expected rule text for delete")
        candidate_note_ids = _collect_candidate_note_ids_for_texts(
            [old_text],
            filename=f"ontology_rules:{rule_id}",
        )

    delete_rule_line(rule_id=rule_id)
    if note_store.loaded:
        note_store.rebuild_search_index_tag_terms_for_notes(candidate_note_ids)
        view_cache.clear()
        update_uuid = generate_new_uuid()
        return {"ok": True, "updateUUID": update_uuid}
    return {"ok": True}


@router.post("/rename-tag")
@transactional_route
def rename_tag(request: Request, payload: RenameTagRequest) -> dict:
    old = payload["old"]
    new = payload["new"]
    if not isinstance(old, str) or old.strip() == "":
        raise HTTPException(status_code=400, detail="old must be a non-empty string")
    if not isinstance(new, str) or new.strip() == "":
        raise HTTPException(status_code=400, detail="new must be a non-empty string")
    if old.strip() == new.strip():
        raise HTTPException(status_code=400, detail="old and new must differ")

    token = _maybe_bearer_token(request)
    return apply_rename_tag_everywhere(old=old, new=new, token=token)


@router.post("/delete-tag")
@transactional_route
def delete_tag(request: Request, payload: DeleteTagRequest) -> dict:
    tag = payload["tag"]
    if not isinstance(tag, str) or tag.strip() == "":
        raise HTTPException(status_code=400, detail="tag must be a non-empty string")
    token = _maybe_bearer_token(request)
    return apply_delete_tag_everywhere(tag=tag, token=token)


@router.get("/focus")
def focus_view(tag: str) -> dict:
    ontology = get_ontology()
    left, middle, right = ontology.focus_view(tag=tag)

    edge_map = build_direct_edge_rule_map()
    direct_left: list[dict] = []
    direct_right: list[dict] = []
    direct_middle: list[dict] = []

    incoming_rules: list[dict] = []
    equality_rule_ids_by_edge: dict[tuple[str, str], set[int]] = {}

    equals = set(middle)

    direct_left_tags: set[str] = set()
    direct_right_tags: set[str] = set()

    def format_atom(atom: object) -> tuple[str, str]:
        if isinstance(atom, TagAtom):
            return "tag", atom.tag
        if isinstance(atom, TextAtom):
            escaped = atom.phrase.replace("\\", "\\\\").replace('"', '\\"')
            return "text", f'"{escaped}"'
        if isinstance(atom, RegexAtom):
            return "regex", f"/{atom.pattern}/{atom.flags}"
        raise TypeError(f"Unknown atom: {type(atom)}")

    def atom_payload(atom: object) -> dict:
        kind, display = format_atom(atom)
        if kind == "tag":
            return {"kind": kind, "tag": display}
        if kind == "text":
            return {"kind": kind, "text": display}
        if kind == "regex":
            return {"kind": kind, "regex": display}
        raise RuntimeError(f"Unexpected atom kind: {kind}")

    def format_atom_for_edit(atom: object) -> str:
        if isinstance(atom, TagAtom):
            return atom.tag
        if isinstance(atom, TextAtom):
            escaped = atom.phrase.replace("\\", "\\\\").replace('"', '\\"')
            return f'"{escaped}"'
        if isinstance(atom, RegexAtom):
            escaped = atom.pattern.replace("\\", "\\\\").replace("/", "\\/")
            return f"/{escaped}/{atom.flags}"
        raise TypeError(f"Unknown atom: {type(atom)}")

    def record_equality_rule_ids(rules: list, rule_id: int) -> bool:
        if len(rules) != 2:
            return False
        first, second = rules
        if len(first.lhs) != 1 or len(second.lhs) != 1:
            return False
        if not isinstance(first.lhs[0], TagAtom) or not isinstance(second.lhs[0], TagAtom):
            return False
        first_lhs = first.lhs[0].tag
        first_rhs = first.rhs
        second_lhs = second.lhs[0].tag
        second_rhs = second.rhs
        if first_lhs != second_rhs or first_rhs != second_lhs:
            return False
        equality_rule_ids_by_edge.setdefault((first_lhs, first_rhs), set()).add(rule_id)
        equality_rule_ids_by_edge.setdefault((first_rhs, first_lhs), set()).add(rule_id)
        return True

    for rule_id, text in list_rule_lines():
        rules = parse_rules_text(text=f"{text}\n", filename=f"ontology_rules:{rule_id}")
        # Avoid duplicating SCC/equality rows; the middle column handles synonyms.
        if record_equality_rule_ids(rules, rule_id):
            continue

        matched_rhs: str | None = None
        lhs_tag: str | None = None

        matched_rule = None
        for rule in rules:
            if rule.rhs not in equals:
                continue
            matched_rhs = rule.rhs
            matched_rule = rule
            if len(rule.lhs) == 1 and isinstance(rule.lhs[0], TagAtom):
                lhs_tag = rule.lhs[0].tag
            break
        if matched_rhs is None:
            continue

        if matched_rule is None:
            raise RuntimeError('Expected matched_rule to be set when matched_rhs is present')

        if lhs_tag is not None and lhs_tag in equals:
            continue

        lhs_atoms_payload = [atom_payload(atom) for atom in matched_rule.lhs]

        if len(matched_rule.lhs) == 1:
            atom = matched_rule.lhs[0]
            kind, display = format_atom(atom)
            edit_value = format_atom_for_edit(atom)
        else:
            kind = 'and'
            display = ' '.join(format_atom(atom)[1] for atom in matched_rule.lhs)
            edit_value = ' '.join(format_atom_for_edit(atom) for atom in matched_rule.lhs)

        if lhs_tag is not None and lhs_tag not in equals:
            direct_left_tags.add(lhs_tag)

        incoming_rules.append(
            {
                "id": rule_id,
                "kind": kind,
                "display": display,
                "editValue": edit_value,
                "lhsAtoms": lhs_atoms_payload,
                "text": text,
                "rhs": matched_rhs,
                "lhsTag": lhs_tag,
            }
        )

    for candidate in sorted(left):
        if candidate in equals:
            continue
        rule_ids: set[int] = set()
        for member in equals:
            key = (candidate, member)
            if key in edge_map:
                rule_ids.add(edge_map[key])
        if not rule_ids:
            continue
        direct_left.append({"tag": candidate, "ruleIds": sorted(rule_ids)})

    for candidate in sorted(right):
        if candidate in equals:
            continue
        rule_ids: set[int] = set()
        for member in equals:
            key = (member, candidate)
            if key in edge_map:
                rule_ids.add(edge_map[key])
        if not rule_ids:
            continue
        direct_right_tags.add(candidate)
        direct_right.append({"tag": candidate, "ruleIds": sorted(rule_ids)})

    for candidate in sorted(equals):
        if candidate == tag:
            continue
        equality_rule_ids = equality_rule_ids_by_edge.get((tag, candidate))
        if equality_rule_ids:
            direct_middle.append({"tag": candidate, "ruleIds": sorted(equality_rule_ids)})
            continue
        forward_key = (tag, candidate)
        backward_key = (candidate, tag)
        if forward_key not in edge_map or backward_key not in edge_map:
            continue
        forward = edge_map[forward_key]
        backward = edge_map[backward_key]
        direct_middle.append({"tag": candidate, "ruleIds": sorted({forward, backward})})

    indirect_left = sorted([t for t in left if t not in equals and t not in direct_left_tags])
    indirect_right = sorted([t for t in right if t not in equals and t not in direct_right_tags])
    indirect_middle = sorted([t for t in equals if t != tag and t not in {row["tag"] for row in direct_middle}])

    return {
        "focusTag": tag,
        "incomingRules": incoming_rules,
        "leftDirect": direct_left,
        "leftIndirect": indirect_left,
        "middle": sorted(equals),
        "middleDirect": direct_middle,
        "middleIndirect": indirect_middle,
        "rightDirect": direct_right,
        "rightIndirect": indirect_right,
    }


@router.get("/tags")
def list_tags(q: str, limit: int) -> dict:
    if not isinstance(q, str):
        raise TypeError("q must be a string")
    if not isinstance(limit, int):
        raise TypeError("limit must be an int")
    if limit < 0:
        raise ValueError("limit must be >= 0")

    ontology = get_ontology()
    tag_counts = search_index.list_tag_frequencies()
    tags = set(tag_counts.keys())
    tags.update(extract_ontology_tags(ontology))

    needle = q.casefold().strip()

    if needle == "":
        ordered = sorted(tags, key=lambda tag: (-tag_counts.get(tag, 0), tag))
        ordered = ordered[:limit]
        payload = [
            {"tag": tag, "count": tag_counts.get(tag, 0)}
            for tag in ordered
        ]
        return {"totalCount": len(tags), "tags": payload}

    matches: list[tuple[int, int, str]] = []
    for tag in tags:
        folded = tag.casefold()
        if folded.startswith(needle):
            rank = 0
        elif needle in folded:
            rank = 1
        elif _fuzzy_match(needle, folded):
            rank = 2
        else:
            continue
        count = tag_counts.get(tag, 0)
        matches.append((rank, -count, tag))

    matches.sort(key=lambda item: (item[0], item[1], item[2]))
    results = [item[2] for item in matches]
    results = results[:limit]

    payload = [
        {"tag": tag, "count": tag_counts.get(tag, 0)}
        for tag in results
    ]
    return {"totalCount": len(tags), "tags": payload}
