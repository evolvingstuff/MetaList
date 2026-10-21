"""Requests that arrive while MetaList is in maintenance (a password being set, a backup
being restored, a storage transaction committing).

An API caller reads the body as JSON, and a module import needs JavaScript, so neither may
be redirected to the HTML maintenance page: a tab-state save that landed 150 ms into a
password setup read that page as JSON and failed the browser smoke (2026-10-21). API
requests wait for maintenance to end and are then answered as usual; static files are
served; only page loads go to the maintenance page."""

from __future__ import annotations

import asyncio
import json
from http import HTTPStatus

import pytest
from starlette.requests import Request
from starlette.responses import Response

import app.api.middleware.auth as auth_middleware
from app.api.middleware.auth import AuthMiddleware
from app.config import API_PREFIX
from app.services.maintenance_mode import maintenance_service

# Long enough for a waiting request to have polled several times before maintenance ends.
_MAINTENANCE_SECONDS = 0.2
_SHORT_WAIT_SECONDS = 0.05


def _request(path: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8000),
        }
    )


async def _answered(_request: Request) -> Response:
    return Response(status_code=HTTPStatus.OK)


@pytest.fixture
def in_maintenance():
    maintenance_service.enter_maintenance("Encrypting all notes with new password")
    yield
    maintenance_service.exit_maintenance()


def test_an_api_request_during_maintenance_is_answered_once_maintenance_ends(in_maintenance) -> None:
    middleware = AuthMiddleware(lambda scope, receive, send: None)

    async def scenario() -> tuple[Response, bool]:
        waiting = asyncio.create_task(middleware.dispatch(_request(f"{API_PREFIX}/auth/status"), _answered))
        await asyncio.sleep(_MAINTENANCE_SECONDS)
        still_waiting = not waiting.done()
        maintenance_service.exit_maintenance()
        return await waiting, still_waiting

    response, still_waiting = asyncio.run(scenario())

    assert still_waiting
    assert response.status_code == HTTPStatus.OK


def test_an_api_request_whose_maintenance_outlasts_the_wait_gets_a_json_503(in_maintenance, monkeypatch) -> None:
    monkeypatch.setattr(auth_middleware, "_MAINTENANCE_WAIT_SECONDS", _SHORT_WAIT_SECONDS)
    middleware = AuthMiddleware(lambda scope, receive, send: None)

    response = asyncio.run(middleware.dispatch(_request(f"{API_PREFIX}/notes/tab-state"), _answered))

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.headers["content-type"] == "application/json"
    assert json.loads(response.body)["detail"].startswith("MetaList is busy")


def test_a_static_file_during_maintenance_is_served(in_maintenance) -> None:
    middleware = AuthMiddleware(lambda scope, receive, send: None)

    response = asyncio.run(middleware.dispatch(_request("/static/js/modules/maintenance.js"), _answered))

    assert response.status_code == HTTPStatus.OK


def test_a_page_load_during_maintenance_goes_to_the_maintenance_page(in_maintenance) -> None:
    middleware = AuthMiddleware(lambda scope, receive, send: None)

    response = asyncio.run(middleware.dispatch(_request("/"), _answered))

    assert response.status_code == HTTPStatus.FOUND
    assert response.headers["location"] == "/maintenance"
