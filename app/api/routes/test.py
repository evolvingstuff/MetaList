from __future__ import annotations

from fastapi import APIRouter

from app.api.transactions import transactional_route
from app.config import TEST_MODE
from app.services.reset_for_tests import reset_state_for_tests

router = APIRouter()


@router.post("/test/reset")
@transactional_route
async def reset_test_state() -> dict:
    assert TEST_MODE, "Test reset endpoint is only available in TEST_MODE"
    reset_state_for_tests()
    return {"ok": True}
