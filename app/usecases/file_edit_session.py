"""Diagram editing sessions: each session, however many times it autosaves, is one undo step."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from app.services import undo_state
from app.services.file_edit_sessions import end_file_edit_session, get_file_edit_session, start_file_edit_session
from app.services.file_storage import (
    FileRevisionConflict,
    capture_file_snapshot,
    get_file_reference_record,
    restore_file_snapshot,
)
from app.services.sync import generate_new_uuid, get_current_sync_uuid
from app.usecases.base import QueryCommand


@dataclass
class CmdStartFileEditSession(QueryCommand):
    file_id: str
    token: str

    def execute(self) -> Dict[str, object]:
        session = start_file_edit_session(file_id=self.file_id, token=self.token)
        return {
            "sessionId": session.session_id,
            "contentRevision": session.before.content_revision,
            "updateUUID": get_current_sync_uuid(),
        }


@dataclass
class CmdFinishFileEditSession(QueryCommand):
    file_id: str
    session_id: str
    host_note_id: str
    # The last revision this editor saved; any other revision means another window saved after it.
    content_revision: int
    # A new diagram's first session is covered by the undo step that inserted the diagram into its
    # note: undoing that removes the diagram, and redoing it brings back the finished drawing.
    is_new_diagram: bool
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, object]:
        session = get_file_edit_session(session_id=self.session_id, file_id=self.file_id)
        after = capture_file_snapshot(file_id=self.file_id, token=self.token)
        saved_by_this_editor = after.content_revision == self.content_revision
        content_changed = after.content_bytes != session.before.content_bytes
        undo_step_recorded = saved_by_this_editor and content_changed and not self.is_new_diagram
        if undo_step_recorded:
            undo_state.record_file_content(
                self.client_id,
                self.undo_context,
                self.host_note_id,
                before=session.before,
                after=after,
                viewport=self.viewport,
            )
        if after.content_revision != session.before.content_revision:
            # Other windows showing the diagram re-render it at the new revision.
            generate_new_uuid()
        end_file_edit_session(self.session_id)
        return {
            "undoStepRecorded": undo_step_recorded,
            "contentRevision": after.content_revision,
            "updateUUID": get_current_sync_uuid(),
        }


@dataclass
class CmdDiscardFileEditSession(QueryCommand):
    file_id: str
    session_id: str
    content_revision: int
    token: str

    def execute(self) -> Dict[str, object]:
        session = get_file_edit_session(session_id=self.session_id, file_id=self.file_id)
        current = get_file_reference_record(self.file_id, self.token)
        if current.content_revision != self.content_revision:
            end_file_edit_session(self.session_id)
            raise FileRevisionConflict(
                file_id=self.file_id,
                expected_revision=self.content_revision,
                current_revision=current.content_revision,
            )
        content_revision = current.content_revision
        if current.content_revision != session.before.content_revision:
            restored = restore_file_snapshot(snapshot=session.before, token=self.token)
            content_revision = restored.content_revision
            generate_new_uuid()
        end_file_edit_session(self.session_id)
        return {"contentRevision": content_revision, "updateUUID": get_current_sync_uuid()}
