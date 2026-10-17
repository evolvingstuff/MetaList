import re
from pathlib import Path

from app.services.shell_session_service import NO_EXIT_CODE

_SHELL_OUTPUT_JS = (
    Path(__file__).resolve().parents[2] / "app" / "static" / "js" / "modules" / "mode-manager" / "services"
    / "shell-output-service.js"
)


def test_browser_no_exit_code_matches_the_server():
    source = _SHELL_OUTPUT_JS.read_text(encoding="utf-8")
    assert re.search(r"^export const NO_EXIT_CODE = (-?\d+);$", source, re.M).group(1) == str(NO_EXIT_CODE)
