from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from app.security.encryption import is_encryption_required
from app.security.shell_execution import is_shell_execution_enabled
from app.usecases.base import QueryCommand
from app.services.content_formatting import _extract_plain_text, _find_first_renderer_tag
from app.services.shell_session_service import NO_EXIT_CODE, shell_session_service
from app.services.store import store


def _invalid_shell_response(*, error_message: str) -> Dict[str, object]:
    if not isinstance(error_message, str) or error_message == "":
        raise TypeError("error_message must be a non-empty string")
    return {
        "runId": "",
        "status": "error",
        "exitCode": NO_EXIT_CODE,
        "stdout": "",
        "stderr": "",
        "durationMs": 0,
        "errorMessage": error_message,
    }


@dataclass
class CmdRunShellStart(QueryCommand):
    note_id: str
    timeout_seconds: int

    def execute(self) -> Dict[str, object]:
        if not isinstance(self.timeout_seconds, int) or self.timeout_seconds < 0:
            raise TypeError("timeout_seconds must be a non-negative integer")
        if not is_shell_execution_enabled():
            return _invalid_shell_response(
                error_message="Shell execution is disabled for this server"
            )
        if not is_encryption_required():
            return _invalid_shell_response(
                error_message="Shell execution requires password protection"
            )

        record = store.get(self.note_id)
        if _find_first_renderer_tag(record.tags) != "shell":
            return _invalid_shell_response(error_message="Note is not tagged @shell")
        script_text = _extract_plain_text(record.content)
        if script_text.strip() == "":
            return _invalid_shell_response(error_message="Shell script is empty")
        return shell_session_service.start_run(
            note_id=self.note_id,
            script_text=script_text,
            timeout_seconds=self.timeout_seconds,
        )


@dataclass
class CmdRunShellStatus(QueryCommand):
    note_id: str
    run_id: str

    def execute(self) -> Dict[str, object]:
        if not is_shell_execution_enabled():
            return _invalid_shell_response(
                error_message="Shell execution is disabled for this server"
            )
        if not is_encryption_required():
            return _invalid_shell_response(
                error_message="Shell execution requires password protection"
            )
        return shell_session_service.get_snapshot(
            note_id=self.note_id,
            run_id=self.run_id,
        )
