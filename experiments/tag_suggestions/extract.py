"""Load a namespace snapshot into a Corpus, unlocking it as login does.

Imported only after __main__ has pointed METALIST_DATA_DIRECTORY and
METALIST_NAMESPACE at the scratch copy: app.config reads them at import time.
"""

from __future__ import annotations

from app.db.migrations import read_database_version
from app.db.version import CURRENT_DATABASE_VERSION
from app.models.database import SafeSession
from app.services.auth_service import AuthService
from app.services.content_cache import populate_cache_from_db
from app.services.note_store import store
from app.services.ontology_rules_store import (
    bootstrap_ontology_rules_store,
    ensure_rules_decrypted_and_compiled,
    list_rule_lines,
)
from app.services.search_index import extract_ordered_tags_for_search
from app.utils.encryption import set_session_dek
from app.utils.text_utils import strip_html

from experiments.tag_suggestions.corpus import Corpus, CorpusNote


def load_snapshot_corpus(*, password: str) -> Corpus:
    """Unlock the scratch copy (any password-protected namespace needs `password`) and read every note."""
    session = SafeSession()
    with SafeSession.allow_reads("experiment:unlock"):
        version = read_database_version(session.connection())
        if version != CURRENT_DATABASE_VERSION:
            raise RuntimeError(
                f"Namespace database is version {version}; this checkout expects {CURRENT_DATABASE_VERSION}. "
                "Open it once with the current MetaList first."
            )
        auth = AuthService(session)
        if auth.has_password():
            if password == "":
                raise RuntimeError("This namespace is password protected: a password is required")
            if not auth.verify_password(password):
                raise RuntimeError("Wrong password for this namespace")
            set_session_dek(auth.unwrap_dek_for_password(password))
        bootstrap_ontology_rules_store(connection=session.connection())
    ensure_rules_decrypted_and_compiled(token="")
    # As unlocking does. An older copy has its notes cleaned once here, written to the copy only.
    cache_session = SafeSession()
    try:
        rows = populate_cache_from_db(cache_session)
        cache_session.commit()
    finally:
        cache_session.close()
    store.load_from_db(None, prefetched_rows=rows)
    return corpus_from_store()


def corpus_from_store() -> Corpus:
    notes: dict[str, CorpusNote] = {}
    children: dict[str | None, tuple[str, ...]] = {}
    pending: list[str | None] = [None]
    while pending:
        parent_id = pending.pop()
        child_ids = tuple(store.get_children(parent_id))
        children[parent_id] = child_ids
        for note_id in child_ids:
            record = store.get_note(note_id)
            assert record.created_at is not None, f"note {note_id} has no creation time"
            terms = extract_ordered_tags_for_search(record.tags)
            notes[note_id] = CorpusNote(
                note_id=note_id,
                parent_id=parent_id,
                content_html=record.content,
                plain_text=strip_html(record.content),
                tags=record.tags,
                explicit_tags=tuple(term for term in terms if not term.startswith("@")),
                meta_tags=tuple(term for term in terms if term.startswith("@")),
                created_at=record.created_at,
            )
            pending.append(note_id)
    rules_text = "\n".join(text for _rule_id, text in list_rule_lines())
    return Corpus(notes=notes, children={key: value for key, value in children.items() if value or key is None},
                  rules_text=rules_text)
