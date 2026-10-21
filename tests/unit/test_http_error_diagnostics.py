from pathlib import Path
import os
import subprocess
import sys

import pytest

from app.security.http_error_diagnostics import describe_server_exception


def test_server_exception_diagnostic_omits_message_and_absolute_path():
    repository = Path(__file__).resolve().parents[2]
    source = compile(
        "raise ValueError('PRIVATE_NOTE_CONTENT')",
        str(repository / "app" / "api" / "routes" / "notes.py"),
        "exec",
    )
    with pytest.raises(ValueError) as captured:
        exec(source)
    diagnostic = describe_server_exception(captured.value)

    assert diagnostic == {
        "errorType": "ValueError",
        "codeLocation": "app/api/routes/notes.py:1",
    }
    assert "PRIVATE_NOTE_CONTENT" not in str(diagnostic)
    assert str(repository) not in str(diagnostic)


def test_server_exception_diagnostic_hides_external_paths():
    source = compile("raise RuntimeError('PRIVATE_NOTE_CONTENT')", "/Users/private/secrets.py", "exec")
    with pytest.raises(RuntimeError) as captured:
        exec(source)
    diagnostic = describe_server_exception(captured.value)

    assert diagnostic == {"errorType": "RuntimeError", "codeLocation": "external"}


def test_real_application_500_contains_data_free_diagnostic(tmp_path):
    script = '''
import re
import logging
from fastapi.testclient import TestClient
from app.main import app
from app.config import API_PREFIX
from app.services.tokens import token_service
from app.api.routes import notes as notes_module

logging.getLogger("diagnostic-fixture").error(
    "Safe logging bridge fixture",
    exc_info=(ValueError, ValueError("PRIVATE_NOTE_CONTENT"), None),
)

exec(compile('def broken_view():\\n    raise ValueError("PRIVATE_NOTE_CONTENT")', notes_module.__file__, 'exec'))

app.add_api_route(API_PREFIX + "/diagnostic-fixture", broken_view)
token = token_service.create_token(client_info="fixture", owner_tab_id="tab", dek=None)
headers = {"Authorization": "Bearer " + token, "X-Metalist-Tab-Id": "tab", "Origin": "http://localhost"}
with TestClient(app, base_url="http://localhost", raise_server_exceptions=False) as client:
    response = client.get(API_PREFIX + "/diagnostic-fixture", headers=headers)
assert response.status_code == 500, (response.status_code, response.text)
assert response.json()["detail"] == "Internal server error"
diagnostic = response.json()["diagnostic"]
assert diagnostic["errorType"] == "ValueError", response.text
assert diagnostic["codeLocation"] == "app/api/routes/notes.py:2", response.text
assert re.fullmatch("[0-9a-f]{8}", diagnostic["requestId"]), response.text
assert response.headers["Cache-Control"] == "no-store, private"
assert "PRIVATE_NOTE_CONTENT" not in response.text
'''
    environment = dict(os.environ, METALIST_DATA_DIRECTORY=str(tmp_path), METALIST_ENVIRONMENT="production")
    result = subprocess.run(
        [sys.executable, "-c", script],
        env=environment,
        capture_output=True,
        encoding="utf-8",
        timeout=30,
    )
    assert result.returncode == 0, result.stderr[-3000:]
    assert "Safe logging bridge fixture error_type=ValueError frames=[]" in result.stdout
    assert "PRIVATE_NOTE_CONTENT" not in result.stdout + result.stderr


def test_real_application_answers_rejected_input_politely(tmp_path):
    # Rejected user input (e.g. a search that does not parse while creating a
    # note) is an expected failure: a 400 the browser shows as a polite
    # warning, never a 500 with a crash diagnostic.
    script = '''
from fastapi.testclient import TestClient
from app.main import app
from app.config import API_PREFIX
from app.services.input_errors import InputRejected
from app.services.tokens import token_service


def rejecting_view():
    raise InputRejected("In a search, + or - must be directly followed by the tag or quoted text, with no space (for example -tag)")


app.add_api_route(API_PREFIX + "/rejected-input-fixture", rejecting_view)
token = token_service.create_token(client_info="fixture", owner_tab_id="tab", dek=None)
headers = {"Authorization": "Bearer " + token, "X-Metalist-Tab-Id": "tab", "Origin": "http://localhost"}
with TestClient(app, base_url="http://localhost", raise_server_exceptions=False) as client:
    response = client.get(API_PREFIX + "/rejected-input-fixture", headers=headers)
assert response.status_code == 400, (response.status_code, response.text)
assert response.json() == {
    "detail": "In a search, + or - must be directly followed by the tag or quoted text, with no space (for example -tag)",
    "inputRejected": True,
}, response.text
'''
    environment = dict(os.environ, METALIST_DATA_DIRECTORY=str(tmp_path), METALIST_ENVIRONMENT="production")
    result = subprocess.run(
        [sys.executable, "-c", script],
        env=environment,
        capture_output=True,
        encoding="utf-8",
        timeout=30,
    )
    assert result.returncode == 0, result.stderr[-3000:]


def test_the_request_log_names_the_handler_that_answered(tmp_path):
    # Routing picks the handler while the request runs, so the answer's line
    # names it; a path no route matches says so.
    script = '''
from fastapi.testclient import TestClient
from app.main import app
from app.config import API_PREFIX
from app.services.tokens import token_service

def request_log_fixture_view():
    return {"ok": True}

app.add_api_route(API_PREFIX + "/request-log-fixture", request_log_fixture_view)
token = token_service.create_token(client_info="fixture", owner_tab_id="tab", dek=None)
headers = {"Authorization": "Bearer " + token, "X-Metalist-Tab-Id": "tab", "Origin": "http://localhost"}
with TestClient(app, base_url="http://localhost", raise_server_exceptions=False) as client:
    assert client.get(API_PREFIX + "/request-log-fixture", headers=headers).status_code == 200
    assert client.get(API_PREFIX + "/request-log-missing", headers=headers).status_code == 404
    # A mounted app (the static files) answers too: the page's stylesheet must load.
    assert client.get("/static/css/main.css").status_code == 200
'''
    # Windows writes a pipe or a file in its code page (cp1252), which has no ⇒ or ⇐:
    # every line of the request log failed to write there (2026-10-21). The server
    # writes UTF-8 whatever the platform's encoding, as the launcher reads it.
    environment = dict(
        os.environ, METALIST_DATA_DIRECTORY=str(tmp_path), METALIST_ENVIRONMENT="production",
        PYTHONIOENCODING="cp1252",
    )
    result = subprocess.run(
        [sys.executable, "-c", script], env=environment, capture_output=True, timeout=30,
    )
    output = result.stdout.decode("utf-8") + result.stderr.decode("utf-8")
    assert result.returncode == 0, output[-3000:]
    assert "Logging error" not in output, output[-3000:]
    answered = [line for line in output.splitlines() if "⇐ 200 GET" in line and "/request-log-fixture" in line]
    assert len(answered) == 1 and "handler=request_log_fixture_view " in answered[0], output[-3000:]
    missing = [line for line in output.splitlines() if "⇐ 404 GET" in line and "/request-log-missing" in line]
    assert len(missing) == 1 and "handler=(no route) " in missing[0], output[-3000:]
    static = [line for line in output.splitlines() if "⇐ 200 GET" in line and "/static/css/main.css" in line]
    assert len(static) == 1 and "handler=NoCacheStaticFiles " in static[0], output[-3000:]
    assert "handler=unknown" not in output
