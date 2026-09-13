from __future__ import annotations

import html
from dataclasses import dataclass

from latex2mathml.converter import convert
from latex2mathml.exceptions import DenominatorNotFoundError
from latex2mathml.exceptions import DoubleSubscriptsError
from latex2mathml.exceptions import DoubleSuperscriptsError
from latex2mathml.exceptions import ExtraLeftOrMissingRightError
from latex2mathml.exceptions import InvalidAlignmentError
from latex2mathml.exceptions import InvalidStyleForGenfracError
from latex2mathml.exceptions import InvalidWidthError
from latex2mathml.exceptions import LimitsMustFollowMathOperatorError
from latex2mathml.exceptions import MissingEndError
from latex2mathml.exceptions import MissingSuperScriptOrSubscriptError
from latex2mathml.exceptions import NoAvailableTokensError
from latex2mathml.exceptions import NumeratorNotFoundError

from app.services.exception_capture import CapturedExceptionContext


_LATEX_CONVERSION_ERRORS = (
    DenominatorNotFoundError,
    DoubleSubscriptsError,
    DoubleSuperscriptsError,
    ExtraLeftOrMissingRightError,
    InvalidAlignmentError,
    InvalidStyleForGenfracError,
    InvalidWidthError,
    LimitsMustFollowMathOperatorError,
    MissingEndError,
    MissingSuperScriptOrSubscriptError,
    NoAvailableTokensError,
    NumeratorNotFoundError,
)


@dataclass(frozen=True, slots=True)
class LatexRenderResult:
    html: str
    has_error: bool
    error_message: str


@dataclass(frozen=True, slots=True)
class _LatexSegment:
    segment_type: str
    value: str


def render_latex_math_to_html(latex_text: str, *, display: str) -> LatexRenderResult:
    if not isinstance(latex_text, str):
        raise TypeError(f"latex_text must be a string, got {type(latex_text)}")
    if display not in {"inline", "block"}:
        raise ValueError("display must be 'inline' or 'block'")
    if latex_text == "":
        return LatexRenderResult(html="", has_error=False, error_message="")

    conversion_capture = CapturedExceptionContext(*_LATEX_CONVERSION_ERRORS, boundary='app/services/latex_rendering.py:render_latex_math_to_html:conversion_capture')
    rendered_math = ""
    with conversion_capture:
        rendered_math = _render_math_segment(latex_text, display=display)
    if conversion_capture.captured_exception is not None:
        return _render_latex_error_result(
            latex_text=latex_text,
            exception=conversion_capture.captured_exception,
        )
    return LatexRenderResult(
        html=rendered_math,
        has_error=False,
        error_message="",
    )


def render_latex_to_html(latex_text: str) -> LatexRenderResult:
    if not isinstance(latex_text, str):
        raise TypeError(f"latex_text must be a string, got {type(latex_text)}")
    if latex_text == "":
        return LatexRenderResult(html="", has_error=False, error_message="")

    if not _has_math_delimiters(latex_text):
        return render_latex_math_to_html(latex_text, display="block")

    segments = _parse_latex_segments(latex_text)
    parts: list[str] = []
    segment_capture = CapturedExceptionContext(*_LATEX_CONVERSION_ERRORS, boundary='app/services/latex_rendering.py:render_latex_to_html:segment_capture')
    with segment_capture:
        for segment in segments:
            if segment.segment_type == "text":
                parts.append(_render_text_segment(segment.value))
                continue

            if segment.segment_type == "display":
                parts.append(_render_math_segment(segment.value, display="block"))
                continue

            if segment.segment_type == "inline":
                parts.append(_render_math_segment(segment.value, display="inline"))
                continue

            raise AssertionError(f"Unknown LaTeX segment type: {segment.segment_type}")
    if segment_capture.captured_exception is not None:
        return _render_latex_error_result(
            latex_text=latex_text,
            exception=segment_capture.captured_exception,
        )
    return LatexRenderResult(
        html="".join(parts),
        has_error=False,
        error_message="",
    )


def _render_math_segment(latex_text: str, *, display: str) -> str:
    if not isinstance(latex_text, str):
        raise TypeError(f"latex_text must be a string, got {type(latex_text)}")
    if display not in {"inline", "block"}:
        raise ValueError("display must be 'inline' or 'block'")
    return convert(latex_text, display=display)


def _render_text_segment(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError(f"text must be a string, got {type(text)}")
    if text == "":
        return ""
    escaped = html.escape(text, quote=False)
    return escaped.replace("\n", "<br>")


def _render_latex_error_html(source: str) -> str:
    if not isinstance(source, str):
        raise TypeError(f"source must be a string, got {type(source)}")
    escaped_text = html.escape(source, quote=False)
    return (
        '<span class="meta-latex-badge">Invalid LaTeX</span>'
        f'<code class="meta-latex-code">{escaped_text}</code>'
    )


def _render_latex_error_result(
    *,
    latex_text: str,
    exception: BaseException,
) -> LatexRenderResult:
    if not isinstance(latex_text, str):
        raise TypeError(f"latex_text must be a string, got {type(latex_text)}")
    if not isinstance(exception, BaseException):
        raise TypeError(f"exception must be a BaseException, got {type(exception)}")
    return LatexRenderResult(
        html=_render_latex_error_html(latex_text),
        has_error=True,
        error_message=str(exception),
    )


def _is_escaped(text: str, index: int) -> bool:
    if not isinstance(text, str):
        raise TypeError(f"text must be a string, got {type(text)}")
    if not isinstance(index, int):
        raise TypeError(f"index must be an int, got {type(index)}")

    count = 0
    cursor = index - 1
    while cursor >= 0 and text[cursor] == "\\":
        count += 1
        cursor -= 1
    return count % 2 == 1


def _find_closing_delimiter(text: str, start_index: int, delimiter: str) -> int:
    if not isinstance(text, str):
        raise TypeError(f"text must be a string, got {type(text)}")
    if not isinstance(start_index, int):
        raise TypeError(f"start_index must be an int, got {type(start_index)}")
    if not isinstance(delimiter, str) or delimiter == "":
        raise TypeError("delimiter must be a non-empty string")

    cursor = start_index
    while cursor < len(text):
        if text.startswith(delimiter, cursor) and not _is_escaped(text, cursor):
            return cursor
        cursor += 1
    return -1


def _find_inline_closing(text: str, start_index: int) -> int:
    if not isinstance(text, str):
        raise TypeError(f"text must be a string, got {type(text)}")
    if not isinstance(start_index, int):
        raise TypeError(f"start_index must be an int, got {type(start_index)}")

    cursor = start_index
    while cursor < len(text):
        if (
            text[cursor] == "$"
            and not _is_escaped(text, cursor)
            and (cursor + 1 >= len(text) or text[cursor + 1] != "$")
        ):
            return cursor
        cursor += 1
    return -1


def _parse_latex_segments(text: str) -> list[_LatexSegment]:
    if not isinstance(text, str):
        raise TypeError(f"text must be a string, got {type(text)}")

    segments: list[_LatexSegment] = []
    cursor = 0
    last_text_start = 0

    def flush_text(end_index: int) -> None:
        nonlocal last_text_start
        if end_index > last_text_start:
            segments.append(
                _LatexSegment(
                    segment_type="text",
                    value=text[last_text_start:end_index],
                )
            )

    while cursor < len(text):
        if text.startswith("$$", cursor) and not _is_escaped(text, cursor):
            close_index = _find_closing_delimiter(text, cursor + 2, "$$")
            if close_index != -1:
                flush_text(cursor)
                segments.append(
                    _LatexSegment(
                        segment_type="display",
                        value=text[cursor + 2:close_index],
                    )
                )
                cursor = close_index + 2
                last_text_start = cursor
                continue

        if (
            text[cursor] == "$"
            and not _is_escaped(text, cursor)
            and (cursor + 1 >= len(text) or text[cursor + 1] != "$")
        ):
            close_index = _find_inline_closing(text, cursor + 1)
            if close_index != -1:
                flush_text(cursor)
                segments.append(
                    _LatexSegment(
                        segment_type="inline",
                        value=text[cursor + 1:close_index],
                    )
                )
                cursor = close_index + 1
                last_text_start = cursor
                continue

        cursor += 1

    flush_text(len(text))
    return segments


def _has_math_delimiters(text: str) -> bool:
    if not isinstance(text, str):
        raise TypeError(f"text must be a string, got {type(text)}")

    cursor = 0
    while cursor < len(text):
        if text.startswith("$$", cursor) and not _is_escaped(text, cursor):
            return True
        if (
            text[cursor] == "$"
            and not _is_escaped(text, cursor)
            and (cursor + 1 >= len(text) or text[cursor + 1] != "$")
        ):
            return True
        cursor += 1
    return False
