"""@diff colours a unified diff; @code=<language> highlights source code.

docs/ui/content-formatting.md, "Diff meta tags" and "Code meta tags".
"""

import re

from app.services.code_rendering import parse_code_tag_language
from app.services.content_formatting import format_note_content_for_view
from app.services.content_formatting import list_known_meta_tag_terms
from app.services.content_formatting import remove_added_style_tags
from app.services.diff_rendering import classify_diff_line


def _render(lines: list[str], tags: str) -> str:
    content_html = "".join(f"<p>{line}</p>" for line in lines)
    return format_note_content_for_view(content_html=content_html, tags=tags, redact_passwords=False)


def _diff_kinds(rendered: str) -> list[tuple[str, str]]:
    return re.findall(r'<span class="meta-diff-line meta-diff-([a-z]+)">([^\n]*)\n</span>', rendered)


def test_a_unified_diff_colours_each_line_by_its_first_character() -> None:
    rendered = _render(
        ["diff --git a/notes.txt b/notes.txt", "--- a/notes.txt", "+++ b/notes.txt", "@@ -1,3 +1,3 @@",
         " unchanged line", "-old wording", "+new wording"],
        "@diff",
    )
    assert _diff_kinds(rendered) == [
        ("file", "diff --git a/notes.txt b/notes.txt"),
        ("file", "--- a/notes.txt"),
        ("file", "+++ b/notes.txt"),
        ("hunk", "@@ -1,3 +1,3 @@"),
        ("context", " unchanged line"),
        ("remove", "-old wording"),
        ("add", "+new wording"),
    ]


def test_lines_jotted_with_only_plus_and_minus_work_too() -> None:
    rendered = _render(["- milk", "+ oat milk", "eggs"], "@diff")
    assert [kind for kind, _line in _diff_kinds(rendered)] == ["remove", "add", "context"]


def test_a_removed_line_starting_with_dashes_is_not_a_file_header() -> None:
    assert classify_diff_line("--- a/file") == "file"
    assert classify_diff_line("-- comment removed") == "remove"
    assert classify_diff_line("++counter") == "add"


def test_diff_text_is_escaped() -> None:
    rendered = _render(["+&lt;script&gt;alert(1)&lt;/script&gt;"], "@diff")
    assert "<script>" not in rendered
    assert "+&lt;script&gt;alert(1)&lt;/script&gt;" in rendered


def test_python_is_highlighted_keeping_its_indentation() -> None:
    rendered = _render(["def area(radius):", "    # circle", "    return 3.14 * radius ** 2"], "@code=python")
    assert '<span class="meta-code-language">python</span>' in rendered
    assert '<span class="tok-k">def</span>' in rendered
    assert '<span class="tok-nf">area</span>' in rendered
    assert '<span class="tok-c1"># circle</span>' in rendered
    assert '<span class="tok-mf">3.14</span>' in rendered
    assert "\n    <span" in rendered
    assert "meta-code-badge" not in rendered


def test_one_tag_works_for_every_language_name_and_alias() -> None:
    assert '<span class="tok-kd">const</span>' in _render(["const total = 1;"], "@code=javascript")
    assert '<span class="tok-kd">const</span>' in _render(["const total = 1;"], "@code=js")
    assert '<span class="tok-k">SELECT</span>' in _render(["SELECT name FROM notes;"], "@code=sql")
    # Tag names are case-insensitive, like every meta tag.
    assert '<span class="tok-k">def</span>' in _render(["def f(): pass"], "@code=Python")


def test_an_unknown_language_shows_the_code_plainly_with_a_badge() -> None:
    rendered = _render(["print('hi')"], "@code=pyhton")
    assert ">Unknown language: pyhton</span>" in rendered
    assert "print('hi')" in rendered
    assert "tok-" not in rendered


def test_code_text_is_escaped() -> None:
    rendered = _render(["x = '&lt;/code&gt;&lt;script&gt;'"], "@code=python")
    assert "<script>" not in rendered
    assert "</code><script>" not in rendered


def test_a_wrapped_region_renders_only_that_part() -> None:
    rendered = _render(["Run ((SELECT 1;)) to check."], "((@code=sql))")
    assert rendered.startswith("<p>Run ")
    assert '<span class="tok-k">SELECT</span>' in rendered
    assert rendered.endswith(" to check.</p>")


def test_only_one_renderer_applies_to_a_note() -> None:
    rendered = _render(["+added"], "@diff @code=python")
    assert "meta-diff-add" in rendered
    assert "meta-code" not in rendered


def test_remove_formatting_removes_code_and_diff_tags() -> None:
    assert remove_added_style_tags("topic @code=python")[0] == "topic"
    assert remove_added_style_tags("topic @diff")[0] == "topic"


def test_code_tag_names() -> None:
    assert parse_code_tag_language("code=python") == "python"
    assert parse_code_tag_language("code=c++") == "c++"
    assert parse_code_tag_language("code=") is None
    assert parse_code_tag_language("codex") is None
    # @code=<language> is recognised by pattern (any language), not listed.
    known = list_known_meta_tag_terms()
    assert "@diff" in known
    assert "@code=python" not in known


def test_mermaid_is_one_diagram_in_its_own_block() -> None:
    # The browser draws .meta-mermaid > .meta-mermaid-source > code.language-mermaid
    # (mermaid-render-service.js), like a fenced block under @markdown.
    rendered = _render(["graph TD", "  A[Paste] --&gt; B[Detect]"], "@mermaid")
    assert rendered == (
        '<div class="meta-mermaid"><pre class="meta-mermaid-source">'
        '<code class="language-mermaid">graph TD\n  A[Paste] --&gt; B[Detect]</code></pre></div>'
    )
    assert "meta-markdown" not in rendered


def test_mermaid_source_is_escaped_and_works_wrapped() -> None:
    assert "<script>" not in _render(["graph TD", "  A[&lt;script&gt;] --&gt; B"], "@mermaid")
    wrapped = _render(["Flow: ((graph LR", "  A --&gt; B)) done"], "((@mermaid))")
    assert '<code class="language-mermaid">graph LR' in wrapped
    assert "@mermaid" in list_known_meta_tag_terms()


def test_pasted_indentation_reads_as_ordinary_spaces() -> None:
    # Pasting into a note stores leading spaces as non-breaking spaces; JSON,
    # code and diffs read them as the spaces they were.
    trip = ["{", "&nbsp; \"title\": \"Weekend trip\",", "&nbsp; \"booked\": true", "}"]
    rendered = _render(trip, "@json")
    assert "meta-json-error" not in rendered
    assert "\xa0" not in rendered
    code = _render(["def f():", "&nbsp; &nbsp; return 1"], "@code=python")
    assert "\n    <span class=\"tok-k\">return</span>" in code
    assert "\xa0" not in _render(["@@ -1 +1 @@", "&nbsp;eggs", "-milk", "+oat milk"], "@diff")
