"""Render AI chat Markdown with readable note mentions and reference links."""

from __future__ import annotations

import html
import re
from collections.abc import Callable

from app.services.embedded_references import EmbedRenderContext
from app.services.embedded_references import get_note_reference_preview
from app.services.embedded_references import render_compact_note_reference_link
from app.services.markdown_rendering import render_markdown_to_html
from app.services.note_store import NoteStore
from app.services.agent.web_evidence import WebCitationReference


_UUID_DASH_CHARACTERS = "-‐‑‒–—−"
_UUID_SEPARATOR_PATTERN = f"[{re.escape(_UUID_DASH_CHARACTERS)}]"
_UUID_BOUNDARY_PATTERN = f"0-9a-fA-F{re.escape(_UUID_DASH_CHARACTERS)}"
_UUID_PATTERN = (
    rf"[0-9a-fA-F]{{8}}{_UUID_SEPARATOR_PATTERN}"
    rf"[0-9a-fA-F]{{4}}{_UUID_SEPARATOR_PATTERN}"
    rf"[0-9a-fA-F]{{4}}{_UUID_SEPARATOR_PATTERN}"
    rf"[0-9a-fA-F]{{4}}{_UUID_SEPARATOR_PATTERN}"
    r"[0-9a-fA-F]{12}"
)
_NOTE_CITATION_RE = re.compile(
    rf"\[\[(?P<reference>{_UUID_PATTERN})\]\]"
    rf"|(?<!\[\[)(?<!web:)(?<![{_UUID_BOUNDARY_PATTERN}])(?P<bare>{_UUID_PATTERN})"
    rf"(?![{_UUID_BOUNDARY_PATTERN}])"
)
_BRACKETED_NOTE_CITATION_RE = re.compile(rf"\[\[{_UUID_PATTERN}\]\]")
_WEB_CITATION_RE = re.compile(
    rf"\[\[web:(?P<web_id>{_UUID_PATTERN})\]\]",
    re.IGNORECASE,
)
_INCOMPLETE_WEB_CITATION_SUFFIX_RE = re.compile(
    rf"\[\[web:[0-9a-fA-F{re.escape(_UUID_DASH_CHARACTERS)}]{{0,36}}\]?$",
    re.IGNORECASE,
)
_INCOMPLETE_BRACKETED_NOTE_CITATION_SUFFIX_RE = re.compile(
    rf"\[\[[0-9a-fA-F{re.escape(_UUID_DASH_CHARACTERS)}]{{0,36}}\]?$"
)
_NUMBERED_NOTE_CITATION_RE = re.compile(
    r"\[citation:(?P<number>[1-9][0-9]*)\]",
    re.IGNORECASE,
)
_CITATION_MARKER_HTML_RE = re.compile(
    r'<sup class="ai-chat-citation-marker" '
    r'aria-label="Reference (?P<number>[1-9][0-9]*)">'
    r'<a href="#" class="ai-chat-citation-link note-reference-link" '
    r'data-ref-note-id="[^"]+" data-ref-query="[^"]+">'
    r'\[(?P<display_number>[1-9][0-9]*)\]</a></sup>'
)
_STANDALONE_SOURCE_LINE_RE = re.compile(
    r"^[ \t]*[-+*]\s+(?:\*\*)?(?:sources?|note\s+ids?)(?:\*\*)?\s*:",
    re.IGNORECASE,
)
_TOP_LEVEL_ORDERED_ITEM_RE = re.compile(r"^(?P<number>[1-9][0-9]*)\.\s+")
_TOP_LEVEL_UNORDERED_ITEM_RE = re.compile(r"^[-+*]\s+")
_FENCE_MARKER_RE = re.compile(r"^[ \t]{0,3}(?P<marker>`{3,}|~{3,})")
_HTML_SEGMENT_RE = re.compile(r"(<[^>]+>)")
_OPEN_TAG_RE = re.compile(r"^<\s*([a-zA-Z][a-zA-Z0-9:-]*)\b")
_CLOSE_TAG_RE = re.compile(r"^<\s*/\s*([a-zA-Z][a-zA-Z0-9:-]*)\s*>")
_VOID_TAGS = frozenset({"br", "hr", "img"})
_CITATION_SUPPRESSING_TAGS = frozenset({"a", "code", "pre"})
_UUID_DASH_TRANSLATION = str.maketrans(
    {
        dash_character: "-"
        for dash_character in _UUID_DASH_CHARACTERS
        if dash_character != "-"
    }
)


def render_ai_chat_markdown_to_html(
    markdown_text: str,
    *,
    notes: NoteStore,
    allowed_note_ids: tuple[str, ...],
    allowed_web_evidence: tuple[WebCitationReference, ...],
) -> str:
    _validate_allowed_note_ids(allowed_note_ids)
    web_evidence_by_id = _validate_allowed_web_evidence(allowed_web_evidence)
    visible_markdown = _hide_incomplete_bracketed_citation_suffix(markdown_text)
    canonical_markdown = _canonicalize_numbered_note_citations(
        markdown_text=visible_markdown,
        allowed_note_ids=allowed_note_ids,
    )
    canonical_markdown = _normalize_generated_response_structure(canonical_markdown)
    rendered_html = render_markdown_to_html(canonical_markdown)
    if rendered_html == "":
        return ""
    context = EmbedRenderContext(
        has_note=notes.has_note,
        get_note=notes.get_note,
        get_children=lambda _parent_id: [],
        has_file=lambda _file_id: False,
        get_file=_reject_file_reference,
        static_collapse_arrows=False,
    )
    body_html, cited_note_ids = _replace_note_citations(
        rendered_html=rendered_html,
        context=context,
        allowed_note_ids=allowed_note_ids,
    )
    reference_groups: list[tuple[str, tuple[str, ...]]] = []
    if cited_note_ids:
        reference_groups = _group_citations_by_reference_root(
            cited_note_ids=cited_note_ids,
            context=context,
        )
    body_html, cited_web_ids = _replace_web_citations(
        rendered_html=body_html,
        evidence_by_id=web_evidence_by_id,
        starting_number=len(reference_groups) + 1,
    )
    if len(reference_groups) == 0 and len(cited_web_ids) == 0:
        return body_html
    references_html = _render_references_section(
        reference_groups,
        context=context,
        cited_web_ids=cited_web_ids,
        evidence_by_id=web_evidence_by_id,
    )
    return f"{body_html}{references_html}"


def render_ai_chat_streaming_markdown_to_html(
    markdown_text: str,
    *,
    allowed_note_ids: tuple[str, ...],
    allowed_web_evidence: tuple[WebCitationReference, ...],
) -> str:
    """Render partial response prose without exposing citation UI before completion."""
    _validate_allowed_note_ids(allowed_note_ids)
    _validate_allowed_web_evidence(allowed_web_evidence)
    visible_markdown = _hide_incomplete_bracketed_citation_suffix(markdown_text)
    canonical_markdown = _canonicalize_numbered_note_citations(
        markdown_text=visible_markdown,
        allowed_note_ids=allowed_note_ids,
    )
    normalized_markdown = _normalize_generated_response_structure(canonical_markdown)

    def remove_reference_tokens(text: str) -> str:
        without_note_ids = _NOTE_CITATION_RE.sub("", text)
        without_web_ids = _WEB_CITATION_RE.sub("", without_note_ids)
        return _NUMBERED_NOTE_CITATION_RE.sub("", without_web_ids)

    reference_free_markdown = _transform_markdown_outside_fences(
        markdown_text=normalized_markdown,
        transform=remove_reference_tokens,
    )
    return render_markdown_to_html(reference_free_markdown)


def _reject_file_reference(file_id: str) -> object:
    raise RuntimeError(f"AI note citation unexpectedly resolved as file {file_id}")


def strip_note_citations_for_history(markdown_text: str) -> str:
    """Remove bracketed note-reference metadata from later model context."""
    if not isinstance(markdown_text, str) or markdown_text == "":
        raise ValueError("AI history content must be a non-empty string")
    stripped = _transform_markdown_outside_fences(
        markdown_text=markdown_text,
        transform=lambda text: _WEB_CITATION_RE.sub(
            "", _BRACKETED_NOTE_CITATION_RE.sub("", text)
        ),
    ).strip()
    if stripped == "":
        raise RuntimeError("AI response contains only note citation metadata")
    return stripped


def sanitize_ai_chat_markdown_citations(
    markdown_text: str,
    *,
    notes: NoteStore,
    allowed_note_ids: tuple[str, ...],
    allowed_web_evidence: tuple[WebCitationReference, ...],
) -> str:
    """Keep only citations backed by notes retrieved during the current run."""
    if not isinstance(markdown_text, str) or markdown_text == "":
        raise ValueError("AI response content must be a non-empty string")
    _validate_allowed_note_ids(allowed_note_ids)
    web_evidence_by_id = _validate_allowed_web_evidence(allowed_web_evidence)
    allowed_note_id_set = frozenset(allowed_note_ids)
    canonical_markdown = _canonicalize_numbered_note_citations(
        markdown_text=markdown_text,
        allowed_note_ids=allowed_note_ids,
    )

    def sanitize_text(text: str) -> str:
        def replace(match: re.Match[str]) -> str:
            raw_note_id = _raw_note_id_from_match(match)
            note_id = raw_note_id.translate(_UUID_DASH_TRANSLATION).lower()
            if note_id not in allowed_note_id_set:
                return ""
            if not notes.has_note(note_id):
                raise RuntimeError("Allowed AI citation note is missing from NoteStore")
            return f"[[{note_id}]]"

        return _NOTE_CITATION_RE.sub(replace, text)

    sanitized = _transform_markdown_outside_fences(
        markdown_text=canonical_markdown,
        transform=sanitize_text,
    )
    allowed_web_ids = frozenset(web_evidence_by_id)

    def sanitize_web_text(text: str) -> str:
        def replace_web(match: re.Match[str]) -> str:
            evidence_id = match.group("web_id").translate(
                _UUID_DASH_TRANSLATION
            ).lower()
            if evidence_id not in allowed_web_ids:
                return ""
            return f"[[web:{evidence_id}]]"

        return _WEB_CITATION_RE.sub(replace_web, text)

    sanitized = _transform_markdown_outside_fences(
        markdown_text=sanitized,
        transform=sanitize_web_text,
    )
    sanitized = _normalize_generated_response_structure(sanitized).strip()
    if sanitized == "":
        raise RuntimeError("AI response contains only unauthorized note citations")
    return sanitized


def find_note_citation_ids(
    markdown_text: str,
    *,
    notes: NoteStore,
) -> tuple[str, ...]:
    if not isinstance(markdown_text, str) or markdown_text == "":
        raise ValueError("AI response content must be a non-empty string")
    cited_note_ids: list[str] = []
    seen_note_ids: set[str] = set()

    def collect(text: str) -> str:
        for match in _NOTE_CITATION_RE.finditer(text):
            raw_note_id = _raw_note_id_from_match(match)
            note_id = raw_note_id.translate(_UUID_DASH_TRANSLATION).lower()
            if notes.has_note(note_id) and note_id not in seen_note_ids:
                seen_note_ids.add(note_id)
                cited_note_ids.append(note_id)
        return text

    _transform_markdown_outside_fences(
        markdown_text=markdown_text,
        transform=collect,
    )
    return tuple(cited_note_ids)


def find_web_citation_ids(markdown_text: str) -> tuple[str, ...]:
    if not isinstance(markdown_text, str) or markdown_text == "":
        raise ValueError("AI response content must be a non-empty string")
    cited_ids: list[str] = []

    def collect(text: str) -> str:
        for match in _WEB_CITATION_RE.finditer(text):
            evidence_id = match.group("web_id").translate(
                _UUID_DASH_TRANSLATION
            ).lower()
            if evidence_id not in cited_ids:
                cited_ids.append(evidence_id)
        return text

    _transform_markdown_outside_fences(markdown_text=markdown_text, transform=collect)
    return tuple(cited_ids)


def _canonicalize_numbered_note_citations(
    *,
    markdown_text: str,
    allowed_note_ids: tuple[str, ...],
) -> str:
    if len(allowed_note_ids) == 0:
        return markdown_text

    def replace_numbered_citation(match: re.Match[str]) -> str:
        reference_number = int(match.group("number"))
        if reference_number > len(allowed_note_ids):
            return ""
        return f"[[{allowed_note_ids[reference_number - 1]}]]"

    return _transform_markdown_outside_fences(
        markdown_text=markdown_text,
        transform=lambda text: _NUMBERED_NOTE_CITATION_RE.sub(
            replace_numbered_citation,
            text,
        ),
    )


def _hide_incomplete_bracketed_citation_suffix(markdown_text: str) -> str:
    """Keep a streaming `[[UUID]]` invisible until both closing brackets arrive."""
    return _transform_markdown_outside_fences(
        markdown_text=markdown_text,
        transform=lambda text: _INCOMPLETE_WEB_CITATION_SUFFIX_RE.sub(
            "",
            _INCOMPLETE_BRACKETED_NOTE_CITATION_SUFFIX_RE.sub("", text),
        ),
    )


def _normalize_generated_response_structure(markdown_text: str) -> str:
    """Repair common model-only Markdown without changing fenced examples."""
    output: list[str] = []
    fence_character = ""
    fence_length = 0
    next_ordered_number: int | None = None
    for line in markdown_text.splitlines(keepends=True):
        marker_match = _FENCE_MARKER_RE.match(line)
        if fence_character != "":
            output.append(line)
            if marker_match is not None:
                marker = marker_match.group("marker")
                if marker[0] == fence_character and len(marker) >= fence_length:
                    fence_character = ""
                    fence_length = 0
            continue
        if marker_match is not None:
            marker = marker_match.group("marker")
            fence_character = marker[0]
            fence_length = len(marker)
            next_ordered_number = None
            output.append(line)
            continue
        if _STANDALONE_SOURCE_LINE_RE.match(line) is not None:
            citations = _BRACKETED_NOTE_CITATION_RE.findall(line)
            if citations:
                previous_index = len(output) - 1
                while previous_index >= 0 and output[previous_index].strip() == "":
                    previous_index -= 1
                if previous_index >= 0:
                    previous_line = output[previous_index]
                    line_ending = ""
                    if previous_line.endswith("\n"):
                        previous_line = previous_line[:-1]
                        line_ending = "\n"
                    output[previous_index] = (
                        previous_line.rstrip()
                        + " "
                        + " ".join(citations)
                        + line_ending
                    )
            continue
        ordered_match = _TOP_LEVEL_ORDERED_ITEM_RE.match(line)
        if ordered_match is not None:
            if next_ordered_number is None:
                next_ordered_number = int(ordered_match.group("number"))
            line = _TOP_LEVEL_ORDERED_ITEM_RE.sub(
                f"{next_ordered_number}. ",
                line,
                count=1,
            )
            next_ordered_number += 1
            output.append(line)
            continue
        stripped = line.strip()
        if (
            stripped != ""
            and not line.startswith((" ", "\t"))
            and _TOP_LEVEL_UNORDERED_ITEM_RE.match(line) is None
        ):
            next_ordered_number = None
        output.append(line)
    return "".join(output)


def _transform_markdown_outside_fences(
    *,
    markdown_text: str,
    transform: Callable[[str], str],
) -> str:
    output: list[str] = []
    fence_character = ""
    fence_length = 0
    for line in markdown_text.splitlines(keepends=True):
        marker_match = _FENCE_MARKER_RE.match(line)
        if fence_character == "":
            if marker_match is not None:
                marker = marker_match.group("marker")
                fence_character = marker[0]
                fence_length = len(marker)
                output.append(line)
                continue
            output.append(transform(line))
            continue

        output.append(line)
        if marker_match is None:
            continue
        marker = marker_match.group("marker")
        if marker[0] == fence_character and len(marker) >= fence_length:
            fence_character = ""
            fence_length = 0
    return "".join(output)


def _validate_allowed_note_ids(allowed_note_ids: tuple[str, ...]) -> None:
    if not isinstance(allowed_note_ids, tuple):
        raise TypeError("allowed_note_ids must be a tuple")
    if len(set(allowed_note_ids)) != len(allowed_note_ids):
        raise ValueError("allowed_note_ids must be unique")
    for note_id in allowed_note_ids:
        if not isinstance(note_id, str) or note_id == "":
            raise ValueError("allowed_note_ids must contain non-empty strings")


def _validate_allowed_web_evidence(
    evidence: tuple[WebCitationReference, ...],
) -> dict[str, WebCitationReference]:
    if not isinstance(evidence, tuple):
        raise TypeError("allowed_web_evidence must be a tuple")
    by_id: dict[str, WebCitationReference] = {}
    for reference in evidence:
        if not isinstance(reference, WebCitationReference):
            raise TypeError("allowed_web_evidence must contain WebCitationReference")
        if reference.evidence_id in by_id:
            raise ValueError("allowed_web_evidence must be unique")
        by_id[reference.evidence_id] = reference
    return by_id


def _raw_note_id_from_match(match: re.Match[str]) -> str:
    reference_note_id = match.group("reference")
    if reference_note_id is not None:
        return reference_note_id
    bare_note_id = match.group("bare")
    assert isinstance(bare_note_id, str) and bare_note_id != ""
    return bare_note_id


def _replace_note_citations(
    *,
    rendered_html: str,
    context: EmbedRenderContext,
    allowed_note_ids: tuple[str, ...],
) -> tuple[str, list[str]]:
    output: list[str] = []
    cited_note_ids: list[str] = []
    seen_note_ids: set[str] = set()
    open_tags: list[str] = []
    citation_number_by_root_id: dict[str, int] = {}
    segments = _HTML_SEGMENT_RE.split(rendered_html)
    segment_index = 0
    while segment_index < len(segments):
        segment = segments[segment_index]
        if segment == "":
            segment_index += 1
            continue
        if not segment.startswith("<"):
            if any(tag in _CITATION_SUPPRESSING_TAGS for tag in open_tags):
                output.append(segment)
            else:
                replaced_text, segment_note_ids, _ = _replace_citations_in_text(
                    text=segment,
                    context=context,
                    allowed_note_ids=allowed_note_ids,
                    citation_number_by_root_id=citation_number_by_root_id,
                )
                output.append(replaced_text)
                for note_id in segment_note_ids:
                    if note_id in seen_note_ids:
                        continue
                    seen_note_ids.add(note_id)
                    cited_note_ids.append(note_id)
            segment_index += 1
            continue

        close_match = _CLOSE_TAG_RE.match(segment)
        if close_match is not None:
            closing_tag = close_match.group(1).casefold()
            if len(open_tags) == 0 or open_tags[-1] != closing_tag:
                raise RuntimeError(
                    f"AI Markdown renderer produced mismatched closing tag {closing_tag}"
                )
            open_tags.pop()
            output.append(segment)
            segment_index += 1
            continue

        open_match = _OPEN_TAG_RE.match(segment)
        if open_match is None:
            raise RuntimeError("AI Markdown renderer produced an unrecognized HTML segment")
        opening_tag = open_match.group(1).casefold()
        can_replace_inline_code = (
            opening_tag == "code"
            and not any(tag in _CITATION_SUPPRESSING_TAGS for tag in open_tags)
            and segment_index + 2 < len(segments)
        )
        if can_replace_inline_code:
            code_text = segments[segment_index + 1]
            closing_code_segment = segments[segment_index + 2]
            closing_code_match = _CLOSE_TAG_RE.match(closing_code_segment)
            is_complete_inline_code = (
                closing_code_match is not None
                and closing_code_match.group(1).casefold() == "code"
            )
            if is_complete_inline_code:
                replaced_text, inline_note_ids, handled_note_citation = (
                    _replace_citations_in_text(
                        text=code_text,
                        context=context,
                        allowed_note_ids=allowed_note_ids,
                        citation_number_by_root_id=citation_number_by_root_id,
                    )
                )
                if handled_note_citation:
                    output.append(replaced_text)
                    for note_id in inline_note_ids:
                        if note_id in seen_note_ids:
                            continue
                        seen_note_ids.add(note_id)
                        cited_note_ids.append(note_id)
                    segment_index += 3
                    continue
        if opening_tag not in _VOID_TAGS and not segment.rstrip().endswith("/>"):
            open_tags.append(opening_tag)
        output.append(segment)
        segment_index += 1

    if len(open_tags) != 0:
        raise RuntimeError(f"AI Markdown renderer left unclosed tags: {open_tags}")
    return "".join(output), cited_note_ids


def _replace_citations_in_text(
    *,
    text: str,
    context: EmbedRenderContext,
    allowed_note_ids: tuple[str, ...],
    citation_number_by_root_id: dict[str, int],
) -> tuple[str, list[str], bool]:
    output: list[str] = []
    cited_note_ids: list[str] = []
    handled_note_citation = False
    previous_marker_output_index: int | None = None
    previous_marker_root_id: str | None = None
    previous_marker_note_ids: list[str] = []
    cursor = 0
    for match in _NOTE_CITATION_RE.finditer(text):
        preceding_text = text[cursor : match.start()]
        reference_note_id = match.group("reference")
        if reference_note_id is not None:
            note_id = reference_note_id
        else:
            note_id = match.group("bare")
        assert isinstance(note_id, str) and note_id != ""
        note_id = note_id.translate(_UUID_DASH_TRANSLATION).lower()
        handled_note_citation = True
        if note_id not in allowed_note_ids:
            output.append(preceding_text)
            previous_marker_output_index = None
            previous_marker_root_id = None
            previous_marker_note_ids = []
            cursor = match.end()
            continue
        if not context.has_note(note_id):
            raise RuntimeError("Allowed AI citation note is missing from NoteStore")
        root_note_id = _resolve_reference_root_id(
            cited_note_id=note_id,
            context=context,
        )
        if root_note_id not in citation_number_by_root_id:
            citation_number_by_root_id[root_note_id] = (
                len(citation_number_by_root_id) + 1
            )
        if reference_note_id is not None:
            reference_number = citation_number_by_root_id[root_note_id]
            can_merge_with_previous_marker = (
                previous_marker_output_index is not None
                and preceding_text.strip() == ""
                and previous_marker_root_id == root_note_id
            )
            if can_merge_with_previous_marker:
                if note_id not in previous_marker_note_ids:
                    previous_marker_note_ids.append(note_id)
                assert previous_marker_output_index is not None
                output[previous_marker_output_index] = _render_citation_marker(
                    reference_number=reference_number,
                    root_note_id=root_note_id,
                    cited_note_ids=tuple(previous_marker_note_ids),
                )
            else:
                output.append(preceding_text)
                previous_marker_note_ids = [note_id]
                output.append(
                    _render_citation_marker(
                        reference_number=reference_number,
                        root_note_id=root_note_id,
                        cited_note_ids=tuple(previous_marker_note_ids),
                    )
                )
                previous_marker_output_index = len(output) - 1
                previous_marker_root_id = root_note_id
            cited_note_ids.append(note_id)
        else:
            output.append(preceding_text)
            preview = get_note_reference_preview(
                reference_note_id=note_id,
                context=context,
                redact_credentials=True,
            )
            output.append(
                '<span class="ai-chat-note-mention">'
                f"“{html.escape(preview)}”"
                "</span>"
            )
            cited_note_ids.append(note_id)
            previous_marker_output_index = None
            previous_marker_root_id = None
            previous_marker_note_ids = []
        cursor = match.end()
    output.append(text[cursor:])
    replaced_text = _sort_adjacent_citation_marker_runs("".join(output))
    return replaced_text, cited_note_ids, handled_note_citation


def _render_citation_marker(
    *,
    reference_number: int,
    root_note_id: str,
    cited_note_ids: tuple[str, ...],
) -> str:
    if reference_number < 1:
        raise ValueError("Citation reference number must be positive")
    if len(cited_note_ids) == 0:
        raise ValueError("Citation marker requires at least one cited note")
    reference_query = " OR ".join(cited_note_ids)
    return (
        '<sup class="ai-chat-citation-marker" '
        f'aria-label="Reference {reference_number}">'
        '<a href="#" class="ai-chat-citation-link note-reference-link" '
        f'data-ref-note-id="{html.escape(root_note_id, quote=True)}" '
        f'data-ref-query="{html.escape(reference_query, quote=True)}">'
        f"[{reference_number}]</a></sup>"
    )


def _replace_web_citations(
    *,
    rendered_html: str,
    evidence_by_id: dict[str, WebCitationReference],
    starting_number: int,
) -> tuple[str, list[str]]:
    if starting_number < 1:
        raise ValueError("Web citation numbering must be positive")
    output: list[str] = []
    cited_ids: list[str] = []
    number_by_id: dict[str, int] = {}
    open_tags: list[str] = []
    for segment in _HTML_SEGMENT_RE.split(rendered_html):
        if segment == "":
            continue
        if not segment.startswith("<"):
            if any(tag in _CITATION_SUPPRESSING_TAGS for tag in open_tags):
                output.append(segment)
                continue

            def replace(match: re.Match[str]) -> str:
                evidence_id = match.group("web_id").translate(
                    _UUID_DASH_TRANSLATION
                ).lower()
                if evidence_id not in evidence_by_id:
                    return ""
                if evidence_id not in number_by_id:
                    number_by_id[evidence_id] = starting_number + len(number_by_id)
                    cited_ids.append(evidence_id)
                reference_number = number_by_id[evidence_id]
                return (
                    '<sup class="ai-chat-citation-marker" '
                    f'aria-label="Reference {reference_number}">'
                    '<a class="ai-chat-citation-link ai-chat-web-citation-link" '
                    f'href="{html.escape(evidence_by_id[evidence_id].final_url, quote=True)}" '
                    'target="_blank" rel="noopener noreferrer">'
                    f"[{reference_number}]</a></sup>"
                )

            output.append(_WEB_CITATION_RE.sub(replace, segment))
            continue
        close_match = _CLOSE_TAG_RE.match(segment)
        if close_match is not None:
            closing_tag = close_match.group(1).casefold()
            if len(open_tags) == 0 or open_tags[-1] != closing_tag:
                raise RuntimeError(
                    f"AI Markdown renderer produced mismatched closing tag {closing_tag}"
                )
            open_tags.pop()
            output.append(segment)
            continue
        open_match = _OPEN_TAG_RE.match(segment)
        if open_match is None:
            raise RuntimeError("AI Markdown renderer produced an unrecognized HTML segment")
        opening_tag = open_match.group(1).casefold()
        if opening_tag not in _VOID_TAGS and not segment.rstrip().endswith("/>"):
            open_tags.append(opening_tag)
        output.append(segment)
    if open_tags:
        raise RuntimeError(f"AI Markdown renderer left unclosed tags: {open_tags}")
    return "".join(output), cited_ids


def _sort_adjacent_citation_marker_runs(rendered_text: str) -> str:
    marker_matches = list(_CITATION_MARKER_HTML_RE.finditer(rendered_text))
    if len(marker_matches) < 2:
        return rendered_text
    output: list[str] = []
    cursor = 0
    marker_index = 0
    while marker_index < len(marker_matches):
        run_start_index = marker_index
        run_end_index = run_start_index + 1
        while run_end_index < len(marker_matches):
            preceding_match = marker_matches[run_end_index - 1]
            next_match = marker_matches[run_end_index]
            between_markers = rendered_text[preceding_match.end() : next_match.start()]
            if between_markers.strip() != "":
                break
            run_end_index += 1

        first_match = marker_matches[run_start_index]
        output.append(rendered_text[cursor : first_match.start()])
        marker_run = marker_matches[run_start_index:run_end_index]
        marker_run.sort(key=lambda match: int(match.group("number")))
        for marker_match in marker_run:
            reference_number = marker_match.group("number")
            display_number = marker_match.group("display_number")
            if display_number != reference_number:
                raise RuntimeError("AI citation marker number does not match its label")
            output.append(marker_match.group(0))
        cursor = marker_matches[run_end_index - 1].end()
        marker_index = run_end_index
    output.append(rendered_text[cursor:])
    return "".join(output)


def _render_references_section(
    reference_groups: list[tuple[str, tuple[str, ...]]],
    *,
    context: EmbedRenderContext,
    cited_web_ids: list[str],
    evidence_by_id: dict[str, WebCitationReference],
) -> str:
    if len(reference_groups) == 0 and len(cited_web_ids) == 0:
        raise ValueError("References section requires at least one citation")
    reference_items: list[str] = []
    all_cited_note_ids: list[str] = []
    for reference_number, (root_note_id, cited_note_ids) in enumerate(
        reference_groups,
        start=1,
    ):
        reference_query = " OR ".join(cited_note_ids)
        all_cited_note_ids.extend(cited_note_ids)
        reference_link = render_compact_note_reference_link(
            reference_note_id=root_note_id,
            context=context,
            redact_credentials=True,
        )
        reference_items.append(
            f'<li data-ref-query="{html.escape(reference_query, quote=True)}">'
            f'<span class="ai-chat-reference-number">[{reference_number}]</span>'
            f"{reference_link}</li>"
        )

    for evidence_id in cited_web_ids:
        page = evidence_by_id[evidence_id]
        reference_number = len(reference_items) + 1
        label = page.title
        if label == "":
            label = page.final_url
        reference_items.append(
            '<li class="ai-chat-web-reference">'
            f'<span class="ai-chat-reference-number">[{reference_number}]</span>'
            f'<a href="{html.escape(page.final_url, quote=True)}" '
            'target="_blank" rel="noopener noreferrer">'
            f"{html.escape(label)}</a></li>"
        )

    open_all_html = ""
    if len(reference_groups) > 1 and len(cited_web_ids) == 0:
        reference_query = " OR ".join(all_cited_note_ids)
        escaped_query = html.escape(reference_query, quote=True)
        open_all_html = (
            '<a href="#" class="ai-chat-open-all-references" '
            f'data-ref-query="{escaped_query}">Open all references</a>'
        )

    return (
        '<section class="ai-chat-references" aria-label="References">'
        '<details class="ai-chat-references-disclosure">'
        '<summary class="ai-chat-references-heading">References</summary>'
        f'<ol>{"".join(reference_items)}</ol>'
        f"{open_all_html}"
        "</details>"
        "</section>"
    )


def _group_citations_by_reference_root(
    *,
    cited_note_ids: list[str],
    context: EmbedRenderContext,
) -> list[tuple[str, tuple[str, ...]]]:
    if len(cited_note_ids) == 0:
        raise ValueError("Reference root resolution requires cited notes")
    root_ids: list[str] = []
    cited_ids_by_root: dict[str, list[str]] = {}
    for cited_note_id in cited_note_ids:
        root_note_id = _resolve_reference_root_id(
            cited_note_id=cited_note_id,
            context=context,
        )
        if root_note_id not in cited_ids_by_root:
            root_ids.append(root_note_id)
            cited_ids_by_root[root_note_id] = []
        if cited_note_id not in cited_ids_by_root[root_note_id]:
            cited_ids_by_root[root_note_id].append(cited_note_id)
    return [
        (root_note_id, tuple(cited_ids_by_root[root_note_id]))
        for root_note_id in root_ids
    ]


def _resolve_reference_root_id(
    *,
    cited_note_id: str,
    context: EmbedRenderContext,
) -> str:
    current_note_id = cited_note_id
    visited_note_ids: set[str] = set()
    while True:
        if current_note_id in visited_note_ids:
            raise RuntimeError(
                "Cycle detected while resolving AI citation root: "
                f"{cited_note_id}"
            )
        visited_note_ids.add(current_note_id)
        record = context.get_note(current_note_id)
        parent_id = record.parent_id
        if parent_id is None:
            return current_note_id
        if not isinstance(parent_id, str) or parent_id == "":
            raise RuntimeError(
                "AI citation note has invalid parent id: "
                f"note_id={current_note_id} parent_id={parent_id}"
            )
        if not context.has_note(parent_id):
            raise RuntimeError(
                "AI citation hierarchy contains a missing parent: "
                f"note_id={current_note_id} parent_id={parent_id}"
            )
        current_note_id = parent_id


# ChatGPT's own citation markup, which OpenAI models sometimes write around a
# citation: U+E200 "cite" U+E202 <source> U+E201. Shown as boxes and a stray "cite".
_PROVIDER_CITATION_OPEN = "\ue200"
_PROVIDER_CITATION_RE = re.compile("\ue200cite\ue202(.*?)\ue201", re.DOTALL)
_PROVIDER_MARKUP_CHARACTERS_RE = re.compile("[\ue200-\ue202]")
_OUR_CITATION_TOKEN_RE = re.compile(r"\[\[[^\[\]]+\]\]")


def strip_provider_citation_markup(text: str, *, is_final: bool) -> str:
    """The answer without the provider's citation markup, keeping our own [[…]]
    citations found inside it. While streaming (is_final False), markup that has
    not closed yet is held back, so the result only ever grows."""
    if not isinstance(text, str):
        raise TypeError("AI response text must be a string")

    def keep_our_citations(source: str) -> str:
        return " ".join(_OUR_CITATION_TOKEN_RE.findall(source))

    cleaned = _PROVIDER_CITATION_RE.sub(lambda match: keep_our_citations(match.group(1)), text)
    unfinished_at = cleaned.rfind(_PROVIDER_CITATION_OPEN)
    if unfinished_at != -1:
        unfinished = cleaned[unfinished_at:]
        cleaned = cleaned[:unfinished_at]
        if is_final:
            cleaned += keep_our_citations(unfinished)
    return _PROVIDER_MARKUP_CHARACTERS_RE.sub("", cleaned)
