"""Find in the list (docs/ui/find.md): how a note's rendered HTML reads, and where a
find's text occurs in it.

The reading and the matching are those of the browser's marks
(app/static/js/modules/mode-manager/services/search-highlight-service.js readVisibleText,
search-highlight-matching.js findPhraseMatches), so a note's count here is the number of
marks the browser paints in it.
"""

from __future__ import annotations

from html.parser import HTMLParser
import re

# Elements whose start and end break the text the way the search reads it: one space
# (search-highlight-service.js TEXT_BREAKING_ELEMENTS).
_TEXT_BREAKING_ELEMENTS = frozenset({
    "address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt",
    "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
    "li", "main", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot",
    "th", "thead", "tr", "ul",
})
_WHITESPACE_RE = re.compile(r"\s")
_WORD_CHARACTER_RE = re.compile(r"[^\W_]")


class _VisibleTextReader(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ends_with_space = True

    def _add_space(self) -> None:
        if self._ends_with_space:
            return
        self.parts.append(" ")
        self._ends_with_space = True

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _TEXT_BREAKING_ELEMENTS:
            self._add_space()

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _TEXT_BREAKING_ELEMENTS:
            self._add_space()

    def handle_endtag(self, tag: str) -> None:
        if tag in _TEXT_BREAKING_ELEMENTS:
            self._add_space()

    def handle_data(self, data: str) -> None:
        for character in data:
            if _WHITESPACE_RE.match(character):
                self._add_space()
            else:
                self.parts.append(character)
                self._ends_with_space = False


def read_visible_text(html: str) -> str:
    """An element's text as the browser's marks read it: every run of whitespace, and
    every break between blocks or lines, is one space."""
    if not isinstance(html, str):
        raise TypeError(f"html must be a string, got {type(html)}")
    reader = _VisibleTextReader()
    reader.feed(html)
    reader.close()
    return "".join(reader.parts)


def read_comment_text(comment: str) -> str:
    """A tag-bar comment's text as its element reads: whitespace runs are one space."""
    if not isinstance(comment, str):
        raise TypeError(f"comment must be a string, got {type(comment)}")
    reader = _VisibleTextReader()
    reader.handle_data(comment)
    return "".join(reader.parts)


def _lowercase_in_place(text: str) -> str:
    """Lowercase, one character for one, so a position in the result is the same
    position in the text (a letter whose lowercase is longer, such as İ, stays)."""
    lowered: list[str] = []
    for character in text:
        lower = character.lower()
        if len(lower) == len(character):
            lowered.append(lower)
        else:
            lowered.append(character)
    return "".join(lowered)


def _is_word_edge(text: str, index: int, is_required: bool) -> bool:
    if not is_required:
        return True
    if index < 0 or index >= len(text):
        return True
    return _WORD_CHARACTER_RE.match(text[index]) is None


def count_occurrences(text: str, find_text: str) -> int:
    """How often find_text occurs in text: in any case, also inside words and
    overlapping; a space at its edge limits it to a word edge on that side."""
    if not isinstance(text, str) or not isinstance(find_text, str):
        raise TypeError("count_occurrences requires strings")
    core = _lowercase_in_place(find_text.strip())
    if core == "":
        raise ValueError("The text to find must not be blank")
    word_starts = find_text.startswith(" ")
    word_ends = find_text.endswith(" ")
    lowered = _lowercase_in_place(text)
    count = 0
    start = lowered.find(core)
    while start != -1:
        end = start + len(core)
        if _is_word_edge(lowered, start - 1, word_starts) and _is_word_edge(lowered, end, word_ends):
            count += 1
        start = lowered.find(core, start + 1)
    return count
