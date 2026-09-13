from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, HTTPException, Request

from app.api.request_auth import get_request_auth_token
from app.api.transactions import transactional_route
from app.services.exception_capture import CapturedExceptionContext
from app.services.reminders import reminder_store
from app.services.input_errors import InputRejected, ResourceNotFound


router = APIRouter(prefix="/reminders", tags=["reminders2"])


def _request_token(request: Request) -> str:
    token = get_request_auth_token(request)
    if token is None:
        return ""
    return token


def _require_body_object(payload: dict[str, object]) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Request body must be an object")
    return payload


def _require_string(payload: dict[str, object], field_name: str) -> str:
    if field_name not in payload:
        raise HTTPException(status_code=400, detail=f"{field_name} is required")
    value = payload[field_name]
    if not isinstance(value, str) or value == "":
        raise HTTPException(status_code=400, detail=f"{field_name} must be a non-empty string")
    return value


def _parse_datetime_field(payload: dict[str, object], field_name: str) -> datetime:
    raw = _require_string(payload, field_name)
    capture = CapturedExceptionContext(ValueError, boundary='app/api/routes/reminders.py:_parse_datetime_field:capture')
    with capture:
        parsed = datetime.fromisoformat(raw)
    if capture.captured_exception is not None:
        raise HTTPException(status_code=400, detail=f"{field_name} must be an ISO datetime") from capture.captured_exception
    if parsed.tzinfo is None:
        raise HTTPException(status_code=400, detail=f"{field_name} must include timezone")
    return parsed


def _parse_date_field(payload: dict[str, object], field_name: str) -> date:
    raw = _require_string(payload, field_name)
    capture = CapturedExceptionContext(ValueError, boundary='app/api/routes/reminders.py:_parse_date_field:capture')
    with capture:
        parsed = date.fromisoformat(raw)
    if capture.captured_exception is not None:
        raise HTTPException(status_code=400, detail=f"{field_name} must be an ISO date") from capture.captured_exception
    return parsed


def _decorate_reminder(reminder: dict[str, object]) -> dict[str, object]:
    return dict(reminder)


def _decorate_payload(payload: dict[str, object]) -> dict[str, object]:
    reminders = payload["reminders"]
    if not isinstance(reminders, list):
        raise RuntimeError("reminders payload must contain reminders list")
    decorated_reminders = [_decorate_reminder(reminder) for reminder in reminders]
    missed = [
        reminder
        for reminder in decorated_reminders
        if reminder["is_currently_missed"] is True
    ]
    return {
        "reminders": decorated_reminders,
        "missed": missed,
    }


def _raise_service_http(exc: BaseException) -> None:
    if isinstance(exc, ResourceNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, InputRejected):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise RuntimeError(f"Unexpected reminder service exception type: {type(exc)}") from exc


def _captured_result(capture: CapturedExceptionContext, result: object) -> object:
    if capture.captured_exception is not None:
        _raise_service_http(capture.captured_exception)
    return result


@router.get("")
def list_reminders() -> dict[str, object]:
    capture = CapturedExceptionContext(ResourceNotFound, InputRejected, boundary='app/api/routes/reminders.py:list_reminders:capture')
    reminders: list[dict[str, object]] = []
    with capture:
        reminders = reminder_store.list_reminders()
    _captured_result(capture, reminders)
    return _decorate_payload({"reminders": reminders})


@router.post("")
@transactional_route
def create_reminder(request: Request, payload: dict[str, object]) -> dict[str, object]:
    body = _require_body_object(payload)
    token = _request_token(request)
    capture = CapturedExceptionContext(ResourceNotFound, InputRejected, boundary='app/api/routes/reminders.py:create_reminder:capture')
    reminder: dict[str, object] = {}
    with capture:
        reminder = reminder_store.create_reminder(payload=body, token=token)
    _captured_result(capture, reminder)
    return {"reminder": _decorate_reminder(reminder)}


@router.put("/{reminder_id}")
@transactional_route
def update_reminder(
    reminder_id: str,
    request: Request,
    payload: dict[str, object],
) -> dict[str, object]:
    body = _require_body_object(payload)
    token = _request_token(request)
    capture = CapturedExceptionContext(ResourceNotFound, InputRejected, boundary='app/api/routes/reminders.py:update_reminder:capture')
    reminder: dict[str, object] = {}
    with capture:
        reminder = reminder_store.update_reminder(
            reminder_id=reminder_id,
            payload=body,
            token=token,
        )
    _captured_result(capture, reminder)
    return {"reminder": _decorate_reminder(reminder)}


@router.delete("/{reminder_id}")
@transactional_route
def delete_reminder(reminder_id: str, request: Request) -> dict[str, object]:
    token = _request_token(request)
    capture = CapturedExceptionContext(ResourceNotFound, InputRejected, boundary='app/api/routes/reminders.py:delete_reminder:capture')
    with capture:
        reminder_store.delete_reminder(reminder_id=reminder_id, token=token)
    _captured_result(capture, None)
    return {"ok": True}


def _run_action(*, reminder_id: str, request: Request, payload: dict[str, object], action: str) -> dict[str, object]:
    body = _require_body_object(payload)
    token = _request_token(request)
    capture = CapturedExceptionContext(ResourceNotFound, InputRejected, boundary='app/api/routes/reminders.py:_run_action:capture')
    reminder: dict[str, object] = {}
    with capture:
        if action == "acknowledge":
            reminder = reminder_store.acknowledge_reminder(
                reminder_id=reminder_id,
                token=token,
                now=_parse_datetime_field(body, "now"),
                local_date=_parse_date_field(body, "local_date"),
                activity_kind=_require_string(body, "activity_kind"),
            )
        elif action == "dismiss":
            reminder = reminder_store.dismiss_reminder(reminder_id=reminder_id, token=token)
        elif action == "done":
            reminder = reminder_store.mark_done(reminder_id=reminder_id, token=token)
        elif action == "pre-acknowledge":
            reminder = reminder_store.acknowledge_pre_reminder(
                reminder_id=reminder_id,
                token=token,
                pre_reminder_key=_require_string(body, "pre_reminder_key"),
                now=_parse_datetime_field(body, "now"),
            )
        elif action == "pause":
            reminder = reminder_store.pause_reminder(reminder_id=reminder_id, token=token)
        elif action == "resume":
            reminder = reminder_store.resume_reminder(reminder_id=reminder_id, token=token)
        elif action == "skip-next":
            reminder = reminder_store.skip_next(reminder_id=reminder_id, token=token)
        else:
            raise RuntimeError(f"Unsupported reminder action: {action}")
    _captured_result(capture, reminder)
    return {"reminder": _decorate_reminder(reminder)}


@router.post("/{reminder_id}/acknowledge")
@transactional_route
def acknowledge_reminder(reminder_id: str, request: Request, payload: dict[str, object]) -> dict[str, object]:
    return _run_action(reminder_id=reminder_id, request=request, payload=payload, action="acknowledge")


@router.post("/{reminder_id}/dismiss")
@transactional_route
def dismiss_reminder(reminder_id: str, request: Request, payload: dict[str, object]) -> dict[str, object]:
    return _run_action(reminder_id=reminder_id, request=request, payload=payload, action="dismiss")


@router.post("/{reminder_id}/done")
@transactional_route
def mark_reminder_done(reminder_id: str, request: Request, payload: dict[str, object]) -> dict[str, object]:
    return _run_action(reminder_id=reminder_id, request=request, payload=payload, action="done")


@router.post("/{reminder_id}/pre-acknowledge")
@transactional_route
def acknowledge_pre_reminder(reminder_id: str, request: Request, payload: dict[str, object]) -> dict[str, object]:
    return _run_action(reminder_id=reminder_id, request=request, payload=payload, action="pre-acknowledge")


@router.post("/{reminder_id}/pause")
@transactional_route
def pause_reminder(reminder_id: str, request: Request, payload: dict[str, object]) -> dict[str, object]:
    return _run_action(reminder_id=reminder_id, request=request, payload=payload, action="pause")


@router.post("/{reminder_id}/resume")
@transactional_route
def resume_reminder(reminder_id: str, request: Request, payload: dict[str, object]) -> dict[str, object]:
    return _run_action(reminder_id=reminder_id, request=request, payload=payload, action="resume")


@router.post("/{reminder_id}/skip-next")
@transactional_route
def skip_next_reminder(reminder_id: str, request: Request, payload: dict[str, object]) -> dict[str, object]:
    return _run_action(reminder_id=reminder_id, request=request, payload=payload, action="skip-next")


@router.post("/evaluate")
@transactional_route
def evaluate_reminders(request: Request, payload: dict[str, object]) -> dict[str, object]:
    body = _require_body_object(payload)
    now = _parse_datetime_field(body, "now")
    local_date = _parse_date_field(body, "local_date")
    activity_kind = _require_string(body, "activity_kind")
    token = _request_token(request)
    capture = CapturedExceptionContext(ResourceNotFound, InputRejected, boundary='app/api/routes/reminders.py:evaluate_reminders:capture')
    result: dict[str, object] = {}
    with capture:
        result = reminder_store.evaluate_due(
            now=now,
            local_date=local_date,
            activity_kind=activity_kind,
            token=token,
        )
    _captured_result(capture, result)

    events = result["events"]
    changed = result["changed"]
    if not isinstance(events, list):
        raise RuntimeError("reminder evaluate result events must be list")
    if not isinstance(changed, list):
        raise RuntimeError("reminder evaluate result changed must be list")
    decorated_events = []
    for event in events:
        if not isinstance(event, dict):
            raise RuntimeError("reminder event must be object")
        decorated_event = dict(event)
        reminder = decorated_event["reminder"]
        if not isinstance(reminder, dict):
            raise RuntimeError("reminder event reminder must be object")
        decorated_event["reminder"] = _decorate_reminder(reminder)
        decorated_events.append(decorated_event)
    return {
        "events": decorated_events,
        "changed": [_decorate_reminder(reminder) for reminder in changed],
    }
