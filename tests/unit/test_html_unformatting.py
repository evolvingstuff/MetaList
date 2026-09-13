import pytest

from app.services.html_unformatting import unformat_note_content_html


def test_unformat_note_content_html_strips_rich_text_wrappers() -> None:
    html = (
        '<h1 style="font-size: 48px"><span style="font-family: Papyrus"><strong>Title</strong></span></h1>'
        '<div><font face="Comic Sans MS">Body copy</font></div>'
    )

    assert unformat_note_content_html(html) == "Title<br>Body copy"


def test_unformat_note_content_html_preserves_links_and_removes_images() -> None:
    html = (
        '<div><strong><a href="https://example.com" title="Example" style="color: red">Link <em>text</em></a></strong></div>'
        '<p><span style="font-size: 32px"><img src="https://example.com/image.png" alt="Example image" width="320"></span></p>'
    )

    assert unformat_note_content_html(html) == (
        '<a href="https://example.com" title="Example">Link text</a>'
    )


def test_unformat_note_content_html_turns_lists_into_plain_lines() -> None:
    html = "<ul><li><strong>One</strong></li><li>Two</li></ul><ol><li>Three</li><li>Four</li></ol>"

    assert unformat_note_content_html(html) == "- One<br>- Two<br>1. Three<br>2. Four"


def test_unformat_note_content_html_preserves_css_rendered_line_breaks() -> None:
    html = (
        "<div>Opening line</div>"
        '<span style="white-space: pre-wrap">First paragraph\n\nSecond paragraph</span>'
    )

    assert unformat_note_content_html(html) == (
        "Opening line<br>First paragraph<br><br>Second paragraph"
    )


def test_unformat_note_content_html_preserves_paragraph_spacing() -> None:
    html = (
        "<p>First paragraph</p>"
        "<p><strong>Second paragraph</strong></p>"
        "<p>Third paragraph</p>"
    )

    assert unformat_note_content_html(html) == (
        "First paragraph<br><br>Second paragraph<br><br>Third paragraph"
    )


@pytest.mark.parametrize(
    ("html", "expected"),
    [
        ('<br><br>Title<br><br><br><br>Authors<br><br>', 'Title<br><br>Authors'),
        ('<p>&nbsp;</p><div><br></div><p>Title</p><p> </p><p><br></p><p>Authors</p><p>&nbsp;</p>', 'Title<br><br>Authors'),
        ('<div style="white-space: pre-wrap">\n \nTitle\n\n \t\n\nAuthors\n \n</div>', 'Title<br><br>Authors'),
        ('<pre>\r\n\r\nTitle\r\n\r\n\r\nAuthors\r\n</pre>', 'Title<br><br>Authors'),
        ('<br><p>&nbsp;</p><div> \t </div><br>', ''),
        ('Title<br>Authors<br><br>Abstract', 'Title<br>Authors<br><br>Abstract'),
        ('<br>Title<br><br><br><a href="https://example.com">Author</a><br><br><br>Abstract<br>', 'Title<br><br><a href="https://example.com">Author</a><br><br>Abstract'),
    ],
)
def test_unformat_normalizes_blank_lines(html: str, expected: str) -> None:
    normalized = unformat_note_content_html(html)
    assert normalized == expected
    assert unformat_note_content_html(normalized) == normalized
