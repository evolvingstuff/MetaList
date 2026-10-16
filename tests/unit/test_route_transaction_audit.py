from __future__ import annotations

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
