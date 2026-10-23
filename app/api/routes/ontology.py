from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from app.utils.byte_sizes import MIB
from http import HTTPStatus
from fastapi import APIRouter, HTTPException, Request
import re
from typing import Annotated
from typing_extensions import TypedDict
from pydantic import ConfigDict, Field, with_config

from app.api.request_auth import get_request_auth_token
from app.api.transactions import transactional_route
from app.security.sensitive_cache import SensitiveMemo
from app.services.resource_limits import SENSITIVE_MEMO_BYTES
from app.services.search_index import search_index
from app.services.tag_ontology import TagOntology
from app.services.tag_term_matching import list_significant_content_match_segments
from app.utils.not_found import NOT_FOUND
from app.services.note_store import store as note_store
from app.services.sync import generate_new_uuid
from app.services.tag_properties import PROPERTY_SUGGESTIONS_IN_RULE, is_property_term
from app.services.tag_ontology import PropertyAtom, RegexAtom, TagAtom, TextAtom, parse_rules_text, rule_text_tests_values
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

# The longest tag a rename or delete accepts, in characters.
MAX_TAG_LENGTH = 1024
# An equality line (A = B) parses into two rules, A => B and B => A.
_EQUALITY_LINE_RULE_COUNT = 2
# Tag search ranks: prefix matches first, then substring, then fuzzy.
_PREFIX_MATCH_RANK = 0
_SUBSTRING_MATCH_RANK = 1
_FUZZY_MATCH_RANK = 2
# What a Tag Relationships field adds next to its focus tag; "none" ranks tags by use alone.
_SUGGESTION_RELATIONS = frozenset({"none", "incoming", "implied", "synonym"})
# A tag counts as linked to the focus tag once they share this many notes: one shared
# note is chance.
_MIN_SHARED_NOTES = 2
# The focus tags whose related order is kept while their dialog is open (tag names
# are private: the memo is cleared on lock).
_RELATED_ORDER_MEMO_ENTRIES = 4
_related_orders = SensitiveMemo(maxsize=_RELATED_ORDER_MEMO_ENTRIES, max_bytes=SENSITIVE_MEMO_BYTES)


def _maybe_bearer_token(request: Request) -> str:
    token = get_request_auth_token(request)
    if token is None:
        return ""
    return token


@with_config(ConfigDict(strict=True))
class RuleTextRequest(TypedDict):
    text: Annotated[str, Field(min_length=1, max_length=MIB)]


@with_config(ConfigDict(strict=True))
class RenameTagRequest(TypedDict):
    old: Annotated[str, Field(min_length=1, max_length=MAX_TAG_LENGTH)]
    new: Annotated[str, Field(min_length=1, max_length=MAX_TAG_LENGTH)]


@with_config(ConfigDict(strict=True))
class DeleteTagRequest(TypedDict):
    tag: Annotated[str, Field(min_length=1, max_length=MAX_TAG_LENGTH)]


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
        # A rule testing super tag values changes notes' own tags: _refresh_note_tags
        # rebuilds every note's, so it needs no candidates.
        if any(isinstance(atom, PropertyAtom) for atom in rule.lhs):
            continue
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


def _rule_warnings(text: str) -> list[str]:
    """What looks wrong in a saved rule: a super tag term no note can match, most likely
    a typo (jogging:mile>10 where notes say miles)."""
    warnings: list[str] = []
    for rule in parse_rules_text(text=f"{text}\n", filename="ontology_rules:warnings"):
        for atom in rule.lhs:
            if not isinstance(atom, PropertyAtom):
                continue
            condition = atom.condition
            if search_index.uses_property(tag=condition.tag, property_name=condition.name):
                continue
            warnings.append(f"No note has {condition.tag}:{condition.name} yet; check the spelling.")
    return warnings


def _refresh_note_tags(candidate_note_ids: set[str], *, rule_texts: list[str]) -> None:
    """After a rule changed: the candidate notes' tags. A rule testing super tag values
    refreshes the notes it can concern, with their children and the notes referencing
    them, since the tags it gives pass to those (NoteStore.refresh_tags_for_value_rules)."""
    if any(rule_text_tests_values(text) for text in rule_texts):
        note_store.refresh_tags_for_value_rules(rule_texts=[text for text in rule_texts if rule_text_tests_values(text)])
        if all(rule_text_tests_values(text) for text in rule_texts):
            return
    note_store.rebuild_search_index_tag_terms_for_notes(candidate_note_ids)


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
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="text must be a string")
    if text.strip() == "":
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="text must be non-empty")
    candidate_note_ids: set[str] = set()
    if note_store.loaded:
        candidate_note_ids = _collect_candidate_note_ids_for_texts(
            [text],
            filename="ontology_rules:new",
        )
    token = _maybe_bearer_token(request)
    rule_id, normalized = create_rule_line(text=text, token=token)
    if note_store.loaded:
        _refresh_note_tags(candidate_note_ids, rule_texts=[text])
        update_uuid = generate_new_uuid()
        return {"id": rule_id, "text": normalized, "updateUUID": update_uuid, "warnings": _rule_warnings(normalized)}
    return {"id": rule_id, "text": normalized, "warnings": []}


@router.put("/rules/{rule_id}")
@transactional_route
def update_rule(request: Request, rule_id: int, payload: RuleTextRequest) -> dict:
    text = payload["text"]
    if not isinstance(text, str):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="text must be a string")
    if text.strip() == "":
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="text must be non-empty")

    existing_lines = list_rule_lines()
    existing_by_id = {existing_id for existing_id, _text in existing_lines}
    if rule_id not in existing_by_id:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=f"Rule not found: {rule_id}")

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
        _refresh_note_tags(candidate_note_ids, rule_texts=[old_text, text])
        update_uuid = generate_new_uuid()
        return {"id": updated_id, "text": normalized, "updateUUID": update_uuid, "warnings": _rule_warnings(normalized)}
    return {"id": updated_id, "text": normalized, "warnings": []}


@router.delete("/rules/{rule_id}")
@transactional_route
def delete_rule(rule_id: int) -> dict:
    existing_lines = list_rule_lines()
    existing_by_id = {existing_id for existing_id, _text in existing_lines}
    if rule_id not in existing_by_id:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=f"Rule not found: {rule_id}")

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
        _refresh_note_tags(candidate_note_ids, rule_texts=[old_text])
        update_uuid = generate_new_uuid()
        return {"ok": True, "updateUUID": update_uuid}
    return {"ok": True}


@router.post("/rename-tag")
@transactional_route
def rename_tag(request: Request, payload: RenameTagRequest) -> dict:
    old = payload["old"]
    new = payload["new"]
    if not isinstance(old, str) or old.strip() == "":
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="old must be a non-empty string")
    if not isinstance(new, str) or new.strip() == "":
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="new must be a non-empty string")
    if old.strip() == new.strip():
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="old and new must differ")

    token = _maybe_bearer_token(request)
    return apply_rename_tag_everywhere(old=old, new=new, token=token)


@router.post("/delete-tag")
@transactional_route
def delete_tag(request: Request, payload: DeleteTagRequest) -> dict:
    tag = payload["tag"]
    if not isinstance(tag, str) or tag.strip() == "":
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="tag must be a non-empty string")
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
        if isinstance(atom, PropertyAtom):
            return "value", atom.condition.format()
        raise TypeError(f"Unknown atom: {type(atom)}")

    def atom_payload(atom: object) -> dict:
        kind, display = format_atom(atom)
        if kind == "tag":
            return {"kind": kind, "tag": display}
        if kind == "text":
            return {"kind": kind, "text": display}
        if kind == "regex":
            return {"kind": kind, "regex": display}
        if kind == "value":
            # A super tag term: its tag is a chip like any tag, the rest is shown as written.
            assert isinstance(atom, PropertyAtom)
            return {"kind": kind, "value": display, "tag": atom.condition.tag}
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
        if isinstance(atom, PropertyAtom):
            return atom.condition.format()
        raise TypeError(f"Unknown atom: {type(atom)}")

    def record_equality_rule_ids(rules: list, rule_id: int) -> bool:
        if len(rules) != _EQUALITY_LINE_RULE_COUNT:
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
        for edge in ((first_lhs, first_rhs), (first_rhs, first_lhs)):
            if edge not in equality_rule_ids_by_edge:
                equality_rule_ids_by_edge[edge] = set()
            equality_rule_ids_by_edge[edge].add(rule_id)
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
        left_rule_ids: set[int] = set()
        for member in equals:
            key = (candidate, member)
            if key in edge_map:
                left_rule_ids.add(edge_map[key])
        if not left_rule_ids:
            continue
        direct_left.append({"tag": candidate, "ruleIds": sorted(left_rule_ids)})

    for candidate in sorted(right):
        if candidate in equals:
            continue
        right_rule_ids: set[int] = set()
        for member in equals:
            key = (member, candidate)
            if key in edge_map:
                right_rule_ids.add(edge_map[key])
        if not right_rule_ids:
            continue
        direct_right_tags.add(candidate)
        direct_right.append({"tag": candidate, "ruleIds": sorted(right_rule_ids)})

    for candidate in sorted(equals):
        if candidate == tag:
            continue
        if (tag, candidate) in equality_rule_ids_by_edge:
            direct_middle.append({"tag": candidate, "ruleIds": sorted(equality_rule_ids_by_edge[(tag, candidate)])})
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


@dataclass(frozen=True)
class _RelatedOrder:
    """Tags in the order a Tag Relationships field suggests them for its focus tag: linked
    tags first, then tags sharing a word with it, then the rest by use."""

    index_revision: int
    # Compared by identity: editing the rules compiles a new ontology.
    ontology: TagOntology
    linked: tuple[str, ...]
    named_alike: tuple[str, ...]
    by_use: tuple[str, ...]


def _link_score(*, relation: str, shared: int, focus_notes: int, tag_notes: int) -> float:
    """How strongly a tag is linked to the focus tag for `relation` (0 to 1)."""
    assert 0 < shared <= tag_notes and shared <= focus_notes, (shared, tag_notes, focus_notes)
    if relation == "incoming":
        # tag => focus: how many of the tag's notes carry the focus tag.
        return shared / tag_notes
    if relation == "implied":
        # focus => tag: how many of the focus tag's notes carry the tag.
        return shared / focus_notes
    assert relation == "synonym", relation
    # Both ways: the notes they share among the notes either is on.
    return shared / (focus_notes + tag_notes - shared)


def _related_order(*, focus: str, relation: str, tag_counts: dict[str, int]) -> _RelatedOrder:
    ontology = get_ontology()
    key = (focus.casefold(), relation)
    found, kept = _related_orders.lookup(key)
    if found and kept.index_revision == search_index.revision and kept.ontology is ontology:
        return kept
    index_revision = search_index.revision
    focus_notes, written_with_focus = search_index.count_written_tags_on_notes_with(focus)
    left, equal, right = ontology.focus_view(tag=focus)
    # The focus tag, its synonyms, and tags already on this side of it say nothing new.
    excluded = {tag.casefold() for tag in equal} | {focus.casefold()}
    if relation == "incoming":
        excluded |= {tag.casefold() for tag in left}
    elif relation == "implied":
        excluded |= {tag.casefold() for tag in right}
    candidates = [tag for tag in tag_counts if tag.casefold() not in excluded]
    scored = []
    for tag in candidates:
        # A meta tag (@bold, @todo) is formatting or a state, not a topic linked to the
        # focus tag; it is still listed by use, and when "@" is typed.
        if tag.startswith("@") or tag.casefold() not in written_with_focus:
            continue
        tag_shared, tag_notes = written_with_focus[tag.casefold()]
        if tag_shared >= _MIN_SHARED_NOTES:
            score = _link_score(relation=relation, shared=tag_shared, focus_notes=focus_notes, tag_notes=tag_notes)
            scored.append((-score, -tag_shared, tag.casefold(), tag))
    linked = tuple(tag for *_ordering, tag in sorted(scored))
    linked_set = set(linked)
    focus_words = set(list_significant_content_match_segments(focus))
    by_use_order = sorted((tag for tag in candidates if tag not in linked_set), key=lambda tag: (-tag_counts[tag], tag))
    named_alike = tuple(tag for tag in by_use_order if focus_words & set(list_significant_content_match_segments(tag)))
    named_alike_set = set(named_alike)
    order = _RelatedOrder(
        index_revision=index_revision, ontology=ontology, linked=linked, named_alike=named_alike,
        by_use=tuple(tag for tag in by_use_order if tag not in named_alike_set),
    )
    _related_orders.store(key, order)
    return order


def _match_rank(*, needle: str, tag: str) -> int:
    """How a typed text matches a tag (prefix, substring or fuzzy), NOT_FOUND if not at all."""
    folded = tag.casefold()
    if folded.startswith(needle):
        return _PREFIX_MATCH_RANK
    if needle in folded:
        return _SUBSTRING_MATCH_RANK
    if _fuzzy_match(needle, folded):
        return _FUZZY_MATCH_RANK
    return NOT_FOUND


@router.get("/tags")
def list_tags(q: str, limit: int, focus: str, relation: str) -> dict:
    """Tags for a Tag Relationships field. With a `relation` to `focus`, tags linked to the
    focus tag come first, then tags sharing a word with it, then the rest by use; typing
    narrows that order (app/services/agent/skills/help-ontology.md, "Relationship dialogs"). Without one (`relation` "none",
    `focus` ""), by match, then use."""
    if not isinstance(q, str) or not isinstance(focus, str) or not isinstance(relation, str):
        raise TypeError("q, focus and relation must be strings")
    if not isinstance(limit, int):
        raise TypeError("limit must be an int")
    if limit < 0:
        raise ValueError("limit must be >= 0")
    if relation not in _SUGGESTION_RELATIONS:
        raise ValueError(f"Unknown suggestion relation: {relation!r}")
    if (relation == "none") != (focus == ""):
        raise ValueError("A focus tag goes with a relation, and only with one")

    # A super tag term in an incoming condition (jogging:mi, drug:dosage>5): its property
    # names, units and values, as a rule reads them (docs/design/tag-properties.md).
    if relation == "incoming" and is_property_term(q):
        suggestions = search_index.suggest_property_completions(typed=q, place=PROPERTY_SUGGESTIONS_IN_RULE, limit=limit)
        return {
            "totalCount": len(suggestions),
            "tags": [
                {"tag": suggestion.replacement, "count": suggestion.note_count, "label": suggestion.label}
                for suggestion in suggestions
            ],
        }

    ontology = get_ontology()
    # A tag only the rules name is on no note yet.
    tag_counts = {tag: 0 for tag in extract_ontology_tags(ontology)}
    tag_counts.update(search_index.list_tag_frequencies())
    needle = q.casefold().strip()

    if relation != "none":
        order = _related_order(focus=focus, relation=relation, tag_counts=tag_counts)
        ordered: list[str] = []
        for group in (order.linked, order.named_alike):
            ordered.extend(tag for tag in group if needle == "" or _match_rank(needle=needle, tag=tag) != NOT_FOUND)
        rest = [(_match_rank(needle=needle, tag=tag), index, tag) for index, tag in enumerate(order.by_use)]
        ordered.extend(tag for rank, _index, tag in sorted(rest) if needle == "" or rank != NOT_FOUND)
        payload = [{"tag": tag, "count": tag_counts[tag], "label": tag} for tag in ordered[:limit]]
        return {"totalCount": len(tag_counts), "tags": payload}

    if needle == "":
        ordered = sorted(tag_counts, key=lambda tag: (-tag_counts[tag], tag))[:limit]
        return {"totalCount": len(tag_counts), "tags": [{"tag": tag, "count": tag_counts[tag], "label": tag} for tag in ordered]}

    matches: list[tuple[int, int, str]] = []
    for tag in tag_counts:
        rank = _match_rank(needle=needle, tag=tag)
        if rank != NOT_FOUND:
            matches.append((rank, -tag_counts[tag], tag))
    # By rank, then most used, then name.
    matches.sort()
    payload = [{"tag": tag, "count": tag_counts[tag], "label": tag} for _rank, _negative_count, tag in matches[:limit]]
    return {"totalCount": len(tag_counts), "tags": payload}
