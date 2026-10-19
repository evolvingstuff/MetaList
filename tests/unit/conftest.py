"""Checks that the rendered-HTML pass removes nothing the renderers emit.

The pass (app/security/rendered_html.py) is a safety net: every tag and attribute the
renderers produce is on its allowlist, so for MetaList's own output it changes only the
spelling (quoting, entities, how empty elements are closed), never the markup. A
renderer that adds a tag or attribute the allowlist lacks would lose it silently in the
browser. This conftest runs that comparison on every pass in the unit suite, so it fails
the test that rendered it instead.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser

import nh3
import pytest

from app.security import rendered_html


# Elements that never have an end tag in HTML.
_VOID_ELEMENTS = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
})


# An attribute name as written (SVG's viewBox keeps its case in the parsed page).
_ATTRIBUTE_NAME_RE = re.compile(r"""\s([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=""")
_URL_SCHEME_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9+.-]*):")


class _TokenCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tokens: list[tuple[object, ...]] = []
        self.attributes_by_tag: dict[str, set[str]] = {}
        self.url_schemes: set[str] = set()

    def _add_text(self, text: str) -> None:
        if len(self.tokens) > 0 and self.tokens[-1][0] == "text":
            self.tokens[-1] = ("text", f"{self.tokens[-1][1]}{text}")
            return
        self.tokens.append(("text", text))

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        names = self.attributes_by_tag.setdefault(tag, set())
        names.update(_ATTRIBUTE_NAME_RE.findall(self.get_starttag_text()))
        names.update(name for name, _value in attrs)
        for _name, value in attrs:
            if value is not None and _URL_SCHEME_RE.match(value):
                self.url_schemes.add(_URL_SCHEME_RE.match(value).group(1).casefold())
        # Both sides are nh3's writing, so every attribute has a value; an empty style
        # attribute styles nothing, and the pass drops it.
        normalized = tuple(sorted(
            (name, value) for name, value in attrs if not (name == "style" and value.strip() == "")
        ))
        self.tokens.append(("start", tag, normalized))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in _VOID_ELEMENTS:
            self.tokens.append(("end", tag))

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID_ELEMENTS:
            return
        self.tokens.append(("end", tag))

    def handle_data(self, data: str) -> None:
        self._add_text(data)

    def handle_comment(self, data: str) -> None:
        # The pass strips comments; renderers emit none that the page relies on.
        return


def _collect(html: str) -> _TokenCollector:
    collector = _TokenCollector()
    collector.feed(html)
    collector.close()
    return collector


def _parsed_as_the_page_would(html: str) -> str:
    """The rendered HTML through the same HTML5 parser and writer as the pass, keeping
    every tag and attribute it has: it differs from the pass's output only by what the
    allowlist removed (a <div> inside a <p> closes the <p> in both)."""
    collector = _collect(html)
    return nh3.Cleaner(
        tags=set(collector.attributes_by_tag),
        clean_content_tags=set(),
        attributes={tag: set(names) for tag, names in collector.attributes_by_tag.items()},
        strip_comments=True,
        link_rel=None,
        url_schemes=collector.url_schemes,
    ).clean(html)


def assert_pass_removed_nothing(*, rendered: str, sanitized: str) -> None:
    before = _collect(_parsed_as_the_page_would(rendered)).tokens
    after = _collect(sanitized).tokens
    if before == after:
        return
    for index, (expected, actual) in enumerate(zip(before, after)):
        if expected != actual:
            raise AssertionError(
                f"the rendered-HTML pass changed the renderer's markup at token {index}: "
                f"rendered {expected!r}, sent {actual!r}. Add what the renderer emits to "
                f"app/security/rendered_html.py, or stop emitting it.\nrendered: {rendered[:2000]}"
            )
    raise AssertionError(
        f"the rendered-HTML pass changed the number of tokens ({len(before)} rendered, "
        f"{len(after)} sent).\nrendered: {rendered[:2000]}"
    )


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
