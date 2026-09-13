"""Failure contracts across the extracted persistence and stream boundaries."""
import asyncio

import pytest

from app.services.ai_chat import AiChatSessionStore
from app.services.ai_chat_stream import ChatTurnStream
from app.services.encryption import EncryptionService
from app.services.note_store import NoteStore
from app.services.password_note_fields import prepare_note_rewrite
from app.services import tag_suggestions
from app.usecases.move import CmdMove


def test_password_note_rewrite_round_trip_does_not_mutate_source():
    encryption = EncryptionService()
    encryption.dek = bytes(range(32))
    original = dict(id='note', content='<p>Private note</p>', tags='private', proposed_tags='suggestion',
                    encryption_nonce=None, encryption_tag=None, tags_encryption_nonce=None,
                    tags_encryption_tag=None, proposed_tags_encryption_nonce=None,
                    proposed_tags_encryption_tag=None)
    before = dict(original)
    encrypted = prepare_note_rewrite(original, encryption, encrypted=True)
    assert original == before
    assert all(encrypted.persisted[column] != original[column]
               for column in ('content', 'tags', 'proposed_tags'))
    decrypted = prepare_note_rewrite({**original, **encrypted.persisted}, encryption, encrypted=False)
    assert {**original, **decrypted.persisted} == original
    assert decrypted.plaintext == encrypted.plaintext


@pytest.mark.parametrize('encrypted', [True, False])
def test_password_note_rewrite_rejects_partial_encryption_metadata(encrypted):
    original = dict(id='broken', content='private', encryption_nonce='nonce', encryption_tag=None)
    with pytest.raises(RuntimeError, match='incomplete encryption metadata'):
        prepare_note_rewrite(original, EncryptionService(), encrypted=encrypted)


@pytest.mark.parametrize('events', [
    [{'type': 'unknown'}],
    [{'type': 'content_delta', 'text': 'answer', 'reference_note_ids': []},
     {'type': 'done', 'reference_note_ids': ['new-reference']}],
])
def test_internal_stream_failure_closes_source_and_fails_turn(events):
    store = AiChatSessionStore()
    turn_id = store.start_turn(session_key='test', user_content='question', provider='ollama', model='test')
    stream = ChatTurnStream(store=store, notes=NoteStore(), session_key='test', turn_id=turn_id,
                            initial_input_tokens=1)
    closed = []

    async def source():
        try:
            for event in events:
                yield event
        finally:
            closed.append(True)

    async def consume():
        with pytest.raises(RuntimeError):
            async for _ in stream.events(source()):
                pass
        # Cleanup must finish before control returns, not just at asyncio shutdown.
        assert closed == [True]

    asyncio.run(consume())
    message = store.snapshot(session_key='test')['messages'][-1]
    assert message['status'] == 'error'
    assert message['error'] == 'Internal agent error'


def test_incomplete_ontology_contract_fails_instead_of_disabling_equivalence():
    with pytest.raises(AttributeError):
        tag_suggestions._equivalent_suggestion_group_key(term='tag', ontology=object())


def test_invalid_move_position_fails_before_mutation():
    command = CmdMove(note_id='note', sibling_id='sibling', position='invalid', new_parent_id=None,
                      client_id='client', undo_context='', viewport={})
    with pytest.raises(RuntimeError, match='BEFORE or AFTER'):
        command.execute()
