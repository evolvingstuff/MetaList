from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from threading import RLock
from typing import List, Mapping, Optional, Sequence, Tuple

from app.db.engine import begin_writer
from app.db.ontology_rules_sql import (
    delete_rule as db_delete_rule,
    fetch_all_rules,
    insert_rule as db_insert_rule,
    update_rule as db_update_rule,
    update_rules_bulk as db_update_rules_bulk,
)
from app.security.encryption import decrypt, encrypt
from app.services.tag_ontology import TagAtom, TagOntology, compile_rules, parse_rules_text


@dataclass(frozen=True)
class OntologyRuleRow:
    id: int
    stored_text: str
    rule_encryption_nonce: Optional[bytes]
    rule_encryption_tag: Optional[bytes]
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class OntologyRulesState:
    rules: Tuple[OntologyRuleRow, ...]
    plaintext_by_id: Mapping[int, str]
    ontology: TagOntology
    is_decrypted: bool


_LOCK = RLock()
_STATE: Optional[OntologyRulesState] = None
# A backslash and the character it escapes.
_ESCAPE_SEQUENCE_LENGTH = 2


def _require_rule_text(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("rule text must be a string")
    stripped = text.strip()
    if stripped == "":
        raise ValueError("rule text must be non-empty")
    return stripped


def _replace_tag_tokens_in_line(*, line: str, old: str, new: str) -> str:
    if not isinstance(line, str):
        raise TypeError("line must be a string")
    if not isinstance(old, str) or old == "":
        raise TypeError("old must be a non-empty string")
    if not isinstance(new, str) or new == "":
        raise TypeError("new must be a non-empty string")

    out = ""
    i = 0
    in_quote: Optional[str] = None
    in_regex = False
    while i < len(line):
        ch = line[i]

        if in_quote is not None:
            out += ch
            if ch == "\\":
                if i + 1 < len(line):
                    out += line[i + 1]
                    i += _ESCAPE_SEQUENCE_LENGTH
                    continue
            if ch == in_quote:
                in_quote = None
            i += 1
            continue

        if in_regex:
            out += ch
            if ch == "\\":
                if i + 1 < len(line):
                    out += line[i + 1]
                    i += _ESCAPE_SEQUENCE_LENGTH
                    continue
            if ch == "/":
                in_regex = False
            i += 1
            continue

        if ch in ('"', "'"):
            in_quote = ch
            out += ch
            i += 1
            continue

        if ch == "/":
            in_regex = True
            out += ch
            i += 1
            continue

        if ch.isspace() or ch in "()":
            out += ch
            i += 1
            continue

        start = i
        while i < len(line):
            nxt = line[i]
            if nxt.isspace() or nxt in "()":
                break
            if nxt in ('"', "'", "/"):
                break
            i += 1
        token = line[start:i]
        if token == old:
            out += new
        else:
            out += token

    return out


def bootstrap_ontology_rules_store(*, connection) -> None:
    """Load ontology rules from SQLite once during startup.

    After this bootstrap, runtime code must treat SQLite as write-only.
    """

    global _STATE
    rows = fetch_all_rules(connection)
    rules: list[OntologyRuleRow] = []
    for row in rows:
        rule_id = row["id"]
        stored_text = row["rule_text"]
        nonce = row["rule_encryption_nonce"]
        tag = row["rule_encryption_tag"]

        if not isinstance(rule_id, int):
            raise TypeError("ontology_rules.id must be an int")
        if not isinstance(stored_text, str):
            raise TypeError("ontology_rules.rule_text must be a string")
        if (nonce is None) != (tag is None):
            raise RuntimeError(
                "ontology_rules row has incomplete encryption metadata: "
                f"id={rule_id} nonce={nonce is not None} tag={tag is not None}"
            )

        created_at = row["created_at"]
        updated_at = row["updated_at"]
        if not isinstance(created_at, datetime):
            raise TypeError("ontology_rules.created_at must be a datetime")
        if not isinstance(updated_at, datetime):
            raise TypeError("ontology_rules.updated_at must be a datetime")

        rules.append(
            OntologyRuleRow(
                id=rule_id,
                stored_text=stored_text,
                rule_encryption_nonce=nonce,
                rule_encryption_tag=tag,
                created_at=created_at,
                updated_at=updated_at,
            )
        )

    # If any row is encrypted, we can only compile after a DEK exists.
    contains_encrypted = any(row.rule_encryption_nonce is not None for row in rules)
    if contains_encrypted:
        state = OntologyRulesState(
            rules=tuple(rules),
            plaintext_by_id={},
            ontology=TagOntology.empty(),
            is_decrypted=False,
        )
    else:
        plaintext_by_id = {row.id: row.stored_text for row in rules}
        ontology = _compile_from_plaintext(plaintext_by_id)
        state = OntologyRulesState(
            rules=tuple(rules),
            plaintext_by_id=plaintext_by_id,
            ontology=ontology,
            is_decrypted=True,
        )

    with _LOCK:
        _STATE = state


def ensure_rules_decrypted_and_compiled(*, token: str) -> None:
    if not isinstance(token, str):
        raise TypeError("token must be a string")

    global _STATE
    with _LOCK:
        state = _STATE
        if state is None:
            raise RuntimeError("Ontology rules store not bootstrapped")
        if state.is_decrypted:
            return

        plaintext_by_id: dict[int, str] = {}
        encrypted_migrations: list[tuple[int, str, Optional[bytes], Optional[bytes], datetime]] = []
        now = datetime.now(timezone.utc)
        for row in state.rules:
            if row.rule_encryption_nonce is None:
                plaintext = row.stored_text
                plaintext_by_id[row.id] = plaintext

                stored_text, nonce, tag = encrypt(plaintext, token)
                if (nonce is None) != (tag is None):
                    raise RuntimeError("Encrypted rule must include both nonce and tag")
                if nonce is not None:
                    encrypted_migrations.append((row.id, stored_text, nonce, tag, now))
                continue
            plaintext_by_id[row.id] = decrypt(
                row.stored_text,
                row.rule_encryption_nonce,
                row.rule_encryption_tag,
                token,
            )

        migrated_by_id: dict[int, tuple[str, Optional[bytes], Optional[bytes]]] = {}
        if encrypted_migrations:
            with begin_writer() as connection:
                db_update_rules_bulk(connection, updates=encrypted_migrations)
            for rule_id, stored_text, nonce, tag, _ in encrypted_migrations:
                migrated_by_id[rule_id] = (stored_text, nonce, tag)

        updated_rows: list[OntologyRuleRow] = []
        for row in state.rules:
            if row.id not in migrated_by_id:
                updated_rows.append(row)
                continue
            stored_text, nonce, tag = migrated_by_id[row.id]
            updated_rows.append(
                OntologyRuleRow(
                    id=row.id,
                    stored_text=stored_text,
                    rule_encryption_nonce=nonce,
                    rule_encryption_tag=tag,
                    created_at=row.created_at,
                    updated_at=now,
                )
            )

        ontology = _compile_from_plaintext(plaintext_by_id)
        _STATE = OntologyRulesState(
            rules=tuple(updated_rows),
            plaintext_by_id=plaintext_by_id,
            ontology=ontology,
            is_decrypted=True,
        )


def _compile_from_plaintext(plaintext_by_id: Mapping[int, str]) -> TagOntology:
    lines = [plaintext_by_id[rid] for rid in sorted(plaintext_by_id.keys())]
    text = "\n".join(lines)
    if text:
        text += "\n"
    parsed = parse_rules_text(text=text, filename="ontology_rules")
    return compile_rules(rules=parsed, filename="ontology_rules")


def get_ontology() -> TagOntology:
    with _LOCK:
        state = _STATE
        if state is None:
            raise RuntimeError("Ontology rules store not bootstrapped")
        if not state.is_decrypted:
            raise RuntimeError("Ontology rules not decrypted yet")
        return state.ontology


def get_ontology_if_ready() -> TagOntology | None:
    with _LOCK:
        state = _STATE
        if state is None or not state.is_decrypted:
            return None
        return state.ontology


def lock_ontology_rules_store() -> None:
    """Discard decrypted rule text while retaining encrypted rows for the next login."""
    global _STATE
    with _LOCK:
        state = _STATE
        if state is None:
            return
        _STATE = OntologyRulesState(
            rules=state.rules,
            plaintext_by_id={},
            ontology=TagOntology.empty(),
            is_decrypted=False,
        )


def list_rule_lines() -> List[Tuple[int, str]]:
    with _LOCK:
        state = _STATE
        if state is None:
            raise RuntimeError("Ontology rules store not bootstrapped")
        if not state.is_decrypted:
            raise RuntimeError("Ontology rules not decrypted yet")
        return [(rid, state.plaintext_by_id[rid]) for rid in sorted(state.plaintext_by_id.keys())]


def _upsert_state_locked(*, rules: Sequence[OntologyRuleRow], plaintext_by_id: Mapping[int, str]) -> None:
    global _STATE
    ontology = _compile_from_plaintext(plaintext_by_id)
    _STATE = OntologyRulesState(
        rules=tuple(rules),
        plaintext_by_id=dict(plaintext_by_id),
        ontology=ontology,
        is_decrypted=True,
    )


def create_rule_line(*, text: str, token: str) -> Tuple[int, str]:
    normalized = _require_rule_text(text)
    if not isinstance(token, str):
        raise TypeError("token must be a string")

    with _LOCK:
        state = _STATE
        if state is None:
            raise RuntimeError("Ontology rules store not bootstrapped")
        if not state.is_decrypted:
            raise RuntimeError("Ontology rules not decrypted yet")

        now = datetime.now(timezone.utc)
        stored_text, nonce, tag = encrypt(normalized, token)
        if (nonce is None) != (tag is None):
            raise RuntimeError("Encrypted rule must include both nonce and tag")

        with begin_writer() as connection:
            rule_id = db_insert_rule(
                connection,
                rule_text=stored_text,
                rule_encryption_nonce=nonce,
                rule_encryption_tag=tag,
                created_at=now,
                updated_at=now,
            )

        updated_rules = list(state.rules)
        updated_rules.append(
            OntologyRuleRow(
                id=rule_id,
                stored_text=stored_text,
                rule_encryption_nonce=nonce,
                rule_encryption_tag=tag,
                created_at=now,
                updated_at=now,
            )
        )

        plaintext_by_id = dict(state.plaintext_by_id)
        plaintext_by_id[rule_id] = normalized

        _upsert_state_locked(rules=updated_rules, plaintext_by_id=plaintext_by_id)
        return rule_id, normalized


def update_rule_line(*, rule_id: int, text: str, token: str) -> Tuple[int, str]:
    if not isinstance(rule_id, int):
        raise TypeError("rule_id must be an int")
    if rule_id < 0:
        raise ValueError("rule_id must be >= 0")
    normalized = _require_rule_text(text)
    if not isinstance(token, str):
        raise TypeError("token must be a string")

    with _LOCK:
        state = _STATE
        if state is None:
            raise RuntimeError("Ontology rules store not bootstrapped")
        if not state.is_decrypted:
            raise RuntimeError("Ontology rules not decrypted yet")
        if rule_id not in state.plaintext_by_id:
            raise IndexError(f"rule_id out of range: {rule_id}")

        now = datetime.now(timezone.utc)
        stored_text, nonce, tag = encrypt(normalized, token)
        if (nonce is None) != (tag is None):
            raise RuntimeError("Encrypted rule must include both nonce and tag")

        with begin_writer() as connection:
            db_update_rule(
                connection,
                rule_id,
                rule_text=stored_text,
                rule_encryption_nonce=nonce,
                rule_encryption_tag=tag,
                updated_at=now,
            )

        updated_rules: list[OntologyRuleRow] = []
        for row in state.rules:
            if row.id != rule_id:
                updated_rules.append(row)
                continue
            updated_rules.append(
                OntologyRuleRow(
                    id=row.id,
                    stored_text=stored_text,
                    rule_encryption_nonce=nonce,
                    rule_encryption_tag=tag,
                    created_at=row.created_at,
                    updated_at=now,
                )
            )

        plaintext_by_id = dict(state.plaintext_by_id)
        plaintext_by_id[rule_id] = normalized
        _upsert_state_locked(rules=updated_rules, plaintext_by_id=plaintext_by_id)
        return rule_id, normalized


def delete_rule_line(*, rule_id: int) -> None:
    if not isinstance(rule_id, int):
        raise TypeError("rule_id must be an int")
    if rule_id < 0:
        raise ValueError("rule_id must be >= 0")

    with _LOCK:
        state = _STATE
        if state is None:
            raise RuntimeError("Ontology rules store not bootstrapped")
        if not state.is_decrypted:
            raise RuntimeError("Ontology rules not decrypted yet")
        if rule_id not in state.plaintext_by_id:
            raise IndexError(f"rule_id out of range: {rule_id}")

        with begin_writer() as connection:
            db_delete_rule(connection, rule_id)

        updated_rules = [row for row in state.rules if row.id != rule_id]
        plaintext_by_id = dict(state.plaintext_by_id)
        plaintext_by_id.pop(rule_id)
        _upsert_state_locked(rules=updated_rules, plaintext_by_id=plaintext_by_id)


def build_direct_edge_rule_map() -> Mapping[tuple[str, str], int]:
    """Map directed (src, dst) edges to the rule_id that created them.

    Only includes implication-style edges where the LHS is exactly one TagAtom.
    Matcher rules are ignored.
    """
    with _LOCK:
        state = _STATE
        if state is None:
            raise RuntimeError("Ontology rules store not bootstrapped")
        if not state.is_decrypted:
            raise RuntimeError("Ontology rules not decrypted yet")

        out: dict[tuple[str, str], int] = {}
        for rule_id, line in state.plaintext_by_id.items():
            rules = parse_rules_text(text=f"{line}\n", filename=f"ontology_rules:{rule_id}")
            for rule in rules:
                if len(rule.lhs) != 1:
                    continue
                atom = rule.lhs[0]
                if not isinstance(atom, TagAtom):
                    continue
                edge = (atom.tag, rule.rhs)
                if edge not in out:
                    out[edge] = rule_id
        return out


def rename_tag_everywhere(*, old: str, new: str, token: str) -> None:
    if not isinstance(old, str) or old.strip() == "":
        raise TypeError("old must be a non-empty string")
    if not isinstance(new, str) or new.strip() == "":
        raise TypeError("new must be a non-empty string")
    if not isinstance(token, str):
        raise TypeError("token must be a string")

    old_tag = old.strip()
    new_tag = new.strip()

    if old_tag == new_tag:
        raise ValueError("old and new tags must differ")

    with _LOCK:
        state = _STATE
        if state is None:
            raise RuntimeError("Ontology rules store not bootstrapped")
        if not state.is_decrypted:
            raise RuntimeError("Ontology rules not decrypted yet")

        updated_plaintext: dict[int, str] = {}
        bulk_updates: list[tuple[int, str, Optional[bytes], Optional[bytes], datetime]] = []
        now = datetime.now(timezone.utc)

        for rule_id, line in state.plaintext_by_id.items():
            replaced = _replace_tag_tokens_in_line(line=line, old=old_tag, new=new_tag)
            updated_plaintext[rule_id] = replaced
            if replaced == line:
                continue
            stored_text, nonce, tag = encrypt(replaced, token)
            if (nonce is None) != (tag is None):
                raise RuntimeError("Encrypted rule must include both nonce and tag")
            bulk_updates.append((rule_id, stored_text, nonce, tag, now))

        if bulk_updates:
            with begin_writer() as connection:
                db_update_rules_bulk(connection, updates=bulk_updates)

        updated_rows: list[OntologyRuleRow] = []
        stored_by_id: dict[int, tuple[str, Optional[bytes], Optional[bytes]]] = {}
        for rule_id, stored_text, nonce, tag, _ in bulk_updates:
            stored_by_id[rule_id] = (stored_text, nonce, tag)

        for row in state.rules:
            if row.id not in stored_by_id:
                updated_rows.append(row)
                continue
            stored_text, nonce, tag = stored_by_id[row.id]
            updated_rows.append(
                OntologyRuleRow(
                    id=row.id,
                    stored_text=stored_text,
                    rule_encryption_nonce=nonce,
                    rule_encryption_tag=tag,
                    created_at=row.created_at,
                    updated_at=now,
                )
            )

        _upsert_state_locked(rules=updated_rows, plaintext_by_id=updated_plaintext)


def delete_tag_everywhere(*, tag: str) -> int:
    if not isinstance(tag, str) or tag.strip() == "":
        raise TypeError("tag must be a non-empty string")

    normalized = tag.strip()
    with _LOCK:
        state = _STATE
        if state is None:
            raise RuntimeError("Ontology rules store not bootstrapped")
        if not state.is_decrypted:
            raise RuntimeError("Ontology rules not decrypted yet")

        deleted_rule_ids: list[int] = []
        for rule_id, line in state.plaintext_by_id.items():
            rules = parse_rules_text(text=f"{line}\n", filename=f"ontology_rules:{rule_id}")
            references_tag = any(
                rule.rhs == normalized
                or any(isinstance(atom, TagAtom) and atom.tag == normalized for atom in rule.lhs)
                for rule in rules
            )
            if references_tag:
                deleted_rule_ids.append(rule_id)

        if not deleted_rule_ids:
            return 0

        with begin_writer() as connection:
            for rule_id in deleted_rule_ids:
                db_delete_rule(connection, rule_id)

        deleted_rule_id_set = set(deleted_rule_ids)
        updated_rows = [row for row in state.rules if row.id not in deleted_rule_id_set]
        updated_plaintext = {
            rule_id: line
            for rule_id, line in state.plaintext_by_id.items()
            if rule_id not in deleted_rule_id_set
        }
        _upsert_state_locked(rules=updated_rows, plaintext_by_id=updated_plaintext)
        return len(deleted_rule_ids)


def extract_ontology_tags(ontology: TagOntology) -> set[str]:
    tags: set[str] = set()
    for src, outs in ontology.implication_out_edges.items():
        if src:
            tags.add(src)
        for dst in outs:
            if dst:
                tags.add(dst)
    for src, outs in ontology.implication_closure.items():
        if src:
            tags.add(src)
        for dst in outs:
            if dst:
                tags.add(dst)
    for src, outs in ontology.implied_by_closure.items():
        if src:
            tags.add(src)
        for dst in outs:
            if dst:
                tags.add(dst)
    for member in ontology.scc_members_by_tag.values():
        for tag in member:
            if tag:
                tags.add(tag)
    return tags
