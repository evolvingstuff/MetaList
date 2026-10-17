from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, List, Tuple

from app.services.content_formatting import (
    MAX_DELIMITER_DEPTH,
    _tokenize_tag_bar_preserving_comments,
    _unwrap_tag_token,
    remove_formatting_scope_delimiters,
)
from app.services.embedded_references import collect_reference_tokens_from_html
from app.services.inline_image_occurrences import INLINE_IMAGE_TAG_RE


# Steps through SIZE_FACTORS for Make Bigger and Make Smaller.
_ONE_SIZE_BIGGER = 1
_ONE_SIZE_SMALLER = -1
SIZE_FACTORS = ("0.1", "0.25", "0.5", "0.75", "1.0", "1.25", "1.5", "2.0", "3.0")
_SIZE_TAG_RE = re.compile(
    r"^@size=(0\.1|0\.25|0\.5|0\.75|1\.0|1\.25|1\.5|2\.0|3\.0)$",
    re.IGNORECASE,
)
_OPEN_TO_CLOSE = {"{": "}", "[": "]", "(": ")"}


@dataclass(frozen=True, slots=True)
class ImageSizeMutationResult:
    content_html: str
    tags: str
    size_factor: str
    changed: bool


@dataclass(frozen=True, slots=True)
class _SourceSpan:
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class _SizeScope:
    token_index: int
    opener: str
    depth: int
    open_start: int
    close_start: int
    inner_tokens: Tuple[str, ...]


def apply_image_size_action(
    *,
    content_html: str,
    tags: str,
    source_kind: str,
    occurrence_index: int,
    action: str,
    is_image_file: Callable[[str], bool],
) -> ImageSizeMutationResult:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    if not isinstance(tags, str):
        raise TypeError("tags must be a string")
    if source_kind not in {"inline", "file"}:
        raise ValueError("source_kind must be 'inline' or 'file'")
    if not isinstance(occurrence_index, int):
        raise TypeError("occurrence_index must be an integer")
    if occurrence_index < 0:
        raise ValueError("occurrence_index must be >= 0")
    if action not in {"bigger", "smaller", "reset"}:
        raise ValueError("action must be 'bigger', 'smaller', or 'reset'")
    if not callable(is_image_file):
        raise TypeError("is_image_file must be callable")

    source_span = _resolve_source_span(
        content_html=content_html,
        source_kind=source_kind,
        occurrence_index=occurrence_index,
        is_image_file=is_image_file,
    )
    tag_tokens = _tokenize_tag_bar_preserving_comments(tags)
    size_scope = _find_size_scope(
        content_html=content_html,
        tag_tokens=tag_tokens,
        source_span=source_span,
    )
    if size_scope is None:
        current_factor = "1.0"
    else:
        current_factor = _scope_size_factor(size_scope)
    target_factor = _target_size_factor(current_factor=current_factor, action=action)

    if size_scope is None:
        if target_factor == "1.0":
            return ImageSizeMutationResult(content_html, tags, "1.0", False)
        opener, depth = _choose_unused_wrapper(content_html=content_html, tags=tags)
        closer = _OPEN_TO_CLOSE[opener]
        open_token = opener * depth
        close_token = closer * depth
        updated_content = (
            f"{content_html[:source_span.start]}{open_token}"
            f"{content_html[source_span.start:source_span.end]}{close_token}"
            f"{content_html[source_span.end:]}"
        )
        tag_tokens.append(f"{open_token}@size={target_factor}{close_token}")
        return ImageSizeMutationResult(
            updated_content,
            " ".join(tag_tokens),
            target_factor,
            True,
        )

    updated_tokens = list(tag_tokens)
    non_size_tokens = tuple(
        token for token in size_scope.inner_tokens if _SIZE_TAG_RE.fullmatch(token) is None
    )
    if target_factor != "1.0":
        replacement_inner = (*non_size_tokens, f"@size={target_factor}")
        updated_tokens[size_scope.token_index] = _wrap_tag_tokens(
            replacement_inner,
            size_scope.opener,
            size_scope.depth,
        )
        return ImageSizeMutationResult(
            content_html,
            " ".join(updated_tokens),
            target_factor,
            target_factor != current_factor,
        )

    if non_size_tokens:
        updated_tokens[size_scope.token_index] = _wrap_tag_tokens(
            non_size_tokens,
            size_scope.opener,
            size_scope.depth,
        )
        return ImageSizeMutationResult(content_html, " ".join(updated_tokens), "1.0", True)

    del updated_tokens[size_scope.token_index]
    if _wrapper_is_used_by_other_tag_token(
        tag_tokens=updated_tokens,
        opener=size_scope.opener,
        depth=size_scope.depth,
    ):
        return ImageSizeMutationResult(content_html, " ".join(updated_tokens), "1.0", True)

    updated_content = remove_formatting_scope_delimiters(
        content_html,
        frozenset({(size_scope.opener, size_scope.depth)}),
    )
    return ImageSizeMutationResult(updated_content, " ".join(updated_tokens), "1.0", True)


def _resolve_source_span(
    *,
    content_html: str,
    source_kind: str,
    occurrence_index: int,
    is_image_file: Callable[[str], bool],
) -> _SourceSpan:
    if source_kind == "inline":
        image_matches = list(INLINE_IMAGE_TAG_RE.finditer(content_html))
        if occurrence_index >= len(image_matches):
            raise IndexError("Inline image occurrence does not exist")
        match = image_matches[occurrence_index]
        return _SourceSpan(start=match.start(), end=match.end())

    references = collect_reference_tokens_from_html(content_html)
    if occurrence_index >= len(references):
        raise IndexError("File reference occurrence does not exist")
    reference = references[occurrence_index]
    if not reference.is_embed:
        raise ValueError("Target file image must be an embedded reference")
    if not is_image_file(reference.note_id):
        raise ValueError("Target reference is not a resizable image or diagram file")
    return _SourceSpan(start=reference.start, end=reference.end)


def _find_size_scope(
    *,
    content_html: str,
    tag_tokens: List[str],
    source_span: _SourceSpan,
) -> _SizeScope | None:
    candidates: List[_SizeScope] = []
    for token_index, token in enumerate(tag_tokens):
        if token.startswith("/*"):
            continue
        inner, wrapper = _unwrap_tag_token(token)
        if wrapper is None:
            continue
        inner_tokens = tuple(part for part in inner.split() if part)
        size_tokens = tuple(part for part in inner_tokens if _SIZE_TAG_RE.fullmatch(part))
        if not size_tokens:
            continue
        if len(size_tokens) != 1:
            raise ValueError("A formatting scope cannot contain multiple @size tags")
        opener, depth = wrapper
        for open_start, close_start in _find_wrapper_pairs(
            content_html=content_html,
            opener=opener,
            depth=depth,
        ):
            if open_start + depth <= source_span.start and close_start >= source_span.end:
                candidates.append(
                    _SizeScope(
                        token_index=token_index,
                        opener=opener,
                        depth=depth,
                        open_start=open_start,
                        close_start=close_start,
                        inner_tokens=inner_tokens,
                    )
                )
    if not candidates:
        return None
    candidates.sort(key=lambda scope: scope.close_start - scope.open_start)
    return candidates[0]


def _find_wrapper_pairs(*, content_html: str, opener: str, depth: int) -> List[Tuple[int, int]]:
    closer = _OPEN_TO_CLOSE[opener]
    open_token = opener * depth
    close_token = closer * depth
    stack: List[int] = []
    pairs: List[Tuple[int, int]] = []
    cursor = 0
    for html_match in re.finditer(r"<(?:[^>\"']|\"[^\"]*\"|'[^']*')*>", content_html):
        _scan_text_for_wrapper_pairs(
            text=content_html[cursor : html_match.start()],
            offset=cursor,
            open_token=open_token,
            close_token=close_token,
            stack=stack,
            pairs=pairs,
        )
        cursor = html_match.end()
    _scan_text_for_wrapper_pairs(
        text=content_html[cursor:],
        offset=cursor,
        open_token=open_token,
        close_token=close_token,
        stack=stack,
        pairs=pairs,
    )
    return pairs


def _scan_text_for_wrapper_pairs(
    *,
    text: str,
    offset: int,
    open_token: str,
    close_token: str,
    stack: List[int],
    pairs: List[Tuple[int, int]],
) -> None:
    index = 0
    while index < len(text):
        if text[index] == open_token[0]:
            run = 1
            while index + run < len(text) and text[index + run] == open_token[0]:
                run += 1
            if run == len(open_token):
                stack.append(offset + index)
            index += run
            continue
        if text[index] == close_token[0]:
            run = 1
            while index + run < len(text) and text[index + run] == close_token[0]:
                run += 1
            if run == len(close_token) and stack:
                pairs.append((stack.pop(), offset + index))
            index += run
            continue
        index += 1


def _scope_size_factor(scope: _SizeScope) -> str:
    matches = [token for token in scope.inner_tokens if _SIZE_TAG_RE.fullmatch(token)]
    if len(matches) != 1:
        raise AssertionError("Size scope must contain exactly one size tag")
    return matches[0].split("=", 1)[1]


def _target_size_factor(*, current_factor: str, action: str) -> str:
    current_index = SIZE_FACTORS.index(current_factor)
    if action == "reset":
        return "1.0"
    if action == "bigger":
        direction = _ONE_SIZE_BIGGER
    else:
        assert action == "smaller"
        direction = _ONE_SIZE_SMALLER
    target_index = max(0, min(len(SIZE_FACTORS) - 1, current_index + direction))
    return SIZE_FACTORS[target_index]


def _choose_unused_wrapper(*, content_html: str, tags: str) -> Tuple[str, int]:
    for opener, closer in _OPEN_TO_CLOSE.items():
        for depth in range(1, MAX_DELIMITER_DEPTH + 1):
            if opener * depth in content_html or closer * depth in content_html:
                continue
            if opener * depth in tags or closer * depth in tags:
                continue
            return opener, depth
    raise ValueError("No unused formatting delimiter is available")


def _wrap_tag_tokens(inner_tokens: Tuple[str, ...], opener: str, depth: int) -> str:
    if not inner_tokens:
        raise ValueError("inner_tokens cannot be empty")
    closer = _OPEN_TO_CLOSE[opener]
    return f"{opener * depth}{' '.join(inner_tokens)}{closer * depth}"


def _wrapper_is_used_by_other_tag_token(
    *,
    tag_tokens: List[str],
    opener: str,
    depth: int,
) -> bool:
    for token in tag_tokens:
        _, wrapper = _unwrap_tag_token(token)
        if wrapper == (opener, depth):
            return True
    return False
