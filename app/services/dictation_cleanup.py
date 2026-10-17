"""Turn dictated text pasted into the search bar or the tag bar into tags.

Speech-to-text tools such as Superwhisper paste sentences ("Neural network,
neural network. Neural-Dash Network.") where the user meant tags
(`neural-network`). This module applies fixed rules, no AI; the behavior is
described case by case in docs/ui/dictation-paste.md:

- sentence punctuation is dropped; spoken joiners ("dash", "hyphen",
  "underscore", "slash", including Superwhisper's "foo-Dash bar") join words;
- the quote phrases ("quote … end quote" by default) or quote marks mark a phrase;
- the longest run of words matching an existing tag becomes that tag, matched
  ignoring case and treating space - _ . / alike, spelled as used most often;
  words also match a tag written as one word ("to do" -> `todo`), joiners first;
- "at" (or a typed @) before words naming a built-in meta tag is that meta tag
  ("at to do" -> `@todo`); otherwise "at" is filler;
- filler words are dropped unless they are tags; repeats and tags already in
  the field are not added again;
- search: unknown words are dropped, "or" becomes OR and the exclusion phrase
  ("minus" by default) excludes the next term; tag bar: unknown words become new tags;
- one-tag fields (`tag`): the whole paste is one tag, existing or new;
- incoming-rule conditions (`condition`): existing tags and quoted text only.
Quoting (quote phrases or quote marks) applies to search and conditions only.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import re

from app.config import TAG_SUGGESTION_CONNECTORS


FILLER_WORDS = frozenset({"a", "an", "and", "at", "the", "tag", "tags", "comma", "period", "um", "uh"})
# The built-in meta tags (KNOWN_META_TAGS in tag-syntax-service.js; a unit test
# keeps the two lists equal).
KNOWN_META_TAGS = (
    "@footnote", "@monospace", "@heading", "@red", "@green", "@blue", "@grey",
    "@highlighter", "@bold", "@italic", "@strikethrough", "@serif", "@copyable",
    "@list-bulleted", "@list-numbered", "@username", "@password", "@email",
    "@todo", "@done", "@markdown", "@llm", "@latex", "@shell", "@json", "@csv", "@chess", "@diff", "@mermaid",
)
_META_AT_WORDS = frozenset({"at", "@"})
# Meta tag names are at most this many words when spoken ("list bulleted").
_MAX_META_WORDS = 3
_PHRASE_SETTING_MIN_CHARS = 2
_PHRASE_SETTING_MAX_CHARS = 64
# A word of at least this many letters, all capitals, keeps its case as an acronym.
_ACRONYM_MIN_LETTERS = 2
_SEARCH_OR_WORDS = frozenset({"or"})
_SPOKEN_JOINERS = {"dash": "-", "hyphen": "-", "underscore": "_", "slash": "/"}
_SENTENCE_PUNCTUATION = ",.?!;:"
_TAG_DISALLOWED = frozenset(':,"\\><=[]{}()*|;~`')
_TAG_START_DISALLOWED = frozenset("-+/")

# "foo-Dash bar", "foo - Dash bar", "foo dash bar": a spoken joiner between two
# words, with or without the symbol Superwhisper also types before it.
_SPOKEN_JOINER_RE = re.compile(
    r"(?<=\S)\s*[-_/]?\s*(?<![A-Za-z0-9])(" + "|".join(_SPOKEN_JOINERS) + r")(?![A-Za-z0-9])[\s,.]*(?=\S)",
    re.IGNORECASE,
)
# Typographic quote marks and minus signs, as dictation tools may type them.
# Superwhisper types "minus" as an em dash stuck to the words around it
# ('Interesting—"fat"'), so an em dash is a minus standing on its own.
_TYPOGRAPHIC = str.maketrans({"“": '"', "”": '"', "„": '"', "−": "-", "–": "-", "—": " - "})
# A phrase setting (quote phrases, Dictation Settings): words of letters.
_PHRASE_SETTING_RE = re.compile(r"[A-Za-z]+(?: [A-Za-z]+)*")
_EQUIVALENCE_SEPARATOR_RE = re.compile(f"[{re.escape(TAG_SUGGESTION_CONNECTORS)}\\s]+")
_NOT_LETTER_OR_DIGIT_RE = re.compile(r"[^0-9a-z]+")


@dataclass(frozen=True)
class _TagIndex:
    """Existing tags by equivalence key, and by their letters and digits only."""
    by_key: dict[str, str]
    by_compact_key: dict[str, str]


@dataclass(frozen=True)
class _Word:
    text: str


@dataclass(frozen=True)
class _Phrase:
    text: str


@dataclass(frozen=True)
class _Syntax:
    """Search syntax the user pasted as is (-tag, +tag, OR)."""
    text: str


def clean_dictated_paste(
    *,
    text: str,
    target: str,
    existing_tag_frequencies: Mapping[str, int],
    current_value: str,
    quote_open: str,
    quote_close: str,
    negate_phrase: str,
) -> str:
    """The text to insert for a paste into the search bar (`search`) or tag bar (`tags`).

    `quote_open` / `quote_close` are the spoken phrases around a quoted phrase
    ("quote" / "end quote" by default) and `negate_phrase` excludes the next search
    term ("minus" by default), all set in Dictation Settings."""
    _require_phrase_settings(quote_open, quote_close, negate_phrase)
    negate_words = tuple(negate_phrase.casefold().split(" "))
    if target not in {"search", "tags", "tag", "condition"}:
        raise ValueError(f"Unknown dictation paste target: {target!r}")
    if not isinstance(text, str) or not isinstance(current_value, str):
        raise TypeError("text and current_value must be strings")
    tag_index = _TagIndex(
        by_key=_most_used_spelling(existing_tag_frequencies, _equivalence_key),
        by_compact_key=_most_used_spelling(existing_tag_frequencies, _compact_key),
    )
    items = _items(text, target=target, quoted_re=_quoted_re(quote_open, quote_close),
                   open_re=re.compile(_spoken_pattern(quote_open), re.IGNORECASE),
                   close_re=re.compile(_spoken_pattern(quote_close), re.IGNORECASE))
    if target == "search":
        return _search_text(items, tag_index=tag_index, current_value=current_value, operators=True,
                            negate_words=negate_words)
    if target == "condition":
        return _search_text(items, tag_index=tag_index, current_value=current_value, operators=False,
                            negate_words=negate_words)
    if target == "tag":
        return _single_tag_text(items, tag_index=tag_index)
    return _tag_bar_text(items, tag_index=tag_index, current_value=current_value, negate_words=negate_words)


def _equivalence_key(text: str) -> str:
    return _EQUIVALENCE_SEPARATOR_RE.sub(" ", text.casefold()).strip()


def _compact_key(text: str) -> str:
    """Letters and digits only: "to do", "to-do" and "todo" are all "todo"."""
    return _NOT_LETTER_OR_DIGIT_RE.sub("", text.casefold())


_META_TAGS_BY_COMPACT_KEY = {_compact_key(tag): tag for tag in KNOWN_META_TAGS}
assert len(_META_TAGS_BY_COMPACT_KEY) == len(KNOWN_META_TAGS)


def _most_used_spelling(existing_tag_frequencies: Mapping[str, int], key_of) -> dict[str, str]:
    """Key -> the existing spelling used most often."""
    best: dict[str, tuple[str, int]] = {}
    for tag, frequency in existing_tag_frequencies.items():
        if not isinstance(tag, str) or tag == "":
            raise TypeError("existing tag names must be non-empty strings")
        if not isinstance(frequency, int) or frequency < 0:
            raise TypeError("existing tag frequencies must be non-negative integers")
        key = key_of(tag)
        if key == "":
            continue
        if key not in best:
            best[key] = (tag, frequency)
            continue
        kept_tag, kept_frequency = best[key]
        if (-frequency, tag.casefold(), tag) < (-kept_frequency, kept_tag.casefold(), kept_tag):
            best[key] = (tag, frequency)
    return {key: tag for key, (tag, _frequency) in best.items()}


def _join_spoken_joiners(text: str) -> str:
    return _SPOKEN_JOINER_RE.sub(lambda match: _SPOKEN_JOINERS[match.group(1).casefold()], text)


def _require_phrase_settings(*phrases: str) -> None:
    for phrase in phrases:
        if (
            not isinstance(phrase, str)
            or not _PHRASE_SETTING_MIN_CHARS <= len(phrase) <= _PHRASE_SETTING_MAX_CHARS
            or _PHRASE_SETTING_RE.fullmatch(phrase) is None
        ):
            raise ValueError(
                "Dictation phrases must be words of letters, "
                f"{_PHRASE_SETTING_MIN_CHARS} to {_PHRASE_SETTING_MAX_CHARS} characters: {phrase!r}"
            )
    if len({phrase.casefold() for phrase in phrases}) != len(phrases):
        raise ValueError("The dictation phrases must differ from each other")


def _phrase_length_at(items: list, start: int, words: tuple[str, ...]) -> int:
    """How many items the spoken phrase `words` takes from `start`; 0 when it is not there."""
    end = start + len(words)
    if end > len(items) or not all(isinstance(item, _Word) for item in items[start:end]):
        return 0
    if tuple(item.text.casefold() for item in items[start:end]) != words:
        return 0
    return len(words)


def _quoted_re(quote_open: str, quote_close: str) -> re.Pattern[str]:
    """A quoted phrase: quote marks, or the spoken open phrase … close phrase (to
    the end of the text when it is never closed)."""
    return re.compile(
        r'"(?P<marked>[^"]*)"|' + _spoken_pattern(quote_open) + r"[\s,.:;]*(?P<spoken>.*?)[\s,.]*(?:" + _spoken_pattern(quote_close) + r"|$)",
        re.IGNORECASE | re.DOTALL,
    )


def _spoken_pattern(phrase: str) -> str:
    """A spoken phrase's words as whole words, with spaces or punctuation between them."""
    return r"(?<![A-Za-z])" + r"[\s,.:;]+".join(re.escape(word) for word in phrase.split(" ")) + r"(?![A-Za-z])"


def _without_unopened_close_phrases(text: str, open_re: re.Pattern[str], close_re: re.Pattern[str]) -> str:
    """Drop close phrases that come before any open phrase ("python end quote"; the
    "quote" in "end quote" must not start a quote)."""
    while True:
        close = close_re.search(text)
        if close is None:
            return text
        opening = open_re.search(text)
        if opening is not None and opening.start() < close.start():
            return text
        text = text[:close.start()] + " " + text[close.end():]


def _items(text: str, *, target: str, quoted_re: re.Pattern[str], open_re: re.Pattern[str],
           close_re: re.Pattern[str]) -> list[_Word | _Phrase | _Syntax]:
    """Words, quoted phrases and pasted search syntax, in order."""
    text = _without_unopened_close_phrases(_join_spoken_joiners(text.translate(_TYPOGRAPHIC)), open_re, close_re)
    items: list[_Word | _Phrase | _Syntax] = []
    position = 0
    for match in quoted_re.finditer(text):
        items.extend(_words(close_re.sub(" ", text[position:match.start()]), target=target))
        phrase = match.group("marked")
        if phrase is None:
            phrase = match.group("spoken")
        # Dictation tools may type quote marks as well as the spoken quote
        # phrases ('quote "Fat. end quote'): inside a phrase they are dropped.
        phrase = " ".join(phrase.replace('"', " ").strip(_SENTENCE_PUNCTUATION + " ").split())
        # Tags cannot hold quoted text: there the quote phrases only drop out.
        if target in {"search", "condition"} and phrase:
            items.append(_Phrase(phrase))
        else:
            items.extend(_words(phrase, target=target))
        position = match.end()
    # A close phrase left over (Superwhisper typed the quote marks itself) is dropped.
    items.extend(_words(close_re.sub(" ", text[position:]), target=target))
    return items


def _words(chunk: str, *, target: str) -> list[_Word | _Syntax]:
    words: list[_Word | _Syntax] = []
    # "@green@bold": meta tags typed together are separate words.
    for token in (part for raw in chunk.split() for part in re.split(r"(?<=\S)(?=@)", raw)):
        if target == "search" and (token == "OR" or (len(token) > 1 and token[0] in "-+" and token[1].isalnum())):
            words.append(_Syntax(token.rstrip(_SENTENCE_PUNCTUATION)))
            continue
        word = token.strip(_SENTENCE_PUNCTUATION)
        # A lone minus (the spoken exclusion typed as a symbol) is never part of
        # a tag: in search it excludes the next term, elsewhere it is dropped.
        if word == "-":
            if target == "search":
                words.append(_Syntax("-"))
            continue
        if word:
            words.append(_Word(word))
    return words


def _word_run_end(items: list, start: int) -> int:
    end = start
    while end < len(items) and isinstance(items[end], _Word):
        end += 1
    return end


def _match_at(items: list, start: int, tag_index: _TagIndex) -> tuple[str, int] | None:
    """The existing tag spelled by the longest run of words from `start`, and its
    length; at each length, a match keeping the joiners wins over one without."""
    for end in range(_word_run_end(items, start), start, -1):
        spoken = " ".join(item.text for item in items[start:end])
        key = _equivalence_key(spoken)
        if key in tag_index.by_key:
            return tag_index.by_key[key], end - start
        compact = _compact_key(spoken)
        if compact in tag_index.by_compact_key:
            return tag_index.by_compact_key[compact], end - start
    return None


def _meta_name_at(items: list, start: int) -> tuple[str, int] | None:
    """A built-in meta tag named by the words from `start` without a leading "at"."""
    run_end = min(_word_run_end(items, start), start + _MAX_META_WORDS)
    for end in range(run_end, start, -1):
        compact = _compact_key("".join(item.text for item in items[start:end]))
        if compact in _META_TAGS_BY_COMPACT_KEY:
            return _META_TAGS_BY_COMPACT_KEY[compact], end - start
    return None


def _tag_match_at(items: list, start: int, tag_index: _TagIndex, in_meta_run: bool) -> tuple[str, int, bool] | None:
    """(tag, words used, whether it is a meta tag) for the words from `start`.

    Superwhisper drops a repeated "at" ("at green at bold" arrives as "At green,
    bold."), so right after a meta tag a word naming another meta tag continues
    the run, even when the user also has a plain tag of that name (often a typo
    for the meta tag)."""
    meta = _meta_tag_at(items, start)
    if meta is not None:
        return meta[0], meta[1], True
    if in_meta_run:
        continued = _meta_name_at(items, start)
        if continued is not None:
            return continued[0], continued[1], True
    user_tag = _match_at(items, start, tag_index)
    if user_tag is not None:
        return user_tag[0], user_tag[1], False
    return None


def _meta_tag_at(items: list, start: int) -> tuple[str, int] | None:
    """"at to do" / "@ to do" / "@todo" -> ("@todo", words used); None otherwise."""
    word = items[start].text
    if word.casefold() in _META_AT_WORDS:
        first, named_from = [], start + 1
    elif word.startswith("@") and len(word) > 1:
        first, named_from = [word[1:]], start + 1
    else:
        return None
    run_end = min(_word_run_end(items, named_from), named_from + _MAX_META_WORDS)
    for end in range(run_end, named_from - 1, -1):
        compact = _compact_key("".join(first + [item.text for item in items[named_from:end]]))
        if compact in _META_TAGS_BY_COMPACT_KEY:
            return _META_TAGS_BY_COMPACT_KEY[compact], end - start
    return None


def _new_tag(text: str) -> str:
    """A new tag from dictated words: joined with dashes, lowercased unless an acronym."""
    words = []
    for word in text.split():
        letters = [char for char in word if char.isalpha()]
        if len(letters) >= _ACRONYM_MIN_LETTERS and all(char.isupper() for char in letters):
            words.append(word)
        else:
            words.append(word.lower())
    candidate = "".join(
        char for char in "-".join(words) if 0x20 < ord(char) <= 0x7E and char not in _TAG_DISALLOWED
    )
    candidate = candidate.lstrip("".join(_TAG_START_DISALLOWED))
    if candidate == "OR":
        return ""
    return candidate


def _quoted_search_text(phrase: str) -> str:
    return '"' + phrase.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _search_text(items: list, *, tag_index: _TagIndex, current_value: str, operators: bool,
                 negate_words: tuple[str, ...]) -> str:
    """A search (with OR and exclusion when `operators`) or an incoming-rule condition."""
    # Elements: a term, "OR", "NOT" (exclude the next term) or "DROP" (an
    # unknown word, which also cancels a pending NOT).
    elements: list[str] = []
    index = 0
    in_meta_run = False
    while index < len(items):
        item = items[index]
        if isinstance(item, _Syntax) and item.text == "-":
            in_meta_run = False
            elements.append("NOT")
            index += 1
            continue
        if isinstance(item, _Syntax):
            in_meta_run = False
            elements.append(item.text)
            index += 1
            continue
        if isinstance(item, _Phrase):
            in_meta_run = False
            elements.append(_quoted_search_text(item.text))
            index += 1
            continue
        match = _tag_match_at(items, index, tag_index, in_meta_run)
        if match is not None:
            tag, words_used, in_meta_run = match
            elements.append(tag)
            index += words_used
            continue
        in_meta_run = False
        negate_length = _phrase_length_at(items, index, negate_words)
        if negate_length:
            # Conditions cannot exclude: there the phrase is only dropped.
            if operators:
                elements.append("NOT")
            index += negate_length
            continue
        word = item.text.casefold()
        if operators and word in _SEARCH_OR_WORDS:
            elements.append("OR")
        elif word not in FILLER_WORDS and word not in _SEARCH_OR_WORDS:
            elements.append("DROP")
        index += 1
    present = {term.casefold() for term in current_value.split()}
    clauses: list[list[str]] = [[]]
    pending_not = False
    for element in elements:
        if element == "OR":
            pending_not = False
            clauses.append([])
            continue
        if element == "NOT":
            pending_not = True
            continue
        if element == "DROP":
            pending_not = False
            continue
        term = element
        if pending_not:
            term = "-" + element
            pending_not = False
        if term.casefold() in present:
            continue
        present.add(term.casefold())
        clauses[-1].append(term)
    return " OR ".join(" ".join(clause) for clause in clauses if clause)


def _tag_bar_text(items: list, *, tag_index: _TagIndex, current_value: str, negate_words: tuple[str, ...]) -> str:
    tags: list[str] = []
    present = {_equivalence_key(tag) for tag in current_value.split()}
    index = 0
    in_meta_run = False
    while index < len(items):
        item = items[index]
        if isinstance(item, _Phrase):
            in_meta_run = False
            tag = _new_tag(item.text)
            if _equivalence_key(item.text) in tag_index.by_key:
                tag = tag_index.by_key[_equivalence_key(item.text)]
            elif _compact_key(item.text) in tag_index.by_compact_key:
                tag = tag_index.by_compact_key[_compact_key(item.text)]
            index += 1
        else:
            match = _tag_match_at(items, index, tag_index, in_meta_run)
            in_meta_run = False
            if match is not None:
                tag, words_used, in_meta_run = match
                index += words_used
            elif _phrase_length_at(items, index, negate_words):
                # Tags cannot exclude: the exclusion phrase is only dropped.
                index += _phrase_length_at(items, index, negate_words)
                continue
            else:
                index += 1
                word = item.text.casefold()
                if word in FILLER_WORDS or word in _SEARCH_OR_WORDS:
                    continue
                tag = _new_tag(item.text)
        if tag == "" or _equivalence_key(tag) in present:
            continue
        present.add(_equivalence_key(tag))
        tags.append(tag)
    return " ".join(tags)


def _single_tag_text(items: list, *, tag_index: _TagIndex) -> str:
    """One tag from the whole paste: a meta tag, an existing tag, or a new one."""
    words = [item for item in items if isinstance(item, _Word)]
    if not words:
        return ""
    meta = _meta_tag_at(words, 0)
    if meta is not None and meta[1] == len(words):
        return meta[0]
    kept = [word for word in words
            if word.text.casefold() not in FILLER_WORDS or _match_at([word], 0, tag_index) is not None]
    if not kept:
        return ""
    match = _match_at([_Word(" ".join(word.text for word in kept))], 0, tag_index)
    if match is not None:
        return match[0]
    return _new_tag(" ".join(word.text for word in kept))
