from __future__ import annotations

from app.services.agent.investigation import InvestigationEvidencePayload
from app.services.agent.scope import SelectedNoteContext
from app.services.agent.scope import SelectedTreeNote
from app.services.agent.web_capabilities import build_web_url_capabilities
from app.services.agent.web_capabilities import extract_normalized_web_urls


def test_extract_normalized_web_urls_deduplicates_and_removes_fragments() -> None:
    assert extract_normalized_web_urls(
        "Read https://Example.com/a?q=1#part, then https://example.com/a?q=1."
    ) == ("https://example.com/a?q=1",)


def test_capabilities_use_user_messages_not_assistant_claims() -> None:
    capabilities = build_web_url_capabilities(
        canonical_messages=[
            {"role": "user", "content": "Open https://allowed.example/a"},
            {"role": "assistant", "content": "Try https://invented.example/"},
            {"role": "user", "content": "Please continue."},
        ],
        selected_note=SelectedNoteContext("none", "", (), unavailable_reason=""),
        investigation_evidence=None,
        retained_web_urls=(),
    )
    assert capabilities.allows("https://allowed.example/a")
    assert not capabilities.allows("https://invented.example/")


def test_unavailable_selected_note_contributes_no_urls() -> None:
    capabilities = build_web_url_capabilities(
        canonical_messages=[{"role": "user", "content": "Read the selected note."}],
        selected_note=SelectedNoteContext(
            "unavailable",
            "",
            (),
            unavailable_reason="blacklisted",
        ),
        investigation_evidence=None,
        retained_web_urls=(),
    )
    assert capabilities.normalized_urls == ()


def test_selected_tree_and_retained_evidence_contribute_urls() -> None:
    selected = SelectedNoteContext(
        "available",
        "child",
        (
            SelectedTreeNote("root", "", "https://parent.example", "topic"),
            SelectedTreeNote("child", "root", "Child text", "https://tag.example/x"),
        ),
        unavailable_reason="",
    )
    capabilities = build_web_url_capabilities(
        canonical_messages=[{"role": "user", "content": "Read these."}],
        selected_note=selected,
        investigation_evidence=None,
        retained_web_urls=("https://prior.example/source",),
    )
    assert capabilities.normalized_urls == (
        "https://parent.example",
        "https://tag.example/x",
        "https://prior.example/source",
    )


def test_only_retained_investigation_tree_content_authorizes_urls() -> None:
    evidence = InvestigationEvidencePayload(
        evidence_note_ids=("root", "child"),
        result_tree_ids=("root",),
        result_trees=(
            {
                "note_id": "root",
                "content_text": "https://root.example",
                "tags": ["root-tag"],
                "children": [
                    {
                        "note_id": "child",
                        "content_text": "child",
                        "tags": ["https://child.example"],
                        "children": [],
                    }
                ],
            },
        ),
        returned_approximate_token_count=20,
    )
    capabilities = build_web_url_capabilities(
        canonical_messages=[{"role": "user", "content": "Investigate."}],
        selected_note=SelectedNoteContext("none", "", (), unavailable_reason=""),
        investigation_evidence=evidence,
        retained_web_urls=(),
    )
    assert capabilities.normalized_urls == (
        "https://root.example",
        "https://child.example",
    )
