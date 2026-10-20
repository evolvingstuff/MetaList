"""Text processing utilities for the application."""

import html
import re
from html.parser import HTMLParser


_IGNORE_TAGS = {"script", "style", "noscript"}

_BLOCK_TAGS = {
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "div",
    "dl",
    "dt",
    "dd",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
}


class HTMLStripper(HTMLParser):
    """Custom HTML parser to strip tags and extract plain text"""
    
    def __init__(self):
        super().__init__()
        self.reset()
        self.strict = False
        self.convert_charrefs = True
        self.text = []

        self._ignore_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        del attrs
        normalized = tag.lower()
        if normalized in _IGNORE_TAGS:
            self._ignore_depth += 1
            return
        if normalized in _BLOCK_TAGS:
            self.text.append(" ")

    def handle_startendtag(self, tag: str, attrs) -> None:
        del attrs
        normalized = tag.lower()
        if normalized in _BLOCK_TAGS:
            self.text.append(" ")

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.lower()
        if normalized in _IGNORE_TAGS:
            if self._ignore_depth > 0:
                self._ignore_depth -= 1
            return
        if normalized in _BLOCK_TAGS:
            self.text.append(" ")
    
    def handle_data(self, data):
        if self._ignore_depth > 0:
            return
        self.text.append(data)
    
    def get_data(self):
        return ''.join(self.text)


class LinkUrlKeepingStripper(HTMLStripper):
    """Visible text, plus each web link's URL after its label when the label does not show it.

    A link pasted from a web page often shows a title ("Video title") and hides
    its URL; search and the AI should still see "Video title (https://...)".
    """

    def __init__(self) -> None:
        super().__init__()
        self._open_links: list[tuple[str, int]] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        super().handle_starttag(tag, attrs)
        if tag.lower() != "a" or self._ignore_depth > 0:
            return
        href = ""
        for name, value in attrs:
            if name.lower() == "href" and value:
                href = value.strip()
        self._open_links.append((href, len(self.text)))

    def handle_endtag(self, tag: str) -> None:
        # Pasted HTML can close a link that was never opened; there is no URL to add then.
        if tag.lower() == "a" and self._open_links:
            href, label_start = self._open_links.pop()
            label = "".join(self.text[label_start:])
            if href.casefold().startswith(("http://", "https://")) and href not in label:
                self.text.append(f" ({href})")
        super().handle_endtag(tag)


def strip_html_keeping_link_urls(html_content: str) -> str:
    """strip_html, plus the URLs that link labels hide (see LinkUrlKeepingStripper)."""
    if not isinstance(html_content, str):
        raise TypeError(f"html_content must be a string, got {type(html_content)}")
    if "href" not in html_content:
        return strip_html(html_content)
    stripper = LinkUrlKeepingStripper()
    stripper.feed(html_content)
    return " ".join(stripper.get_data().split())


def strip_html(html_content: str) -> str:
    """
    Strip HTML tags from content and return plain text.
    
    Args:
        html_content: HTML string to strip
        
    Returns:
        Plain text with HTML tags removed
    """
    if not isinstance(html_content, str):
        raise TypeError(f"html_content must be a string, got {type(html_content)}")
    if html_content == "":
        return ""
    
    # Use our custom parser to strip HTML
    stripper = HTMLStripper()
    stripper.feed(html_content)
    text = stripper.get_data()
    
    # Collapse whitespace runs. str.split() uses the same Unicode whitespace
    # set as regex \s but runs several times faster on large notes.
    return " ".join(text.split())


# A tag as the note sanitizer writes it: a quoted attribute value may hold ">".
_SANITIZED_TAG_BODY = r"""(?:[^>"']|"[^"]*"|'[^']*')*>"""
_SANITIZED_BLOCK_TAG_RE = re.compile(
    r"</?(?:" + "|".join(sorted(_BLOCK_TAGS)) + r")(?=[\s/>])" + _SANITIZED_TAG_BODY
)
_SANITIZED_TAG_RE = re.compile(r"</?[a-zA-Z][^\s/>]*" + _SANITIZED_TAG_BODY)
# Markup the sanitizer never writes: its presence means the input was not sanitized.
_UNSANITIZED_MARKUP_RE = re.compile(r"<!--|<(?:" + "|".join(sorted(_IGNORE_TAGS)) + r")[\s/>]", re.IGNORECASE)


def strip_sanitized_html(sanitized_html: str) -> str:
    """strip_html's text for the note sanitizer's output (app/security/note_html.py),
    without Python's HTML parser: tags are well formed and lowercase, text holds no raw
    "<" and every "&" starts an entity, and there are no comments, scripts or styles.
    Block tags become a space, other tags nothing, then entities are unescaped and
    whitespace collapsed. Unlocking extracts every note's text with it."""
    if not isinstance(sanitized_html, str):
        raise TypeError(f"sanitized_html must be a string, got {type(sanitized_html)}")
    if _UNSANITIZED_MARKUP_RE.search(sanitized_html):
        raise ValueError("strip_sanitized_html needs the note sanitizer's output: found a comment, script or style")
    text = _SANITIZED_TAG_RE.sub("", _SANITIZED_BLOCK_TAG_RE.sub(" ", sanitized_html))
    return " ".join(html.unescape(text).split())
