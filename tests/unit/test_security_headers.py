from __future__ import annotations

import re
from pathlib import Path

import pytest
from starlette.responses import HTMLResponse

from app.security.http_headers import apply_security_headers
from app.security.http_headers import build_content_security_policy


NONCE = "A" * 32


def test_content_security_policy_allows_only_nonce_or_self_scripts() -> None:
    policy = build_content_security_policy(nonce=NONCE)

    assert f"script-src 'self' 'nonce-{NONCE}'" in policy
    assert "script-src 'self' 'unsafe-inline'" not in policy
    assert "object-src 'none'" in policy
    assert "frame-ancestors 'none'" in policy
    assert "base-uri 'none'" in policy


def test_content_security_policy_blocks_direct_remote_images() -> None:
    policy = build_content_security_policy(nonce=NONCE)

    assert "img-src 'self' data: blob:" in policy
    assert "img-src 'self' data: blob: https: http:" not in policy


def test_content_security_policy_blocks_direct_remote_connections() -> None:
    policy = build_content_security_policy(nonce=NONCE)

    assert "connect-src 'self' data: blob:" in policy
    assert "connect-src 'self' data: blob: https: http:" not in policy


def test_apply_security_headers_sets_browser_defenses() -> None:
    response = HTMLResponse("<html></html>")

    apply_security_headers(response=response, nonce=NONCE)

    assert response.headers["content-security-policy"] == build_content_security_policy(nonce=NONCE)
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "camera=()" in response.headers["permissions-policy"]
    assert response.headers["cache-control"] == "no-store, private"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["expires"] == "0"


@pytest.mark.parametrize("nonce", ["", "too-short", "!" * 32])
def test_content_security_policy_rejects_invalid_nonces(nonce: str) -> None:
    with pytest.raises(ValueError, match="CSP nonce"):
        build_content_security_policy(nonce=nonce)


def test_inline_template_scripts_carry_the_response_nonce() -> None:
    template_directory = Path(__file__).resolve().parents[2] / "app" / "templates"
    template_names = (
        "base.html",
        "locked.html",
        "maintenance.html",
        "namespace_deleted.html",
        "namespace_renamed.html",
    )

    for template_name in template_names:
        template_text = (template_directory / template_name).read_text(encoding="utf-8")
        inline_script_tags = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>", template_text)
        if template_name == "maintenance.html":
            assert 'src="/static/js/modules/maintenance.js?v=${asset_version}"' in template_text
            assert not inline_script_tags
        else:
            assert inline_script_tags, template_name
        assert all('nonce="${request.state.csp_nonce}"' in tag for tag in inline_script_tags)
