import re
from pathlib import Path

from app.services import client_state_service

_ROOT = Path(__file__).resolve().parents[2]
_LIMITS_JS = _ROOT / "app" / "static" / "js" / "modules" / "ai-chat" / "ai-chat-size-limits.js"
_MAIN_CSS = _ROOT / "app" / "static" / "css" / "main.css"


def _js_constant(source: str, name: str) -> int:
    return int(re.search(rf"^export const {name} = (\d+);$", source, re.M).group(1))


def test_browser_chat_size_limits_match_the_server():
    source = _LIMITS_JS.read_text(encoding="utf-8")
    for name in (
        "AI_CHAT_MINIMUM_WIDTH", "AI_CHAT_MAXIMUM_WIDTH",
        "AI_CHAT_COMPOSER_MINIMUM_HEIGHT", "AI_CHAT_COMPOSER_MAXIMUM_HEIGHT",
    ):
        assert _js_constant(source, name) == getattr(client_state_service, name), name


def test_stylesheet_chat_widths_match_the_limits():
    source = _LIMITS_JS.read_text(encoding="utf-8")
    css = _MAIN_CSS.read_text(encoding="utf-8")
    assert f"--ai-chat-min-notes-width: {_js_constant(source, 'AI_CHAT_MINIMUM_NOTES_WIDTH')}px;" in css
    assert re.search(rf"clamp\(\s*{_js_constant(source, 'AI_CHAT_MINIMUM_WIDTH')}px,", css)
