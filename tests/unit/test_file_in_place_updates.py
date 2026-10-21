"""In-place updates and rendered previews for files MetaList edits itself (Excalidraw diagrams)."""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

from app.api.upload_limits import _is_upload_request
from app.db.file_schema import FILE_PREVIEWS_TABLE, initialize_file_schema
from app.db.file_session import begin_file_writer, connect_file_reader
from app.db.files_sql import fetch_file, fetch_file_preview
from app.models.database import SafeSession
from app.security.encryption import clear_encryption_key, get_encryption_service, set_encryption_required, set_session_dek
from app.services import file_storage
from app.services.file_registry import FileRegistry, file_registry
from app.services.file_storage import (
    FileNotEditable,
    FilePreviewMissing,
    FileRevisionConflict,
    InvalidFileContent,
    create_file,
    decrypt_all_files_for_plaintext,
    download_file,
    encrypt_all_files_for_active_dek,
    get_file_preview,
    replace_file_content,
    store_file_previews,
    trim_unused_files,
)

SCENE_V1 = json.dumps({"type": "excalidraw", "version": 2, "elements": [], "appState": {}, "files": {}}).encode()
SCENE_V2 = json.dumps({"type": "excalidraw", "version": 2, "elements": [{"id": "r1", "type": "rectangle"}], "appState": {}, "files": {}}).encode()
LIGHT_SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#ffffff"/></svg>'
DARK_SVG = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#121212"/></svg>'


def _clear_shared_memory_file_database() -> None:
    # The in-memory file database is shared for the whole test process; start each test empty.
    with begin_file_writer() as connection:
        connection.execute("DELETE FROM files")
        assert connection.execute(f"SELECT count(*) FROM {FILE_PREVIEWS_TABLE}").fetchone()[0] == 0


@pytest.fixture
def encrypted_files(tmp_path: Path, monkeypatch):
    set_encryption_required(True)
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    set_session_dek(os.urandom(32))
    file_registry.reset()
    _clear_shared_memory_file_database()
    yield
    file_registry.reset()
    clear_encryption_key()
    set_encryption_required(False)
    SafeSession.use_file_db()


@pytest.fixture
def plaintext_files(tmp_path: Path, monkeypatch):
    set_encryption_required(False)
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    file_registry.reset()
    _clear_shared_memory_file_database()
    yield
    file_registry.reset()
    clear_encryption_key()
    set_encryption_required(False)
    SafeSession.use_file_db()


def _create_diagram() -> str:
    record = create_file(
        original_filename="Diagram.excalidraw",
        mime_type="application/vnd.excalidraw+json",
        content_bytes=SCENE_V1,
        token="token",
    )
    assert record.thumbnail_kind == "excalidraw"
    assert record.content_revision == 1
    return record.id


def test_excalidraw_files_are_classified_by_extension_or_mime(encrypted_files) -> None:
    by_extension = create_file(original_filename="a.excalidraw", mime_type="application/json", content_bytes=SCENE_V1, token="token")
    by_mime = create_file(original_filename="b.json", mime_type="application/vnd.excalidraw+json", content_bytes=SCENE_V1, token="token")
    plain_json = create_file(original_filename="c.json", mime_type="application/json", content_bytes=SCENE_V1, token="token")
    assert by_extension.thumbnail_kind == "excalidraw"
    assert by_mime.thumbnail_kind == "excalidraw"
    assert plain_json.thumbnail_kind == "other"


def test_replace_file_content_bumps_revision_and_stays_encrypted(encrypted_files) -> None:
    file_id = _create_diagram()

    updated = replace_file_content(file_id=file_id, content_bytes=SCENE_V2, expected_revision=1, token="token")

    assert updated.content_revision == 2
    assert updated.size_bytes == len(SCENE_V2)
    assert updated.original_filename == "Diagram.excalidraw"
    downloaded = download_file(file_id, "token")
    assert downloaded.content_bytes == SCENE_V2
    assert downloaded.record.content_revision == 2
    with connect_file_reader() as connection:
        row = fetch_file(connection, file_id)
    assert row is not None
    assert row["blob_encryption_nonce"] is not None
    assert SCENE_V2 != row["blob_data"]


def test_replace_file_content_rejects_stale_revision(encrypted_files) -> None:
    file_id = _create_diagram()
    replace_file_content(file_id=file_id, content_bytes=SCENE_V2, expected_revision=1, token="token")

    with pytest.raises(FileRevisionConflict) as captured:
        replace_file_content(file_id=file_id, content_bytes=SCENE_V1, expected_revision=1, token="token")

    assert captured.value.current_revision == 2
    assert download_file(file_id, "token").content_bytes == SCENE_V2


def test_replace_file_content_refuses_ordinary_attachments(encrypted_files) -> None:
    record = create_file(original_filename="report.pdf", mime_type="application/pdf", content_bytes=b"%PDF", token="token")
    with pytest.raises(FileNotEditable):
        replace_file_content(file_id=record.id, content_bytes=b"%PDF-2", expected_revision=1, token="token")
    assert download_file(record.id, "token").content_bytes == b"%PDF"


@pytest.mark.parametrize(
    "content",
    [b"not json", b"[]", json.dumps({"type": "other", "elements": []}).encode(), json.dumps({"type": "excalidraw"}).encode(), b"\xff\xfe"],
)
def test_replace_file_content_rejects_invalid_scenes(encrypted_files, content: bytes) -> None:
    file_id = _create_diagram()
    with pytest.raises(InvalidFileContent):
        replace_file_content(file_id=file_id, content_bytes=content, expected_revision=1, token="token")
    assert download_file(file_id, "token").record.content_revision == 1


def test_previews_round_trip_encrypted_for_the_current_revision(encrypted_files) -> None:
    file_id = _create_diagram()
    with pytest.raises(FilePreviewMissing):
        get_file_preview(file_id=file_id, variant="light", token="token")

    store_file_previews(file_id=file_id, previews_by_variant={"light": LIGHT_SVG, "dark": DARK_SVG}, content_revision=1, token="token")

    light = get_file_preview(file_id=file_id, variant="light", token="token")
    dark = get_file_preview(file_id=file_id, variant="dark", token="token")
    assert (light.content_bytes, light.mime_type, light.content_revision) == (LIGHT_SVG, "image/svg+xml", 1)
    assert dark.content_bytes == DARK_SVG
    with connect_file_reader() as connection:
        row = fetch_file_preview(connection, file_id, "light")
    assert row is not None
    assert row["preview_encryption_nonce"] is not None
    assert LIGHT_SVG != row["preview_data"]


def test_previews_reject_stale_revisions_missing_variants_and_non_svg(encrypted_files) -> None:
    file_id = _create_diagram()
    replace_file_content(file_id=file_id, content_bytes=SCENE_V2, expected_revision=1, token="token")

    with pytest.raises(FileRevisionConflict):
        store_file_previews(file_id=file_id, previews_by_variant={"light": LIGHT_SVG, "dark": DARK_SVG}, content_revision=1, token="token")
    with pytest.raises(InvalidFileContent):
        store_file_previews(file_id=file_id, previews_by_variant={"light": LIGHT_SVG}, content_revision=2, token="token")
    with pytest.raises(InvalidFileContent):
        store_file_previews(file_id=file_id, previews_by_variant={"light": LIGHT_SVG, "dark": b"<html></html>"}, content_revision=2, token="token")

    store_file_previews(file_id=file_id, previews_by_variant={"light": LIGHT_SVG, "dark": DARK_SVG}, content_revision=2, token="token")
    assert get_file_preview(file_id=file_id, variant="dark", token="token").content_revision == 2


def test_previews_are_refused_for_ordinary_attachments(encrypted_files) -> None:
    record = create_file(original_filename="photo.png", mime_type="image/png", content_bytes=b"png", token="token")
    with pytest.raises(FileNotEditable):
        store_file_previews(file_id=record.id, previews_by_variant={"light": LIGHT_SVG, "dark": DARK_SVG}, content_revision=1, token="token")


@dataclass(frozen=True)
class _FakeNote:
    content: str


class _FakeNoteStore:
    loaded = True

    def __init__(self, notes: dict[str, _FakeNote]) -> None:
        self._notes = notes

    def list_note_ids(self) -> list[str]:
        return list(self._notes.keys())

    def get_note(self, note_id: str) -> _FakeNote:
        return self._notes[note_id]


def test_trimming_an_unused_diagram_deletes_its_previews(encrypted_files, monkeypatch) -> None:
    kept_id = _create_diagram()
    dropped_id = _create_diagram()
    for file_id in (kept_id, dropped_id):
        store_file_previews(file_id=file_id, previews_by_variant={"light": LIGHT_SVG, "dark": DARK_SVG}, content_revision=1, token="token")
    monkeypatch.setattr(file_storage, "note_store", _FakeNoteStore({"note": _FakeNote(content=f"<div>![[{kept_id}]]</div>")}))

    result = trim_unused_files()

    assert result.deleted_file_ids == [dropped_id]
    with connect_file_reader() as connection:
        remaining = connection.execute(f"SELECT file_id FROM {FILE_PREVIEWS_TABLE} ORDER BY variant").fetchall()
    assert {row["file_id"] for row in remaining} == {kept_id}


def test_encryption_migrations_rewrite_previews(plaintext_files) -> None:
    file_id = _create_diagram()
    store_file_previews(file_id=file_id, previews_by_variant={"light": LIGHT_SVG, "dark": DARK_SVG}, content_revision=1, token="token")
    with connect_file_reader() as connection:
        plain_row = fetch_file_preview(connection, file_id, "dark")
    assert plain_row is not None and plain_row["preview_data"] == DARK_SVG

    set_session_dek(os.urandom(32))
    service = get_encryption_service()
    encrypt_all_files_for_active_dek(encryption_service=service)
    with connect_file_reader() as connection:
        encrypted_row = fetch_file_preview(connection, file_id, "dark")
    assert encrypted_row is not None
    assert encrypted_row["preview_encryption_nonce"] is not None
    assert encrypted_row["content_revision"] == 1
    assert get_file_preview(file_id=file_id, variant="dark", token="token").content_bytes == DARK_SVG

    decrypt_all_files_for_plaintext(encryption_service=service)
    with connect_file_reader() as connection:
        decrypted_row = fetch_file_preview(connection, file_id, "dark")
    assert decrypted_row is not None
    assert decrypted_row["preview_data"] == DARK_SVG
    assert decrypted_row["preview_encryption_nonce"] is None


def test_schema_upgrade_adds_revisions_and_previews_to_existing_file_databases(tmp_path: Path) -> None:
    database_path = tmp_path / "old.files.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE files (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, title_encryption_nonce BLOB, title_encryption_tag BLOB,
                metadata_json TEXT NOT NULL, metadata_encryption_nonce BLOB, metadata_encryption_tag BLOB,
                blob_data BLOB NOT NULL, blob_encryption_nonce BLOB, blob_encryption_tag BLOB,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "INSERT INTO files (id, title, metadata_json, blob_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            ("legacy", "a.txt", "{}", b"legacy bytes", "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"),
        )

    with sqlite3.connect(database_path) as connection:
        initialize_file_schema(connection)
        initialize_file_schema(connection)
        revision = connection.execute("SELECT content_revision FROM files WHERE id='legacy'").fetchone()[0]
        blob = connection.execute("SELECT blob_data FROM files WHERE id='legacy'").fetchone()[0]
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert revision == 1
    assert blob == b"legacy bytes"
    assert FILE_PREVIEWS_TABLE in tables


def test_http_routes_update_diagrams_and_serve_previews(tmp_path: Path) -> None:
    script = '''
from fastapi.testclient import TestClient
from app.main import app
from app.config import API_PREFIX
from app.services.tokens import token_service

scene_v1 = b'{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}'
scene_v2 = b'{"type":"excalidraw","version":2,"elements":[{"id":"r1"}],"appState":{},"files":{}}'
light = b'<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
dark = b'<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>'
token = token_service.create_token(client_info="fixture", owner_tab_id="tab", dek=None)
headers = {"Authorization": "Bearer " + token, "X-Metalist-Tab-Id": "tab", "Origin": "http://localhost"}
with TestClient(app, base_url="http://localhost", raise_server_exceptions=False) as client:
    created = client.post(API_PREFIX + "/files/upload", headers=headers,
                          files={"file": ("Diagram.excalidraw", scene_v1, "application/vnd.excalidraw+json")})
    assert created.status_code == 200, created.text
    file_id = created.json()["file_id"]
    assert created.json()["thumbnail_kind"] == "excalidraw"

    download = client.get(API_PREFIX + f"/files/{file_id}/download", headers=headers)
    assert download.headers["X-MetaList-File-Revision"] == "1"

    updated = client.put(API_PREFIX + f"/files/{file_id}/content", headers=headers,
                         files={"file": ("Diagram.excalidraw", scene_v2, "application/vnd.excalidraw+json")},
                         data={"expected_revision": "1"})
    assert updated.status_code == 200, updated.text
    assert updated.json() == {"file_id": file_id, "content_revision": 2, "size_bytes": len(scene_v2)}

    stale = client.put(API_PREFIX + f"/files/{file_id}/content", headers=headers,
                       files={"file": ("Diagram.excalidraw", scene_v1, "application/vnd.excalidraw+json")},
                       data={"expected_revision": "1"})
    assert stale.status_code == 409, stale.text
    assert stale.json()["currentRevision"] == 2

    missing = client.get(API_PREFIX + f"/files/{file_id}/previews/light", headers=headers)
    assert missing.status_code == 404, missing.text

    stored = client.put(API_PREFIX + f"/files/{file_id}/previews", headers=headers,
                        files={"light": ("light.svg", light, "image/svg+xml"), "dark": ("dark.svg", dark, "image/svg+xml")},
                        data={"content_revision": "2"})
    assert stored.status_code == 200, stored.text
    preview = client.get(API_PREFIX + f"/files/{file_id}/previews/dark", headers=headers)
    assert preview.status_code == 200, preview.text
    assert preview.content == dark
    assert preview.headers["content-type"].startswith("image/svg+xml")
    assert preview.headers["X-MetaList-File-Revision"] == "2"

    bad_variant = client.get(API_PREFIX + f"/files/{file_id}/previews/sepia", headers=headers)
    assert bad_variant.status_code == 404, bad_variant.text

    pdf = client.post(API_PREFIX + "/files/upload", headers=headers, files={"file": ("a.pdf", b"%PDF", "application/pdf")})
    refused = client.put(API_PREFIX + f"/files/{pdf.json()['file_id']}/content", headers=headers,
                         files={"file": ("a.pdf", b"%PDF-2", "application/pdf")}, data={"expected_revision": "1"})
    assert refused.status_code == 400, refused.text

    unauthenticated = client.put(API_PREFIX + f"/files/{file_id}/content",
                                 files={"file": ("Diagram.excalidraw", scene_v2, "application/vnd.excalidraw+json")},
                                 data={"expected_revision": "2"}, headers={"Origin": "http://localhost"})
    assert unauthenticated.status_code == 401, unauthenticated.text
print("ROUTES OK")
'''
    environment = dict(os.environ, METALIST_DATA_DIRECTORY=str(tmp_path), METALIST_ENVIRONMENT="production")
    result = subprocess.run([sys.executable, "-c", script], env=environment, capture_output=True, encoding="utf-8", timeout=60)
    assert result.returncode == 0, (result.stdout[-2000:], result.stderr[-3000:])
    assert "ROUTES OK" in result.stdout


@pytest.mark.parametrize(
    ("method", "path", "expected"),
    [
        ("POST", "/api2/files/upload", True),
        ("PUT", "/api2/files/abc/content", True),
        ("PUT", "/api2/files/abc/previews", True),
        ("GET", "/api2/files/abc/previews/light", False),
        ("GET", "/api2/files/abc/download", False),
        ("PUT", "/api2/notes/abc/content", False),
    ],
)
def test_in_place_file_updates_share_the_upload_size_limits(method: str, path: str, expected: bool) -> None:
    assert _is_upload_request({"method": method, "path": path}) is expected


def test_diagrams_can_be_resized_like_images_but_other_files_cannot() -> None:
    registry = FileRegistry()
    registry.replace_all_with_thumbnail_kinds({"diagram": "excalidraw", "photo": "image", "report": "pdf"})
    assert registry.has_resizable_file("diagram") is True
    assert registry.has_resizable_file("photo") is True
    assert registry.has_resizable_file("report") is False
    assert registry.has_image_file("diagram") is False


# --- Editing sessions: one undo step per session, and Discard restores the opening snapshot ---

SCENE_V3 = json.dumps({"type": "excalidraw", "version": 2, "elements": [{"id": "r1"}, {"id": "e1", "type": "ellipse"}], "appState": {}, "files": {}}).encode()
LIGHT_SVG_V3 = b'<svg xmlns="http://www.w3.org/2000/svg"><ellipse fill="#ffffff"/></svg>'
DARK_SVG_V3 = b'<svg xmlns="http://www.w3.org/2000/svg"><ellipse fill="#121212"/></svg>'
UNDO_CONTEXT = "tab:main|search:|epoch:0"
VIEWPORT = {"scrollY": 0, "scrollAnchor": None}


def _stored_previews(file_id: str) -> dict[str, tuple[bytes, int]]:
    previews = {}
    for variant in ("light", "dark"):
        preview = file_storage.find_file_preview(file_id=file_id, variant=variant, token="token")
        if preview is not None:
            previews[variant] = (preview.content_bytes, preview.content_revision)
    return previews


def _edit_twice_and_render(file_id: str, *, start_revision: int) -> int:
    """Two autosaves followed by Done's preview render, as the editor does."""
    replace_file_content(file_id=file_id, content_bytes=SCENE_V2, expected_revision=start_revision, token="token")
    final = replace_file_content(file_id=file_id, content_bytes=SCENE_V3, expected_revision=start_revision + 1, token="token")
    store_file_previews(
        file_id=file_id,
        previews_by_variant={"light": LIGHT_SVG_V3, "dark": DARK_SVG_V3},
        content_revision=final.content_revision,
        token="token",
    )
    return final.content_revision


@pytest.fixture
def edit_sessions():
    from app.services import undo_state
    from app.services.file_edit_sessions import reset_all_file_edit_sessions

    undo_state.reset_all_undo_state()
    yield undo_state
    undo_state.reset_all_undo_state()
    reset_all_file_edit_sessions()


def test_restoring_a_snapshot_writes_content_and_previews_as_the_next_revision(encrypted_files) -> None:
    file_id = _create_diagram()
    store_file_previews(file_id=file_id, previews_by_variant={"light": LIGHT_SVG, "dark": DARK_SVG}, content_revision=1, token="token")
    snapshot = file_storage.capture_file_snapshot(file_id=file_id, token="token")
    assert snapshot.content_revision == 1
    assert snapshot.previews_by_variant == {"light": LIGHT_SVG, "dark": DARK_SVG}
    _edit_twice_and_render(file_id, start_revision=1)

    restored = file_storage.restore_file_snapshot(snapshot=snapshot, token="token")

    assert restored.content_revision == 4
    assert download_file(file_id, "token").content_bytes == SCENE_V1
    assert _stored_previews(file_id) == {"light": (LIGHT_SVG, 4), "dark": (DARK_SVG, 4)}
    with connect_file_reader() as connection:
        row = fetch_file_preview(connection, file_id, "light")
    assert row is not None and row["preview_encryption_nonce"] is not None


def test_restoring_a_snapshot_taken_before_any_render_removes_newer_previews(encrypted_files) -> None:
    file_id = _create_diagram()
    snapshot = file_storage.capture_file_snapshot(file_id=file_id, token="token")
    assert snapshot.previews_by_variant == {}
    _edit_twice_and_render(file_id, start_revision=1)

    file_storage.restore_file_snapshot(snapshot=snapshot, token="token")

    assert download_file(file_id, "token").content_bytes == SCENE_V1
    assert _stored_previews(file_id) == {}


def test_snapshots_are_refused_for_ordinary_attachments(encrypted_files) -> None:
    record = create_file(original_filename="report.pdf", mime_type="application/pdf", content_bytes=b"%PDF", token="token")
    with pytest.raises(FileNotEditable):
        file_storage.capture_file_snapshot(file_id=record.id, token="token")


def test_an_editing_session_undoes_and_redoes_as_one_step(encrypted_files, edit_sessions, monkeypatch) -> None:
    from app.usecases.file_edit_session import CmdFinishFileEditSession, CmdStartFileEditSession

    monkeypatch.setattr(edit_sessions, "_root_ancestor_id", lambda note_id: note_id)
    file_id = _create_diagram()
    started = CmdStartFileEditSession(file_id=file_id, token="token").execute()
    assert started["contentRevision"] == 1
    final_revision = _edit_twice_and_render(file_id, start_revision=1)

    finished = CmdFinishFileEditSession(
        file_id=file_id, session_id=started["sessionId"], host_note_id="host", content_revision=final_revision,
        is_new_diagram=False, token="token", client_id="client", undo_context=UNDO_CONTEXT, viewport=VIEWPORT,
    ).execute()

    assert finished["undoStepRecorded"] is True
    assert finished["contentRevision"] == 3
    history = edit_sessions._ctx("client").history
    assert [op["type"] for op in history] == ["file_content"]
    from app.services.file_edit_sessions import open_file_edit_session_count
    assert open_file_edit_session_count() == 0

    undone = edit_sessions.undo("client", "token")
    assert undone["opType"] == "file_content"
    assert undone["focusNoteId"] == "host"
    assert download_file(file_id, "token").content_bytes == SCENE_V1
    assert download_file(file_id, "token").record.content_revision == 4
    assert _stored_previews(file_id) == {}

    edit_sessions.redo("client", "token")
    assert download_file(file_id, "token").content_bytes == SCENE_V3
    assert _stored_previews(file_id) == {"light": (LIGHT_SVG_V3, 5), "dark": (DARK_SVG_V3, 5)}
    assert edit_sessions.undo("client", "token")["opType"] == "file_content"
    assert edit_sessions.undo("client", "token") is None


def test_sessions_that_change_nothing_or_lost_a_conflict_record_no_undo_step(encrypted_files, edit_sessions) -> None:
    from app.usecases.file_edit_session import CmdFinishFileEditSession, CmdStartFileEditSession

    file_id = _create_diagram()

    def finish(session_id: str, revision: int) -> dict:
        return CmdFinishFileEditSession(
            file_id=file_id, session_id=session_id, host_note_id="host", content_revision=revision,
            is_new_diagram=False, token="token", client_id="client", undo_context=UNDO_CONTEXT, viewport=VIEWPORT,
        ).execute()

    untouched = CmdStartFileEditSession(file_id=file_id, token="token").execute()
    assert finish(untouched["sessionId"], 1) == {"undoStepRecorded": False, "contentRevision": 1, "updateUUID": _current_sync_uuid()}

    drawn_then_erased = CmdStartFileEditSession(file_id=file_id, token="token").execute()
    replace_file_content(file_id=file_id, content_bytes=SCENE_V2, expected_revision=1, token="token")
    replace_file_content(file_id=file_id, content_bytes=SCENE_V1, expected_revision=2, token="token")
    assert finish(drawn_then_erased["sessionId"], 3)["undoStepRecorded"] is False

    overtaken = CmdStartFileEditSession(file_id=file_id, token="token").execute()
    replace_file_content(file_id=file_id, content_bytes=SCENE_V2, expected_revision=3, token="token")
    replace_file_content(file_id=file_id, content_bytes=SCENE_V3, expected_revision=4, token="token")  # another window
    assert finish(overtaken["sessionId"], 4)["undoStepRecorded"] is False

    new_diagram = CmdStartFileEditSession(file_id=file_id, token="token").execute()
    replace_file_content(file_id=file_id, content_bytes=SCENE_V2, expected_revision=5, token="token")
    # Undoing the diagram's insertion into its note already removes this drawing.
    assert CmdFinishFileEditSession(
        file_id=file_id, session_id=new_diagram["sessionId"], host_note_id="host", content_revision=6,
        is_new_diagram=True, token="token", client_id="client", undo_context=UNDO_CONTEXT, viewport=VIEWPORT,
    ).execute()["undoStepRecorded"] is False

    assert edit_sessions._ctx("client").history == []


def _current_sync_uuid() -> str:
    from app.services.sync import get_current_sync_uuid

    return get_current_sync_uuid()


def test_discard_restores_the_opening_snapshot_without_an_undo_step(encrypted_files, edit_sessions) -> None:
    from app.usecases.file_edit_session import CmdDiscardFileEditSession, CmdStartFileEditSession

    file_id = _create_diagram()
    store_file_previews(file_id=file_id, previews_by_variant={"light": LIGHT_SVG, "dark": DARK_SVG}, content_revision=1, token="token")
    started = CmdStartFileEditSession(file_id=file_id, token="token").execute()
    final_revision = _edit_twice_and_render(file_id, start_revision=1)

    discarded = CmdDiscardFileEditSession(
        file_id=file_id, session_id=started["sessionId"], content_revision=final_revision, token="token",
    ).execute()

    assert discarded["contentRevision"] == 4
    assert download_file(file_id, "token").content_bytes == SCENE_V1
    assert _stored_previews(file_id) == {"light": (LIGHT_SVG, 4), "dark": (DARK_SVG, 4)}
    assert edit_sessions._ctx("client").history == []

    unchanged = CmdStartFileEditSession(file_id=file_id, token="token").execute()
    assert CmdDiscardFileEditSession(
        file_id=file_id, session_id=unchanged["sessionId"], content_revision=4, token="token",
    ).execute()["contentRevision"] == 4


def test_discard_leaves_another_windows_save_alone(encrypted_files, edit_sessions) -> None:
    from app.services.file_edit_sessions import FileEditSessionMissing, open_file_edit_session_count
    from app.usecases.file_edit_session import CmdDiscardFileEditSession, CmdStartFileEditSession

    file_id = _create_diagram()
    started = CmdStartFileEditSession(file_id=file_id, token="token").execute()
    replace_file_content(file_id=file_id, content_bytes=SCENE_V2, expected_revision=1, token="token")
    replace_file_content(file_id=file_id, content_bytes=SCENE_V3, expected_revision=2, token="token")  # another window

    with pytest.raises(FileRevisionConflict):
        CmdDiscardFileEditSession(file_id=file_id, session_id=started["sessionId"], content_revision=2, token="token").execute()

    assert download_file(file_id, "token").content_bytes == SCENE_V3
    assert open_file_edit_session_count() == 0
    with pytest.raises(FileEditSessionMissing):
        CmdDiscardFileEditSession(file_id=file_id, session_id=started["sessionId"], content_revision=3, token="token").execute()


def test_edit_sessions_are_bounded_and_cleared_with_undo_state(encrypted_files, edit_sessions, monkeypatch) -> None:
    from app.services import file_edit_sessions

    file_id = _create_diagram()
    other_id = _create_diagram()
    first = file_edit_sessions.start_file_edit_session(file_id=file_id, token="token")
    with pytest.raises(file_edit_sessions.FileEditSessionMissing):
        file_edit_sessions.get_file_edit_session(session_id=first.session_id, file_id=other_id)
    for _ in range(file_edit_sessions.MAX_OPEN_FILE_EDIT_SESSIONS):
        file_edit_sessions.start_file_edit_session(file_id=other_id, token="token")
    assert file_edit_sessions.open_file_edit_session_count() == file_edit_sessions.MAX_OPEN_FILE_EDIT_SESSIONS
    with pytest.raises(file_edit_sessions.FileEditSessionMissing):
        file_edit_sessions.get_file_edit_session(session_id=first.session_id, file_id=file_id)

    latest = file_edit_sessions.start_file_edit_session(file_id=file_id, token="token")
    real_monotonic = file_edit_sessions.monotonic
    monkeypatch.setattr(
        file_edit_sessions, "monotonic",
        lambda: real_monotonic() + file_edit_sessions.FILE_EDIT_SESSION_MAX_AGE_SECONDS + 1,
    )
    with pytest.raises(file_edit_sessions.FileEditSessionMissing):
        file_edit_sessions.get_file_edit_session(session_id=latest.session_id, file_id=file_id)
    assert file_edit_sessions.open_file_edit_session_count() == 0

    monkeypatch.setattr(file_edit_sessions, "monotonic", real_monotonic)
    file_edit_sessions.start_file_edit_session(file_id=file_id, token="token")
    edit_sessions.reset_all_undo_state()
    assert file_edit_sessions.open_file_edit_session_count() == 0


def test_http_edit_session_routes_record_one_undo_step(tmp_path: Path) -> None:
    script = '''
from fastapi.testclient import TestClient
from app.main import app
from app.config import API_PREFIX
from app.services.tokens import token_service

scene_v1 = b'{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}'
scene_v2 = b'{"type":"excalidraw","version":2,"elements":[{"id":"r1"}],"appState":{},"files":{}}'
scene_v3 = b'{"type":"excalidraw","version":2,"elements":[{"id":"r1"},{"id":"e1"}],"appState":{},"files":{}}'
light = b'<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
dark = b'<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>'
token = token_service.create_token(client_info="fixture", owner_tab_id="tab", dek=None)
headers = {"Authorization": "Bearer " + token, "X-Metalist-Tab-Id": "tab", "Origin": "http://localhost"}
undo_context = "tab:tab|search:|epoch:0"
viewport = {"scrollY": 0, "scrollAnchor": None}
excalidraw = "application/vnd.excalidraw+json"

def save(client, file_id, content, revision):
    response = client.put(API_PREFIX + f"/files/{file_id}/content", headers=headers,
                          files={"file": ("Diagram.excalidraw", content, excalidraw)}, data={"expected_revision": str(revision)})
    assert response.status_code == 200, response.text

def download(client, file_id):
    response = client.get(API_PREFIX + f"/files/{file_id}/download", headers=headers)
    return response.content, response.headers["X-MetaList-File-Revision"]

with TestClient(app, base_url="http://localhost", raise_server_exceptions=False) as client:
    note = client.post(API_PREFIX + "/notes/new", headers=headers, json={
        "first_visible_note_id": None, "search_query": None, "clientId": "client",
        "undoContext": undo_context, "viewport": viewport,
    })
    assert note.status_code == 200, note.text
    note_id = note.json()["id"]
    created = client.post(API_PREFIX + "/files/upload", headers=headers, files={"file": ("Diagram.excalidraw", scene_v1, excalidraw)})
    file_id = created.json()["file_id"]
    finish_body = {"clientId": "client", "hostNoteId": note_id, "isNewDiagram": False, "undoContext": undo_context, "viewport": viewport}

    started = client.post(API_PREFIX + f"/files/{file_id}/edit-sessions", headers=headers)
    assert started.status_code == 200, started.text
    session_id = started.json()["sessionId"]
    assert started.json()["contentRevision"] == 1
    save(client, file_id, scene_v2, 1)
    save(client, file_id, scene_v3, 2)
    stored = client.put(API_PREFIX + f"/files/{file_id}/previews", headers=headers,
                        files={"light": ("light.svg", light, "image/svg+xml"), "dark": ("dark.svg", dark, "image/svg+xml")},
                        data={"content_revision": "3"})
    assert stored.status_code == 200, stored.text

    missing_note = client.post(API_PREFIX + f"/files/{file_id}/edit-sessions/{session_id}/finish", headers=headers,
                               json={**finish_body, "hostNoteId": "no-such-note", "contentRevision": 3})
    assert missing_note.status_code == 404, missing_note.text
    finished = client.post(API_PREFIX + f"/files/{file_id}/edit-sessions/{session_id}/finish", headers=headers,
                           json={**finish_body, "contentRevision": 3})
    assert finished.status_code == 200, finished.text
    assert finished.json()["undoStepRecorded"] is True
    assert finished.json()["contentRevision"] == 3
    expired = client.post(API_PREFIX + f"/files/{file_id}/edit-sessions/{session_id}/finish", headers=headers,
                          json={**finish_body, "contentRevision": 3})
    assert expired.status_code == 410, expired.text

    undone = client.post(API_PREFIX + "/notes/undo", headers=headers, params={"client_id": "client", "undoContext": undo_context})
    assert undone.status_code == 200, undone.text
    assert undone.json()["scrollRestore"]["opType"] == "file_content"
    assert download(client, file_id) == (scene_v1, "4")
    preview = client.get(API_PREFIX + f"/files/{file_id}/previews/light", headers=headers)
    assert preview.status_code == 404, preview.text
    redone = client.post(API_PREFIX + "/notes/redo", headers=headers, params={"client_id": "client", "undoContext": undo_context})
    assert redone.status_code == 200, redone.text
    assert download(client, file_id) == (scene_v3, "5")
    preview = client.get(API_PREFIX + f"/files/{file_id}/previews/dark", headers=headers)
    assert preview.content == dark and preview.headers["X-MetaList-File-Revision"] == "5"

    discarding = client.post(API_PREFIX + f"/files/{file_id}/edit-sessions", headers=headers).json()
    save(client, file_id, scene_v1, 5)
    stale = client.post(API_PREFIX + f"/files/{file_id}/edit-sessions/{discarding['sessionId']}/discard", headers=headers,
                        json={"contentRevision": 5})
    assert stale.status_code == 409, stale.text
    discarding = client.post(API_PREFIX + f"/files/{file_id}/edit-sessions", headers=headers).json()
    save(client, file_id, scene_v2, 6)
    discarded = client.post(API_PREFIX + f"/files/{file_id}/edit-sessions/{discarding['sessionId']}/discard", headers=headers,
                            json={"contentRevision": 7})
    assert discarded.status_code == 200, discarded.text
    assert discarded.json()["contentRevision"] == 8
    assert download(client, file_id) == (scene_v1, "8")

    pdf = client.post(API_PREFIX + "/files/upload", headers=headers, files={"file": ("a.pdf", b"%PDF", "application/pdf")})
    refused = client.post(API_PREFIX + f"/files/{pdf.json()['file_id']}/edit-sessions", headers=headers)
    assert refused.status_code == 400, refused.text
    unknown = client.post(API_PREFIX + "/files/no-such-file/edit-sessions", headers=headers)
    assert unknown.status_code == 404, unknown.text
print("EDIT SESSION ROUTES OK")
'''
    environment = dict(os.environ, METALIST_DATA_DIRECTORY=str(tmp_path), METALIST_ENVIRONMENT="production")
    result = subprocess.run([sys.executable, "-c", script], env=environment, capture_output=True, encoding="utf-8", timeout=60)
    assert result.returncode == 0, (result.stdout[-2000:], result.stderr[-3000:])
    assert "EDIT SESSION ROUTES OK" in result.stdout
