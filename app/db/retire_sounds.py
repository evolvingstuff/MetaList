"""Retire sound payloads only on an installed live namespace during migration 8→9."""

from contextlib import closing
import json
from pathlib import Path
import sqlite3

SOUND_FIELDS = frozenset({'popup_sound_enabled', 'popup_sound_id', 'ack_sound_enabled', 'ack_sound_id'})
SOUND_PREFERENCES = frozenset({f'pref.reminder_{prefix}{field}' for prefix in ('', 'default_') for field in SOUND_FIELDS})


def _clean_json(value, nonce, tag, removed_keys, encryption_service):
    if value is None or value == '':
        return None
    if (nonce is None) != (tag is None):
        raise RuntimeError('Retired sound settings have incomplete encryption metadata')
    plaintext = value
    if nonce is not None:
        if encryption_service is None:
            raise RuntimeError('Sound retirement requires the namespace DEK')
        plaintext = encryption_service.decrypt_from_storage(value, nonce, tag)
    payload = json.loads(plaintext)
    if not isinstance(payload, dict):
        raise RuntimeError('Sound retirement requires a JSON object')
    if removed_keys.isdisjoint(payload):
        return None
    cleaned = json.dumps({key: entry for key, entry in payload.items() if key not in removed_keys}, separators=(',', ':'))
    if nonce is not None:
        return encryption_service.encrypt_for_storage(cleaned)
    return cleaned, None, None


def retire_sounds(*, connection, encryption_enabled, encryption_service) -> int:
    rewritten = 0
    for row in connection.execute('SELECT id, payload_json, payload_encryption_nonce, payload_encryption_tag FROM reminders').fetchall():
        cleaned = _clean_json(row[1], row[2], row[3], SOUND_FIELDS, encryption_service)
        if cleaned is not None:
            connection.execute('UPDATE reminders SET payload_json=?, payload_encryption_nonce=?, payload_encryption_tag=? WHERE id=?', (*cleaned, row[0]))
            rewritten += 1
    for name, removed_keys in (('client_preferences', SOUND_PREFERENCES), ('command_palette_usage', frozenset({'form.manage_sounds'}))):
        row = connection.execute(f'SELECT {name}_json, {name}_encryption_nonce, {name}_encryption_tag FROM app_settings WHERE id=1').fetchone()
        if row is None:
            continue
        cleaned = _clean_json(*row, removed_keys, encryption_service)
        if cleaned is not None:
            connection.execute(f'UPDATE app_settings SET {name}_json=?, {name}_encryption_nonce=?, {name}_encryption_tag=? WHERE id=1', cleaned)
            rewritten += 1
    database = connection.execute('PRAGMA database_list').fetchone()[2]
    if database:
        notes = Path(database)
        target = notes.with_name(f'{notes.stem}.files{notes.suffix}')
        if not target.exists():
            return rewritten
        with closing(sqlite3.connect(target)) as files:
            _drop_sound_table(files)
    else:
        with closing(sqlite3.connect('file:metalist_files_memory?mode=memory&cache=shared', uri=True)) as files:
            _drop_sound_table(files)
    return rewritten


def _drop_sound_table(connection):
    connection.execute('PRAGMA secure_delete=ON')
    connection.execute('DROP TABLE IF EXISTS sounds')
    connection.commit()
    connection.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    connection.execute('VACUUM')
