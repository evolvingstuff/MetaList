"""Atomic, non-undoable application of a fully prepared proposal operation."""

from __future__ import annotations

from app.db.notes_sql import update_note_fields_preserving_updated_at
from app.db.session import begin_request_transaction, begin_writer
from app.services.bulk_operation import bulk_operation_guard
from app.security.encryption import encrypt
from app.services.content_cache import cache_note_tags, cache_note_proposed_tags
from app.services.note_store import store
from app.services.search_history import current_local_date, record_explicit_tag_addition_batch
from app.services.sync import generate_new_uuid, get_current_sync_uuid
from app.services.undo_state import reset_all_undo_state
from app.usecases.tag_proposals import (
    _effective_accepted_tag_keys,
    _proposal_tokens,
    merge_accepted_proposals,
    proposal_says_something_new,
)


def prepare_proposal_changes(note_ids, action, tag_filter, proposals):
    assert action in {"generate", "accept", "remove"}
    changes = {}
    affected = 0
    affected_proposals = {}
    for note_id in note_ids:
        record = store.get_note(note_id)
        pending = list(_proposal_tokens(record.proposed_tags))
        tags = record.tags
        if action == "generate":
            seen = {tag.casefold() for tag in pending} | _effective_accepted_tag_keys(note_id)
            additions = []
            # The AI proposes nothing for some notes.
            note_proposals = ()
            if note_id in proposals:
                note_proposals = proposals[note_id]
            for tag in note_proposals:
                if proposal_says_something_new(proposal=tag, seen=seen, pending=pending, tags=record.tags):
                    pending.append(tag)
                    seen.add(tag.casefold())
                    additions.append(tag)
                    affected += 1
            if additions:
                affected_proposals[note_id] = tuple(additions)
        else:
            selected = [tag for tag in pending if not tag_filter or tag.casefold() == tag_filter.casefold()]
            if selected:
                affected_proposals[note_id] = tuple(selected)
            selected_keys = {tag.casefold() for tag in selected}
            pending = [tag for tag in pending if tag.casefold() not in selected_keys]
            affected += len(selected)
            if action == "accept":
                # Only what adds to the tag bar changes it; normalising every note would
                # "change" notes that have no proposals at all.
                tags = merge_accepted_proposals(tags, tuple(selected))
        proposed = " ".join(pending)
        if tags != record.tags or proposed != record.proposed_tags:
            changes[note_id] = (tags, proposed)
    assert set(affected_proposals) == set(changes)
    return changes, affected, affected_proposals


def apply_bulk_proposals(*, changes: dict[str, tuple[str, str]], token: str) -> str:
    # The requests let through during a bulk operation hold this lock from capturing
    # undo and sync state to any rollback: applying under it, the bulk change never
    # clears undo history while one reads it, nor is undone by one that fails.
    with bulk_operation_guard.lock:
        if not changes:
            return get_current_sync_uuid()
        # Prepare all encrypted fields before opening a write transaction.
        encrypted = {}
        previous_tags = {}
        for note_id, (tags, proposed) in changes.items():
            previous_tags[note_id] = store.get_note(note_id).tags
            fields = {}
            for name, value in (("tags", tags), ("proposed_tags", proposed)):
                ciphertext, nonce, auth_tag = encrypt(value, token)
                fields[name] = ciphertext
                fields[f"{name}_encryption_nonce"] = nonce
                fields[f"{name}_encryption_tag"] = auth_tag
            encrypted[note_id] = fields
        with begin_request_transaction():
            with begin_writer() as connection:
                for note_id, fields in encrypted.items():
                    update_note_fields_preserving_updated_at(connection, note_id, **fields)
            record_explicit_tag_addition_batch(
                tag_changes=tuple((previous_tags[note_id], tags) for note_id, (tags, _) in changes.items()),
                token=token, interacted_on=current_local_date(),
            )
        # No await separates successful commit, publication, and history invalidation.
        store.apply_bulk_tag_sources(changes)
        for note_id, (tags, proposed) in changes.items():
            cache_note_tags(note_id, tags)
            cache_note_proposed_tags(note_id, proposed)
        reset_all_undo_state()
        return generate_new_uuid()
