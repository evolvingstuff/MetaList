import hashlib
import json
import sqlite3
from contextlib import closing

import pytest

from app.db.schema import initialize_schema
from app.db.settings_sql import insert_default_settings
from app.db.file_schema import initialize_file_schema
from app.db.migrations import run_database_migrations
from app.services.encryption import EncryptionService
from app.services.backup_service import create_timestamped_backup_for_paths


@pytest.mark.parametrize('encrypted', [False, True])
def test_sound_retirement_preserves_reminders_files_and_historical_archive(tmp_path, encrypted):
    notes = tmp_path/'fixture.metalist.db'
    files = tmp_path/'fixture.metalist.files.db'
    encryption = EncryptionService()
    encryption.dek = b'k'*32
    reminder = {'title': 'Keep this reminder', 'popup_sound_id': 'retired', 'ack_sound_enabled': True}
    preferences = {'pref.theme': 'dark', 'pref.reminder_default_popup_sound_id': 'retired'}
    def fields(payload):
        serialized = json.dumps(payload)
        if encrypted:
            return encryption.encrypt_for_storage(serialized)
        return serialized, None, None
    with closing(sqlite3.connect(notes)) as connection:
        initialize_schema(connection)
        insert_default_settings(connection)
        connection.execute('PRAGMA user_version=8')
        connection.execute('UPDATE app_settings SET client_preferences_json=?, client_preferences_encryption_nonce=?, client_preferences_encryption_tag=? WHERE id=1', fields(preferences))
        connection.execute('INSERT INTO reminders VALUES (?, ?, ?, ?, ?, ?)', ('reminder', *fields(reminder), '2026-09-12', '2026-09-12'))
        connection.commit()
    with closing(sqlite3.connect(files)) as connection:
        initialize_file_schema(connection)
        connection.execute("INSERT INTO files VALUES ('attachment','keep title',NULL,NULL,'{}',NULL,NULL,?,NULL,NULL,'2026-09-12','2026-09-12')", (b'keep attachment bytes',))
        connection.execute('CREATE TABLE sounds AS SELECT * FROM files')
        connection.execute("UPDATE sounds SET id='sound', blob_data=?", (b'retired sound bytes',))
        connection.execute('CREATE TABLE retained_attachment_marker(value TEXT)')
        connection.execute("INSERT INTO retained_attachment_marker VALUES ('keep attachment')")
        connection.commit()
    backup = create_timestamped_backup_for_paths(notes, tmp_path/'backups')
    archive = tmp_path/'backups'/backup.filename
    original = hashlib.sha256(archive.read_bytes()).digest()
    with closing(sqlite3.connect(notes)) as connection:
        service = None
        if encrypted:
            service = encryption
        with connection:
            result = run_database_migrations(connection=connection, encryption_enabled=encrypted, encryption_service=service)
        assert result.applied_versions == (9,)
        row = connection.execute('SELECT payload_json, payload_encryption_nonce, payload_encryption_tag FROM reminders').fetchone()
        payload = row[0]
        if encrypted:
            payload = encryption.decrypt_from_storage(*row)
        assert json.loads(payload) == {'title':'Keep this reminder'}
        row = connection.execute('SELECT client_preferences_json, client_preferences_encryption_nonce, client_preferences_encryption_tag FROM app_settings').fetchone()
        payload = row[0]
        if encrypted:
            payload = encryption.decrypt_from_storage(*row)
        assert json.loads(payload) == {'pref.theme':'dark'}
        assert run_database_migrations(connection=connection, encryption_enabled=encrypted, encryption_service=service).applied_versions == ()
    with closing(sqlite3.connect(files)) as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE name='sounds'").fetchone() is None
        assert connection.execute('SELECT value FROM retained_attachment_marker').fetchone() == ('keep attachment',)
        assert connection.execute('SELECT blob_data FROM files').fetchone() == (b'keep attachment bytes',)
    assert hashlib.sha256(archive.read_bytes()).digest() == original
