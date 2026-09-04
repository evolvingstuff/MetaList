from app.api.routes.notes import router as notes_router
from app.config import API_PREFIX


def test_removed_calendar_routes_are_not_registered() -> None:
    registered_paths = {
        f"{API_PREFIX}{route.path}"
        for route in notes_router.routes
    }

    assert f"{API_PREFIX}/notes/activity" not in registered_paths
    assert f"{API_PREFIX}/notes/tab-state/date-filter" not in registered_paths
