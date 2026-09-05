from __future__ import annotations

from copy import deepcopy
import os
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import embedded_documents as routes
from app.db.session import after_request_commit, begin_request_transaction, connect_reader
from app.models.database import SafeSession
from app.security.encryption import clear_encryption_key, set_encryption_required, set_session_dek, get_encryption_service
from app.services.embedded_documents import EmbeddedDocumentStore, document_store, render_diagram_svg
from app.services.document_references import clone_clipboard_documents, render_editable_documents, snapshot_documents
from app.services.embedded_references import EmbedRenderContext, collect_reference_tokens_from_html, render_note_content_with_embeds
from app.services.note_store import store as note_store
from app.services.store import store
from app.services.sync import get_clipboard, reset_state
from app.services.undo_state import undo, redo, reset_all_undo_state
from app.usecases.copy_note import CmdCopyNote
from app.usecases.paste_child import CmdPasteChild
from app.usecases.paste_sibling import CmdPasteSibling
from app.usecases.create_note import apply_insert_note
import app.services.note_store as note_store_module
from app.services.tag_ontology import TagOntology
from app.services.snapshot import build_view_state


VIEWPORT = {"scrollY": 0, "scrollAnchor": None}


def diagram(label):
    return {"kind": "diagram", "version": 1, "source": {"rectangles": [
        {"id": "rectangle", "x": 50.0, "y": 40.0, "label": label},
    ]}}


@pytest.fixture(autouse=True)
def isolated_documents(tmp_path, monkeypatch):
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    monkeypatch.setattr(note_store_module, "get_ontology", lambda: TagOntology.empty())
    SafeSession.use_memory_db()
    clear_encryption_key()
    set_encryption_required(False)
    document_store.reset()
    note_store.reset()
    note_store.load_from_db(None, prefetched_rows=[])
    reset_state()
    reset_all_undo_state()
    yield
    document_store.reset()
    note_store.reset()
    reset_all_undo_state()
    reset_state()
    clear_encryption_key()
    set_encryption_required(False)
    SafeSession.use_file_db()


def add_note(content, parent_id):
    note_id = str(uuid4())
    siblings = store.children(parent_id)
    prev_id = None
    if siblings:
        prev_id = siblings[-1]
    apply_insert_note(note_id, parent_id, prev_id, None, "", content=content, tags="", proposed_tags="")
    return note_id


def test_documents_commit_and_rollback_with_note_transaction():
    with begin_request_transaction():
        document_id = document_store.create(diagram("committed"))
        assert not document_store.has(document_id)
    assert document_store.get(document_id) == diagram("committed")
    with pytest.raises(RuntimeError, match="rollback"):
        with begin_request_transaction():
            document_store.put(document_id, diagram("uncommitted"))
            abandoned_id = document_store.create(diagram("abandoned"))
            raise RuntimeError("rollback")
    assert document_store.get(document_id) == diagram("committed")
    assert not document_store.has(abandoned_id)
    reloaded = EmbeddedDocumentStore()
    with connect_reader("test:documents") as connection:
        reloaded.bootstrap(connection=connection)
    assert reloaded.get(document_id) == diagram("committed")
    assert not reloaded.has(abandoned_id)


def test_document_encryption_hydration_and_password_transitions():
    document_id = document_store.create(diagram("private label"))
    set_session_dek(os.urandom(32))
    service = get_encryption_service()
    with connect_reader("test:encrypt") as connection:
        document_store.rewrite_storage(connection=connection, encryption_service=service, force_plaintext=False)
        row = connection.execute("SELECT payload, nonce, tag FROM embedded_documents").fetchone()
        assert "private label" not in row["payload"]
        assert len(row["nonce"]) == 12
        assert len(row["tag"]) == 16
        document_store.bootstrap(connection=connection)
    assert document_store.documents == {}
    document_store.ensure_decrypted(token="")
    assert document_store.get(document_id) == diagram("private label")
    with connect_reader("test:decrypt") as connection:
        document_store.rewrite_storage(connection=connection, encryption_service=service, force_plaintext=True)
        document_store.bootstrap(connection=connection)
    assert document_store.get(document_id) == diagram("private label")


def test_copy_snapshots_once_and_remaps_each_distinct_document():
    first = document_store.create(diagram("original"))
    second = document_store.create(diagram("second"))
    note_reference = str(uuid4())
    original = [{"content": f"![[{first}]] ![[{first}]] ![[{second}]] ![[{note_reference}]]"}]
    clipboard = snapshot_documents(original)
    document_store.put(first, diagram("changed after copy"))
    with begin_request_transaction():
        copied = clone_clipboard_documents(clipboard)
    ids = [token.note_id for token in collect_reference_tokens_from_html(copied[0]["content"])]
    assert ids[0] == ids[1]
    assert ids[0] != first
    assert ids[2] != second
    assert ids[3] == note_reference
    assert document_store.get(ids[0]) == diagram("original")
    assert document_store.get(ids[2]) == diagram("second")
    assert clipboard[0]["content"] == original[0]["content"]
    again = clone_clipboard_documents(clipboard)
    assert again[0]["content"] != copied[0]["content"]


@pytest.mark.parametrize("placement", ["sibling", "child", "blank"])
def test_real_note_paste_clones_diagrams_and_undo_redo_keep_identity(placement):
    first = document_store.create(diagram("root"))
    second = document_store.create(diagram("child"))
    root = add_note(f"Before ![[{first}]] After", None)
    add_note(f"![[{second}]]", root)
    CmdCopyNote(note_id=root, client_id="test").execute()
    assert get_clipboard("test")[0]["embedded_documents"][first] == diagram("root")
    target_content = "target"
    if placement == "blank":
        target_content = ""
    target = add_note(target_content, None)
    command_type = CmdPasteSibling
    if placement == "child":
        command_type = CmdPasteChild
    command = command_type(target_note_id=target, search_query="", token="", client_id="test",
                           undo_context="context", viewport=VIEWPORT)
    with begin_request_transaction():
        result = command.execute()
    pasted = store.get(result["id"])
    cloned_first = collect_reference_tokens_from_html(pasted.content)[0].note_id
    cloned_child = store.get(store.children(pasted.id)[0])
    cloned_second = collect_reference_tokens_from_html(cloned_child.content)[0].note_id
    assert cloned_first != first
    assert cloned_second != second
    assert document_store.get(cloned_first) == diagram("root")
    assert document_store.get(cloned_second) == diagram("child")
    with begin_request_transaction():
        undo("test", "")
    with begin_request_transaction():
        redo("test", "")
    assert collect_reference_tokens_from_html(store.get(pasted.id).content)[0].note_id == cloned_first
    assert document_store.get(cloned_first) == diagram("root")
    assert document_store.get(first) == diagram("root")


def test_inline_and_referenced_preview_refresh_without_rewriting_host():
    document_id = document_store.create(diagram("before"))
    root = add_note(f"![[{document_id}]]", None)
    context = EmbedRenderContext(has_note=store.contains, get_note=store.get,
                                get_children=store.children, has_file=lambda _id: False,
                                get_file=lambda _id: None)
    host = str(uuid4())
    content = f"![[{root}]]"
    before = render_note_content_with_embeds(note_id=host, content_html=content, tags="", context=context,
                                           static_export=False, redact_passwords=False)
    assert 'data-document-id=' in before
    assert document_id in render_editable_documents(store.get(root).content)
    document_store.put(document_id, diagram("after"))
    after = render_note_content_with_embeds(note_id=host, content_html=content, tags="", context=context,
                                          static_export=False, redact_passwords=False)
    assert before != after
    assert store.get(root).content == f"![[{document_id}]]"
    assert len(document_store.documents) == 1


def test_vector_preview_escapes_text():
    svg = render_diagram_svg(diagram('<script>alert("x")</script>'))
    assert '<script>' not in svg
    assert '&lt;script&gt;' in svg


@pytest.mark.parametrize("collapsed", [False, True])
def test_single_diagram_note_keeps_collapse_control_and_clickable_preview(collapsed):
    document_id = document_store.create(diagram("thumbnail"))
    note_id = add_note(f"<div>![[{document_id}]]</div>", None)
    note_store.set_collapsed(note_id, collapsed)
    state = build_view_state(editing_note_id=None, search=None, sort_mode="normal",
                            client_known_note_ids=set(), client_seen_root_ids=set(),
                            anchor_root_id=None, is_untagged_view=False)
    note = state.payloads[note_id]
    assert note["flags"]["isCollapsible"] is True
    assert note["flags"]["isCollapsed"] is collapsed
    assert f'data-document-id="{document_id}"' in note["content"]


def test_api_insertion_conflict_validation_and_saved_diagram_undo(monkeypatch):
    monkeypatch.setattr(routes, "require_request_auth_token", lambda _request: "")
    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app)
    note_id = add_note("Before", None)
    payload = {"clientId": "test", "undoContext": "context", "viewport": VIEWPORT,
               "note_id": note_id, "document": diagram("first"), "expected_content": "Before",
               "content": "Before<div>![[NEW-DOCUMENT]]</div>After", "search_query": ""}
    response = client.post('/documents/in-note', json=payload)
    assert response.status_code == 200, response.text
    document_id = response.json()["document_id"]
    assert store.get(note_id).content == f"Before<div>![[{document_id}]]</div>After"
    assert client.post('/documents/in-note', json=payload).status_code == 409
    assert len(document_store.documents) == 1
    update = {"clientId": "test", "undoContext": "context", "viewport": VIEWPORT,
              "note_id": note_id, "document": diagram("second"), "expected_document": diagram("first")}
    assert client.put(f'/documents/{document_id}', json=update).status_code == 200
    assert client.put(f'/documents/{document_id}', json=update).status_code == 409
    with begin_request_transaction():
        undo("test", "")
    assert document_store.get(document_id) == diagram("first")
    with begin_request_transaction():
        redo("test", "")
    assert document_store.get(document_id) == diagram("second")
    invalid = deepcopy(update)
    invalid["document"]["source"]["rectangles"] *= 2
    assert client.put(f'/documents/{document_id}', json=invalid).status_code == 422
    assert client.get(f'/documents/{document_id}').json() == diagram("second")


def test_invalid_viewport_rejected_before_document_or_note_is_created(monkeypatch):
    monkeypatch.setattr(routes, "require_request_auth_token", lambda _request: "")
    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app)
    payload = {"clientId": "test", "undoContext": "context", "viewport": {},
               "note_id": "", "document": diagram("new"), "expected_content": "",
               "content": "<div>![[NEW-DOCUMENT]]</div>", "search_query": ""}
    assert client.post('/documents/in-note', json=payload).status_code == 422
    assert not document_store.documents
    assert not store.children(None)
    payload["viewport"] = VIEWPORT
    response = client.post('/documents/in-note', json=payload)
    assert response.status_code == 200, response.text
    note_id = response.json()["note_id"]
    document_id = response.json()["document_id"]
    with begin_request_transaction():
        undo("test", "")
    assert not store.contains(note_id)
    assert document_store.has(document_id)  # Retained for redo and clipboard references.
    with begin_request_transaction():
        redo("test", "")
    assert store.get(note_id).content == f"<div>![[{document_id}]]</div>"


def test_encrypted_creation_and_updates_never_store_plaintext():
    set_session_dek(os.urandom(32))
    set_encryption_required(True)
    document_id = document_store.create(diagram("secret first"))
    document_store.put(document_id, diagram("secret second"))
    with connect_reader("test:encrypted-document") as connection:
        row = connection.execute("SELECT payload, nonce, tag FROM embedded_documents").fetchone()
        assert "secret" not in row["payload"]
        assert row["nonce"] is not None
        document_store.bootstrap(connection=connection)
    with pytest.raises(RuntimeError, match="before namespace hydration"):
        document_store.get(document_id)
    document_store.ensure_decrypted(token="")
    assert document_store.get(document_id) == diagram("secret second")


def test_commit_callback_failure_does_not_leak_transaction_context():
    def fail():
        raise RuntimeError("callback bug")

    with pytest.raises(RuntimeError, match="callback bug"):
        with begin_request_transaction():
            document_id = document_store.create(diagram("saved"))
            after_request_commit(fail)
    with begin_request_transaction():
        document_store.put(document_id, diagram("next transaction"))
    assert document_store.get(document_id) == diagram("next transaction")
