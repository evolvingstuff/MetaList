"""A namespace server starts without loading the AI SDKs: the OpenAI SDK and instructor
took about 200 ms of every server's startup, which has to wait for each one (2026-10-19).
They load when the AI is first used (ai_setup.connect_to_ai)."""

from __future__ import annotations

import json
import os
import subprocess
import sys

_IMPORT_TIMEOUT_SECONDS = 60
_LAZY_PACKAGES = ("openai", "instructor")


def test_starting_the_app_loads_no_ai_sdk(tmp_path) -> None:
    # Its own process: importing the app starts services that must not run in the tests.
    script = (
        "import json, sys\n"
        "import app.main\n"
        f"print(json.dumps(sorted(name for name in sys.modules if name.split('.')[0] in {_LAZY_PACKAGES!r})))\n"
    )
    environment = dict(os.environ, METALIST_DATA_DIRECTORY=str(tmp_path), METALIST_ENVIRONMENT="production")
    result = subprocess.run(
        [sys.executable, "-c", script],
        env=environment,
        capture_output=True,
        text=True,
        timeout=_IMPORT_TIMEOUT_SECONDS,
    )
    assert result.returncode == 0, result.stderr[-3000:]
    assert json.loads(result.stdout.strip().splitlines()[-1]) == []
