"""The @diff renderer: a unified diff with added and removed lines coloured.

Unified diff is what `git diff` and `diff -u` print: `---`/`+++` name the files,
`@@ -1,3 +1,3 @@` starts each changed section, and every other line begins with a
space (unchanged), `-` (removed) or `+` (added). Lines jotted by hand with only
`+`/`-` marks work too. Nothing needs to parse, so there is no error state.
"""
from __future__ import annotations

import html
from typing import FrozenSet

from app.services.structured_note_renderers import _copyable_attr, _extract_plain_text


_FILE_HEADER_PREFIXES = ("diff --git ", "index ", "--- ", "+++ ", "new file mode", "deleted file mode", "similarity index", "rename from", "rename to")


def classify_diff_line(line: str) -> str:
    """The kind of a diff line: file, hunk, add, remove, or context."""
    if not isinstance(line, str):
        raise TypeError("line must be a string")
    if line.startswith(_FILE_HEADER_PREFIXES) or line in {"---", "+++"}:
        return "file"
    if line.startswith("@@"):
        return "hunk"
    if line.startswith("+"):
        return "add"
    if line.startswith("-"):
        return "remove"
    return "context"


def render_diff_meta(*, content_html: str, formatting_tags: FrozenSet[str], extra_classes: str) -> str:
    raw_text = _extract_plain_text(content_html)
    copy_attr = _copyable_attr(formatting_tags, raw_text)
    lines = raw_text.strip("\n").split("\n")
    rendered_lines = "".join(
        f'<span class="meta-diff-line meta-diff-{classify_diff_line(line)}">{html.escape(line, quote=False)}\n</span>'
        for line in lines
    )
    code_class = "meta-diff-code"
    if extra_classes:
        code_class = f"{code_class} {extra_classes}"
    return (
        f'<div class="meta-diff"{copy_attr}>'
        f'<pre class="meta-diff-pre"><code class="{code_class}">{rendered_lines}</code></pre>'
        "</div>"
    )


__all__ = ["classify_diff_line", "render_diff_meta"]
