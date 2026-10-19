from dataclasses import replace

import pytest

from app.services.agent.web_evidence import WebEvidenceStore
from app.services.agent.web_evidence import citation_references_for_pages
from app.services.agent.web_fetch import WebPageFetchResult


def _result(*, requested: str, final: str):
    return WebPageFetchResult(
        requested_url=requested,
        final_url=final,
        status="ok",
        title="Example",
        content_text="Evidence text",
        outgoing_links=(),
        fetched_at="2026-09-24T00:00:00+00:00",
        truncated=False,
        error_kind="",
    )


def test_store_deduplicates_requested_and_redirect_final_urls() -> None:
    store = WebEvidenceStore()
    first = store.retain_success(
        session_key="session",
        result=_result(
            requested="https://example.com/start",
            final="https://example.com/final",
        ),
    )
    again = store.retain_success(
        session_key="session",
        result=_result(
            requested="https://example.com/final",
            final="https://example.com/final",
        ),
    )

    assert again is first
    assert store.find_by_url(session_key="session", url="https://example.com/start") is first
    assert store.find_by_url(session_key="session", url="https://example.com/final") is first
    assert first.citation_token == f"[[web:{first.evidence_id}]]"


def test_store_retains_labeled_page_links_as_distinct_citation_references() -> None:
    store = WebEvidenceStore()
    result = replace(
        _result(
            requested="https://example.com/list",
            final="https://example.com/list",
        ),
        outgoing_links=(
            ("First article", "https://articles.example/first"),
            ("Second article", "https://articles.example/second"),
        ),
    )

    page = store.retain_success(session_key="session", result=result)
    references = citation_references_for_pages((page,))

    assert [reference.source_kind for reference in references] == [
        "opened_page",
        "page_link",
        "page_link",
    ]
    assert [reference.final_url for reference in references] == [
        "https://example.com/list",
        "https://articles.example/first",
        "https://articles.example/second",
    ]
    assert store.retained_urls(session_key="session") == (
        "https://example.com/list",
    )
    assert store.available_references_for_ids(
        session_key="session",
        evidence_ids=tuple(reference.evidence_id for reference in references),
    ) == references
    assert page.as_model_payload()["outgoing_link_references"] == [
        reference.as_catalog_payload() for reference in references[1:]
    ]


def test_store_clear_is_session_scoped() -> None:
    store = WebEvidenceStore()
    left = store.retain_success(
        session_key="left",
        result=_result(
            requested="https://example.com/a",
            final="https://example.com/a",
        ),
    )
    store.retain_success(
        session_key="right",
        result=replace(
            _result(
                requested="https://example.com/a",
                final="https://example.com/a",
            ),
            requested_url="https://example.com/right",
            final_url="https://example.com/right",
        ),
    )

    store.clear_session(session_key="left")

    with pytest.raises(KeyError):
        store.get(session_key="left", evidence_id=left.evidence_id)
    assert store.available_references_for_ids(
        session_key="left",
        evidence_ids=(left.evidence_id,),
    ) == ()
    assert len(store.evidence(session_key="right")) == 1
