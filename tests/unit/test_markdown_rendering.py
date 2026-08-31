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
