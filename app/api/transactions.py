from __future__ import annotations

from functools import wraps
from contextlib import nullcontext
import inspect
from typing import Any, Awaitable, Callable, ParamSpec, TypeVar, cast, get_type_hints

from fastapi import FastAPI, HTTPException
from app.services.bulk_operation import bulk_operation_guard
from fastapi.routing import APIRoute

from app.db.session import begin_request_transaction
from app.services.request_recovery import register_runtime_recovery
from app.services.maintenance_mode import maintenance_service


P = ParamSpec("P")
R = TypeVar("R")
_TRANSACTIONAL_ROUTE_MARKER = "__transactional_route__"
_MUTATION_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_STORAGE_TRANSITIONS = frozenset({"create_password", "remove_password", "restore_from_backup", "restore_backup", "import_backup"})


def _resolved_signature(func: Callable[..., Any]) -> inspect.Signature:
    signature = inspect.signature(func)
    resolved_hints = get_type_hints(
        func,
        globalns=func.__globals__,
        localns=None,
        include_extras=True,
    )

    parameters = [
        parameter.replace(
            annotation=resolved_hints.get(parameter.name, parameter.annotation),
        )
        for parameter in signature.parameters.values()
    ]
    return_annotation = resolved_hints.get("return", signature.return_annotation)
    return signature.replace(
        parameters=parameters,
        return_annotation=return_annotation,
    )


def transactional_route(func: Callable[P, R] | Callable[P, Awaitable[R]]) -> Callable[P, R] | Callable[P, Awaitable[R]]:
    resolved_signature = _resolved_signature(cast(Callable[..., Any], func))

    if inspect.iscoroutinefunction(func):
        async_func = cast(Callable[P, Awaitable[R]], func)

        @wraps(async_func)
        async def async_wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            with bulk_operation_guard.track_mutation():
                _check_bulk_guard(func.__name__)
                with begin_request_transaction():
                    register_runtime_recovery()
                    return await async_func(*args, **kwargs)

        async_wrapper.__signature__ = resolved_signature
        setattr(async_wrapper, _TRANSACTIONAL_ROUTE_MARKER, True)
        return async_wrapper

    sync_func = cast(Callable[P, R], func)

    @wraps(sync_func)
    def sync_wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        with bulk_operation_guard.lock:
            with bulk_operation_guard.track_mutation():
                _check_bulk_guard(func.__name__)
                maintenance = nullcontext()
                if func.__name__ in _STORAGE_TRANSITIONS:
                    maintenance = maintenance_service.hold_for_transaction("Updating namespace storage")
                with maintenance:
                    with begin_request_transaction():
                        register_runtime_recovery()
                        return sync_func(*args, **kwargs)

    sync_wrapper.__signature__ = resolved_signature
    setattr(sync_wrapper, _TRANSACTIONAL_ROUTE_MARKER, True)
    return sync_wrapper


def assert_mutation_routes_wrapped(app: FastAPI) -> None:
    violations: list[str] = []

    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        if route.methods is None:
            continue

        mutation_methods = sorted(method for method in route.methods if method in _MUTATION_METHODS)
        if len(mutation_methods) == 0:
            continue

        endpoint = route.endpoint
        if getattr(endpoint, _TRANSACTIONAL_ROUTE_MARKER, False) is True:
            continue

        violations.append(
            f"{','.join(mutation_methods)} {route.path} -> {endpoint.__module__}.{endpoint.__qualname__}",
        )

    if len(violations) == 0:
        return

    message_lines = ["Mutation routes missing @transactional_route:"]
    for violation in violations:
        message_lines.append(f"- {violation}")
    raise RuntimeError("\n".join(message_lines))


def _check_bulk_guard(endpoint_name: str) -> None:
    if endpoint_name in _STORAGE_TRANSITIONS and bulk_operation_guard.active_mutations > 1:
        raise HTTPException(status_code=409, detail="Wait for the current request to finish before changing namespace storage.")
    permitted = {"answer_bulk_question", "preview_cloud_privacy", "put_ai_debug_details"}
    if bulk_operation_guard.operation_id and endpoint_name not in permitted:
        raise HTTPException(status_code=409, detail="A bulk operation is running. Wait or cancel it before changing the app.")
