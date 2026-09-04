from app.models.utils import note_data_to_html
from app.models.utils import note_data_to_plain_text
from app.models.utils import render_note_data_read_only


def test_render_note_data_read_only_requires_tags_and_renders() -> None:
    tree = {
        "content": "<div>Hello</div>",
        "tags": "",
        "children": [
            {"content": "<div>Child</div>", "tags": "foo", "children": []},
        ],
    }
    rendered = render_note_data_read_only(tree)
    assert isinstance(rendered, dict)
    assert "content" in rendered
    assert "children" in rendered


def test_render_note_data_read_only_latex_is_ready_for_clipboard_html() -> None:
    tree = {
        "content": "<div>\\frac{1}{2}</div>",
        "tags": "@latex",
        "children": [],
    }

    rendered = render_note_data_read_only(tree)
    html = note_data_to_html(rendered)

    assert '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">' in html
    assert "<mfrac>" in html
    assert "\\frac{1}{2}" not in html


def test_note_data_to_plain_text_preserves_block_lines_and_tab_indents() -> None:
    tree = {
        "content": "<h1>Distribution plan</h1><p>Goal: run:</p><pre>metalist</pre>",
        "tags": "",
        "children": [
            {
                "content": "<p>Install with:</p><pre>pipx install metalist</pre>",
                "tags": "",
                "children": [
                    {"content": "<div>Nested detail</div>", "tags": "", "children": []},
                ],
            },
            {"content": "<ul><li>PyPI</li><li>pipx</li></ul>", "tags": "", "children": []},
        ],
    }

    rendered = render_note_data_read_only(tree)
    plain_text = note_data_to_plain_text(rendered)

    assert plain_text == "\n".join(
        [
            "Distribution plan",
            "Goal: run:",
            "metalist",
            "\tInstall with:",
            "\tpipx install metalist",
            "\t\tNested detail",
            "\t\t- PyPI",
            "\t\t- pipx",
        ]
    )


def test_note_data_to_plain_text_renders_markdown_lists_with_tabs_not_standalone_dashes() -> None:
    tree = {
        "content": (
            "<div>## Tooling distinction</div>"
            "<div></div>"
            "<div>- PyPI = package registry / where the app is published</div>"
            "<div>- pip = installs Python packages into the current environment</div>"
        ),
        "tags": "@markdown",
        "children": [],
    }

    rendered = render_note_data_read_only(tree)
    plain_text = note_data_to_plain_text(rendered)

    assert plain_text == "\n".join(
        [
            "Tooling distinction",
            "\t- PyPI = package registry / where the app is published",
            "\t- pip = installs Python packages into the current environment",
        ]
    )
    assert "\n-\n" not in plain_text


def test_note_data_to_html_includes_note_clipboard_marker_for_rich_paste_detection() -> None:
    tree = {
        "content": "<div>Hello</div>",
        "tags": "",
        "children": [],
    }

    rendered = render_note_data_read_only(tree)
    html = note_data_to_html(rendered)

    assert 'data-metalist-note-clipboard="true"' in html
