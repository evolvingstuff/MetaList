from __future__ import annotations

import pytest

import app.api.routes.auth as auth_route
from app.services.namespace_switcher import NamespaceDeleteResult


def test_encrypted_namespace_deletion_body_does_not_require_password(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delete_calls: list[dict[str, object]] = []
    monkeypatch.setattr(auth_route, "ACTIVE_NAMESPACE", "default")
    assert not hasattr(auth_route, "_namespace_requires_password")
    monkeypatch.setattr(
        auth_route,
        "delete_namespace",
        lambda **kwargs: delete_calls.append(kwargs) or NamespaceDeleteResult(  # shockharness: ignore[DEF003] reason="the stub records its call, then returns its value (append/update return None)"
            deleted_namespace="locked",
            redirect_url="",
            delete_job_id="",
            active_namespace_deleted=False,
            message="locked namespace successfully deleted.",
        ),
    )

    response = auth_route._delete_namespace_from_body(
        body={
            "confirmed_namespace": "locked",
            "redirect_namespace": "default",
        },
        target_namespace="locked",
    )

    assert response["deleted_namespace"] == "locked"
    assert delete_calls == [
        {
            "environ": auth_route.os.environ,
            "current_namespace": "default",
            "target_namespace": "locked",
            "confirmed_namespace": "locked",
            "redirect_namespace": "default",
        }
    ]


def test_namespace_delete_preflight_does_not_report_password_requirement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth_route, "ACTIVE_NAMESPACE", "default")
    monkeypatch.setattr(auth_route, "_namespace_target_exists", lambda *, namespace: True)
    assert not hasattr(auth_route, "_namespace_requires_password")
    monkeypatch.setattr(
        auth_route,
        "build_namespace_catalog",
        lambda **kwargs: {
            "namespaces": [
                {"namespace": "default"},
                {"namespace": "locked"},
            ]
        },
    )

    response = auth_route.namespace_delete_preflight.__wrapped__(
        payload={"target_namespace": "locked"},
        token="token",
    )

    assert response == {
        "target_namespace": "locked",
        "target_exists": True,
        "is_current_namespace": False,
        "redirect_namespaces": ["default"],
        "recreates_default": False,
    }
