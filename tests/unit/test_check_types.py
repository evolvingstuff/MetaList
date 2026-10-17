import importlib.util
import subprocess
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_types.py"
_SPEC = importlib.util.spec_from_file_location("check_types", _SCRIPT)
check_types = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(check_types)

_KNOWN = 'app/a.py: Argument 1 to "f" has incompatible type "int"; expected "str"  [arg-type]'
_OTHER = 'app/b.py: "object" has no attribute "x"  [attr-defined]'


def _with_baseline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entries: list[str]) -> None:
    baseline = tmp_path / "mypy-baseline.txt"
    baseline.write_text("# header\n" + "".join(f"{entry}\n" for entry in entries), encoding="utf-8")
    monkeypatch.setattr(check_types, "_BASELINE_PATH", baseline)


def test_known_errors_pass(tmp_path, monkeypatch, capsys):
    _with_baseline(tmp_path, monkeypatch, [_KNOWN, _KNOWN])
    monkeypatch.setattr(check_types, "_current_errors", lambda: [_KNOWN, _KNOWN])
    check_types.check()
    assert "none new" in capsys.readouterr().out


def test_a_new_error_fails(tmp_path, monkeypatch):
    _with_baseline(tmp_path, monkeypatch, [_KNOWN])
    monkeypatch.setattr(check_types, "_current_errors", lambda: [_KNOWN, _OTHER])
    with pytest.raises(SystemExit, match="1 new type error"):
        check_types.check()


def test_another_occurrence_of_a_known_error_is_new(tmp_path, monkeypatch):
    _with_baseline(tmp_path, monkeypatch, [_KNOWN])
    monkeypatch.setattr(check_types, "_current_errors", lambda: [_KNOWN, _KNOWN])
    with pytest.raises(SystemExit, match="1 new type error"):
        check_types.check()


def test_a_fixed_error_asks_for_a_baseline_update(tmp_path, monkeypatch):
    _with_baseline(tmp_path, monkeypatch, [_KNOWN, _OTHER])
    monkeypatch.setattr(check_types, "_current_errors", lambda: [_KNOWN])
    with pytest.raises(SystemExit, match="1 baseline error.*update"):
        check_types.check()


def test_mypy_output_is_read_without_line_numbers_and_with_forward_slashes(monkeypatch):
    output = (
        'app\\a.py:12: error: Argument 1 to "f" has incompatible type "int"; expected "str"  [arg-type]\n'
        "app\\a.py:12: note: See docs\n"
        "Found 1 error in 1 file (checked 2 source files)\n"
    )
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess(args, 1, output, ""))
    assert check_types._current_errors() == [_KNOWN]


def test_mypy_failing_to_run_is_an_error(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess(args, 2, "", "boom"))
    with pytest.raises(RuntimeError, match="could not run"):
        check_types._current_errors()
