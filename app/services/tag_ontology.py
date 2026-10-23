from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Dict, FrozenSet, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from app.services.exception_capture import CapturedExceptionContext
from app.services.input_errors import InputRejected
from app.services.tag_properties import (
    PropertyCondition,
    PropertyValue,
    condition_holds,
    is_property_term,
    parse_property_term,
)

# An escape is a backslash and the character it escapes.
_ESCAPE_LENGTH = 2


@dataclass(frozen=True, slots=True)
class OntologyParseError(Exception):
    filename: str
    line: int
    column: int
    message: str
    source_line: str

    def __str__(self) -> str:  # pragma: no cover
        return (
            f"{self.filename}:{self.line}:{self.column}: {self.message}\n"
            f"{self.source_line}\n"
            f"{' ' * (self.column - 1)}^"
        )


@dataclass(frozen=True, slots=True)
class TagAtom:
    tag: str


@dataclass(frozen=True, slots=True)
class TextAtom:
    phrase: str


@dataclass(frozen=True, slots=True)
class RegexAtom:
    pattern: str
    flags: str


@dataclass(frozen=True, slots=True)
class PropertyAtom:
    """A super tag term on a rule's left side (docs/design/tag-properties.md):
    jogging:miles>10, task:due?, task:status=done. Every search form but MAX and MIN."""

    condition: PropertyCondition


Atom = TagAtom | TextAtom | RegexAtom | PropertyAtom


@dataclass(frozen=True, slots=True)
class Rule:
    lhs: Tuple[Atom, ...]
    rhs: str


@dataclass(frozen=True, slots=True)
class MatcherRule:
    required_tags: FrozenSet[str]
    required_text_phrases: Tuple[str, ...]
    required_text_patterns: Tuple[re.Pattern[str], ...]
    required_regexes: Tuple[re.Pattern[str], ...]
    rhs: str

    def satisfied(self, *, plaintext: str, tags: Set[str]) -> bool:
        for required in self.required_tags:
            if required not in tags:
                return False
        for pattern in self.required_text_patterns:
            if pattern.search(plaintext) is None:
                return False
        for compiled in self.required_regexes:
            if compiled.search(plaintext) is None:
                return False
        return True


@dataclass(frozen=True, slots=True)
class ValueRule:
    """A rule testing a note's super tag values. It is decided from the note itself:
    the tags its values infer are its own, so children and referencing notes inherit
    them like the tags written on it (note_store applies them while tags are inherited)."""

    conditions: Tuple[PropertyCondition, ...]
    # The rule's tag atoms: tags the note must carry (written, inherited or implied).
    required_tags: FrozenSet[str]
    required_text_patterns: Tuple[re.Pattern[str], ...]
    required_regexes: Tuple[re.Pattern[str], ...]
    rhs: str


def _compile_quoted_text_as_word_match(phrase: str) -> re.Pattern[str]:
    if not isinstance(phrase, str):
        raise TypeError(f"phrase must be a string, got {type(phrase)}")
    if phrase == "":
        raise ValueError("phrase must be non-empty")

    # "TODO" should not match "TODORS".
    # Use word boundaries by default.
    #
    # Case heuristics:
    # - all-lowercase phrase => case-insensitive match
    # - otherwise => case-sensitive match
    #
    # (This keeps "Todo" distinct from "TODO" by default, but allows "todo" to match any case.)
    flags = 0
    if phrase == phrase.lower():
        flags |= re.IGNORECASE

    escaped = re.escape(phrase)
    return re.compile(rf"\b{escaped}\b", flags)


_DISALLOWED_TAG_CHARS = set(':"\\><=[]{}()*|;~`')


def _is_valid_tag_token(token: str) -> bool:
    if not token:
        return False
    if token == "OR":
        return False
    if any(ch.isspace() for ch in token):
        return False
    if token[0] in ("-", "+", "/"):
        return False
    if token[0] in ("\"", "'"):
        return False
    if token[0] in ("(", ")"):
        return False
    for ch in token:
        if ch in _DISALLOWED_TAG_CHARS:
            return False
    return True


def is_valid_tag_token(token: str) -> bool:
    """Public validator for ontology tag tokens.

    This matches the "plain token" constraints used by the client-side tag/search syntax.
    """

    if not isinstance(token, str):
        raise TypeError(f"token must be a string, got {type(token)}")
    return _is_valid_tag_token(token)


def parse_rules_text(*, text: str, filename: str) -> List[Rule]:
    if not isinstance(text, str):
        raise TypeError(f"text must be a string, got {type(text)}")
    if not isinstance(filename, str) or not filename:
        raise TypeError("filename must be a non-empty string")

    rules: List[Rule] = []
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        stripped = raw_line.lstrip()
        if stripped == "":
            continue
        if stripped.startswith("#") or stripped.startswith("//"):
            continue
        rules.extend(
            _parse_rule_line(raw_line=raw_line, filename=filename, line_number=line_number)
        )
    return rules


def _parse_rule_line(*, raw_line: str, filename: str, line_number: int) -> List[Rule]:
    line = raw_line.rstrip("\n")
    index = 0

    def error(message: str, *, at: int) -> OntologyParseError:
        column = max(1, at + 1)
        return OntologyParseError(
            filename=filename,
            line=line_number,
            column=column,
            message=message,
            source_line=line,
        )

    def skip_spaces(i: int) -> int:
        while i < len(line) and line[i].isspace():
            i += 1
        return i

    index = skip_spaces(index)
    if index >= len(line):
        return []

    lhs_atoms: Tuple[Atom, ...]
    if line[index] == "(":
        index += 1
        atoms: List[Atom] = []
        while True:
            index = skip_spaces(index)
            if index >= len(line):
                raise error("Unclosed '(' in LHS", at=len(line) - 1)
            if line[index] == ")":
                if not atoms:
                    raise error("Empty LHS group '()' is not allowed", at=index)
                index += 1
                break
            if line[index] == "(":
                raise error("Nested parentheses are not allowed in v1", at=index)
            atom, index = _parse_atom(line, index, filename=filename, line_number=line_number)
            atoms.append(atom)
        lhs_atoms = tuple(atoms)
    else:
        atom, index = _parse_atom(line, index, filename=filename, line_number=line_number)
        lhs_atoms = (atom,)

    index = skip_spaces(index)
    op: Optional[str] = None
    if line.startswith("=>", index):
        op = "=>"
        index += len(op)
    elif index < len(line) and line[index] == "=":
        op = "="
        index += 1
    else:
        raise error("Expected '=>' or '=' operator", at=index)

    index = skip_spaces(index)
    if index >= len(line):
        raise error("Missing RHS tag", at=len(line) - 1)

    rhs_token, index = _read_bare_token(line, index)
    if not _is_valid_tag_token(rhs_token):
        raise error(f"Invalid RHS tag token: {rhs_token!r}", at=index - len(rhs_token))

    index = skip_spaces(index)
    if index != len(line):
        raise error("Unexpected trailing text (no inline comments in v1)", at=index)

    if op == "=>":
        return [Rule(lhs=lhs_atoms, rhs=rhs_token)]

    if op != "=":
        raise error(f"Unknown operator: {op!r}", at=index)

    if len(lhs_atoms) != 1 or not isinstance(lhs_atoms[0], TagAtom):
        raise error("'=' is only allowed between tag atoms in v1", at=0)

    lhs_tag = lhs_atoms[0].tag
    return [
        Rule(lhs=(TagAtom(lhs_tag),), rhs=rhs_token),
        Rule(lhs=(TagAtom(rhs_token),), rhs=lhs_tag),
    ]


def _parse_atom(
    line: str,
    index: int,
    *,
    filename: str,
    line_number: int,
) -> tuple[Atom, int]:
    if index >= len(line):
        raise OntologyParseError(
            filename=filename,
            line=line_number,
            column=max(1, index + 1),
            message="Expected atom, got end of line",
            source_line=line,
        )

    ch = line[index]
    if ch in ("\"", "'"):
        phrase, next_index = _read_quoted_phrase(
            line=line,
            index=index,
            filename=filename,
            line_number=line_number,
        )
        if phrase == "":
            raise OntologyParseError(
                filename=filename,
                line=line_number,
                column=index + 1,
                message="Empty quoted phrase is not allowed",
                source_line=line,
            )
        return TextAtom(phrase=phrase), next_index

    if ch == "/":
        pattern, flags, next_index = _read_regex_literal(
            line=line,
            index=index,
            filename=filename,
            line_number=line_number,
        )
        return RegexAtom(pattern=pattern, flags=flags), next_index

    token, next_index = _read_bare_token(line, index)
    if is_property_term(token):
        return _parse_property_atom(token, line=line, index=index, filename=filename, line_number=line_number), next_index
    if token in ("=>", "="):
        raise OntologyParseError(
            filename=filename,
            line=line_number,
            column=index + 1,
            message="Expected atom, got operator",
            source_line=line,
        )
    if not _is_valid_tag_token(token):
        raise OntologyParseError(
            filename=filename,
            line=line_number,
            column=index + 1,
            message=f"Invalid tag token: {token!r}",
            source_line=line,
        )
    return TagAtom(tag=token), next_index


def _parse_property_atom(token: str, *, line: str, index: int, filename: str, line_number: int) -> PropertyAtom:
    def error(message: str) -> OntologyParseError:
        return OntologyParseError(
            filename=filename, line=line_number, column=index + 1, message=message, source_line=line,
        )

    capture = CapturedExceptionContext(InputRejected, boundary='app/services/tag_ontology.py:_parse_property_atom:capture')
    condition: PropertyCondition | None = None
    with capture:
        condition = parse_property_term(token)
    if capture.captured_exception is not None:
        raise error(str(capture.captured_exception)) from capture.captured_exception
    assert condition is not None
    if condition.is_extreme:
        raise error(f"{condition.value_text} is for searches: a rule decides from one note, not among notes")
    return PropertyAtom(condition=condition)


def _read_bare_token(line: str, index: int) -> tuple[str, int]:
    start = index
    while index < len(line):
        ch = line[index]
        if ch.isspace() or ch == ")":
            break
        index += 1
    return line[start:index], index


def _read_quoted_phrase(*, line: str, index: int, filename: str, line_number: int) -> tuple[str, int]:
    quote = line[index]
    start_index = index
    index += 1
    out = ""
    while index < len(line):
        ch = line[index]
        if ch == quote:
            return out, index + 1
        if ch == "\\":
            if index + 1 >= len(line):
                out += "\\"
                index += 1
                continue
            nxt = line[index + 1]
            if nxt == quote or nxt == "\\":
                out += nxt
                index += _ESCAPE_LENGTH
                continue
            out += "\\"
            index += 1
            continue
        out += ch
        index += 1

    raise OntologyParseError(
        filename=filename,
        line=line_number,
        column=start_index + 1,
        message=f"Unclosed quote {quote!r}",
        source_line=line,
    )


def _read_regex_literal(*, line: str, index: int, filename: str, line_number: int) -> tuple[str, str, int]:
    assert line[index] == "/"
    start_index = index
    index += 1
    pattern = ""
    while index < len(line):
        ch = line[index]
        if ch == "/":
            index += 1
            break
        if ch == "\\":
            if index + 1 < len(line):
                nxt = line[index + 1]
                if nxt == "/":
                    pattern += "/"
                    index += _ESCAPE_LENGTH
                    continue
                pattern += f"\\{nxt}"
                index += _ESCAPE_LENGTH
                continue
            pattern += "\\"
            index += 1
            continue
        pattern += ch
        index += 1
    else:
        raise OntologyParseError(
            filename=filename,
            line=line_number,
            column=start_index + 1,
            message="Unclosed regex literal",
            source_line=line,
        )

    flags_start_index = index
    flags = ""
    while index < len(line):
        ch = line[index]
        if ch.isspace() or ch == ")":
            break
        flags += ch
        index += 1

    for offset, flag in enumerate(flags):
        if flag != "i":
            raise OntologyParseError(
                filename=filename,
                line=line_number,
                column=flags_start_index + offset + 1,
                message=f"Unsupported regex flag: {flag}",
                source_line=line,
            )
    return pattern, flags, index


def _compile_regex(pattern: str, flags: str) -> re.Pattern[str]:
    re_flags = 0
    if "i" in flags:
        re_flags |= re.IGNORECASE
    return re.compile(pattern, re_flags)


@dataclass(frozen=True, slots=True)
class TagOntology:
    implication_out_edges: Mapping[str, FrozenSet[str]]
    implication_closure: Mapping[str, FrozenSet[str]]
    implied_by_closure: Mapping[str, FrozenSet[str]]
    scc_members_by_tag: Mapping[str, FrozenSet[str]]
    matcher_rules: Tuple[MatcherRule, ...]
    value_rules: Tuple[ValueRule, ...]
    # For super tag terms: each tag (casefolded) and the tags implying it, casefolded.
    implying_casefold: Mapping[str, FrozenSet[str]]

    @staticmethod
    def empty() -> TagOntology:
        return TagOntology(
            implication_out_edges={},
            implication_closure={},
            implied_by_closure={},
            scc_members_by_tag={},
            matcher_rules=(),
            value_rules=(),
            implying_casefold={},
        )

    @property
    def is_empty(self) -> bool:
        if self.matcher_rules or self.value_rules:
            return False
        for edges in self.implication_out_edges.values():
            if edges:
                return False
        return True

    def focus_view(self, *, tag: str) -> tuple[FrozenSet[str], FrozenSet[str], FrozenSet[str]]:
        """Return (left, equal, right) for a focus tag.

        - left: all tags that (transitively) imply `tag`, excluding equals
        - equal: SCC members (equivalence class), including `tag`
        - right: all tags transitively implied by `tag`, excluding equals
        """
        if not isinstance(tag, str) or not tag:
            raise TypeError("tag must be a non-empty string")

        # The three maps hold every tag a rule names; any other tag stands alone.
        if tag not in self.scc_members_by_tag:
            return frozenset(), frozenset({tag}), frozenset()
        equals = self.scc_members_by_tag[tag]
        left = self.implied_by_closure[tag]
        right = self.implication_closure[tag]
        return (
            frozenset(t for t in left if t not in equals),
            equals,
            frozenset(t for t in right if t not in equals),
        )

    def infer_effective_tags(self, *, base_tags: FrozenSet[str], plaintext: str) -> FrozenSet[str]:
        if self.is_empty:
            return base_tags

        tags: Set[str] = set(base_tags)

        pending: List[str] = list(tags)
        while pending:
            current = pending.pop()
            implied = self.implication_closure.get(current)
            if not implied:
                continue
            for implied_tag in implied:
                if implied_tag in tags:
                    continue
                tags.add(implied_tag)
                pending.append(implied_tag)

        while True:
            before = len(tags)

            for rule in self.matcher_rules:
                if rule.rhs in tags:
                    continue
                if rule.satisfied(plaintext=plaintext, tags=tags):
                    tags.add(rule.rhs)
                    pending.append(rule.rhs)

            while pending:
                current = pending.pop()
                implied = self.implication_closure.get(current)
                if not implied:
                    continue
                for implied_tag in implied:
                    if implied_tag in tags:
                        continue
                    tags.add(implied_tag)
                    pending.append(implied_tag)

            if len(tags) == before:
                break

        return frozenset(tags)

    def infer_value_tags(
        self, *, values: Mapping[Tuple[str, str], PropertyValue], own_tag_names: FrozenSet[str],
        base_tags: FrozenSet[str], plaintext: str,
    ) -> FrozenSet[str]:
        """The tags a note's super tag values infer (ValueRule), with the tags they imply.
        values and own_tag_names: the note's own, from its tag bar; base_tags: the tags it
        carries (written and inherited), which a rule's tag atoms read with what they imply;
        a rule's text atoms read the note's plaintext. Rules can feed each other."""
        inferred: Set[str] = set()
        if not self.value_rules:
            return frozenset()
        tags = set(self.infer_implication_only(base_tags=base_tags))
        changed = True
        while changed:
            changed = False
            for rule in self.value_rules:
                if rule.rhs in tags:
                    continue
                if not self._value_rule_holds(rule, values=values, own_tag_names=own_tag_names, tags=tags,
                                              plaintext=plaintext):
                    continue
                added = self.infer_implication_only(base_tags=frozenset({rule.rhs}))
                inferred.update(added)
                tags.update(added)
                changed = True
        return frozenset(inferred)

    def _value_rule_holds(
        self, rule: ValueRule, *, values: Mapping[Tuple[str, str], PropertyValue], own_tag_names: FrozenSet[str],
        tags: Set[str], plaintext: str,
    ) -> bool:
        if not rule.required_tags <= tags:
            return False
        for condition in rule.conditions:
            tag_names = self.implying_casefold.get(condition.key[0], frozenset()) | {condition.key[0]}
            if not condition_holds(condition, values=values, own_tag_names=own_tag_names, tag_names=tag_names):
                return False
        if any(pattern.search(plaintext) is None for pattern in rule.required_text_patterns):
            return False
        return all(compiled.search(plaintext) is not None for compiled in rule.required_regexes)

    @property
    def value_rules_read_text(self) -> bool:
        return any(rule.required_text_patterns or rule.required_regexes for rule in self.value_rules)

    def infer_implication_only(self, *, base_tags: FrozenSet[str]) -> FrozenSet[str]:
        if self.is_empty:
            return base_tags

        tags: Set[str] = set(base_tags)
        for tag in base_tags:
            implied = self.implication_closure.get(tag)
            if implied:
                tags.update(implied)
        return frozenset(tags)


def _compile_value_rule(rule: Rule) -> ValueRule:
    conditions: List[PropertyCondition] = []
    required_tags: Set[str] = set()
    text_patterns: List[re.Pattern[str]] = []
    regexes: List[re.Pattern[str]] = []
    for atom in rule.lhs:
        if isinstance(atom, PropertyAtom):
            conditions.append(atom.condition)
        elif isinstance(atom, TagAtom):
            required_tags.add(atom.tag)
        elif isinstance(atom, TextAtom):
            text_patterns.append(_compile_quoted_text_as_word_match(atom.phrase))
        elif isinstance(atom, RegexAtom):
            regexes.append(_compile_regex(atom.pattern, atom.flags))
        else:
            raise TypeError(f"Unknown atom type: {type(atom)}")
    return ValueRule(
        conditions=tuple(conditions), required_tags=frozenset(required_tags),
        required_text_patterns=tuple(text_patterns), required_regexes=tuple(regexes), rhs=rule.rhs,
    )


def rule_text_tests_values(text: str) -> bool:
    """Whether rule text holds a super tag term (its rules change notes' own tags)."""
    return any(
        isinstance(atom, PropertyAtom)
        for rule in parse_rules_text(text=f"{text}\n", filename="ontology_rules:check")
        for atom in rule.lhs
    )


def _add_tag_node(out_edges: Dict[str, Set[str]], tag: str) -> None:
    """Every tag a rule names is a node of the implication graph, with or without edges."""
    if tag not in out_edges:
        out_edges[tag] = set()


def compile_rules(*, rules: Sequence[Rule], filename: str) -> TagOntology:
    if not rules:
        return TagOntology.empty()

    out_edges: Dict[str, Set[str]] = {}
    matcher_rules: List[MatcherRule] = []
    value_rules: List[ValueRule] = []

    for rule in rules:
        if len(rule.lhs) == 1 and isinstance(rule.lhs[0], TagAtom):
            src = rule.lhs[0].tag
            _add_tag_node(out_edges, src)
            _add_tag_node(out_edges, rule.rhs)
            out_edges[src].add(rule.rhs)
            continue
        if any(isinstance(atom, PropertyAtom) for atom in rule.lhs):
            value_rules.append(_compile_value_rule(rule))
            _add_tag_node(out_edges, rule.rhs)
            continue

        required_tags: Set[str] = set()
        required_text_phrases: List[str] = []
        required_text_patterns: List[re.Pattern[str]] = []
        required_regexes: List[re.Pattern[str]] = []

        for atom in rule.lhs:
            if isinstance(atom, TagAtom):
                required_tags.add(atom.tag)
                continue
            if isinstance(atom, TextAtom):
                required_text_phrases.append(atom.phrase)
                required_text_patterns.append(_compile_quoted_text_as_word_match(atom.phrase))
                continue
            if isinstance(atom, RegexAtom):
                required_regexes.append(_compile_regex(atom.pattern, atom.flags))
                continue
            raise TypeError(f"Unknown atom type: {type(atom)}")

        matcher_rules.append(
            MatcherRule(
                required_tags=frozenset(required_tags),
                required_text_phrases=tuple(required_text_phrases),
                required_text_patterns=tuple(required_text_patterns),
                required_regexes=tuple(required_regexes),
                rhs=rule.rhs,
            )
        )
        _add_tag_node(out_edges, rule.rhs)

    frozen_out: Dict[str, FrozenSet[str]] = {
        key: frozenset(value) for key, value in out_edges.items()
    }

    closure, scc_members_by_tag = _compute_implication_closure_and_scc_members(frozen_out)
    implied_by = _compute_implied_by_closure(closure)
    implying_casefold: Dict[str, Set[str]] = {}
    for tag, implying in implied_by.items():
        if tag.casefold() not in implying_casefold:
            implying_casefold[tag.casefold()] = set()
        implying_casefold[tag.casefold()].update(other.casefold() for other in implying)
    return TagOntology(
        value_rules=tuple(value_rules),
        implying_casefold={tag: frozenset(implying) for tag, implying in implying_casefold.items()},
        implication_out_edges=frozen_out,
        implication_closure=closure,
        implied_by_closure=implied_by,
        scc_members_by_tag=scc_members_by_tag,
        matcher_rules=tuple(matcher_rules),
    )


def _compute_implied_by_closure(
    closure: Mapping[str, FrozenSet[str]],
) -> Mapping[str, FrozenSet[str]]:
    output: Dict[str, Set[str]] = {tag: set() for tag in closure.keys()}
    for src, implied in closure.items():
        for dst in implied:
            # The closure holds every node, implied ones included.
            output[dst].add(src)
    return {tag: frozenset(value) for tag, value in output.items()}


def _compute_implication_closure_and_scc_members(
    out_edges: Mapping[str, FrozenSet[str]],
) -> tuple[Mapping[str, FrozenSet[str]], Mapping[str, FrozenSet[str]]]:
    nodes: Set[str] = set(out_edges.keys())
    for children in out_edges.values():
        nodes.update(children)

    # compile_rules makes every implied tag a node, so every node has its edges.
    forward: Dict[str, List[str]] = {node: list(out_edges[node]) for node in nodes}
    reverse: Dict[str, List[str]] = {node: [] for node in nodes}
    for src, children in forward.items():
        for dst in children:
            reverse[dst].append(src)

    order: List[str] = []
    visited: Set[str] = set()
    for node in nodes:
        if node in visited:
            continue
        stack: List[tuple[str, int]] = [(node, 0)]
        visited.add(node)
        while stack:
            current, child_index = stack[-1]
            children = forward[current]
            if child_index < len(children):
                nxt = children[child_index]
                stack[-1] = (current, child_index + 1)
                if nxt in visited:
                    continue
                visited.add(nxt)
                stack.append((nxt, 0))
                continue
            stack.pop()
            order.append(current)

    component_by_node: Dict[str, int] = {}
    components: List[List[str]] = []

    for node in reversed(order):
        if node in component_by_node:
            continue
        comp_index = len(components)
        members: List[str] = []
        queue = [node]
        component_by_node[node] = comp_index
        while queue:
            current = queue.pop()
            members.append(current)
            for parent in reverse[current]:
                if parent in component_by_node:
                    continue
                component_by_node[parent] = comp_index
                queue.append(parent)
        components.append(members)

    comp_out: Dict[int, Set[int]] = {i: set() for i in range(len(components))}
    for src, children in forward.items():
        src_comp = component_by_node[src]
        for dst in children:
            dst_comp = component_by_node[dst]
            if dst_comp == src_comp:
                continue
            comp_out[src_comp].add(dst_comp)

    reachable_comps_memo: Dict[int, FrozenSet[int]] = {}

    def reach(comp_id: int) -> FrozenSet[int]:
        if comp_id in reachable_comps_memo:
            return reachable_comps_memo[comp_id]

        reached: Set[int] = set()
        stack = list(comp_out[comp_id])
        while stack:
            nxt = stack.pop()
            if nxt in reached:
                continue
            reached.add(nxt)
            stack.extend(comp_out[nxt])
        frozen = frozenset(reached)
        reachable_comps_memo[comp_id] = frozen
        return frozen

    tags_in_comp: Dict[int, FrozenSet[str]] = {
        comp_id: frozenset(members) for comp_id, members in enumerate(components)
    }

    scc_members_by_tag: Dict[str, FrozenSet[str]] = {
        tag: tags_in_comp[component_by_node[tag]] for tag in nodes
    }

    closure: Dict[str, FrozenSet[str]] = {}
    for node in nodes:
        comp_id = component_by_node[node]
        implied: Set[str] = set(tags_in_comp[comp_id])
        implied.discard(node)
        for reachable_comp_id in reach(comp_id):
            implied.update(tags_in_comp[reachable_comp_id])
        closure[node] = frozenset(implied)

    return closure, scc_members_by_tag
