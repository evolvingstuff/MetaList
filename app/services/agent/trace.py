"""Session-only trace capture for the complete conversation and latest-run debug view."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from threading import Lock
from uuid import uuid4

from app.version import __version__


class AgentTraceStore:
    def __init__(self) -> None:
        self._exact_detail_hidden_sessions: set[str] = set()
        self._histories: dict[str, list[dict[str, object]]] = {}
        self._discarded_run_ids: set[str] = set()
        self._latest_runs: dict[str, dict[str, object]] = {}
        self._lock = Lock()

    def reset(self) -> None:
        with self._lock:
            self._exact_detail_hidden_sessions.clear()
            self._latest_runs.clear()
            self._histories.clear()
            self._discarded_run_ids.clear()

    def clear_session(self, *, session_key: str) -> None:
        self._validate_session_key(session_key)
        with self._lock:
            self._exact_detail_hidden_sessions.discard(session_key)
            self._discarded_run_ids.update(run["run_id"] for run in self._histories.get(session_key, []))
            self._latest_runs.pop(session_key, None)
            self._histories.pop(session_key, None)

    def clear_trace(self, *, session_key: str) -> None:
        self._validate_session_key(session_key)
        with self._lock:
            self._discarded_run_ids.update(run["run_id"] for run in self._histories.get(session_key, []))
            self._latest_runs.pop(session_key, None)
            self._histories.pop(session_key, None)

    def set_exact_details_enabled(self, *, session_key: str, enabled: bool) -> None:
        self._validate_session_key(session_key)
        if not isinstance(enabled, bool):
            raise TypeError("enabled must be a boolean")
        with self._lock:
            if enabled:
                self._exact_detail_hidden_sessions.discard(session_key)
            else:
                self._exact_detail_hidden_sessions.add(session_key)

    def is_exact_details_enabled(self, *, session_key: str) -> bool:
        self._validate_session_key(session_key)
        with self._lock:
            return session_key not in self._exact_detail_hidden_sessions

    def start_run(self, *, session_key: str, model: str, user_message: str) -> str:
        self._validate_session_key(session_key)
        if not isinstance(model, str) or model == "":
            raise ValueError("Trace model must be non-empty")
        if not isinstance(user_message, str) or user_message == "":
            raise ValueError("Trace user message must be non-empty")
        run_id = str(uuid4())
        with self._lock:
            self._latest_runs[session_key] = {
                "run_id": run_id,
                "model": model,
                "user_message": user_message,
                "status": "running",
                "started_at": self._now_iso(),
                "finished_at": "",
                "error": "",
                "events": [],
            }
            self._histories.setdefault(session_key, []).append(self._latest_runs[session_key])
        return run_id

    def append_event(
        self,
        *,
        session_key: str,
        run_id: str,
        event_type: str,
        label: str,
        detail: dict[str, object],
        duration_ms: float,
    ) -> None:
        self._validate_event_input(
            session_key=session_key,
            run_id=run_id,
            event_type=event_type,
            label=label,
            detail=detail,
            duration_ms=duration_ms,
        )
        with self._lock:
            run = self._find_run(session_key, run_id)
            if run is None:
                return
            events = run["events"]
            assert isinstance(events, list)
            events.append(
                {
                    "sequence": len(events) + 1,
                    "type": event_type,
                    "label": label,
                    "timestamp": self._now_iso(),
                    "duration_ms": round(duration_ms, 3),
                    "detail": deepcopy(detail),
                }
            )

    def complete_run(self, *, session_key: str, run_id: str) -> None:
        self._finish_run(session_key=session_key, run_id=run_id, status="complete", error="")

    def fail_run(self, *, session_key: str, run_id: str, error: str) -> None:
        if not isinstance(error, str) or error == "":
            raise ValueError("Trace failure error must be non-empty")
        self._finish_run(session_key=session_key, run_id=run_id, status="error", error=error)

    def snapshot(self, *, session_key: str) -> dict[str, object]:
        self._validate_session_key(session_key)
        with self._lock:
            enabled = session_key not in self._exact_detail_hidden_sessions
            if session_key not in self._latest_runs:
                return {"enabled": enabled, "has_trace": False, "run": {}}
            return {"enabled": enabled, "has_trace": True, "run": deepcopy(self._latest_runs[session_key])}

    def export_history(self, *, session_key: str) -> list:
        """One input/output pair per actual provider attempt, in request order."""
        self._validate_session_key(session_key)
        with self._lock:
            runs = deepcopy(self._histories.get(session_key, []))
        pairs = []
        for run in runs:
            calls = {}
            run_pair_start = len(pairs)
            for event in run["events"]:
                detail = event["detail"]
                kind = event["type"]
                if kind == "LLM_CALL_STARTED":
                    calls[detail["call_id"]] = {"input": detail, "pairs": []}
                elif kind == "LLM_WIRE_REQUEST":
                    call = calls[detail["call_id"]]
                    pair = [{
                        "schema_version": 1, "application_version": __version__,
                        "run_id": run["run_id"], "call_id": detail["call_id"],
                        "attempt": len(call["pairs"]) + 1,
                        "timestamp": event["timestamp"],
                        "request": detail["body"],
                        "invocation": call["input"],
                    }, {"status": "running", "response": {}, "chunks": [], "error": ""}]
                    call["pairs"].append(pair)
                    pairs.append(pair)
                elif kind == "LLM_ATTEMPT_OUTPUT":
                    call = calls[detail["call_id"]]
                    if detail["attempt"] <= len(call["pairs"]):
                        output = call["pairs"][detail["attempt"] - 1][1]
                        output.update(response=detail["response"], error=detail["error"])
                        output["status"] = "complete"
                        if detail["error"] != "":
                            output["status"] = "error"
                elif kind == "LLM_RAW_CHUNK":
                    calls[detail["call_id"]]["pairs"][-1][1]["chunks"].append(
                        {key: value for key, value in detail.items() if key != "call_id"}
                    )
                elif kind in {"MENU_REQUESTED", "MENU_RESULT"}:
                    if len(pairs) > run_pair_start:
                        pairs[-1][1].setdefault("application_events", []).append(event)
                elif kind == "LLM_CALL_FINISHED":
                    call = calls[detail["call_id"]]
                    if not call["pairs"]:
                        # Failure before HTTP: retain the attempted invocation explicitly.
                        pair = [{"schema_version": 1, "application_version": __version__,
                                 "run_id": run["run_id"], "call_id": detail["call_id"],
                                 "attempt": 0, "timestamp": event["timestamp"],
                                 "request": {}, "invocation": call["input"]},
                                {"status": detail["status"], "response": {},
                                 "chunks": [], "error": detail["error"]}]
                        pairs.append(pair)
                    else:
                        output = call["pairs"][-1][1]
                        output["status"] = detail["status"]
                        if detail["error"]:
                            output["error"] = detail["error"]
        return pairs

    def _find_run(self, session_key: str, run_id: str):
        # A cleared session may still receive the cancellation of an old call.
        if session_key not in self._histories or run_id in self._discarded_run_ids:
            return None
        for run in self._histories[session_key]:
            if run["run_id"] == run_id:
                return run
        raise RuntimeError("Agent trace run id does not match a recorded run")

    def _finish_run(self, *, session_key: str, run_id: str, status: str, error: str) -> None:
        self._validate_session_key(session_key)
        if not isinstance(run_id, str) or run_id == "":
            raise ValueError("run_id must be non-empty")
        if status not in {"complete", "error"}:
            raise ValueError("Unsupported trace completion status")
        with self._lock:
            run = self._find_run(session_key, run_id)
            if run is None:
                return
            run["status"] = status
            run["finished_at"] = self._now_iso()
            run["error"] = error

    @staticmethod
    def _validate_session_key(session_key: str) -> None:
        if not isinstance(session_key, str) or session_key == "":
            raise ValueError("session_key must be a non-empty string")

    @staticmethod
    def _validate_event_input(
        *,
        session_key: str,
        run_id: str,
        event_type: str,
        label: str,
        detail: dict[str, object],
        duration_ms: float,
    ) -> None:
        AgentTraceStore._validate_session_key(session_key)
        if not isinstance(run_id, str) or run_id == "":
            raise ValueError("run_id must be non-empty")
        if not isinstance(event_type, str) or event_type == "":
            raise ValueError("event_type must be non-empty")
        if not isinstance(label, str) or label == "":
            raise ValueError("label must be non-empty")
        if not isinstance(detail, dict):
            raise TypeError("detail must be a dictionary")
        if not isinstance(duration_ms, (int, float)) or duration_ms < 0:
            raise ValueError("duration_ms must be non-negative")

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()


agent_trace_store = AgentTraceStore()
