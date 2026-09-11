from html.parser import HTMLParser

import pytest

from app.services.link_titles import link_title_store

from app.services.content_formatting import format_note_content_for_view, list_known_meta_tag_terms, remove_added_style_tags


def render(content: str, tags: str) -> str:
    return format_note_content_for_view(content_html=content, tags=tags, redact_passwords=False)


class AnchorValidator(HTMLParser):
    def __init__(self):
        super().__init__()
        self.anchor_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.anchor_depth += 1
            assert self.anchor_depth == 1, 'Anchors must not nest'

    def handle_endtag(self, tag):
        if tag == 'a':
            self.anchor_depth -= 1


def test_example_numbers_spans_and_renders_markdown_link():
    rendered = render('blah{{[https://usefullink.com](https://usefullink.com)}}<br>yada{{here is something}}', '{{@footnote}}')
    main, references = rendered.split('<section', 1)
    assert main.count('<sup ') == 2
    assert 'data-footnote-number="1"' in main
    assert 'data-footnote-number="2"' in main
    assert 'here is something' not in main
    assert 'here is something' in references
    assert '<details' not in rendered
    assert 'href="https://usefullink.com"' in references
    assert '{{' not in rendered
    AnchorValidator().feed(rendered)


@pytest.mark.parametrize('tags', ['', '@footnote', '@FOOTNOTE'])
def test_global_footnote_is_inert(tags):
    assert render('<div>hello{{world}}</div>', tags) == '<div>hello{{world}}</div>'


def test_unclosed_or_wrong_depth_scope_stays_literal():
    assert render('a{{unclosed', '{{@footnote}}') == 'a{{unclosed'
    assert render('a{one}{{{three}}}', '{{@footnote}}') == 'a{one}{{{three}}}'


def test_numbering_follows_content_across_delimiter_types_and_resets():
    rendered = render('a((first))b{{second}}c((third))', '{{@footnote}} ((@footnote))')
    assert rendered.index('first') < rendered.index('second') < rendered.index('third')
    assert 'data-footnote-number="3"' in rendered
    assert 'data-footnote-number="1"' in render('next{{only}}', '{{@footnote}}')
    assert 'data-footnote-number="2"' not in render('next{{only}}', '{{@footnote}}')


def test_cross_paragraph_scope_is_one_reference_with_both_lines():
    rendered = render('<div>before{{first</div><div>second}}after</div>', '{{@footnote}}')
    main, references = rendered.split('<section', 1)
    assert main.count('<sup ') == 1
    assert '<div>after</div>' in main
    assert 'first</span><br><span' in references
    assert 'second' in references
    assert rendered.count('<div') == rendered.count('</div>')


def test_rich_html_and_shared_style_survive_in_reference():
    rendered = render('a{{see <a href="https://example.com">source</a> and <b>bold</b> text}}', '{{@footnote @red}}')
    assert 'see <a ' in rendered
    assert '</a> and <b>bold</b> text' in rendered
    assert 'meta-red' in rendered.split('<section', 1)[1]


def test_global_markdown_keeps_markers_and_appends_references():
    rendered = render('**body**{{a reference}}', '@markdown {{@footnote}}')
    assert '<strong>body</strong><sup ' in rendered
    assert 'MLFOOTNOTE' not in rendered
    assert 'a reference' in rendered.split('<section', 1)[1]


def test_html_text_is_escaped_in_footnotes():
    rendered = render('body{{&lt;script&gt;bad()&lt;/script&gt;}}', '{{@footnote}}')
    assert '<script>' not in rendered
    assert '&lt;script&gt;' in rendered


def test_remove_formatting_and_suggestions_include_footnote():
    assert '@footnote' in list_known_meta_tag_terms()
    assert remove_added_style_tags('topic @footnote {{@footnote}}') == ('topic', frozenset({('{', 2)}))


def test_identical_text_reuses_number_even_across_different_scopes_and_styles():
    rendered = render('blah{{foo}}<br>yada((foo))<br>then{{bar}}', '{{@footnote}} ((@footnote @red))')
    main, references = rendered.split('<section', 1)
    assert main.count('data-footnote-number="1"') == 2
    assert main.count('data-footnote-number="2"') == 1
    assert 'data-footnote-number="3"' not in main
    assert references.count('data-footnote-reference="1"') == 1
    assert references.count('>foo<') == 1


def test_same_link_label_with_different_destinations_remains_distinct():
    rendered = render('a{{[source](https://one.example)}}b{{[source](https://two.example)}}', '{{@footnote}}')
    assert 'data-footnote-number="2"' in rendered


def test_password_redaction_does_not_append_secret_footnote_bodies():
    rendered = format_note_content_for_view(
        content_html='body{{secret reference}}', tags='@password {{@footnote}}',
        redact_passwords=True,
    )
    assert 'secret reference' not in rendered
    assert 'data-footnote-reference' not in rendered


@pytest.mark.parametrize('spacing', [' ', '   ', '\t', '\u00a0', '&nbsp;', '&#32;', '&#x20;'])
def test_view_removes_horizontal_space_before_footnote_but_keeps_following_space(spacing):
    rendered = render(f'and even{spacing}{{{{moar stuff}}}} after', '{{@footnote}}')
    assert 'and even<sup ' in rendered
    assert '</sup> after' in rendered


@pytest.mark.parametrize('line_break', ['\n', '\r\n', '<br>', '<br/>', '&#10;'])
def test_space_trimming_preserves_line_breaks(line_break):
    rendered = render(f'and even{line_break}  {{{{moar stuff}}}} ordinary text', '{{@footnote}}')
    assert f'and even{line_break}<sup ' in rendered


def test_space_trimming_crosses_inline_formatting_without_changing_markup():
    rendered = render('<b>and even&nbsp;</b> {{moar stuff}} after', '{{@footnote}}')
    assert '<b>and even</b><sup ' in rendered
    assert '</sup> after' in rendered


def test_markdown_and_duplicate_footnote_markers_trim_preceding_spaces():
    rendered = render('**and even** {{foo}} and again {{foo}}', '@markdown {{@footnote}}')
    assert '<strong>and even</strong><sup ' in rendered
    assert 'and again<sup ' in rendered
    assert rendered.count('data-footnote-number="1"') == 2


@pytest.mark.parametrize('reference', [
    'https://www.youtube.com/watch?v=abc123',
    '[https://www.youtube.com/watch?v=abc123](https://www.youtube.com/watch?v=abc123)',
    '<a href="https://www.youtube.com/watch?v=abc123">https://www.youtube.com/watch?v=abc123</a>',
])
def test_url_footnotes_use_cached_titles(monkeypatch, reference):
    monkeypatch.setattr(link_title_store, 'get_ok_title', lambda url: 'A Useful Video')
    rendered = render('body {{' + reference + '}}', '{{@footnote}}')
    assert '<span class="link-title-text">A Useful Video</span>' in rendered
    assert '<span class="link-title-domain"> · youtube.com</span>' in rendered
    assert 'href="https://www.youtube.com/watch?v=abc123"' in rendered
    assert 'body<sup ' in rendered


def test_missing_footnote_title_queues_fetch_then_appears_on_next_render(monkeypatch):
    url = 'https://example.com/video'
    queued = []
    monkeypatch.setattr(link_title_store, 'get_ok_title', lambda value: None)
    monkeypatch.setattr(link_title_store, 'maybe_enqueue_fetch', queued.append)
    first = render('body {{' + url + '}} again {{' + url + '}}', '{{@footnote}}')
    assert queued == [url]
    assert f'>{url}</a>' in first
    monkeypatch.setattr(link_title_store, 'get_ok_title', lambda value: 'Title <with> & characters')
    second = render('body {{' + url + '}} again {{' + url + '}}', '{{@footnote}}')
    assert 'Title &lt;with&gt; &amp; characters' in second
    assert second.count('data-footnote-number="1"') == 2
    assert second.count('class="link-title-text"') == 1


def test_footnote_preserves_custom_link_labels(monkeypatch):
    monkeypatch.setattr(link_title_store, 'get_ok_title', lambda value: 'Replacement title')
    rendered = render('body {{[my chosen label](https://example.com)}}', '{{@footnote}}')
    assert '>my chosen label</a>' in rendered
    assert 'Replacement title' not in rendered


def test_footnote_url_with_query_parameters_keeps_its_destination(monkeypatch):
    requested = []
    def cached_title(url):
        requested.append(url)
        return 'Video title'
    monkeypatch.setattr(link_title_store, 'get_ok_title', cached_title)
    rendered = render('body {{https://example.com/watch?v=123&amp;list=456}}', '{{@footnote}}')
    assert requested == ['https://example.com/watch?v=123&list=456']
    assert 'href="https://example.com/watch?v=123&amp;list=456"' in rendered
    assert 'Video title' in rendered


def test_uncached_url_reference_keeps_markup_characters_escaped(monkeypatch):
    monkeypatch.setattr(link_title_store, 'get_ok_title', lambda value: None)
    monkeypatch.setattr(link_title_store, 'maybe_enqueue_fetch', lambda value: None)
    rendered = render('body {{<a href="https://example.com/&lt;img&gt;">https://example.com/&lt;img&gt;</a>}}', '{{@footnote}}')
    assert '<img>' not in rendered
    assert '&lt;img&gt;' in rendered


@pytest.mark.parametrize('content, expected', [
    ('Blah\n{{long reference}}\nYada', 'Blah<sup'),
    ('<p>Blah</p><p>{{long reference}}</p><p>Yada</p>', '<p>Blah<sup'),
    ('<div>Blah</div><div>{{long reference}}</div><div>Yada</div>', '<div>Blah<sup'),
    ('Blah<br>{{long reference}}<br>Yada', 'Blah<sup'),
])
def test_standalone_footnote_attaches_to_previous_paragraph(content, expected):
    rendered = render(content, '{{@footnote}}')
    main = rendered.split('<section', 1)[0]
    assert expected in main
    assert 'Yada' in main
    assert 'long reference' not in main
    assert main.count('<sup') == 1
    assert '<p><sup' not in main
    assert '<div><sup' not in main
    if '\n' in content:
        assert '</sup>\n\nYada' in main
    if '<br>' in content:
        assert '</sup><br><br>Yada' in main


def test_consecutive_standalone_footnotes_share_previous_paragraph():
    rendered = render('<p>Blah</p><p>{{first}}</p><p>{{second}}</p><p>Yada</p>', '{{@footnote}}')
    main = rendered.split('<section', 1)[0]
    assert '<p>Blah<sup' in main
    assert '</sup><sup' in main
    assert '</sup></p><p>Yada</p>' in main


def test_standalone_multiblock_footnote_removes_its_continuation_paragraphs():
    rendered = render('<div>Blah</div><div>{{first</div><div>second}}</div><div>Yada</div>', '{{@footnote}}')
    main, references = rendered.split('<section', 1)
    assert '<div>Blah<sup' in main
    assert '</sup></div><div>Yada</div>' in main
    assert 'first' in references and 'second' in references


def test_mixed_line_footnote_does_not_move_to_previous_paragraph():
    rendered = render('<p>Blah</p><p>{{reference}} ordinary text</p>', '{{@footnote}}')
    assert '<p>Blah</p><p><sup' in rendered
    assert '</sup> ordinary text' in rendered


def test_leading_standalone_footnote_keeps_a_visible_marker():
    rendered = render('<p>{{reference}}</p><p>Yada</p>', '{{@footnote}}')
    assert '<p><sup' in rendered


def test_standalone_footnote_with_editor_trailing_break_moves_as_one_block():
    rendered = render('<div>Blah</div><div>{{reference}}<br></div><div>Yada</div>', '{{@footnote}}')
    assert '<div>Blah<sup' in rendered
    assert '</sup></div><div>Yada</div>' in rendered


def test_standalone_footnotes_in_markdown_preserve_one_paragraph_break():
    rendered = render('Blah\n{{first}}\n{{second}}\nYada', '@markdown {{@footnote}}')
    assert '<p>Blah<sup' in rendered
    assert '</sup><sup' in rendered
    assert '</sup></p><p>Yada</p>' in rendered


def test_standalone_footnote_does_not_attach_directly_to_a_list_container():
    rendered = render('<ul><li>Blah</li></ul><p>{{reference}}</p>', '{{@footnote}}')
    assert '<ul><li>Blah</li></ul><p><sup' in rendered


def test_standalone_footnote_does_not_add_blank_lines_to_existing_paragraph_gap():
    rendered = render('Blah\n\n{{reference}}\n\nYada', '{{@footnote}}')
    assert '</sup>\n\nYada' in rendered


def test_final_standalone_footnote_does_not_leave_an_empty_line():
    rendered = render('Blah\n{{reference}}', '{{@footnote}}')
    assert '</sup><section' in rendered
