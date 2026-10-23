from __future__ import annotations

import re

from app.services.content_formatting import COMMENT_CLOSE, COMMENT_OPEN, MAX_DELIMITER_DEPTH, _unwrap_tag_token
from app.services.tag_properties import tag_part_of_token



def delete_tag_from_tag_bar(*, tags: str, tag: str) -> tuple[str, bool]:
    if not isinstance(tags, str):
        raise TypeError('tags must be a string')
    if not isinstance(tag, str) or tag == '':
        raise TypeError('tag must be a non-empty string')

    out = ''
    changed = False
    index = 0
    while index < len(tags):
        if tags.startswith(COMMENT_OPEN, index):
            end = tags.find(COMMENT_CLOSE, index + len(COMMENT_OPEN))
            if end == -1:
                out += tags[index:]
                break
            out += tags[index : end + len(COMMENT_CLOSE)]
            index = end + len(COMMENT_CLOSE)
            continue

        ch = tags[index]
        if ch.isspace():
            out += ch
            index += 1
            continue

        start = index
        opener = tags[index]
        token_end = None

        if opener in {'[', '{', '('}:
            opener_run = 1
            while index + opener_run < len(tags) and tags[index + opener_run] == opener:
                opener_run += 1
            if opener_run <= MAX_DELIMITER_DEPTH:
                closer = {"[": "]", "{": "}", "(": ")"}[opener]
                needle = closer * opener_run
                close_at = tags.find(needle, index + opener_run)
                if close_at != -1:
                    token_end = close_at + opener_run

        if token_end is None:
            token_end = start
            while token_end < len(tags) and not tags[token_end].isspace():
                token_end += 1

        token = tags[start:token_end]
        base, wrapper = _unwrap_tag_token(token)

        if wrapper is None:
            # Deleting jogging also removes jogging:miles=3, its properties with it.
            if tag_part_of_token(base) == tag:
                changed = True
            else:
                out += token
        else:
            remaining = _delete_inner_token(inner=base, tag=tag)
            if remaining != base:
                changed = True
                if remaining != '':
                    opener_char, depth = wrapper
                    closer_char = {"[": "]", "{": "}", "(": ")"}[opener_char]
                    out += (opener_char * depth) + remaining + (closer_char * depth)
            else:
                out += token

        index = token_end

    return out, changed


def _delete_inner_token(*, inner: str, tag: str) -> str:
    parts = re.split(r'\s+', inner.strip())
    remaining = [part for part in parts if part != tag]
    if len(remaining) == len(parts):
        return inner
    return ' '.join(remaining)


def rename_tag_in_tag_bar(*, tags: str, old: str, new: str) -> tuple[str, bool]:
    if not isinstance(tags, str):
        raise TypeError('tags must be a string')
    if not isinstance(old, str) or old == '':
        raise TypeError('old must be a non-empty string')
    if not isinstance(new, str) or new == '':
        raise TypeError('new must be a non-empty string')

    if old == new:
        return tags, False

    out = ''
    changed = False
    index = 0
    while index < len(tags):
        if tags.startswith(COMMENT_OPEN, index):
            end = tags.find(COMMENT_CLOSE, index + len(COMMENT_OPEN))
            if end == -1:
                out += tags[index:]
                break
            out += tags[index : end + len(COMMENT_CLOSE)]
            index = end + len(COMMENT_CLOSE)
            continue

        ch = tags[index]
        if ch.isspace():
            out += ch
            index += 1
            continue

        start = index
        opener = tags[index]
        token_end = None

        if opener in {'[', '{', '('}:
            opener_run = 1
            while index + opener_run < len(tags) and tags[index + opener_run] == opener:
                opener_run += 1
            if opener_run <= MAX_DELIMITER_DEPTH:
                closer = {"[": "]", "{": "}", "(": ")"}[opener]
                needle = closer * opener_run
                close_at = tags.find(needle, index + opener_run)
                if close_at != -1:
                    token_end = close_at + opener_run

        if token_end is None:
            token_end = start
            while token_end < len(tags) and not tags[token_end].isspace():
                token_end += 1

        token = tags[start:token_end]
        base, wrapper = _unwrap_tag_token(token)

        if wrapper is None:
            # Renaming jogging keeps its properties: running:miles=3.
            if tag_part_of_token(base) == old:
                out += new + base[len(old):]
                changed = True
            else:
                out += token
        else:
            replaced = _replace_inner_tokens(inner=base, old=old, new=new)
            if replaced != base:
                changed = True
                opener_char, depth = wrapper
                closer_char = {"[": "]", "{": "}", "(": ")"}[opener_char]
                out += (opener_char * depth) + replaced + (closer_char * depth)
            else:
                out += token

        index = token_end

    return out, changed


def _replace_inner_tokens(*, inner: str, old: str, new: str) -> str:
    parts = re.split(r'(\s+)', inner)
    out: list[str] = []
    for part in parts:
        if part == old:
            out.append(new)
        else:
            out.append(part)
    return ''.join(out)


def toggle_meta_tag_pair_in_tag_bar(*, tags: str, tag_a: str, tag_b: str) -> tuple[str, bool]:
    if not isinstance(tags, str):
        raise TypeError('tags must be a string')
    if not isinstance(tag_a, str) or tag_a == '':
        raise TypeError('tag_a must be a non-empty string')
    if not isinstance(tag_b, str) or tag_b == '':
        raise TypeError('tag_b must be a non-empty string')
    if tag_a == tag_b:
        raise ValueError('tag_a and tag_b must be different')

    has_a = _has_global_tag(tags=tags, target=tag_a)
    has_b = _has_global_tag(tags=tags, target=tag_b)
    if has_a and has_b:
        raise RuntimeError(f"Both toggle tags present: {tag_a} {tag_b}")
    if not has_a and not has_b:
        raise KeyError(f"Missing toggle tags: {tag_a} {tag_b}")

    if has_a:
        from_tag = tag_a
        to_tag = tag_b
    else:
        from_tag = tag_b
        to_tag = tag_a

    out = ''
    changed = False
    index = 0
    while index < len(tags):
        if tags.startswith(COMMENT_OPEN, index):
            end = tags.find(COMMENT_CLOSE, index + len(COMMENT_OPEN))
            if end == -1:
                out += tags[index:]
                break
            out += tags[index : end + len(COMMENT_CLOSE)]
            index = end + len(COMMENT_CLOSE)
            continue

        ch = tags[index]
        if ch.isspace():
            out += ch
            index += 1
            continue

        start = index
        opener = tags[index]
        token_end = None

        if opener in {'[', '{', '('}:
            opener_run = 1
            while index + opener_run < len(tags) and tags[index + opener_run] == opener:
                opener_run += 1
            if opener_run <= MAX_DELIMITER_DEPTH:
                closer = {"[": "]", "{": "}", "(": ")"}[opener]
                needle = closer * opener_run
                close_at = tags.find(needle, index + opener_run)
                if close_at != -1:
                    token_end = close_at + opener_run

        if token_end is None:
            token_end = start
            while token_end < len(tags) and not tags[token_end].isspace():
                token_end += 1

        token = tags[start:token_end]
        base, wrapper = _unwrap_tag_token(token)

        if wrapper is None and base == from_tag:
            out += to_tag
            changed = True
        else:
            out += token

        index = token_end

    return out, changed


def _has_global_tag(*, tags: str, target: str) -> bool:
    index = 0
    while index < len(tags):
        if tags.startswith(COMMENT_OPEN, index):
            end = tags.find(COMMENT_CLOSE, index + len(COMMENT_OPEN))
            if end == -1:
                return False
            index = end + len(COMMENT_CLOSE)
            continue

        ch = tags[index]
        if ch.isspace():
            index += 1
            continue

        start = index
        opener = tags[index]
        token_end = None

        if opener in {'[', '{', '('}:
            opener_run = 1
            while index + opener_run < len(tags) and tags[index + opener_run] == opener:
                opener_run += 1
            if opener_run <= MAX_DELIMITER_DEPTH:
                closer = {"[": "]", "{": "}", "(": ")"}[opener]
                needle = closer * opener_run
                close_at = tags.find(needle, index + opener_run)
                if close_at != -1:
                    token_end = close_at + opener_run

        if token_end is None:
            token_end = start
            while token_end < len(tags) and not tags[token_end].isspace():
                token_end += 1

        token = tags[start:token_end]
        base, wrapper = _unwrap_tag_token(token)
        if wrapper is None and base == target:
            return True

        index = token_end

    return False
