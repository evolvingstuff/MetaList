"""Session-bound, single-use acknowledgments for browser menu opening."""

import asyncio
from dataclasses import dataclass
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from app.services.agent.help_catalog import MENU_BY_ID

_MAX_RESULT_DETAIL_CHARS = 2000
# How long the agent waits for the browser to open the menu it asked for.
_MENU_RESULT_TIMEOUT_SECONDS = 30


class MenuResult(BaseModel):
    model_config = ConfigDict(extra='forbid')

    request_id: str = Field(..., min_length=1)
    status: Literal['opened', 'unavailable', 'cancelled']
    detail: str = Field(..., max_length=_MAX_RESULT_DETAIL_CHARS)


@dataclass(frozen=True)
class PendingMenu:
    session_key: str
    request_id: str
    menu_id: str
    future: asyncio.Future


class MenuActionStore:
    def __init__(self) -> None:
        self._pending: dict[str, PendingMenu] = {}

    def create(self, *, session_key: str, menu_id: str) -> PendingMenu:
        assert session_key and menu_id in MENU_BY_ID
        pending = PendingMenu(session_key, str(uuid4()), menu_id, asyncio.get_running_loop().create_future())
        self._pending[pending.request_id] = pending
        return pending

    def acknowledge(self, *, session_key: str, result: MenuResult) -> None:
        if result.request_id not in self._pending:
            raise ValueError('Menu request is no longer pending')
        pending = self._pending[result.request_id]
        if pending.session_key != session_key or pending.future.done():
            raise ValueError('Menu request is not pending for this session')
        pending.future.set_result(result)

    async def wait(self, pending: PendingMenu) -> MenuResult:
        # lint: allow-PY001 rationale="browser disconnect or missing acknowledgment is an external timeout"
        try:
            return await asyncio.wait_for(pending.future, timeout=_MENU_RESULT_TIMEOUT_SECONDS)
        # lint: allow-PY001 rationale="record a missing browser acknowledgment as unavailable, never success"
        except asyncio.TimeoutError:
            return MenuResult(request_id=pending.request_id, status='unavailable', detail='Browser did not acknowledge opening within 30 seconds.')
        finally:
            self.discard(pending)

    def discard(self, pending: PendingMenu) -> None:
        # The browser's acknowledgment may have removed it already.
        if pending.request_id in self._pending:
            del self._pending[pending.request_id]
        if not pending.future.done():
            pending.future.cancel()


menu_action_store = MenuActionStore()
