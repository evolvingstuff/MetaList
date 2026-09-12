from pathlib import Path
import os
import sqlite3
import subprocess
import sys

import pytest

from app.db.live_recovery import LiveDatabaseRecovery, recover_pending_change, _directory
from app.db import live_recovery


def make_pair(directory):
    notes = directory / 'fixture.metalist.db'
    files = directory / 'fixture.metalist.files.db'
    for path in (notes, files):
        with sqlite3.connect(path) as connection:
            connection.execute('CREATE TABLE marker(value TEXT)')
            connection.execute("INSERT INTO marker VALUES ('old')")
    return notes, files


def read_marker(path):
    with sqlite3.connect(path) as connection:
        return connection.execute('SELECT value FROM marker').fetchone()[0]


@pytest.mark.parametrize('stage', ['pending', 'committed', 'before_cleanup'])
def test_process_exit_recovers_all_or_keeps_complete_commit(tmp_path, stage):
    notes, files = make_pair(tmp_path)
    script = '''
from pathlib import Path
import os, sqlite3, sys
from app.db.live_recovery import LiveDatabaseRecovery
notes, files = Path(sys.argv[1]), Path(sys.argv[2])
change = LiveDatabaseRecovery(notes)
change.begin()
for path in (notes, files):
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE marker SET value='new'")
if sys.argv[3] == 'before_cleanup':
    change._finish = lambda: os._exit(23)
if sys.argv[3] != 'pending':
    change.commit()
os._exit(23)
'''
    completed = subprocess.run([sys.executable, '-c', script, str(notes), str(files), stage], check=False)
    assert completed.returncode == 23
    recover_pending_change(notes)
    expected = 'old'
    if stage != 'pending':
        expected = 'new'
    assert read_marker(notes) == expected
    assert read_marker(files) == expected
    assert not _directory(notes).exists()


def test_incomplete_preparation_never_touches_live_databases(tmp_path):
    notes, files = make_pair(tmp_path)
    directory = _directory(notes)
    directory.mkdir()
    (directory / 'preparing.json').write_text('{')
    recover_pending_change(notes)
    assert read_marker(notes) == read_marker(files) == 'old'
    assert not directory.exists()


def test_failed_recovery_retains_journal_for_retry(tmp_path, monkeypatch):
    notes, files = make_pair(tmp_path)
    change = LiveDatabaseRecovery(notes)
    change.begin()
    for path in (notes, files):
        with sqlite3.connect(path) as connection:
            connection.execute("UPDATE marker SET value='new'")
    # A corrupt recovery image must fail before either live target is touched.
    image = _directory(notes) / '1.sqlite'
    original_bytes = image.read_bytes()
    image.write_bytes(b'corrupt transaction image')
    with pytest.raises(RuntimeError, match='checksum'):
        change.rollback()
    assert read_marker(notes) == read_marker(files) == 'new'
    assert _directory(notes).exists()
    image.write_bytes(original_bytes)
    recover_pending_change(notes)
    assert read_marker(notes) == read_marker(files) == 'old'


def test_originally_absent_sidecar_is_removed_on_rollback(tmp_path):
    notes = tmp_path / 'fixture.metalist.db'
    with sqlite3.connect(notes) as connection:
        connection.execute('CREATE TABLE marker(value TEXT)')
    change = LiveDatabaseRecovery(notes)
    change.begin()
    files = tmp_path / 'fixture.metalist.files.db'
    with sqlite3.connect(files) as connection:
        connection.execute('CREATE TABLE marker(value TEXT)')
    change.rollback()
    assert notes.exists()
    assert not files.exists()


def test_duplicate_begin_does_not_release_the_active_transaction_lock(tmp_path):
    notes, files = make_pair(tmp_path)
    original = LiveDatabaseRecovery(notes)
    original.begin()
    with pytest.raises(RuntimeError, match='already active'):
        LiveDatabaseRecovery(notes).begin()
    original.rollback()
    assert read_marker(notes) == read_marker(files) == 'old'


def test_interrupted_rollback_can_retry_the_entire_set(tmp_path, monkeypatch):
    notes, files = make_pair(tmp_path)
    change = LiveDatabaseRecovery(notes)
    change.begin()
    for path in (notes, files):
        with sqlite3.connect(path) as connection:
            connection.execute("UPDATE marker SET value='new'")
    original_copy = live_recovery._copy_sqlite
    def fail_second(source, target):
        if target == files:
            raise OSError('injected recovery I/O failure')
        original_copy(source, target)
    with monkeypatch.context() as patch:
        patch.setattr(live_recovery, '_copy_sqlite', fail_second)
        with pytest.raises(OSError, match='recovery I/O'):
            change.rollback()
    assert _directory(notes).exists()
    recover_pending_change(notes)
    assert read_marker(notes) == read_marker(files) == 'old'
