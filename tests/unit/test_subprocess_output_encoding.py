"""Tests that read a child process's output as text name its encoding, UTF-8.

MetaList writes its console as UTF-8 on every OS (app/main.py). A test reading a child's
output with text=True decodes it in the platform's code page instead, which on Windows is
cp1252: the request log's arrows made the reader thread fail there and the output read as
None (2026-10-21). A test that reads text must say encoding="utf-8"."""

from __future__ import annotations

import ast
from pathlib import Path

_TESTS = Path(__file__).resolve().parents[1]
_SUBPROCESS_CALLS = {"run", "Popen", "check_output", "check_call", "call"}
_TEXT_KEYWORDS = {"text", "universal_newlines"}


def _called_name(called: ast.expr) -> str:
    if isinstance(called, ast.Attribute):
        return called.attr
    if isinstance(called, ast.Name):
        return called.id
    return ""


def _reads_text_without_encoding(call: ast.Call) -> bool:
    keywords = {keyword.arg: keyword.value for keyword in call.keywords}
    reads_text = any(
        name in keywords and isinstance(keywords[name], ast.Constant) and keywords[name].value is True
        for name in _TEXT_KEYWORDS
    )
    return reads_text and "encoding" not in keywords


def test_every_test_reading_child_output_as_text_names_utf8() -> None:
    offenders = []
    for path in sorted(_TESTS.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Call) and _called_name(node.func) in _SUBPROCESS_CALLS and _reads_text_without_encoding(node):
                offenders.append(f"{path.relative_to(_TESTS)}:{node.lineno}")
    assert offenders == [], f"read child output with encoding=\"utf-8\", not text=True: {offenders}"
