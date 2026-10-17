from __future__ import annotations

import re

from app.services.content_formatting import COMMENT_CLOSE, COMMENT_OPEN, find_plain_text_urls
from app.services.link_titles import link_title_store, normalize_url_for_link_title
from app.utils.text_utils import strip_html_keeping_link_urls


_WHITESPACE_RE = re.compile(r"\s+")


def _normalize_whitespace(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip()


def extract_tag_bar_comment_text(tags: str) -> str:
    if not isinstance(tags, str):
        raise TypeError(f"tags must be a string, got {type(tags)}")

    comments: list[str] = []
    index = 0
    while index < len(tags):
        start = tags.find(COMMENT_OPEN, index)
        if start == -1:
            break

        end = tags.find(COMMENT_CLOSE, start + len(COMMENT_OPEN))
        if end == -1:
            break

        inner = tags[start + len(COMMENT_OPEN) : end]
        normalized = _normalize_whitespace(inner)
        if normalized:
            comments.append(normalized)

        index = end + len(COMMENT_CLOSE)

    return " ".join(comments)


def list_link_title_urls(content_text: str) -> frozenset[str]:
    """The normalized URLs written out in a note's text; their cached titles are searchable."""
    if "://" not in content_text:
        # Most notes have no URL; skip the scan during hydration.
        return frozenset()
    urls: set[str] = set()
    for url in find_plain_text_urls(content_text):
        normalized_url = normalize_url_for_link_title(url)
        if normalized_url is not None:
            urls.add(normalized_url)
    return frozenset(urls)


def append_link_titles_casefold(text_casefold: str, link_title_urls: frozenset[str]) -> str:
    """Searchable text plus the cached titles of the note's URLs (docs/ui/search-semantics.md).

    Only titles already fetched count; a title fetched later is added when the
    search index refreshes the notes containing that URL.
    """
    if not isinstance(text_casefold, str) or not isinstance(link_title_urls, frozenset):
        raise TypeError("append_link_titles_casefold requires text and a frozenset of URLs")
    titles: list[str] = []
    for url in sorted(link_title_urls):
        title = link_title_store.get_ok_title(url)
        if title is not None:
            titles.append(title.casefold())
    if not titles:
        return text_casefold
    return " ".join([text_casefold, *titles])


def build_searchable_text_casefold_from_plaintext(content_text: str, tags: str) -> str:
    """Visible text, tag-bar comments and the cached titles of URLs in the text, casefolded."""
    return append_link_titles_casefold(
        build_searchable_base_text_casefold(content_text, tags),
        list_link_title_urls(content_text),
    )


def build_searchable_base_text_casefold(content_text: str, tags: str) -> str:
    """Visible text and tag-bar comments, casefolded (without URL titles)."""
    if not isinstance(content_text, str):
        raise TypeError(f"content_text must be a string, got {type(content_text)}")
    if not isinstance(tags, str):
        raise TypeError(f"tags must be a string, got {type(tags)}")

    comment_text = extract_tag_bar_comment_text(tags)

    combined = content_text
    if comment_text:
        if combined:
            combined = f"{combined} {comment_text}"
        else:
            combined = comment_text

    return combined.casefold()


def build_searchable_text_casefold(content_html: str, tags: str) -> str:
    if not isinstance(content_html, str):
        raise TypeError(f"content_html must be a string, got {type(content_html)}")
    if not isinstance(tags, str):
        raise TypeError(f"tags must be a string, got {type(tags)}")

    return build_searchable_text_casefold_from_plaintext(strip_html_keeping_link_urls(content_html), tags)


def text_term_matches(term: str, text_casefold: str) -> bool:
    """Whether a quoted search term occurs in casefolded note text.

    A term matches anywhere, also inside words ("fat" in "father"), except that a
    space at its edge marks a word boundary on that side: "fat " needs the word to
    end there (a space, punctuation or the end of the text follows), " fat" needs it
    to start there (docs/ui/search-semantics.md).
    """
    if not isinstance(term, str) or not isinstance(text_casefold, str):
        raise TypeError("text_term_matches requires strings")
    core = term.strip().casefold()
    if core == "":
        raise ValueError("A quoted search term must not be blank")
    word_starts = term.startswith(" ")
    word_ends = term.endswith(" ")
    if not word_starts and not word_ends:
        return core in text_casefold
    start = text_casefold.find(core)
    while start != -1:
        end = start + len(core)
        if _is_word_edge(text_casefold, start - 1, word_starts) and _is_word_edge(text_casefold, end, word_ends):
            return True
        start = text_casefold.find(core, start + 1)
    return False


def _is_word_edge(text: str, index: int, required: bool) -> bool:
    """Whether position `index` (just outside a match) ends a word, when required."""
    if not required:
        return True
    if index < 0 or index >= len(text):
        return True
    return not text[index].isalnum()
