from __future__ import annotations

import pytest

from app.services.agent.staged_summary import UNCITABLE_ABSENT_FROM_REQUEST
from app.services.agent.staged_summary import UNCITABLE_NON_EVIDENCE_REFERENCE
from app.services.agent.staged_summary import UNCITABLE_STRUCTURAL_PLACEHOLDER
from app.services.agent.staged_summary import SummaryBatchResult
from app.services.agent.staged_summary import SummaryFindingsResult
from app.services.agent.staged_summary import SummaryFinding
from app.services.agent.staged_summary import attach_summary_coverage
from app.services.agent.staged_summary import classify_uncitable_note_ids
from app.services.agent.staged_summary import partition_summary_results
from app.services.agent.staged_summary import structural_placeholder_note_ids
from app.services.agent.staged_summary import summarize_partial_findings


def test_application_attaches_authoritative_root_coverage() -> None:
    result = attach_summary_coverage(
        result=SummaryFindingsResult(findings=[SummaryFinding(
            text="The notes compare two approaches.",
            supporting_note_ids=["child-a"],
        )]),
        expected_root_ids=("root-a", "root-b"),
        allowed_note_ids=frozenset({"root-a", "child-a", "root-b"}),
    )

    assert result.covered_root_ids == ["root-a", "root-b"]


def test_summary_batch_rejects_invented_note_ids() -> None:
    result = SummaryFindingsResult(
        findings=[
            SummaryFinding(
                text="Unsupported claim.",
                supporting_note_ids=["outside-batch"],
            )
        ],
    )

    with pytest.raises(ValueError, match="outside the disclosed evidence"):
        attach_summary_coverage(
            result=result,
            expected_root_ids=("root-a",),
            allowed_note_ids=frozenset({"root-a"}),
        )


def test_summary_reduction_partitions_all_results_without_reordering() -> None:
    results = tuple(
        SummaryBatchResult(
            covered_root_ids=[f"root-{index}"],
            findings=[SummaryFinding(
                text=(f"Finding {index} " * 80),
                supporting_note_ids=[f"note-{index}"],
            )],
        )
        for index in range(5)
    )

    groups = partition_summary_results(results=results, token_limit=500)

    assert len(groups) > 1
    assert tuple(result for group in groups for result in group) == results


def test_structural_placeholders_are_collected_from_nested_trees() -> None:
    trees = (
        {
            "note_id": "heading",
            "is_evidence": False,
            "children": [
                {"note_id": "match", "content_text": "Evidence"},
                {
                    "note_id": "subheading",
                    "is_evidence": False,
                    "children": [{"note_id": "deep", "content_text": "More"}],
                },
            ],
        },
        {"note_id": "root-evidence", "content_text": "Root"},
    )

    assert structural_placeholder_note_ids(trees) == frozenset({"heading", "subheading"})


def test_uncitable_note_ids_are_classified_for_diagnosis() -> None:
    result = SummaryFindingsResult(findings=[
        SummaryFinding(text="A", supporting_note_ids=["match", "heading"]),
        SummaryFinding(text="B", supporting_note_ids=["from-history", "invented"]),
        SummaryFinding(text="C", supporting_note_ids=["heading"]),
    ])

    assert classify_uncitable_note_ids(
        result=result,
        allowed_note_ids=frozenset({"match"}),
        structural_note_ids=frozenset({"heading"}),
        request_text='[{"content":"Earlier answer cited [[from-history]]"}]',
    ) == (
        ("heading", UNCITABLE_STRUCTURAL_PLACEHOLDER),
        ("from-history", UNCITABLE_NON_EVIDENCE_REFERENCE),
        ("invented", UNCITABLE_ABSENT_FROM_REQUEST),
    )


def test_selected_note_ancestor_is_citable_even_when_structural_in_batch() -> None:
    result = SummaryFindingsResult(findings=[
        SummaryFinding(text="A", supporting_note_ids=["heading"]),
    ])

    assert classify_uncitable_note_ids(
        result=result,
        allowed_note_ids=frozenset({"heading"}),
        structural_note_ids=frozenset({"heading"}),
        request_text="",
    ) == ()


def test_partial_findings_preview_uses_newest_text_tail() -> None:
    assert summarize_partial_findings(partial_output={}, tail_characters=5) == (0, "")
    assert summarize_partial_findings(
        partial_output={"findings": [
            {"text": "first finding"},
            {"text": "second finding"},
            {"supporting_note_ids": ["a"]},
        ]},
        tail_characters=7,
    ) == (3, "finding")
    with pytest.raises(TypeError):
        summarize_partial_findings(
            partial_output={"findings": [{"text": 3}]},
            tail_characters=7,
        )
