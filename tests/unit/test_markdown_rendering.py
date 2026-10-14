from app.services.markdown_rendering import render_markdown_to_html


def test_ordered_list_continues_across_blank_lines_between_items() -> None:
    rendered = render_markdown_to_html(
        "1. First point\n\n1. Second point\n\n1. Third point\n\nAfter the list."
    )

    assert rendered == (
        "<ol><li>First point</li><li>Second point</li>"
        "<li>Third point</li></ol><p>After the list.</p>"
    )


def test_ordered_list_honors_an_explicit_non_one_start_number() -> None:
    rendered = render_markdown_to_html("4. Fourth point")

    assert rendered == '<ol start="4"><li>Fourth point</li></ol>'


def test_malformed_external_markdown_table_renders_as_text() -> None:
    rendered = render_markdown_to_html(
        "Answer before table.\n\n"
        "| Topic | Detail |\n"
        "| --- |\n"
        "| caching | reused input |"
    )

    assert rendered == (
        "<p>Answer before table.</p>"
        "<p>| Topic | Detail |<br>\n"
        "| --- |<br>\n"
        "| caching | reused input |</p>"
    )


def test_bold_currency_amounts_do_not_become_one_latex_span() -> None:
    rendered = render_markdown_to_html(
        "QQQ is currently **$741.64**, up **$0.43** (**+0.06%**) today."
    )

    assert rendered == (
        "<p>QQQ is currently <strong>$741.64</strong>, up "
        "<strong>$0.43</strong> (<strong>+0.06%</strong>) today.</p>"
    )
    assert "meta-latex" not in rendered


def test_numeric_dollar_delimited_math_still_renders() -> None:
    rendered = render_markdown_to_html("Math: $2 + 3 = 5$.")

    assert 'class="meta-latex meta-latex-inline"' in rendered
    assert "<math" in rendered


def test_plain_currency_range_keeps_both_dollar_signs() -> None:
    rendered = render_markdown_to_html("The range is $5–$10 today.")

    assert rendered == "<p>The range is $5–$10 today.</p>"
    assert "meta-latex" not in rendered


# Fenced code that names a language is coloured as @code=<language> colours it.
_FENCE = "```{language}\n{code}\n```"


def test_a_fence_naming_a_language_is_highlighted_with_its_label() -> None:
    rendered = render_markdown_to_html(_FENCE.format(language="python", code="def f(x):\n    return x < 1"))
    assert rendered.startswith('<div class="meta-code"><span class="meta-code-language">python</span>')
    assert '<span class="tok-k">def</span>' in rendered
    assert '<span class="tok-o">&lt;</span>' in rendered


def test_a_fence_language_may_be_an_alias_in_any_case() -> None:
    for language in ("py", "Python", "JS"):
        rendered = render_markdown_to_html(_FENCE.format(language=language, code="x = 1"))
        assert f'<span class="meta-code-language">{language}</span>' in rendered
        assert 'class="tok-' in rendered


def test_a_fence_without_a_known_language_stays_plain_without_a_badge() -> None:
    assert render_markdown_to_html(_FENCE.format(language="", code="plain <b>")) == "<pre><code>plain &lt;b&gt;</code></pre>"
    assert render_markdown_to_html(_FENCE.format(language="output", code="42")) == (
        '<pre><code class="language-output">42</code></pre>'
    )
    assert "Unknown language" not in render_markdown_to_html(_FENCE.format(language="text", code="x"))


def test_a_mermaid_fence_is_unchanged() -> None:
    assert render_markdown_to_html(_FENCE.format(language="mermaid", code="graph TD\nA-->B")) == (
        '<pre class="meta-mermaid-source"><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>'
    )


def test_highlighted_fence_code_is_escaped() -> None:
    rendered = render_markdown_to_html(_FENCE.format(language="html", code='<script>alert("x")</script>'))
    assert "<script>" not in rendered
    assert "&lt;" in rendered
