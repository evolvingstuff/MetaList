"""Strict structured contracts for complete-scope staged summarization."""

from __future__ import annotations

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field
from pydantic import field_validator

from app.services.agent.token_estimation import estimate_input_tokens

SUMMARY_FINDING_MAX_CHARS = 2_000
SUMMARY_FINDING_MAX_SUPPORTING_NOTES = 24
SUMMARY_MAX_FINDINGS = 128


class SummaryFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(..., min_length=1, max_length=SUMMARY_FINDING_MAX_CHARS)
    supporting_note_ids: list[str] = Field(..., min_length=1, max_length=SUMMARY_FINDING_MAX_SUPPORTING_NOTES)

    @field_validator("text")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        if value.strip() == "":
            raise ValueError("Summary finding text must not be blank")
        return value

    @field_validator("supporting_note_ids")
    @classmethod
    def validate_supporting_note_ids(cls, values: list[str]) -> list[str]:
        normalized = [value.strip() for value in values]
        if any(value == "" for value in normalized):
            raise ValueError("Supporting note IDs must not be blank")
        if len(set(normalized)) != len(normalized):
            raise ValueError("Supporting note IDs must be unique per finding")
        return normalized


class SummaryFindingsResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    findings: list[SummaryFinding] = Field(..., max_length=SUMMARY_MAX_FINDINGS)


class SummaryBatchResult(SummaryFindingsResult):
    covered_root_ids: list[str] = Field(..., min_length=1)

    @field_validator("covered_root_ids")
    @classmethod
    def validate_covered_root_ids(cls, values: list[str]) -> list[str]:
        normalized = [value.strip() for value in values]
        if any(value == "" for value in normalized):
            raise ValueError("Covered root IDs must not be blank")
        if len(set(normalized)) != len(normalized):
            raise ValueError("Covered root IDs must be unique")
        return normalized


def attach_summary_coverage(
    *,
    result: SummaryFindingsResult,
    expected_root_ids: tuple[str, ...],
    allowed_note_ids: frozenset[str],
) -> SummaryBatchResult:
    if not isinstance(result, SummaryFindingsResult):
        raise TypeError("result must be SummaryFindingsResult")
    for finding in result.findings:
        unknown_note_ids = set(finding.supporting_note_ids) - allowed_note_ids
        if unknown_note_ids:
            raise ValueError(
                "Summary finding cited note IDs outside the disclosed evidence: "
                + ", ".join(sorted(unknown_note_ids))
            )
    return SummaryBatchResult(
        covered_root_ids=list(expected_root_ids),
        findings=result.findings,
    )


UNCITABLE_STRUCTURAL_PLACEHOLDER = "structural placeholder without disclosed content"
UNCITABLE_NON_EVIDENCE_REFERENCE = (
    "appears in the request but is not citable evidence for this stage"
)
UNCITABLE_ABSENT_FROM_REQUEST = "does not appear anywhere in the request"


def structural_placeholder_note_ids(
    result_trees: tuple[dict[str, object], ...],
) -> frozenset[str]:
    """Return tree nodes serialized only as structure (``is_evidence: false``)."""
    placeholder_ids: set[str] = set()
    pending = list(result_trees)
    while pending:
        node = pending.pop()
        if not isinstance(node, dict):
            raise TypeError("Serialized result tree nodes must be objects")
        note_id = node["note_id"]
        if not isinstance(note_id, str) or note_id == "":
            raise TypeError("Serialized result tree nodes require note IDs")
        if "is_evidence" in node:
            if node["is_evidence"] is not False:
                raise ValueError("Structural tree nodes must be marked is_evidence false")
            placeholder_ids.add(note_id)
        if "children" in node:
            children = node["children"]
            if not isinstance(children, list):
                raise TypeError("Serialized result tree children must be a list")
            pending.extend(children)
    return frozenset(placeholder_ids)


def classify_uncitable_note_ids(
    *,
    result: SummaryFindingsResult,
    allowed_note_ids: frozenset[str],
    structural_note_ids: frozenset[str],
    request_text: str,
) -> tuple[tuple[str, str], ...]:
    """Explain each cited ID that was not disclosed as citable evidence."""
    if not isinstance(result, SummaryFindingsResult):
        raise TypeError("result must be SummaryFindingsResult")
    rejected_ids = dict.fromkeys(
        note_id
        for finding in result.findings
        for note_id in finding.supporting_note_ids
        if note_id not in allowed_note_ids
    )
    classified: list[tuple[str, str]] = []
    for note_id in rejected_ids:
        reason = UNCITABLE_ABSENT_FROM_REQUEST
        if note_id in structural_note_ids:
            reason = UNCITABLE_STRUCTURAL_PLACEHOLDER
        elif note_id in request_text:
            reason = UNCITABLE_NON_EVIDENCE_REFERENCE
        classified.append((note_id, reason))
    return tuple(classified)


def summarize_partial_findings(
    *,
    partial_output: dict[str, object],
    tail_characters: int,
) -> tuple[int, str]:
    """Return the streamed finding count and the tail of the newest finding text."""
    if tail_characters < 1:
        raise ValueError("Preview tail length must be positive")
    if "findings" not in partial_output:
        return 0, ""
    findings = partial_output["findings"]
    if not isinstance(findings, list):
        raise TypeError("Partial summary findings must be a list")
    latest_text = ""
    for finding in findings:
        if not isinstance(finding, dict):
            raise TypeError("Partial summary findings must be objects")
        if "text" in finding:
            if not isinstance(finding["text"], str):
                raise TypeError("Partial summary finding text must be a string")
            latest_text = finding["text"]
    return len(findings), latest_text[-tail_characters:]


def validate_summary_batch_result(
    *,
    result: SummaryBatchResult,
    expected_root_ids: tuple[str, ...],
    allowed_note_ids: frozenset[str],
) -> SummaryBatchResult:
    if not isinstance(result, SummaryBatchResult):
        raise TypeError("result must be SummaryBatchResult")
    if tuple(result.covered_root_ids) != expected_root_ids:
        raise ValueError("Summary batch did not confirm exact root coverage")
    for finding in result.findings:
        unknown_note_ids = set(finding.supporting_note_ids) - allowed_note_ids
        if unknown_note_ids:
            raise ValueError(
                "Summary finding cited note IDs outside the disclosed evidence: "
                + ", ".join(sorted(unknown_note_ids))
            )
    return result


def summary_reference_note_ids(
    results: tuple[SummaryBatchResult, ...],
) -> tuple[str, ...]:
    return tuple(dict.fromkeys(
        note_id
        for result in results
        for finding in result.findings
        for note_id in finding.supporting_note_ids
    ))


def estimate_summary_results_tokens(
    results: tuple[SummaryBatchResult, ...],
) -> int:
    return estimate_input_tokens([
        result.model_dump(mode="json") for result in results
    ])


def partition_summary_results(
    *,
    results: tuple[SummaryBatchResult, ...],
    token_limit: int,
) -> tuple[tuple[SummaryBatchResult, ...], ...]:
    if not results:
        raise ValueError("Summary reduction requires at least one result")
    if not isinstance(token_limit, int) or isinstance(token_limit, bool) or token_limit < 1:
        raise ValueError("Summary reduction token limit must be positive")
    groups: list[tuple[SummaryBatchResult, ...]] = []
    current: list[SummaryBatchResult] = []
    for result in results:
        if estimate_summary_results_tokens((result,)) > token_limit:
            raise ValueError(
                "One intermediate summary exceeds the configured evidence limit"
            )
        candidate = (*current, result)
        if current and estimate_summary_results_tokens(candidate) > token_limit:
            groups.append(tuple(current))
            current = []
        current.append(result)
    if current:
        groups.append(tuple(current))
    return tuple(groups)
