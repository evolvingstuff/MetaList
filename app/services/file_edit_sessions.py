"""Open editing sessions for files MetaList edits in place (Excalidraw diagrams).

The editor autosaves many revisions, but the whole session is one undo step, so the content
and previews the session started from are kept here until the editor closes. Like the undo
stacks, these snapshots hold plaintext and are dropped whenever undo state is reset.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from time import monotonic
import uuid

from app.services.file_storage import FileSnapshot, capture_file_snapshot
from app.services.resource_limits import CLIENT_IDLE_SECONDS

# Editors normally close within minutes; these only bound sessions left behind by closed windows.
# An editor open longer than the age limit still saves, but no longer forms a single undo step.
MAX_OPEN_FILE_EDIT_SESSIONS = 8
# Sixteen client idle periods: with the default 30-minute idle limit, 8 hours.
_MAX_AGE_IN_IDLE_PERIODS = 16
FILE_EDIT_SESSION_MAX_AGE_SECONDS = CLIENT_IDLE_SECONDS * _MAX_AGE_IN_IDLE_PERIODS


class FileEditSessionMissing(LookupError):
    """The editing session ended, expired, or was dropped when undo history was reset."""


@dataclass(frozen=True)
class FileEditSession:
    session_id: str
    file_id: str
    before: FileSnapshot
    started_at: float


_sessions: "OrderedDict[str, FileEditSession]" = OrderedDict()


def _prune_expired_sessions() -> None:
    now = monotonic()
    for session_id in tuple(_sessions):
        if now - _sessions[session_id].started_at >= FILE_EDIT_SESSION_MAX_AGE_SECONDS:
            del _sessions[session_id]


def start_file_edit_session(*, file_id: str, token: str) -> FileEditSession:
    _prune_expired_sessions()
    session = FileEditSession(
        session_id=str(uuid.uuid4()),
        file_id=file_id,
        before=capture_file_snapshot(file_id=file_id, token=token),
        started_at=monotonic(),
    )
    _sessions[session.session_id] = session
    while len(_sessions) > MAX_OPEN_FILE_EDIT_SESSIONS:
        _sessions.popitem(last=False)
    return session


def get_file_edit_session(*, session_id: str, file_id: str) -> FileEditSession:
    _prune_expired_sessions()
    if session_id not in _sessions:
        raise FileEditSessionMissing(f"Editing session {session_id} is no longer open")
    session = _sessions[session_id]
    if session.file_id != file_id:
        raise FileEditSessionMissing(f"Editing session {session_id} does not belong to file {file_id}")
    return session


def end_file_edit_session(session_id: str) -> None:
    if session_id not in _sessions:
        raise FileEditSessionMissing(f"Editing session {session_id} is no longer open")
    del _sessions[session_id]


def open_file_edit_session_count() -> int:
    return len(_sessions)


def reset_all_file_edit_sessions() -> None:
    _sessions.clear()
