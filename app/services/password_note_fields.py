"""Prepare note-column rewrites without publishing cache or database state."""

from dataclasses import dataclass
from typing import Mapping

from app.security.note_html import sanitize_note_html
from app.services.encryption import EncryptionService


@dataclass(frozen=True)
class NoteFieldRewrite:
    persisted: dict[str, object]
    plaintext: dict[str, str]


_FIELDS = (
    ('content', 'encryption_nonce', 'encryption_tag'),
    ('tags', 'tags_encryption_nonce', 'tags_encryption_tag'),
    ('proposed_tags', 'proposed_tags_encryption_nonce', 'proposed_tags_encryption_tag'),
)


def prepare_note_rewrite(note: Mapping[str, object], encryption: EncryptionService, *, encrypted: bool) -> NoteFieldRewrite:
    persisted: dict[str, object] = {}
    plaintext: dict[str, str] = {}
    for column, nonce_column, tag_column in _FIELDS:
        stored, nonce, tag = note[column], note[nonce_column], note[tag_column]
        if not isinstance(stored, str):
            raise RuntimeError(f'Note {note["id"]} has invalid {column}; expected text')
        if (nonce is None) != (tag is None):
            raise RuntimeError(f'Note {note["id"]} has incomplete encryption metadata for {column}')
        if encrypted == (nonce is not None):
            continue
        text = stored
        if not encrypted:
            text = encryption.decrypt_from_storage(stored, nonce, tag)
        if column == 'content':
            text = sanitize_note_html(text)
        plaintext[column] = text
        if encrypted:
            ciphertext, new_nonce, new_tag = encryption.encrypt_for_storage(text)
            persisted.update({column: ciphertext, nonce_column: new_nonce, tag_column: new_tag})
        else:
            persisted.update({column: text, nonce_column: None, tag_column: None})
    return NoteFieldRewrite(persisted=persisted, plaintext=plaintext)
