"""Every rendered-HTML pass in the unit suite is checked to remove nothing the renderers emit."""

import pytest

from app.security import rendered_html
from tests.unit.rendered_html_lossless import assert_pass_removed_nothing


class _CheckedCleaner:
    def __init__(self, cleaner) -> None:
        self._cleaner = cleaner

    def clean(self, html: str) -> str:
        sanitized = self._cleaner.clean(html)
        assert_pass_removed_nothing(rendered=html, sanitized=sanitized)
        return sanitized


@pytest.fixture
def unchecked_rendered_html_pass():
    """For a test that feeds the pass unsafe markup on purpose, so it is meant to remove some."""
    return


@pytest.fixture(autouse=True)
def _rendered_html_pass_removes_nothing(request, monkeypatch):
    if "unchecked_rendered_html_pass" in request.fixturenames:
        return
    cleaner = rendered_html._build_rendered_cleaner()
    monkeypatch.setattr(rendered_html, "_build_rendered_cleaner", lambda: _CheckedCleaner(cleaner))
