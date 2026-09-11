import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request

from app.api.routes.notes import LinkTitlePrefetchRequest, prefetch_link_titles
from app.services.link_titles import link_title_store
from app.services.content_formatting import format_note_content_for_view
from app.usecases.prefetch_link_titles import CmdPrefetchLinkTitles


@pytest.mark.parametrize("content,tags", [
    ("<p>https://example.com/article</p>", ""),
    ('<a href="https://example.com/article">https://example.com/article</a>', ""),
    ("Text {{https://example.com/article}}", "{{@footnote}}"),
    ("https://example.com/article", "@markdown"),
])
def test_prefetch_queues_view_eligible_draft_urls_without_saving(monkeypatch, content, tags):
    queued = []
    monkeypatch.setattr(link_title_store, "get_ok_title", lambda url: None)
    monkeypatch.setattr(link_title_store, "maybe_enqueue_fetch", queued.append)
    command = CmdPrefetchLinkTitles(content=content, tags=tags)
    assert command.execute() == {"status": "success"}
    assert "https://example.com/article" in queued
    assert command.content == content


@pytest.mark.parametrize("content,tags", [
    ("<p>ordinary text</p>", ""),
    ("https://example.com/secret", "@password"),
    ('<img src="https://example.com/image.png">', ""),
    ('<a href="https://example.com">Custom label</a>', ""),
    ('Read <a href="https://example.com">https://example.com</a> now', ""),
])
def test_prefetch_preserves_view_lookup_exclusions(monkeypatch, content, tags):
    queued = []
    monkeypatch.setattr(link_title_store, "maybe_enqueue_fetch", queued.append)
    CmdPrefetchLinkTitles(content=content, tags=tags).execute()
    assert queued == []


def test_prefetch_requires_authentication_and_explicit_tags():
    request = Request({"type": "http", "headers": []})
    with pytest.raises(HTTPException) as captured:
        prefetch_link_titles.__wrapped__(
            request, LinkTitlePrefetchRequest(content="https://example.com", tags=""),
        )
    assert captured.value.status_code == 401
    with pytest.raises(ValidationError):
        LinkTitlePrefetchRequest(content="https://example.com")


@pytest.mark.parametrize("content,tags", [
    ("<p>https://example.com/article</p>", ""),
    ('<p><a href="https://example.com/article">https://example.com/article</a></p>', ""),
    ("https://example.com/article", "@markdown"),
])
def test_completed_prefetch_is_used_by_first_view_render(monkeypatch, content, tags):
    titles = {}
    queued = []
    monkeypatch.setattr(link_title_store, "get_ok_title", titles.get)
    monkeypatch.setattr(link_title_store, "maybe_enqueue_fetch", queued.append)
    CmdPrefetchLinkTitles(content=content, tags=tags).execute()
    assert queued == ["https://example.com/article"]
    titles[queued[0]] = "Article & Details"
    rendered = format_note_content_for_view(content_html=content, tags=tags, redact_passwords=False)
    assert '<span class="link-title-text">Article &amp; Details</span>' in rendered
    assert '<span class="link-title-domain"> · example.com</span>' in rendered
    assert 'target="_blank"' in rendered
