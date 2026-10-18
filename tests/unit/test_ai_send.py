"""Every message MetaList sends to an AI passes through app/services/agent/ai_send.py.

ShockHarness checks the callers of ai_send's functions for `cloud_disclosable`, but it
cannot resolve a method called on an adapter passed in, so a send made directly on an
adapter would be checked by nothing. This test makes the rule complete: no module of the
application calls an adapter's send methods except ai_send itself and PrivacyGuardedInference,
which is an adapter wrapping another. (evals/ sends fixture notes, not the user's, and
calls adapters directly.)
"""

import ast
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2] / "app"
SEND_METHODS = frozenset({"infer_structured", "stream_text", "stream_tool_turn"})
SENDERS = frozenset({"app/services/agent/ai_send.py", "app/services/agent/privacy_guard.py"})


def _send_calls(path: Path) -> list[int]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return [
        node.lineno for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in SEND_METHODS
    ]


def test_only_ai_send_calls_an_adapters_send_methods():
    found = {}
    for path in sorted(APP_ROOT.rglob("*.py")):
        relative = path.relative_to(APP_ROOT.parent).as_posix()
        lines = _send_calls(path)
        if lines and relative not in SENDERS:
            found[relative] = lines
    assert found == {}, f"send through app/services/agent/ai_send.py instead: {found}"


def test_ai_send_sends_with_each_method():
    assert len(_send_calls(APP_ROOT / "services" / "agent" / "ai_send.py")) == len(SEND_METHODS)


def test_each_send_requires_cloud_disclosable_messages_first():
    tree = ast.parse((APP_ROOT / "services" / "agent" / "ai_send.py").read_text(encoding="utf-8"))
    functions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    assert {function.name for function in functions} == {"send_structured", "send_text_stream", "send_tool_turn"}
    for function in functions:
        assert ast.unparse(function.body[0]) == "requires(messages, 'cloud_disclosable')", function.name
