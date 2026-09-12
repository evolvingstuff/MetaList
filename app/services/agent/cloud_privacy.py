"""Shared privacy boundary for note content sent to cloud inference providers."""

from __future__ import annotations

from dataclasses import dataclass
import json
import hashlib
from typing import Callable

from app.services.note_store import NoteStore
from app.services.note_store import store as note_store
from app.services.search_index import search_index
from app.services.tag_ontology import is_valid_tag_token
from app.utils.text_utils import strip_html


CLOUD_PRIVACY_POLICY_PREFERENCE_KEY = "pref.ai.cloud_privacy_policy"
_CLOUD_PROVIDERS = frozenset({"openai"})
_SUPPORTED_PROVIDERS = frozenset({"ollama", "openai"})
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
    raw_policy = preferences.get(CLOUD_PRIVACY_POLICY_PREFERENCE_KEY)
    policy = EMPTY_CLOUD_PRIVACY_POLICY
    if raw_policy is not None:
        policy = parse_cloud_privacy_policy_preference(raw_policy)
    return CloudPrivacyBoundary(
        provider=provider,
        apply_cloud_policy=is_cloud_inference_provider(provider),
        policy=policy,
    )


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
    ) -> None:
        self._notes = notes
        self._effective_tags_provider = effective_tags_provider

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
        record = self._notes.get_note(note_id)
        effective_tags_casefold = {
            tag.casefold() for tag in self._effective_tags_provider(note_id)
        }
        if "@password" in effective_tags_casefold:
            return True
        if not match_plan.apply_cloud_policy:
            return False
        if effective_tags_casefold & match_plan.blacklist_tags:
            return True
        needs_plaintext = any(
            (match_plan.blacklist_phrases, match_plan.whitelist_phrases)
        )
        plaintext_casefold = ""
        if needs_plaintext:
            plaintext_casefold = strip_html(record.content).strip().casefold()
        if any(
            phrase in plaintext_casefold for phrase in match_plan.blacklist_phrases
        ):
            return True
        if not match_plan.has_whitelist:
            return False
        if effective_tags_casefold & match_plan.whitelist_tags:
            return False
        return not any(
            phrase in plaintext_casefold for phrase in match_plan.whitelist_phrases
        )

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


cloud_privacy_evaluator = CloudPrivacyEvaluator(
    notes=note_store,
    effective_tags_provider=search_index.list_effective_tag_terms_for_note,
)
