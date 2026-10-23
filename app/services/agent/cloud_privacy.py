"""Shared privacy boundary for note content sent to cloud inference providers."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import json
import hashlib
from typing import Callable

from app.services.note_store import NoteStore
from app.services.note_store import store as note_store
from app.services.search_index import search_index
from app.services.tag_case import build_preferred_tag_case_map
from app.services.search_query import ParsedSearchQuery, SearchClause
from app.services.search_query import format_search_query, format_search_term, parse_search_query
from app.services.tag_ontology import is_valid_tag_token
from app.services.content_formatting import extract_note_text_for_agent


CLOUD_PRIVACY_POLICY_PREFERENCE_KEY = "pref.ai.cloud_privacy_policy"
_CLOUD_PROVIDERS = frozenset({"openai"})
_SUPPORTED_PROVIDERS = frozenset({"openai"})
_MAX_POLICY_ENTRIES_PER_LIST = 200
_MAX_POLICY_TAG_LENGTH = 256
_MAX_POLICY_PHRASE_LENGTH = 500


@dataclass(frozen=True, slots=True)
class CloudPrivacyPolicy:
    whitelist_tags: tuple[str, ...]
    whitelist_phrases: tuple[str, ...]
    blacklist_tags: tuple[str, ...]
    blacklist_phrases: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CloudPrivacyBoundary:
    provider: str
    apply_cloud_policy: bool
    policy: CloudPrivacyPolicy


@dataclass(frozen=True, slots=True)
class _CloudPrivacyMatchPlan:
    apply_cloud_policy: bool
    whitelist_tags: frozenset[str]
    whitelist_phrases: tuple[str, ...]
    blacklist_tags: frozenset[str]
    blacklist_phrases: tuple[str, ...]
    has_whitelist: bool


EMPTY_CLOUD_PRIVACY_POLICY = CloudPrivacyPolicy(
    whitelist_tags=(),
    whitelist_phrases=(),
    blacklist_tags=(),
    blacklist_phrases=(),
)


def is_cloud_inference_provider(provider: str) -> bool:
    if not isinstance(provider, str) or provider == "":
        raise TypeError("provider must be a non-empty string")
    if provider not in _SUPPORTED_PROVIDERS:
        raise ValueError(f"Unsupported inference provider: {provider}")
    return provider in _CLOUD_PROVIDERS


def resolve_cloud_privacy_boundary(
    *,
    preferences: dict[str, str],
    provider: str,
) -> CloudPrivacyBoundary:
    if not isinstance(preferences, dict):
        raise TypeError("preferences must be a dict")
    # A user who never set a privacy policy has the empty one.
    policy = EMPTY_CLOUD_PRIVACY_POLICY
    if CLOUD_PRIVACY_POLICY_PREFERENCE_KEY in preferences:
        policy = parse_cloud_privacy_policy_preference(preferences[CLOUD_PRIVACY_POLICY_PREFERENCE_KEY])
    return CloudPrivacyBoundary(
        provider=provider,
        apply_cloud_policy=is_cloud_inference_provider(provider),
        policy=policy,
    )


def visible_tag_counts(boundary: CloudPrivacyBoundary) -> tuple[dict[str, str], Counter[str]]:
    """Display case and note count of each tag on notes the AI may see, by casefold."""
    note_ids = tuple(note_store.list_note_ids())
    hidden = cloud_privacy_evaluator.hidden_note_ids(note_ids=note_ids, boundary=boundary)
    exact_counts: Counter[str] = Counter()
    for note_id in note_ids:
        if note_id in hidden:
            continue
        for term in note_store.get_note(note_id).tag_terms:
            if is_valid_tag_token(term) and not term.startswith("@"):
                exact_counts[term] += 1
    display = build_preferred_tag_case_map(dict(exact_counts))
    counts: Counter[str] = Counter()
    for term, count in exact_counts.items():
        counts[term.casefold()] += count
    blacklisted = {tag.casefold() for tag in boundary.policy.blacklist_tags}
    assert not (counts.keys() & blacklisted) or not boundary.apply_cloud_policy, \
        "A note carrying a blacklisted tag is hidden, so its tags are never counted"
    return display, counts


# What the AI is shown in place of a search term it may not see.
PRIVATE_SEARCH_TERM = "[private]"


def disclosable_search_query(query: str, *, finds_visible_note: Callable[[str], bool]) -> str:
    """The search as the AI may be shown it. The AI sees a search term only if it can
    see at least one note the term picks out: for a term, a note its part of the
    search (its OR clause) finds; for an excluded term (-x), a note the exclusion
    removes, which is a note the clause finds with x required instead. Other terms
    become PRIVATE_SEARCH_TERM. One rule covers every way a note becomes private
    (tags, synonyms, implications, text rules, phrases), and a search that finds
    nothing is withheld like one that finds only private notes, so the AI cannot tell
    the two apart. `finds_visible_note(search)` says whether that search finds a
    note the AI may see. A search with nothing withheld is returned as typed."""
    if query.strip() == "":
        return query
    shown_clauses = [_disclosable_clause_terms(clause, finds_visible_note)
                     for clause in parse_search_query(query).clauses]
    if not any(clause_withheld for _, clause_withheld in shown_clauses):
        return query
    return " OR ".join(" ".join(shown_terms) for shown_terms, _ in shown_clauses)


def _disclosable_clause_terms(
    clause: SearchClause, finds_visible_note: Callable[[str], bool],
) -> tuple[list[str], bool]:
    """The clause's terms as the AI may be shown them, and whether any was withheld."""
    required_terms = [format_search_term(tag, is_phrase=False, is_excluded=False) for tag in sorted(clause.required_tags)]
    required_terms += [format_search_term(phrase, is_phrase=True, is_excluded=False) for phrase in clause.required_text]
    required_terms += [condition.format() for condition in clause.required_properties]
    shown: list[str] = []
    withheld = False
    # Every required term picks out the same notes: the ones the clause finds.
    if required_terms:
        if finds_visible_note(_clause_search(clause)):
            shown += required_terms
        else:
            shown.append(PRIVATE_SEARCH_TERM)
            withheld = True
    excluded_withheld = False
    for tag in sorted(clause.forbidden_tags):
        removed = SearchClause(required_tags=clause.required_tags | {tag},
                               forbidden_tags=clause.forbidden_tags - {tag},
                               required_text=clause.required_text, forbidden_text=clause.forbidden_text,
                               required_properties=clause.required_properties,
                               forbidden_properties=clause.forbidden_properties)
        if finds_visible_note(_clause_search(removed)):
            shown.append(format_search_term(tag, is_phrase=False, is_excluded=True))
        else:
            excluded_withheld = True
    for index, phrase in enumerate(clause.forbidden_text):
        removed = SearchClause(required_tags=clause.required_tags, forbidden_tags=clause.forbidden_tags,
                               required_text=clause.required_text + (phrase,),
                               forbidden_text=clause.forbidden_text[:index] + clause.forbidden_text[index + 1:],
                               required_properties=clause.required_properties,
                               forbidden_properties=clause.forbidden_properties)
        if finds_visible_note(_clause_search(removed)):
            shown.append(format_search_term(phrase, is_phrase=True, is_excluded=True))
        else:
            excluded_withheld = True
    for index, condition in enumerate(clause.forbidden_properties):
        removed = SearchClause(required_tags=clause.required_tags, forbidden_tags=clause.forbidden_tags,
                               required_text=clause.required_text, forbidden_text=clause.forbidden_text,
                               required_properties=clause.required_properties + (condition,),
                               forbidden_properties=clause.forbidden_properties[:index]
                               + clause.forbidden_properties[index + 1:])
        if finds_visible_note(_clause_search(removed)):
            shown.append(f"-{condition.format()}")
        else:
            excluded_withheld = True
    if excluded_withheld:
        shown.append(f"-{PRIVATE_SEARCH_TERM}")
    return shown, withheld or excluded_withheld


def _clause_search(clause: SearchClause) -> str:
    return format_search_query(ParsedSearchQuery(clauses=(clause,)))


def validate_cloud_privacy_policy_preference(value: str) -> str:
    policy = parse_cloud_privacy_policy_preference(value)
    canonical = serialize_cloud_privacy_policy(policy)
    if canonical != value:
        raise RuntimeError("Cloud privacy policy preference must use canonical JSON")
    return canonical


def parse_cloud_privacy_policy_preference(value: str) -> CloudPrivacyPolicy:
    if not isinstance(value, str):
        raise TypeError("Cloud privacy policy preference must be a string")
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise RuntimeError("Cloud privacy policy must decode to an object")
    expected_keys = {
        "blacklist_phrases",
        "blacklist_tags",
        "whitelist_phrases",
        "whitelist_tags",
    }
    if set(parsed) != expected_keys:
        raise RuntimeError("Cloud privacy policy has missing or unknown fields")
    return CloudPrivacyPolicy(
        whitelist_tags=_validate_policy_entries(
            parsed["whitelist_tags"],
            field_name="whitelist_tags",
            is_tag=True,
        ),
        whitelist_phrases=_validate_policy_entries(
            parsed["whitelist_phrases"],
            field_name="whitelist_phrases",
            is_tag=False,
        ),
        blacklist_tags=_validate_policy_entries(
            parsed["blacklist_tags"],
            field_name="blacklist_tags",
            is_tag=True,
        ),
        blacklist_phrases=_validate_policy_entries(
            parsed["blacklist_phrases"],
            field_name="blacklist_phrases",
            is_tag=False,
        ),
    )


def serialize_cloud_privacy_policy(policy: CloudPrivacyPolicy) -> str:
    if not isinstance(policy, CloudPrivacyPolicy):
        raise TypeError("policy must be CloudPrivacyPolicy")
    payload = {
        "blacklist_phrases": list(policy.blacklist_phrases),
        "blacklist_tags": list(policy.blacklist_tags),
        "whitelist_phrases": list(policy.whitelist_phrases),
        "whitelist_tags": list(policy.whitelist_tags),
    }
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def _validate_policy_entries(
    raw_entries: object,
    *,
    field_name: str,
    is_tag: bool,
) -> tuple[str, ...]:
    if not isinstance(raw_entries, list):
        raise RuntimeError(f"Cloud privacy {field_name} must be a list")
    if len(raw_entries) > _MAX_POLICY_ENTRIES_PER_LIST:
        raise RuntimeError(f"Cloud privacy {field_name} has too many entries")
    normalized: list[str] = []
    seen_casefold: set[str] = set()
    maximum_length = _MAX_POLICY_PHRASE_LENGTH
    if is_tag:
        maximum_length = _MAX_POLICY_TAG_LENGTH
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, str):
            raise RuntimeError(f"Cloud privacy {field_name} entries must be strings")
        entry = raw_entry.strip()
        if entry == "" or entry != raw_entry:
            raise RuntimeError(f"Cloud privacy {field_name} entries must be trimmed and non-empty")
        if len(entry) > maximum_length:
            raise RuntimeError(f"Cloud privacy {field_name} entry is too long")
        if is_tag and not is_valid_tag_token(entry):
            raise RuntimeError(f"Cloud privacy {field_name} contains an invalid tag")
        entry_casefold = entry.casefold()
        if entry_casefold in seen_casefold:
            raise RuntimeError(f"Cloud privacy {field_name} contains a duplicate entry")
        seen_casefold.add(entry_casefold)
        normalized.append(entry)
    return tuple(normalized)


class CloudPrivacyEvaluator:
    """Evaluate direct and ancestor-derived disclosure restrictions."""

    def __init__(
        self,
        *,
        notes: NoteStore,
        effective_tags_provider: Callable[[str], frozenset[str]],
        accepted_tags_provider: Callable[[str], frozenset[str]],
    ) -> None:
        self._notes = notes
        # Every tag search gives the note, proposals included: the blacklist and
        # credentials. A proposed private tag hides the note until it is rejected.
        self._effective_tags_provider = effective_tags_provider
        # The same without proposals: the whitelist, so the AI cannot propose its way in.
        self._accepted_tags_provider = accepted_tags_provider

    def history_disclosure_key(self, *, boundary: CloudPrivacyBoundary) -> str:
        note_ids = tuple(self._notes.list_note_ids())
        hidden_ids = self.hidden_note_ids(note_ids=note_ids, boundary=boundary)
        permitted_ids = sorted(set(note_ids) - hidden_ids)
        payload = (boundary.provider, serialize_cloud_privacy_policy(boundary.policy), permitted_ids)
        return hashlib.sha256(json.dumps(payload, separators=(",", ":")).encode()).hexdigest()

    def hidden_note_ids(
        self,
        *,
        note_ids: tuple[str, ...],
        boundary: CloudPrivacyBoundary,
    ) -> frozenset[str]:
        if not isinstance(note_ids, tuple):
            raise TypeError("note_ids must be a tuple")
        if not isinstance(boundary, CloudPrivacyBoundary):
            raise TypeError("boundary must be CloudPrivacyBoundary")
        direct_hidden_cache: dict[str, bool] = {}
        hierarchy_hidden_cache: dict[str, bool] = {}
        match_plan = self._match_plan(boundary)
        hidden: set[str] = set()
        for note_id in note_ids:
            if self._is_hidden_by_hierarchy(
                note_id=note_id,
                match_plan=match_plan,
                direct_hidden_cache=direct_hidden_cache,
                hierarchy_hidden_cache=hierarchy_hidden_cache,
            ):
                hidden.add(note_id)
        return frozenset(hidden)

    def has_visible_note(
        self,
        *,
        note_ids: tuple[str, ...],
        boundary: CloudPrivacyBoundary,
    ) -> bool:
        """Whether any of the notes may be shown to the AI; stops at the first one."""
        if not isinstance(note_ids, tuple):
            raise TypeError("note_ids must be a tuple")
        if not isinstance(boundary, CloudPrivacyBoundary):
            raise TypeError("boundary must be CloudPrivacyBoundary")
        direct_hidden_cache: dict[str, bool] = {}
        hierarchy_hidden_cache: dict[str, bool] = {}
        match_plan = self._match_plan(boundary)
        return any(
            not self._is_hidden_by_hierarchy(
                note_id=note_id,
                match_plan=match_plan,
                direct_hidden_cache=direct_hidden_cache,
                hierarchy_hidden_cache=hierarchy_hidden_cache,
            )
            for note_id in note_ids
        )

    def _is_hidden_by_hierarchy(
        self,
        *,
        note_id: str,
        match_plan: _CloudPrivacyMatchPlan,
        direct_hidden_cache: dict[str, bool],
        hierarchy_hidden_cache: dict[str, bool],
    ) -> bool:
        if note_id in hierarchy_hidden_cache:
            return hierarchy_hidden_cache[note_id]
        path: list[str] = []
        path_ids: set[str] = set()
        current_id = note_id
        ancestor_hidden = False
        while True:
            if current_id in hierarchy_hidden_cache:
                ancestor_hidden = hierarchy_hidden_cache[current_id]
                break
            if current_id in path_ids:
                raise RuntimeError(f"Hierarchy cycle detected at {current_id}")
            path_ids.add(current_id)
            path.append(current_id)
            record = self._notes.get_note(current_id)
            if record.parent_id is None:
                break
            current_id = record.parent_id
        for path_note_id in reversed(path):
            if path_note_id in direct_hidden_cache:
                direct_hidden = direct_hidden_cache[path_note_id]
            else:
                direct_hidden = self._is_directly_hidden(
                    note_id=path_note_id,
                    match_plan=match_plan,
                )
                direct_hidden_cache[path_note_id] = direct_hidden
            if direct_hidden:
                ancestor_hidden = True
            hierarchy_hidden_cache[path_note_id] = ancestor_hidden
        return hierarchy_hidden_cache[note_id]

    def _is_directly_hidden(
        self,
        *,
        note_id: str,
        match_plan: _CloudPrivacyMatchPlan,
    ) -> bool:
        return self._direct_exclusion_reason(note_id=note_id, match_plan=match_plan) != ""

    def exclusion_reason(self, *, note_id: str, boundary: CloudPrivacyBoundary) -> str:
        """Return a content-free reason, including restrictions on ancestors."""
        match_plan = self._match_plan(boundary)
        reasons = {self._direct_exclusion_reason(note_id=note_id, match_plan=match_plan)}
        reasons |= self._ancestor_exclusion_reasons(note_id=note_id, match_plan=match_plan)
        return _strongest_reason(reasons)

    def draft_exclusion_reason(
        self, *, note_id: str, draft_effective_tags: frozenset[str], draft_accepted_tags: frozenset[str],
        draft_content_html: str, boundary: CloudPrivacyBoundary,
    ) -> str:
        """exclusion_reason for a note being edited, judged on its unsaved tags and text."""
        if not isinstance(draft_effective_tags, frozenset):
            raise TypeError("draft_effective_tags must be a frozenset")
        if not isinstance(draft_accepted_tags, frozenset):
            raise TypeError("draft_accepted_tags must be a frozenset")
        if not isinstance(draft_content_html, str):
            raise TypeError("draft_content_html must be a string")
        match_plan = self._match_plan(boundary)
        reasons = {self._exclusion_reason_for(
            effective_tags=draft_effective_tags, accepted_tags=lambda: draft_accepted_tags,
            content_html=draft_content_html, match_plan=match_plan,
        )}
        reasons |= self._ancestor_exclusion_reasons(note_id=note_id, match_plan=match_plan)
        return _strongest_reason(reasons)

    def _ancestor_exclusion_reasons(self, *, note_id: str, match_plan: _CloudPrivacyMatchPlan) -> set[str]:
        reasons = set()
        seen = {note_id}
        parent_id = self._notes.get_note(note_id).parent_id
        while parent_id is not None:
            assert parent_id not in seen, "Hierarchy cycle in disclosure boundary"
            seen.add(parent_id)
            reasons.add(self._direct_exclusion_reason(note_id=parent_id, match_plan=match_plan))
            parent_id = self._notes.get_note(parent_id).parent_id
        return reasons

    def _direct_exclusion_reason(self, *, note_id: str, match_plan: _CloudPrivacyMatchPlan) -> str:
        return self._exclusion_reason_for(
            effective_tags=self._effective_tags_provider(note_id),
            accepted_tags=lambda: self._accepted_tags_provider(note_id),
            content_html=self._notes.get_note(note_id).content,
            match_plan=match_plan,
        )

    @staticmethod
    def _exclusion_reason_for(
        *, effective_tags: frozenset[str], accepted_tags: Callable[[], frozenset[str]], content_html: str,
        match_plan: _CloudPrivacyMatchPlan,
    ) -> str:
        effective_tags_casefold = {tag.casefold() for tag in effective_tags}
        # Credentials are private by default, whatever the policy says.
        if "@password" in effective_tags_casefold:
            return "password_protected"
        if "@username" in effective_tags_casefold:
            return "username_protected"
        if not match_plan.apply_cloud_policy:
            return ""
        if effective_tags_casefold & match_plan.blacklist_tags:
            return "blacklisted"
        needs_plaintext = any(
            (match_plan.blacklist_phrases, match_plan.whitelist_phrases)
        )
        plaintext_casefold = ""
        if needs_plaintext:
            # Phrases are matched against exactly the text the AI is sent: the visible
            # text plus link addresses a label hides and cached titles of linked pages.
            # The tags argument only decides credential redaction, handled above.
            sent_text, _ = extract_note_text_for_agent(content_html=content_html, tags="")
            plaintext_casefold = sent_text.casefold()
        if any(
            phrase in plaintext_casefold for phrase in match_plan.blacklist_phrases
        ):
            return "blacklisted"
        if not match_plan.has_whitelist:
            return ""
        if match_plan.whitelist_tags and {tag.casefold() for tag in accepted_tags()} & match_plan.whitelist_tags:
            return ""
        if any(
            phrase in plaintext_casefold for phrase in match_plan.whitelist_phrases
        ):
            return ""
        return "not_whitelisted"

    @staticmethod
    def _match_plan(boundary: CloudPrivacyBoundary) -> _CloudPrivacyMatchPlan:
        policy = boundary.policy
        return _CloudPrivacyMatchPlan(
            apply_cloud_policy=boundary.apply_cloud_policy,
            whitelist_tags=frozenset(
                tag.casefold() for tag in policy.whitelist_tags
            ),
            whitelist_phrases=tuple(
                phrase.casefold() for phrase in policy.whitelist_phrases
            ),
            blacklist_tags=frozenset(
                tag.casefold() for tag in policy.blacklist_tags
            ),
            blacklist_phrases=tuple(
                phrase.casefold() for phrase in policy.blacklist_phrases
            ),
            has_whitelist=any(
                (policy.whitelist_tags, policy.whitelist_phrases)
            ),
        )


def _strongest_reason(reasons: set[str]) -> str:
    for reason in ("password_protected", "username_protected", "blacklisted", "not_whitelisted"):
        if reason in reasons:
            return reason
    assert reasons <= {""}, f"Unknown exclusion reasons: {reasons}"
    return ""


cloud_privacy_evaluator = CloudPrivacyEvaluator(
    notes=note_store,
    effective_tags_provider=search_index.list_effective_tag_terms_for_note,
    accepted_tags_provider=note_store.accepted_effective_tag_terms,
)
