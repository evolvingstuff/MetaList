from __future__ import annotations

import os
import subprocess
import sys

from fastapi import FastAPI
import pytest

from app.api.transactions import assert_mutation_routes_wrapped
from app.api.transactions import transactional_route


def test_transaction_audit_accepts_decorated_mutation_routes() -> None:
    app = FastAPI()

    @app.post("/mutate")
    @transactional_route
    def mutate() -> dict[str, bool]:
        return {"ok": True}

    assert_mutation_routes_wrapped(app)


def test_transaction_audit_rejects_undecorated_mutation_routes() -> None:
    app = FastAPI()

    def mutate() -> dict[str, bool]:
        return {"ok": True}

    app.add_api_route("/mutate", mutate, methods=["POST"])

    with pytest.raises(RuntimeError, match="POST /mutate"):
        assert_mutation_routes_wrapped(app)


def test_transaction_audit_ignores_read_only_routes() -> None:
    app = FastAPI()

    @app.get("/read")
    def read() -> dict[str, bool]:
        return {"ok": True}

    assert_mutation_routes_wrapped(app)


_REAL_APP_TIMEOUT_SECONDS = 60


def test_every_data_changing_route_of_the_real_app_runs_in_a_transaction(tmp_path) -> None:
    # The audit was only ever run on made-up apps, so a new MetaList route without
    # @transactional_route would have gone unnoticed (found by ShockHarness DEAD002).
    # The real app starts in its own process: importing it starts services that must
    # not run inside the test process.
    script = (
        "from app.api.transactions import assert_mutation_routes_wrapped\n"
        "from app.main import app\n"
        "assert_mutation_routes_wrapped(app)\n"
    )
    environment = dict(os.environ, METALIST_DATA_DIRECTORY=str(tmp_path), METALIST_ENVIRONMENT="production")
    result = subprocess.run(
        [sys.executable, "-c", script],
        env=environment,
        capture_output=True,
        text=True,
        timeout=_REAL_APP_TIMEOUT_SECONDS,
    )
    assert result.returncode == 0, result.stderr[-3000:]
