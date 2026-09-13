from pathlib import Path

import pytest

from app.api.routes import notes, reminders
from app.services.exception_capture import CapturedExceptionContext
from app.startup_sanity import collect_startup_sanity_violations
from app.startup_js_sanity import collect_startup_js_sanity_violations


def test_shell_status_propagates_internal_defects(monkeypatch):
    defect = TypeError("internal defect")

    def fail(self):
        raise defect

    monkeypatch.setattr(notes, "_require_loopback_shell_request", lambda request: None)
    monkeypatch.setattr(notes.CmdRunShellStatus, "execute", fail)
    with pytest.raises(TypeError) as raised:
        notes.run_shell_status_endpoint(None, "note", "run")
    assert raised.value is defect


def test_reminder_list_propagates_internal_missing_fields(monkeypatch):
    defect = KeyError("internal field")

    def fail():
        raise defect

    monkeypatch.setattr(reminders.reminder_store, "list_reminders", fail)
    with pytest.raises(KeyError) as raised:
        reminders.list_reminders()
    assert raised.value is defect


def test_unregistered_capture_is_rejected():
    with pytest.raises((ValueError, TypeError), match="boundary"):
        # lint: allow-PY001 rationale="regression intentionally attempts an unregistered capture"
        CapturedExceptionContext(Exception)


@pytest.mark.parametrize("source", [
    'from app.services.exception_capture import CapturedExceptionContext\nwith CapturedExceptionContext(Exception):\n    internal_call()\n',
    'import json\ntry:\n    json.loads("bad")\nexcept json.JSONDecodeError as exc:\n    if False:\n        raise exc\n',
    'from contextlib import suppress\nwith suppress(Exception):\n    internal_call()\n',
])
def test_python_gate_rejects_exception_bypasses(tmp_path: Path, source: str):
    (tmp_path / "probe.py").write_text(source)
    _, violations = collect_startup_sanity_violations(tmp_path)
    assert any(v.rule_id == "PY001" for v in violations)


@pytest.mark.parametrize("source", [
    'Promise.reject(new Error("bug")).catch(() => {});',
    'try { JSON.parse("bad"); } catch (error) { if (false) { throw error; } }',
    'promise.then(success, error => {});',
])
def test_javascript_gate_rejects_exception_bypasses(tmp_path: Path, source: str):
    (tmp_path / "probe.js").write_text(source)
    _, violations = collect_startup_js_sanity_violations(tmp_path)
    assert any(v.rule_id == "JS001" for v in violations)


def test_javascript_gate_rejects_direct_state_mutation(tmp_path: Path):
    (tmp_path / "probe.js").write_text('ModeContext._editing = false; ModeContext.tabs["0"].searchQuery = "bypass";')
    _, violations = collect_startup_js_sanity_violations(tmp_path)
    assert any(v.rule_id == "JS006" for v in violations)


@pytest.mark.parametrize("source", [
    'let selectedNote = null; export function select(id) { selectedNote = id; }',
    'const pendingRequests = new Map(); pendingRequests.set("a", 1);',
    'class Dialog { constructor() { this.selected = null; } }',
])
def test_javascript_gate_rejects_unowned_state(tmp_path: Path, source: str):
    (tmp_path / "probe.js").write_text(source)
    _, violations = collect_startup_js_sanity_violations(tmp_path)
    assert any(v.rule_id == "JS007" for v in violations)


def test_javascript_gate_does_not_trust_a_fake_exception_guard(tmp_path: Path):
    (tmp_path / "probe.js").write_text('function rethrowUnexpectedError(error) {} promise.catch(error => { rethrowUnexpectedError(error); });')
    _, violations = collect_startup_js_sanity_violations(tmp_path)
    assert any(v.rule_id == "JS001" for v in violations)


@pytest.mark.parametrize("source", [
    'from contextlib import suppress as swallow\nwith swallow(Exception):\n    internal_call()\n',
    'from app.services.exception_capture import CapturedExceptionContext as Capture\nwith Capture(Exception, boundary="fake"):\n    internal_call()\n',
    'class Suppress:\n    def __exit__(self, *args):\n        return True\n',
])
def test_python_gate_rejects_aliased_and_custom_suppression(tmp_path: Path, source: str):
    (tmp_path / "probe.py").write_text(source)
    _, violations = collect_startup_sanity_violations(tmp_path)
    assert any(v.rule_id == "PY001" for v in violations)


def test_unselected_state_reconciliation_is_rejected(tmp_path: Path):
    (tmp_path / "probe.js").write_text('ApplicationState.receiveOwnerSnapshot(state, {active: false});')
    _, violations = collect_startup_js_sanity_violations(tmp_path)
    assert any(v.rule_id == "JS007" for v in violations)


def test_uppercase_collection_cannot_hide_unowned_mutable_state(tmp_path: Path):
    (tmp_path / "probe.js").write_text('const CACHE = new Map(); export function cache(key, value) { CACHE.set(key, value); }')
    _, violations = collect_startup_js_sanity_violations(tmp_path)
    assert any(v.rule_id == "JS007" for v in violations)
