from datetime import datetime, timedelta, timezone
import sqlite3

from app.db.link_titles_sql import insert_link_title_row
from app.db.schema import initialize_schema
from app.services import content_formatting as content_formatting_module
from app.services.link_titles import link_title_store
from app.services.content_formatting import find_list_style
from app.services.content_formatting import extract_note_text_for_agent
from app.services.content_formatting import format_note_content_for_view as _format_note_content_for_view
from app.services.content_formatting import remove_added_style_tags
from app.services.content_formatting import remove_formatting_scope_delimiters
from app.services.tag_ontology import compile_rules, parse_rules_text


def format_note_content_for_view(*, content_html: str, tags: str) -> str:
    return _format_note_content_for_view(
        content_html=content_html,
        tags=tags,
        redact_passwords=False,
    )


def test_remove_added_style_tags_preserves_comments_semantic_tags_and_remaining_scopes() -> None:
    updated_tags, wrappers_to_remove = remove_added_style_tags(
        "foo /* @red keep */ @red [[@bold @markdown]] {{@red project}} @todo"
    )

    assert updated_tags == "foo /* @red keep */ {{project}} @todo"
    assert wrappers_to_remove == frozenset({("[", 2)})


def test_remove_added_style_tags_removes_highlighter_style() -> None:
    updated_tags, wrappers_to_remove = remove_added_style_tags(
        "@todo @highlighter {@highlighter}"
    )

    assert updated_tags == "@todo"
    assert wrappers_to_remove == frozenset({("{", 1)})


def test_remove_formatting_scope_delimiters_handles_crossing_scopes_without_touching_html() -> None:
    content = '<a href="https://example.com/?q=[value]">blah [[blah {both]] italic}</a>'

    updated_content = remove_formatting_scope_delimiters(
        content,
        frozenset({("[", 2), ("{", 1)}),
    )

    assert updated_content == '<a href="https://example.com/?q=[value]">blah blah both italic</a>'


def test_format_note_content_for_view_no_matching_tag_keeps_delimiters() -> None:
    html = "<div>{{hello}}</div>"
    rendered = format_note_content_for_view(content_html=html, tags="")
    assert rendered == html


def test_format_note_content_for_view_autolinks_plain_http_url() -> None:
    html = "<div>https://google.com</div>"
    rendered = format_note_content_for_view(content_html=html, tags="")
    assert (
        '<a href="https://google.com" target="_blank" rel="noopener noreferrer">https://google.com</a>'
        in rendered
    )


def test_format_note_content_for_view_autolinks_plain_http_url_without_trailing_punctuation() -> None:
    html = "<div>See https://google.com.</div>"
    rendered = format_note_content_for_view(content_html=html, tags="")
    assert (
        '<a href="https://google.com" target="_blank" rel="noopener noreferrer">https://google.com</a>.'
        in rendered
    )


def test_format_note_content_for_view_renders_cached_standalone_link_title() -> None:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    now = datetime.now(timezone.utc)
    insert_link_title_row(
        connection,
        url="https://www.youtube.com/watch?v=abc123",
        url_encryption_nonce=None,
        url_encryption_tag=None,
        title="A Useful Video",
        title_encryption_nonce=None,
        title_encryption_tag=None,
        status="ok",
        last_error_kind=None,
        last_checked_at=now,
        last_success_at=now,
        last_failure_at=None,
        next_check_after=None,
        failure_count=0,
        created_at=now,
        updated_at=now,
    )
    link_title_store.bootstrap(connection=connection)
    try:
        rendered = format_note_content_for_view(
            content_html="<div>https://www.youtube.com/watch?v=abc123</div>",
            tags="",
        )
    finally:
        link_title_store.reset()
        connection.close()

    assert 'class="link-title"' in rendered
    assert '<span class="link-title-text">A Useful Video</span>' in rendered
    assert '<span class="link-title-domain"> · youtube.com</span>' in rendered
    assert 'href="https://www.youtube.com/watch?v=abc123"' in rendered


def test_format_note_content_for_view_does_not_title_inline_link() -> None:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    now = datetime.now(timezone.utc)
    insert_link_title_row(
        connection,
        url="https://example.com/article",
        url_encryption_nonce=None,
        url_encryption_tag=None,
        title="Article Title",
        title_encryption_nonce=None,
        title_encryption_tag=None,
        status="ok",
        last_error_kind=None,
        last_checked_at=now,
        last_success_at=now,
        last_failure_at=None,
        next_check_after=None,
        failure_count=0,
        created_at=now,
        updated_at=now,
    )
    link_title_store.bootstrap(connection=connection)
    try:
        rendered = format_note_content_for_view(
            content_html="<div>Read https://example.com/article later</div>",
            tags="",
        )
    finally:
        link_title_store.reset()
        connection.close()

    assert "Article Title" not in rendered
    assert (
        '<a href="https://example.com/article" target="_blank" rel="noopener noreferrer">https://example.com/article</a>'
        in rendered
    )


def test_format_note_content_for_view_explains_failed_standalone_link_title() -> None:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    now = datetime.now(timezone.utc) + timedelta(days=1)
    insert_link_title_row(
        connection,
        url="https://www.youtube.com/watch?v=abc123",
        url_encryption_nonce=None,
        url_encryption_tag=None,
        title=None,
        title_encryption_nonce=None,
        title_encryption_tag=None,
        status="failed",
        last_error_kind="timeout",
        last_checked_at=now,
        last_success_at=None,
        last_failure_at=now,
        next_check_after=now + timedelta(days=7),
        failure_count=1,
        created_at=now,
        updated_at=now,
    )
    link_title_store.bootstrap(connection=connection)
    try:
        rendered = format_note_content_for_view(
            content_html="<div>https://www.youtube.com/watch?v=abc123</div>",
            tags="",
        )
    finally:
        link_title_store.reset()
        connection.close()

    assert "A Useful Video" not in rendered
    assert 'title="Link title lookup failed: timeout; retry after ' in rendered
    assert (
        '<a href="https://www.youtube.com/watch?v=abc123"'
        in rendered
    )


def test_format_note_content_for_view_normalizes_existing_anchor_to_new_tab() -> None:
    html = '<div><a href="https://example.com">Example</a></div>'
    rendered = format_note_content_for_view(content_html=html, tags="")
    assert (
        '<a href="https://example.com" target="_blank" rel="noopener noreferrer">Example</a>'
        in rendered
    )


def test_format_note_content_for_view_leaves_hash_anchor_unchanged() -> None:
    html = '<div><a href="#note-123">Example</a></div>'
    rendered = format_note_content_for_view(content_html=html, tags="")
    assert '<a href="#note-123">Example</a>' in rendered
    assert 'target="_blank"' not in rendered


def test_format_note_content_for_view_scoped_monospace_consumes_delimiters() -> None:
    html = "<div>{{hello}}</div>"
    rendered = format_note_content_for_view(content_html=html, tags="{{@monospace}}")
    assert rendered == '<div><span class="meta-scope meta-monospace">hello</span></div>'


def test_format_note_content_for_view_scoped_size_uses_layout_wrapper() -> None:
    html = '<div>{<img src="example.png">}</div>'

    rendered = format_note_content_for_view(content_html=html, tags="{@size=2.0}")

    assert rendered == (
        '<div><span class="meta-scope meta-box-inline meta-size" '
        'style="--meta-size-factor:2">'
        '<img src="example.png"></span></div>'
    )


def test_format_note_content_for_view_scoped_size_parses_equivalent_numbers() -> None:
    for tag in ("{{@size=2}}", "{{@size=2.0}}", "{{@size=2.00}}"):
        rendered = format_note_content_for_view(
            content_html="<div>{{hello}}</div>",
            tags=tag,
        )

        assert rendered == (
            '<div><span class="meta-scope meta-box-inline meta-size" '
            'style="--meta-size-factor:2">'
            "hello</span></div>"
        )


def test_format_note_content_for_view_global_size_parses_equivalent_numbers() -> None:
    for tag in ("@size=2", "@size=2.0", "@size=2.00"):
        rendered = format_note_content_for_view(
            content_html="<div>hello</div>",
            tags=tag,
        )

        assert rendered == (
            '<div class="meta-global meta-box-block meta-size" '
            'style="--meta-size-factor:2">'
            "<div>hello</div></div>"
        )


def test_format_note_content_for_view_scoped_size_accepts_arbitrary_positive_decimal() -> None:
    rendered = format_note_content_for_view(
        content_html="<div>{{hello}}</div>",
        tags="{{@size=0.4}}",
    )

    assert rendered == (
        '<div><span class="meta-scope meta-box-inline meta-size" '
        'style="--meta-size-factor:0.4">hello</span></div>'
    )


def test_format_note_content_for_view_global_size_accepts_arbitrary_positive_decimal() -> None:
    rendered = format_note_content_for_view(
        content_html="<div>hello</div>",
        tags="@size=0.4",
    )

    assert rendered == (
        '<div class="meta-global meta-box-block meta-size" '
        'style="--meta-size-factor:0.4"><div>hello</div></div>'
    )


def test_format_note_content_for_view_scoped_multiple_meta_tags_apply_union() -> None:
    html = "<div>{{hello}}</div>"
    rendered = format_note_content_for_view(content_html=html, tags="{{@red @monospace}}")
    assert rendered == '<div><span class="meta-scope meta-monospace meta-red">hello</span></div>'


def test_format_note_content_for_view_scoped_highlighter_uses_inline_box_wrapper() -> None:
    rendered = format_note_content_for_view(
        content_html="<div>{highlighted text}</div>",
        tags="{@highlighter}",
    )

    assert rendered == (
        '<div><span class="meta-scope meta-box-inline meta-highlighter">'
        "highlighted text</span></div>"
    )


def test_format_note_content_for_view_scoped_style_spans_multiple_blocks() -> None:
    content_html = "<div>{first line</div><div>second line}</div>"

    red_rendered = format_note_content_for_view(
        content_html=content_html,
        tags="{@red}",
    )
    highlighter_rendered = format_note_content_for_view(
        content_html=content_html,
        tags="{@highlighter}",
    )

    assert red_rendered == (
        '<div><span class="meta-scope meta-red">first line</span></div>'
        '<div><span class="meta-scope meta-red">second line</span></div>'
    )
    assert highlighter_rendered == (
        '<div><span class="meta-scope meta-box-inline meta-highlighter">'
        "first line</span></div>"
        '<div><span class="meta-scope meta-box-inline meta-highlighter">'
        "second line</span></div>"
    )


def test_format_note_content_for_view_scoped_size_spans_multiple_blocks() -> None:
    rendered = format_note_content_for_view(
        content_html="<div>{first line</div><div>second line}</div>",
        tags="{@size=2}",
    )

    assert rendered == (
        '<div><span class="meta-scope meta-box-inline meta-size" '
        'style="--meta-size-factor:2">first line</span></div>'
        '<div><span class="meta-scope meta-box-inline meta-size" '
        'style="--meta-size-factor:2">second line</span></div>'
    )


def test_format_note_content_for_view_unclosed_multi_block_scope_stays_literal() -> None:
    content_html = "<div>{first line</div><div>second line</div>"

    rendered = format_note_content_for_view(
        content_html=content_html,
        tags="{@highlighter}",
    )

    assert rendered == content_html


def test_format_note_content_for_view_global_highlighter_wraps_block_content() -> None:
    rendered = format_note_content_for_view(
        content_html="<div>highlighted text</div>",
        tags="@highlighter",
    )

    assert rendered == (
        '<div class="meta-global meta-box-block meta-highlighter">'
        "<div>highlighted text</div></div>"
    )


def test_format_note_content_for_view_depth_mismatch_does_not_match_subdepth() -> None:
    html = "<div>{{{hello}}}</div>"
    rendered = format_note_content_for_view(content_html=html, tags="{{@monospace}}")
    assert rendered == html


def test_format_note_content_for_view_nested_scopes() -> None:
    html = "<div>{{a [[b]]}}</div>"
    rendered = format_note_content_for_view(
        content_html=html,
        tags="{{@monospace}} [[@red]]",
    )
    assert (
        rendered
        == '<div><span class="meta-scope meta-monospace">a <span class="meta-scope meta-red">b</span></span></div>'
    )


def test_format_note_content_for_view_crossing_scopes_split_overlapping_styles() -> None:
    html = "<div>start [[bold {both]] italic}</div>"
    rendered = format_note_content_for_view(
        content_html=html,
        tags="[[@bold]] {@italic}",
    )
    assert rendered == (
        '<div>start <span class="meta-scope meta-bold">bold '
        '<span class="meta-scope meta-italic">both</span></span>'
        '<span class="meta-scope meta-italic"> italic</span></div>'
    )


def test_format_note_content_for_view_crossing_strikethrough_keeps_both_ranges() -> None:
    html = "<div>[[bold {both]] struck}</div>"
    rendered = format_note_content_for_view(
        content_html=html,
        tags="[[@bold]] {@strikethrough}",
    )
    assert rendered == (
        '<div><span class="meta-scope meta-bold">bold '
        '<span class="meta-scope meta-strikethrough">both</span></span>'
        '<span class="meta-scope meta-strikethrough"> struck</span></div>'
    )


def test_format_note_content_for_view_wrapper_spanning_tags() -> None:
    html = "<div>{{hello <b>world</b>}}</div>"
    rendered = format_note_content_for_view(content_html=html, tags="{{@red}}")
    assert rendered == '<div><span class="meta-scope meta-red">hello <b>world</b></span></div>'


def test_format_note_content_for_view_unclosed_wrapper_keeps_literal() -> None:
    html = "<div>{{hello</div>"
    rendered = format_note_content_for_view(content_html=html, tags="{{@red}}")
    assert rendered == html


def test_format_note_content_for_view_regular_scoped_tag_consumes_delimiters() -> None:
    html = "<div>[hello]</div>"
    rendered = format_note_content_for_view(content_html=html, tags="[foo]")
    assert rendered == "<div>hello</div>"


def test_format_note_content_for_view_global_applies_entire_note() -> None:
    html = "<div>hello</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@red")
    assert rendered == '<span class="meta-global meta-red"><div>hello</div></span>'


def test_format_note_content_for_view_basic_meta_tags_apply_classes() -> None:
    html = "<div>hello</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@bold @italic @heading @serif")
    assert 'meta-bold' in rendered
    assert 'meta-italic' in rendered
    assert 'meta-heading' in rendered
    assert 'meta-serif' in rendered


def test_format_note_content_for_view_dark_theme_meta_is_ignored() -> None:
    html = "<div>hello</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@dark-theme")
    assert rendered == html


def test_format_note_content_for_view_scoped_meta_tags_do_not_apply_globally() -> None:
    html = "<div>foo [bar]</div>"
    rendered = format_note_content_for_view(content_html=html, tags="[@red]")
    assert 'meta-global meta-red' not in rendered
    assert '<span class="meta-scope meta-red">bar</span>' in rendered


def test_implied_meta_style_preserves_semantic_tag_capture_scope(monkeypatch) -> None:
    rules = parse_rules_text(
        text="blue => @blue\nquestion => blue",
        filename="ontology_rules.txt",
    )
    ontology = compile_rules(rules=rules, filename="ontology_rules.txt")
    monkeypatch.setattr(
        content_formatting_module,
        "get_ontology_if_ready",
        lambda: ontology,
    )

    direct_style = format_note_content_for_view(
        content_html="<div>this is a statement. {this is blue}</div>",
        tags="{blue}",
    )
    implied_style = format_note_content_for_view(
        content_html="<div>this is a statement. {this is a question}</div>",
        tags="{question}",
    )
    empty_capture = format_note_content_for_view(
        content_html="<div>this is a question</div>",
        tags="{question}",
    )

    assert direct_style == (
        '<div>this is a statement. '
        '<span class="meta-scope meta-blue">this is blue</span></div>'
    )
    assert implied_style == (
        '<div>this is a statement. '
        '<span class="meta-scope meta-blue">this is a question</span></div>'
    )
    assert empty_capture == "<div>this is a question</div>"


def test_format_note_content_for_view_scoped_strikethrough_uses_inline_box_wrapper() -> None:
    html = "<div>{hello}</div>"
    rendered = format_note_content_for_view(content_html=html, tags="{@strikethrough}")
    assert rendered == '<div><span class="meta-scope meta-box-inline meta-strikethrough">hello</span></div>'


def test_format_note_content_for_view_global_strikethrough_wraps_block_content() -> None:
    html = "<div>hello</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@strikethrough")
    assert rendered == '<div class="meta-global meta-box-block meta-strikethrough"><div>hello</div></div>'


def test_format_note_content_for_view_username_meta_renders_credential_row() -> None:
    html = "<div><b>tomlahore1</b></div>"
    rendered = format_note_content_for_view(content_html=html, tags="@username")
    assert 'meta-credential-username' in rendered
    assert 'Username:' in rendered
    assert 'data-copy-value="tomlahore1"' in rendered
    assert ">tomlahore1<" in rendered


def test_format_note_content_for_view_password_meta_renders_copyable_value() -> None:
    html = "<div>sekret</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@password")
    assert 'meta-credential-password' in rendered
    assert 'Password:' in rendered
    assert 'data-copy-value="sekret"' in rendered
    assert ">sekret<" in rendered


def test_format_note_content_for_view_password_meta_applies_other_global_classes() -> None:
    html = "<div>sekret</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@password @red")
    assert 'meta-credential-value meta-red' in rendered


def test_format_note_content_for_view_password_meta_redacts_underlying_value() -> None:
    html = "<div>sekret</div>"
    rendered = _format_note_content_for_view(
        content_html=html,
        tags="@password",
        redact_passwords=True,
    )
    assert 'data-copy-value="XXXXXX"' in rendered
    assert ">XXXXXX<" in rendered
    assert "sekret" not in rendered


def test_extract_note_text_for_agent_withholds_password_even_with_renderer_tag() -> None:
    content_text, is_redacted = extract_note_text_for_agent(
        content_html="<div>sekret</div>",
        tags="@password @markdown",
    )

    assert content_text == "[REDACTED: @password]"
    assert is_redacted is True
    assert "sekret" not in content_text


def test_format_note_content_for_view_email_meta_renders_mailto_link() -> None:
    html = "<div>hello@example.com</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@email")
    assert 'meta-email' in rendered
    assert 'Email:' in rendered
    assert 'href="mailto:hello@example.com"' in rendered
    assert 'target="_blank"' in rendered
    assert 'rel="noopener noreferrer"' in rendered
    assert ">hello@example.com<" in rendered


def test_format_note_content_for_view_todo_meta_renders_status_row() -> None:
    html = "<div>stuff to do</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@todo")
    assert 'meta-status-todo' in rendered
    assert 'meta-status-toggle' in rendered
    assert '<div class="meta-status-text">' in rendered
    assert html in rendered


def test_format_note_content_for_view_done_meta_renders_status_row() -> None:
    html = "<div>stuff done</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@done")
    assert 'meta-status-done' in rendered
    assert 'meta-status-toggle' in rendered
    assert '<div class="meta-status-text">' in rendered
    assert html in rendered


def test_format_note_content_for_view_status_meta_applies_other_global_classes() -> None:
    html = "<div>stuff</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@done @red")
    assert 'meta-status-text meta-red' in rendered


def test_format_note_content_for_view_status_meta_strikethrough_wraps_inner_content() -> None:
    html = "<div>stuff</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@done @strikethrough")
    assert '<div class="meta-status-text"><div class="meta-status-format meta-box-block meta-strikethrough"><div>stuff</div></div></div>' in rendered


def test_format_note_content_for_view_markdown_meta_renders_server_side_html() -> None:
    html = (
        "<div># Title</div>"
        "<div>Paragraph with [link](https://example.com)</div>"
        "<div>- one</div>"
        "<div>- two</div>"
    )
    rendered = format_note_content_for_view(content_html=html, tags="@markdown")
    assert 'class="meta-markdown"' in rendered
    assert 'data-markdown-rendered="true"' in rendered
    assert "<h1>Title</h1>" in rendered
    assert (
        '<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>'
        in rendered
    )
    assert "<ul><li>one</li><li>two</li></ul>" in rendered
    assert "# Title" not in rendered
    assert "<div># Title</div>" not in rendered


def test_format_note_content_for_view_markdown_auto_renders_latex_delimiters() -> None:
    html = (
        "<div>The core operational target is:</div>"
        "<div></div>"
        "<div>\\[</div>"
        "<div>\\text{maximize actionable coverage}</div>"
        "<div>\\]</div>"
        "<div></div>"
        "<div>Inline threshold: \\(p \\geq \\pi_+\\).</div>"
        "<div>Dollar math: $q \\leq \\pi_-$.</div>"
        "<div>Display dollar math: $$r = 1 - q$$.</div>"
    )

    rendered = format_note_content_for_view(content_html=html, tags="@markdown")

    assert rendered.count('<math xmlns="http://www.w3.org/1998/Math/MathML"') == 4
    assert rendered.count('display="block"') == 2
    assert rendered.count('display="inline"') == 2
    assert "<mtext>maximize" in rendered
    assert "\\[" not in rendered
    assert "\\]" not in rendered
    assert "\\(" not in rendered
    assert "\\)" not in rendered
    assert "$q" not in rendered
    assert "$$r" not in rendered


def test_format_note_content_for_view_markdown_keeps_non_math_dollars_literal() -> None:
    html = (
        "<div>Budget: $5 and $10.</div>"
        "<div>Escaped example: \\$x\\$.</div>"
        "<div>Unclosed example: \\(x + 1.</div>"
    )

    rendered = format_note_content_for_view(content_html=html, tags="@markdown")

    assert "Budget: $5 and $10." in rendered
    assert "Escaped example: \\$x\\$." in rendered
    assert "Unclosed example: \\(x + 1." in rendered
    assert "<math" not in rendered


def test_format_note_content_for_view_markdown_does_not_render_latex_in_code() -> None:
    html = (
        "<div>Inline code: `\\(x^2\\)`</div>"
        "<div></div>"
        "<div>```text</div>"
        "<div>\\[y^2\\]</div>"
        "<div>```</div>"
    )

    rendered = format_note_content_for_view(content_html=html, tags="@markdown")

    assert "<code>\\(x^2\\)</code>" in rendered
    assert "<pre><code" in rendered
    assert "\\[y^2\\]" in rendered
    assert "<math" not in rendered


def test_format_note_content_for_view_marks_mermaid_fence_for_browser_rendering() -> None:
    html = (
        "<div>```mermaid</div>"
        "<div>flowchart TD</div>"
        "<div>A[Source&lt;br/&gt;table_a] --&gt; B[Target]</div>"
        "<div>```</div>"
    )

    rendered = format_note_content_for_view(content_html=html, tags="@markdown")

    assert '<pre class="meta-mermaid-source">' in rendered
    assert '<code class="language-mermaid">' in rendered
    assert "flowchart TD" in rendered
    assert "A[Source&lt;br/&gt;table_a] --&gt; B[Target]" in rendered


def test_format_note_content_for_view_markdown_auto_latex_preserves_scoped_latex() -> None:
    html = (
        "<div>Automatic: \\(x^2\\)</div>"
        "<div>Explicit: (((\\frac{1}{2})))</div>"
    )

    rendered = format_note_content_for_view(
        content_html=html,
        tags="@markdown (((@LaTeX)))",
    )

    assert rendered.count('<math xmlns="http://www.w3.org/1998/Math/MathML"') == 2
    assert rendered.count("<msup>") == 1
    assert rendered.count("<mfrac>") == 1
    assert "(((" not in rendered
    assert ")))" not in rendered
    assert "@@MLLATEX[" not in rendered


def test_format_note_content_for_view_latex_meta_renders_server_side_mathml() -> None:
    html = "<div>\\frac{1}{2}</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@latex")
    assert 'class="meta-latex meta-latex-display"' in rendered
    assert '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">' in rendered
    assert "<mfrac>" in rendered
    assert "<div>\\frac{1}{2}</div>" not in rendered


def test_format_note_content_for_view_latex_meta_invalid_input_shows_error() -> None:
    html = "<div>\\begin{matrix}1&amp;2</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@latex")
    assert 'class="meta-latex meta-latex-error"' in rendered
    assert "Invalid LaTeX" in rendered
    assert "\\begin{matrix}1&amp;2" in rendered


def test_format_note_content_for_view_markdown_with_scoped_latex_renders_server_side() -> None:
    html = (
        "<div># Math Test</div>"
        "<div></div>"
        "<div>Inline math inside markdown: {{$E = mc^2$}}</div>"
        "<div></div>"
        "<div>Display math inside markdown:</div>"
        "<div>{{$$</div>"
        "<div>\\int_0^\\infty e^{-x^2}\\,dx=\\frac{\\sqrt{\\pi}}{2}</div>"
        "<div>$$}}</div>"
    )
    rendered = format_note_content_for_view(
        content_html=html,
        tags="@markdown {{@LaTeX}}",
    )
    assert "<h1>Math Test</h1>" in rendered
    assert 'Inline math inside markdown: <span class="meta-latex meta-latex-inline">' in rendered
    assert "Display math inside markdown:<br>" in rendered
    assert '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">' in rendered
    assert "<mfrac>" in rendered
    assert "@@MLLATEX[" not in rendered
    assert "{{$$" not in rendered
    assert "$$}}" not in rendered


def test_format_note_content_for_view_markdown_list_scoped_latex_stays_inline() -> None:
    html = (
        "<div>Where:</div>"
        "<div>- [[$r$]] = interest rate</div>"
        "<div>- [[$\\delta$]] = depreciation/maintenance</div>"
    )
    rendered = format_note_content_for_view(
        content_html=html,
        tags="@markdown [[@LaTeX]]",
    )
    assert "<ul>" in rendered
    assert '<span class="meta-latex meta-latex-inline">' in rendered
    assert '<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline">' in rendered
    assert "[[$r$]]" not in rendered
    assert "[[$\\delta$]]" not in rendered


def test_format_note_content_for_view_scoped_latex_renders_server_side_without_markdown() -> None:
    html = "<div>Standalone expression: {{\\frac{\\text{done}}{\\text{total}}}}</div>"
    rendered = format_note_content_for_view(
        content_html=html,
        tags="{{@LaTeX}}",
    )
    assert 'Standalone expression: <span class="meta-latex meta-latex-display">' in rendered
    assert '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">' in rendered
    assert "<mfrac>" in rendered
    assert "{{\\frac{\\text{done}}{\\text{total}}}}" not in rendered


def test_format_note_content_for_view_shell_meta_renders_script_block() -> None:
    html = "<div>echo hello</div><div>echo world</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@shell")
    assert 'class="meta-shell"' in rendered
    assert 'class="meta-shell-script"' in rendered
    assert "echo hello" in rendered
    assert "echo world" in rendered


def test_format_note_content_for_view_json_meta_formats_and_highlights() -> None:
    html = '<div>{"name": "MetaList", "count": 2}</div>'
    rendered = format_note_content_for_view(content_html=html, tags="@json")
    assert 'meta-json' in rendered
    assert '<span class="json-key">"name"</span>' in rendered
    assert '<span class="json-string">"MetaList"</span>' in rendered
    assert '<span class="json-number">2</span>' in rendered


def test_format_note_content_for_view_json_meta_invalid_shows_error_badge() -> None:
    html = "<div>{invalid}</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@json")
    assert 'meta-json-error' in rendered
    assert "Invalid JSON" in rendered
    assert "{invalid}" in rendered


def test_format_note_content_for_view_csv_meta_renders_table() -> None:
    html = "<div>a,b</div><div>1,2</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@csv")
    assert 'meta-csv' in rendered
    assert "<table" in rendered
    assert "<td>a</td>" in rendered
    assert "<td>b</td>" in rendered
    assert "<td>1</td>" in rendered
    assert "<td>2</td>" in rendered


def test_format_note_content_for_view_scoped_csv_meta_renders_table() -> None:
    html = "<div>((a,b,c</div><div>1,2,3))</div>"
    rendered = format_note_content_for_view(content_html=html, tags="((@csv))")
    assert 'meta-csv' in rendered
    assert 'meta-csv-inline' in rendered
    assert "<table" in rendered
    assert "<td>a</td>" in rendered
    assert "<td>b</td>" in rendered
    assert "<td>c</td>" in rendered
    assert "<td>1</td>" in rendered
    assert "<td>2</td>" in rendered
    assert "<td>3</td>" in rendered


def test_format_note_content_for_view_scoped_markdown_meta_renders_selection() -> None:
    html = "<div>{{**bold**}}</div>"
    rendered = format_note_content_for_view(content_html=html, tags="{{@markdown}}")
    assert 'class="meta-markdown"' in rendered
    assert "<strong>bold</strong>" in rendered
    assert "{{" not in rendered


def test_format_note_content_for_view_scoped_json_meta_renders_selection() -> None:
    html = '<div>[{"name":"scarlet"}]</div>'
    rendered = format_note_content_for_view(content_html=html, tags="[@json]")
    assert 'class="meta-json"' in rendered
    assert 'json-key' in rendered
    assert "scarlet" in rendered


def test_format_note_content_for_view_scoped_shell_meta_renders_selection() -> None:
    html = "<div>{echo scarlet}</div>"
    rendered = format_note_content_for_view(content_html=html, tags="{@shell}")
    assert 'class="meta-shell"' in rendered
    assert "echo scarlet" in rendered


def test_format_note_content_for_view_scoped_csv_meta_applies_scoped_formatting() -> None:
    html = "<div>((a,b,c</div><div>1,2,[3]))</div>"
    rendered = format_note_content_for_view(content_html=html, tags="((@csv)) [@red]")
    assert '<span class="meta-scope meta-red">3</span>' in rendered


def test_format_note_content_for_view_scoped_csv_meta_supports_nested_csv() -> None:
    html = "<div>((a,b,c</div><div>1,2,[x,y</div><div>3,4]</div><div>))</div>"
    rendered = format_note_content_for_view(content_html=html, tags="((@csv)) [@csv]")
    assert 'meta-csv-error' not in rendered
    assert rendered.count("<table") >= 2


def test_format_note_content_for_view_scoped_csv_preserves_standalone_image_row() -> None:
    html = (
        "<div>[[{{a,b,c</div>"
        '<div><img src="dog.png" alt="Dog"></div>'
        "<div>1,2,3</div>"
        "<div>4,5,6}}]]</div>"
    )

    rendered = format_note_content_for_view(
        content_html=html,
        tags="scratchpad {{@csv}} [[@size=2]]",
    )

    assert 'class="meta-scope meta-box-block meta-size"' in rendered
    assert 'style="--meta-size-factor:2"' in rendered
    assert '<td class="meta-csv-media-cell" colspan="3">' in rendered
    assert '<img src="dog.png" alt="Dog">' in rendered
    assert "[[" not in rendered
    assert "{{" not in rendered


def test_format_note_content_for_view_csv_meta_invalid_shows_error_badge() -> None:
    html = "<div>a,b</div><div>1,2,3</div>"
    rendered = format_note_content_for_view(content_html=html, tags="@csv")
    assert 'meta-csv-error' in rendered
    assert "Invalid CSV" in rendered
    assert "a,b" in rendered


def test_find_list_style_returns_none_without_list_tags() -> None:
    assert find_list_style("@red foo") is None


def test_find_list_style_prefers_last_tag() -> None:
    assert find_list_style("@list-bulleted @list-numbered") == "numbered"
    assert find_list_style("@list-numbered @list-bulleted") == "bulleted"


def test_find_list_style_ignores_wrapped_tags() -> None:
    assert find_list_style("((@list-bulleted))") is None
    assert find_list_style("[[@list-numbered]]") is None
