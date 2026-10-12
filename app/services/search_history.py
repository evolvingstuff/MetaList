from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from threading import RLock

from app.db.search_history_sql import (
    delete_all_search_history_rows,
    delete_search_history_rows,
    fetch_all_search_history_rows,
    upsert_search_history_row,
)
from app.db.session import begin_writer
from app.security.encryption import (
    get_encryption_service,
    get_encryption_service_with_token,
    is_encryption_required,
)
from app.services.search_history_storage import (
    MAX_TAG_ACTIVITY_RETENTION_DAYS,
    coerce_search_history_encryption_service,
    decode_search_history_payload,
    deserialize_search_history_payload,
    encode_search_history_payload,
    new_search_history_storage_id,
    serialize_search_history_payload,
)
from app.services.search_index import extract_tags_for_search, search_index
from app.services.search_query import parse_search_query


DEFAULT_TAG_ACTIVITY_WINDOWS = (1, 7, 30)
SUPPORTED_NOTE_INTERACTION_TYPES = frozenset(
    {"edit", "expand", "command", "fullscreen", "move", "indent", "outdent"}
)


def _tag_activity_case_sort_key(tag_name: str) -> tuple[str, int, str]:
    lowercase_penalty = 1
    if tag_name == tag_name.casefold():
        lowercase_penalty = 0
    return tag_name.casefold(), lowercase_penalty, tag_name


@dataclass(frozen=True, slots=True)
class TagActivityState:
    storage_id: str
    counts_by_date: dict[str, dict[str, int]]


@dataclass(frozen=True, slots=True)
class TagActivityWindowSelection:
    tag: str
    window_days: int
    # The tag's activity credits in that window (why it won the slot).
    activity_count: int


def current_local_date() -> date:
    return datetime.now().astimezone().date()


def validate_tag_activity_windows(window_days: tuple[int, ...]) -> None:
    if not isinstance(window_days, tuple):
        raise TypeError("window_days must be a tuple")
    seen: set[int] = set()
    for day_count in window_days:
        if not isinstance(day_count, int) or isinstance(day_count, bool):
            raise TypeError("tag activity windows must contain integers")
        if day_count < 1 or day_count > MAX_TAG_ACTIVITY_RETENTION_DAYS:
            raise ValueError(
                "tag activity windows must be between 1 and "
                f"{MAX_TAG_ACTIVITY_RETENTION_DAYS} days"
            )
        if day_count in seen:
            raise ValueError("tag activity windows cannot contain duplicates")
        seen.add(day_count)


def _validate_counts_by_date_for_ranking(
    counts_by_date: dict[str, dict[str, int]],
) -> None:
    if not isinstance(counts_by_date, dict):
        raise TypeError("counts_by_date must be a dict")
    for day_text, tag_counts in counts_by_date.items():
        if not isinstance(day_text, str):
            raise TypeError("counts_by_date keys must be strings")
        date.fromisoformat(day_text)
        if not isinstance(tag_counts, dict):
            raise TypeError("daily tag counts must be dicts")
        for tag_name, count in tag_counts.items():
            if not isinstance(tag_name, str) or tag_name == "":
                raise TypeError("daily tag names must be non-empty strings")
            if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
                raise TypeError("daily tag counts must be positive integers")


def rank_tag_activity_window_selections(
    *,
    counts_by_date: dict[str, dict[str, int]],
    candidate_tags: list[str],
    window_days: tuple[int, ...],
    today: date,
) -> list[TagActivityWindowSelection]:
    _validate_counts_by_date_for_ranking(counts_by_date)
    if not isinstance(candidate_tags, list):
        raise TypeError("candidate_tags must be a list")
    if not isinstance(today, date):
        raise TypeError("today must be a date")
    validate_tag_activity_windows(window_days)

    candidate_by_casefold: dict[str, str] = {}
    candidate_order: dict[str, int] = {}
    for index, candidate in enumerate(candidate_tags):
        if not isinstance(candidate, str) or candidate == "":
            raise TypeError("candidate_tags must contain non-empty strings")
        candidate_casefold = candidate.casefold()
        if candidate_casefold in candidate_by_casefold:
            raise ValueError("candidate_tags cannot contain case-insensitive duplicates")
        candidate_by_casefold[candidate_casefold] = candidate
        candidate_order[candidate_casefold] = index

    parsed_counts: list[tuple[date, dict[str, int]]] = []
    for day_text, tag_counts in counts_by_date.items():
        parsed_counts.append((date.fromisoformat(day_text), tag_counts))

    selections: list[TagActivityWindowSelection] = []
    selected_casefold: set[str] = set()
    for day_count in window_days:
        earliest_day = today - timedelta(days=day_count - 1)
        totals_by_casefold: dict[str, int] = {}
        for activity_day, tag_counts in parsed_counts:
            if activity_day < earliest_day or activity_day > today:
                continue
            for tag_name, count in tag_counts.items():
                tag_casefold = tag_name.casefold()
                if tag_casefold not in candidate_by_casefold:
                    continue
                if tag_casefold in selected_casefold:
                    continue
                if tag_casefold not in totals_by_casefold:
                    totals_by_casefold[tag_casefold] = 0
                totals_by_casefold[tag_casefold] += count
        if not totals_by_casefold:
            continue
        winner_casefold = min(
            totals_by_casefold,
            key=lambda tag_casefold: (
                -totals_by_casefold[tag_casefold],
                candidate_order[tag_casefold],
            ),
        )
        selected_casefold.add(winner_casefold)
        selections.append(
            TagActivityWindowSelection(
                tag=candidate_by_casefold[winner_casefold],
                window_days=day_count,
                activity_count=totals_by_casefold[winner_casefold],
            )
        )
    return selections


def rank_tag_activity_windows(
    *,
    counts_by_date: dict[str, dict[str, int]],
    candidate_tags: list[str],
    window_days: tuple[int, ...],
    today: date,
) -> list[str]:
    return [
        selection.tag
        for selection in rank_tag_activity_window_selections(
            counts_by_date=counts_by_date,
            candidate_tags=candidate_tags,
            window_days=window_days,
            today=today,
        )
    ]


def _copy_counts_by_date(
    counts_by_date: dict[str, dict[str, int]],
) -> dict[str, dict[str, int]]:
    return {
        day_text: dict(tag_counts)
        for day_text, tag_counts in counts_by_date.items()
    }


def _prune_counts_by_date(
    *, counts_by_date: dict[str, dict[str, int]], today: date
) -> dict[str, dict[str, int]]:
    if not isinstance(today, date):
        raise TypeError("today must be a date")
    eligible_days: list[tuple[date, str]] = []
    for day_text, tag_counts in counts_by_date.items():
        activity_day = date.fromisoformat(day_text)
        if not tag_counts:
            raise RuntimeError("stored tag activity day cannot be empty")
        eligible_days.append((activity_day, day_text))
    eligible_days.sort(reverse=True)
    retained: dict[str, dict[str, int]] = {}
    for _activity_day, day_text in eligible_days[:MAX_TAG_ACTIVITY_RETENTION_DAYS]:
        retained[day_text] = dict(counts_by_date[day_text])
    return retained


def _increment_daily_tag_groups(
    *,
    counts_by_date: dict[str, dict[str, int]],
    interacted_on: date,
    tag_groups: tuple[tuple[str, ...], ...],
) -> dict[str, dict[str, int]]:
    """Credit each group's distinct tags once, in order, on one day.

    Pruning is idempotent for a fixed day and a tag keeps the spelling it was
    first counted under, so one pass equals one call per group.
    """
    updated = _prune_counts_by_date(counts_by_date=counts_by_date, today=interacted_on)
    day_text = interacted_on.isoformat()
    if day_text in updated:
        daily_counts = updated[day_text]
    else:
        daily_counts = {}
        updated[day_text] = daily_counts

    existing_key_by_casefold = {
        tag_name.casefold(): tag_name for tag_name in daily_counts
    }
    for tags in tag_groups:
        unique_tags_by_casefold: dict[str, str] = {}
        for tag_name in tags:
            if not isinstance(tag_name, str) or tag_name == "":
                raise TypeError("interaction tags must be non-empty strings")
            tag_casefold = tag_name.casefold()
            if tag_casefold not in unique_tags_by_casefold:
                unique_tags_by_casefold[tag_casefold] = tag_name

        for tag_casefold, tag_name in unique_tags_by_casefold.items():
            if tag_casefold in existing_key_by_casefold:
                stored_name = existing_key_by_casefold[tag_casefold]
            else:
                stored_name = tag_name
                existing_key_by_casefold[tag_casefold] = stored_name
            if stored_name not in daily_counts:
                daily_counts[stored_name] = 0
            daily_counts[stored_name] += 1
    return _prune_counts_by_date(counts_by_date=updated, today=interacted_on)


class SearchHistoryStore:
    def __init__(self) -> None:
        self._lock = RLock()
        self._stored_row: dict[str, object] | None = None
        self._state: TagActivityState | None = None
        self._is_decrypted = True

    def bootstrap(self, *, connection) -> None:
        rows = fetch_all_search_history_rows(connection)
        if len(rows) > 1:
            raise RuntimeError("tag activity history must contain at most one encrypted row")
        stored_row = None
        state = None
        is_decrypted = True
        if rows:
            stored_row = rows[0]
            state = _deserialize_state(
                row=stored_row,
                encryption_service=_resolve_encryption_service(""),
                require_success=False,
            )
            is_decrypted = state is not None
        with self._lock:
            self._stored_row = stored_row
            self._state = state
            self._is_decrypted = is_decrypted

    def ensure_decrypted(self, *, token: str) -> None:
        if not isinstance(token, str):
            raise TypeError("token must be a string")
        with self._lock:
            if self._is_decrypted:
                return
            if self._stored_row is None:
                raise RuntimeError("encrypted tag activity state is missing its stored row")
            state = _deserialize_state(
                row=self._stored_row,
                encryption_service=_resolve_encryption_service(token),
                require_success=True,
            )
            if state is None:
                raise RuntimeError("tag activity decryption did not produce state")
            self._state = state
            self._is_decrypted = True

    def reset(self) -> None:
        with self._lock:
            self._stored_row = None
            self._state = None
            self._is_decrypted = True

    def clear_persisted_state_for_tests(self) -> None:
        with begin_writer() as connection:
            delete_all_search_history_rows(connection)
        self.reset()

    def record_interaction(
        self,
        *,
        tags: tuple[str, ...],
        token: str,
        interacted_on: date,
    ) -> bool:
        if not isinstance(tags, tuple):
            raise TypeError("tags must be a tuple")
        return self.record_interactions(tag_groups=(tags,), token=token, interacted_on=interacted_on)

    def record_interactions(
        self,
        *,
        tag_groups: tuple[tuple[str, ...], ...],
        token: str,
        interacted_on: date,
    ) -> bool:
        """Apply several interactions in order and persist once.

        Equivalent to one record_interaction per group; bulk operations use it
        so the aggregate is not re-serialized, re-encrypted, and rewritten per note.
        """
        if not isinstance(tag_groups, tuple) or not all(isinstance(tags, tuple) for tags in tag_groups):
            raise TypeError("tag_groups must be a tuple of tuples")
        tag_groups = tuple(tags for tags in tag_groups if tags)
        if not tag_groups:
            return False
        if not isinstance(interacted_on, date):
            raise TypeError("interacted_on must be a date")
        encryption_service = _resolve_encryption_service(token)
        if encryption_service is None and is_encryption_required():
            raise RuntimeError("Tag activity interaction requires an active DEK")

        with self._lock:
            self.ensure_decrypted(token=token)
            counts_by_date: dict[str, dict[str, int]] = {}
            storage_id = new_search_history_storage_id()
            if self._state is not None:
                counts_by_date = self._state.counts_by_date
                storage_id = self._state.storage_id
            updated_counts = _increment_daily_tag_groups(
                counts_by_date=counts_by_date,
                interacted_on=interacted_on,
                tag_groups=tag_groups,
            )
            state = TagActivityState(
                storage_id=storage_id,
                counts_by_date=updated_counts,
            )
            row = _serialize_state(
                state=state,
                encryption_service=encryption_service,
            )
            with begin_writer() as connection:
                _upsert_stored_row(connection=connection, row=row)
            self._state = state
            self._stored_row = row
            self._is_decrypted = True
        return True

    def list_recent_tags(
        self,
        *,
        candidate_tags: list[str],
        window_days: tuple[int, ...],
        token: str,
        today: date,
    ) -> list[str]:
        return [
            selection.tag
            for selection in self.list_recent_tag_selections(
                candidate_tags=candidate_tags,
                window_days=window_days,
                token=token,
                today=today,
            )
        ]

    def list_recent_tag_selections(
        self,
        *,
        candidate_tags: list[str],
        window_days: tuple[int, ...],
        token: str,
        today: date,
    ) -> list[TagActivityWindowSelection]:
        with self._lock:
            self.ensure_decrypted(token=token)
            counts_by_date: dict[str, dict[str, int]] = {}
            if self._state is not None:
                counts_by_date = _copy_counts_by_date(self._state.counts_by_date)
        return rank_tag_activity_window_selections(
            counts_by_date=counts_by_date,
            candidate_tags=candidate_tags,
            window_days=window_days,
            today=today,
        )

    def copy_daily_counts(self, *, token: str) -> dict[str, dict[str, int]]:
        with self._lock:
            self.ensure_decrypted(token=token)
            if self._state is None:
                return {}
            return _copy_counts_by_date(self._state.counts_by_date)

    def reset_history(self, *, token: str) -> int:
        with self._lock:
            self.ensure_decrypted(token=token)
            deleted_count = 0
            if self._stored_row is not None:
                deleted_count = 1
            with begin_writer() as connection:
                delete_all_search_history_rows(connection)
            self._stored_row = None
            self._state = None
            self._is_decrypted = True
        return deleted_count

    def rewrite_persisted_entries(
        self,
        *,
        connection,
        encryption_service: object,
        force_plaintext: bool,
    ) -> int:
        service = _coerce_encryption_service(encryption_service)
        if service is None:
            raise RuntimeError("Tag activity encryption rewrite requires an active DEK")
        with self._lock:
            if self._stored_row is None:
                return 0
            if self._state is None:
                state = _deserialize_state(
                    row=self._stored_row,
                    encryption_service=service,
                    require_success=True,
                )
                if state is None:
                    raise RuntimeError("tag activity rewrite could not decrypt state")
            else:
                state = self._state
            if force_plaintext and _row_is_plaintext(self._stored_row):
                return 0
            if not force_plaintext and _row_is_encrypted(self._stored_row):
                return 0

            target_service = service
            rewritten_state = state
            old_storage_id = state.storage_id
            if force_plaintext:
                target_service = None
            else:
                rewritten_state = TagActivityState(
                    storage_id=new_search_history_storage_id(),
                    counts_by_date=state.counts_by_date,
                )
            row = _serialize_state(
                state=rewritten_state,
                encryption_service=target_service,
            )
            _upsert_stored_row(connection=connection, row=row)
            if rewritten_state.storage_id != old_storage_id:
                delete_search_history_rows(connection, [old_storage_id])
            self._stored_row = row
            self._state = rewritten_state
            self._is_decrypted = True
        return 1


def record_note_interaction(
    *, note_id: str, interaction_type: str, token: str, interacted_on: date
) -> bool:
    if not isinstance(note_id, str) or note_id == "":
        raise TypeError("note_id must be a non-empty string")
    if interaction_type not in SUPPORTED_NOTE_INTERACTION_TYPES:
        raise ValueError(f"Unsupported interaction_type: {interaction_type}")
    if not isinstance(token, str) or token == "":
        raise ValueError("token must be a non-empty string")
    tags = tuple(sorted(search_index.list_raw_tag_terms_for_note(note_id)))
    return search_history_store.record_interaction(
        tags=tags,
        token=token,
        interacted_on=interacted_on,
    )


def _explicit_tag_additions(*, before_tags: str, after_tags: str) -> tuple[str, ...]:
    before_casefold = {
        tag_name.casefold() for tag_name in extract_tags_for_search(before_tags)
    }
    added_by_casefold: dict[str, str] = {}
    after_terms = sorted(
        extract_tags_for_search(after_tags),
        key=_tag_activity_case_sort_key,
    )
    for tag_name in after_terms:
        tag_casefold = tag_name.casefold()
        if tag_casefold in before_casefold or tag_casefold in added_by_casefold:
            continue
        added_by_casefold[tag_casefold] = tag_name
    return tuple(added_by_casefold.values())


def record_explicit_tag_addition_batch(
    *,
    tag_changes: tuple[tuple[str, str], ...],
    token: str,
    interacted_on: date,
) -> bool:
    """Credit newly added explicit tags for many (before, after) tag strings at once."""
    if not isinstance(token, str) or token == "":
        raise ValueError("token must be a non-empty string")
    if not isinstance(interacted_on, date):
        raise TypeError("interacted_on must be a date")
    groups = []
    for before_tags, after_tags in tag_changes:
        if not isinstance(before_tags, str) or not isinstance(after_tags, str):
            raise TypeError("tag changes must be (before, after) strings")
        groups.append(_explicit_tag_additions(before_tags=before_tags, after_tags=after_tags))
    return search_history_store.record_interactions(
        tag_groups=tuple(groups), token=token, interacted_on=interacted_on,
    )


def record_explicit_tag_additions(
    *,
    before_tags: str,
    after_tags: str,
    token: str,
    interacted_on: date,
) -> bool:
    if not isinstance(before_tags, str):
        raise TypeError("before_tags must be a string")
    if not isinstance(after_tags, str):
        raise TypeError("after_tags must be a string")
    if not isinstance(token, str) or token == "":
        raise ValueError("token must be a non-empty string")
    if not isinstance(interacted_on, date):
        raise TypeError("interacted_on must be a date")

    return search_history_store.record_interaction(
        tags=_explicit_tag_additions(before_tags=before_tags, after_tags=after_tags),
        token=token,
        interacted_on=interacted_on,
    )


def _resolve_known_tag_term(tag_name: str) -> str | None:
    if not isinstance(tag_name, str) or tag_name == "":
        raise TypeError("tag_name must be a non-empty string")
    exact_casefold_matches = [
        candidate
        for candidate in search_index.list_tag_suggestion_terms()
        if candidate.casefold() == tag_name.casefold()
    ]
    if not exact_casefold_matches:
        return None
    return min(exact_casefold_matches, key=_tag_activity_case_sort_key)


def record_search_suggestion_selection(
    *, tag: str, token: str, interacted_on: date
) -> bool:
    if not isinstance(tag, str) or tag == "":
        raise TypeError("tag must be a non-empty string")
    if not isinstance(token, str) or token == "":
        raise ValueError("token must be a non-empty string")
    if not isinstance(interacted_on, date):
        raise TypeError("interacted_on must be a date")
    resolved_tag = _resolve_known_tag_term(tag)
    if resolved_tag is None:
        raise ValueError(f"Selected search suggestion is not a known tag: {tag}")
    return search_history_store.record_interaction(
        tags=(resolved_tag,),
        token=token,
        interacted_on=interacted_on,
    )


def record_tab_search_selection(
    *, search_query: str, token: str, interacted_on: date
) -> bool:
    if not isinstance(search_query, str):
        raise TypeError("search_query must be a string")
    if not isinstance(token, str) or token == "":
        raise ValueError("token must be a non-empty string")
    if not isinstance(interacted_on, date):
        raise TypeError("interacted_on must be a date")

    parsed_query = parse_search_query(search_query)
    requested_tags = {
        tag_name
        for clause in parsed_query.clauses
        for tag_name in clause.required_tags
    }
    resolved_by_casefold: dict[str, str] = {}
    for tag_name in sorted(requested_tags, key=_tag_activity_case_sort_key):
        resolved_tag = _resolve_known_tag_term(tag_name)
        if resolved_tag is None:
            continue
        resolved_by_casefold[resolved_tag.casefold()] = resolved_tag
    return search_history_store.record_interaction(
        tags=tuple(resolved_by_casefold.values()),
        token=token,
        interacted_on=interacted_on,
    )


def list_recent_search_tags_for_first_query(
    *,
    query: str,
    candidate_tags: list[str],
    window_days: tuple[int, ...],
    token: str,
    today: date,
) -> list[str]:
    if not isinstance(query, str):
        raise TypeError("query must be a string")
    prefix = _extract_first_search_tag_prefix(query)
    if prefix is None:
        return []
    return search_history_store.list_recent_tags(
        candidate_tags=candidate_tags,
        window_days=window_days,
        token=token,
        today=today,
    )


def list_recent_search_tag_selections_for_first_query(
    *,
    query: str,
    candidate_tags: list[str],
    window_days: tuple[int, ...],
    token: str,
    today: date,
) -> list[TagActivityWindowSelection]:
    if not isinstance(query, str):
        raise TypeError("query must be a string")
    prefix = _extract_first_search_tag_prefix(query)
    if prefix is None:
        return []
    return search_history_store.list_recent_tag_selections(
        candidate_tags=candidate_tags,
        window_days=window_days,
        token=token,
        today=today,
    )


def reset_search_history(*, token: str) -> int:
    if not isinstance(token, str) or token == "":
        raise ValueError("token must be a non-empty string")
    return search_history_store.reset_history(token=token)


def list_search_suggestion_statistics(*, token: str) -> dict[str, object]:
    if not isinstance(token, str) or token == "":
        raise ValueError("token must be a non-empty string")
    counts_by_date = search_history_store.copy_daily_counts(token=token)
    days: list[dict[str, object]] = []
    for day_text in sorted(counts_by_date, reverse=True):
        tag_counts = counts_by_date[day_text]
        tags = [
            {"tag": tag_name, "count": count}
            for tag_name, count in sorted(
                tag_counts.items(),
                key=lambda tag_count_pair: (
                    -tag_count_pair[1],
                    tag_count_pair[0].casefold(),
                    tag_count_pair[0],
                ),
            )
        ]
        days.append(
            {
                "date": day_text,
                "totalTagCredits": sum(tag_counts.values()),
                "tags": tags,
            }
        )
    return {
        "retentionPopulatedDayLimit": MAX_TAG_ACTIVITY_RETENTION_DAYS,
        "days": days,
    }


def is_first_search_tag_suggestion_context(query: str) -> bool:
    return _extract_first_search_tag_prefix(query) is not None


def prioritize_first_search_tag_suggestions(
    *,
    query: str,
    base_suggestions: list[str],
    recent_tags: list[str],
    priority_slots: int,
) -> list[str]:
    if _extract_first_search_tag_prefix(query) is None:
        return _merge_prioritized_search_suggestions(
            base_suggestions=base_suggestions,
            priority_tags=[],
            priority_slots=priority_slots,
        )
    return _merge_prioritized_search_suggestions(
        base_suggestions=base_suggestions,
        priority_tags=recent_tags,
        priority_slots=priority_slots,
    )


def _extract_first_search_tag_prefix(query: str) -> str | None:
    if not isinstance(query, str):
        raise TypeError(f"query must be a string, got {type(query)}")
    if query.strip() == "":
        return ""
    text = query.lstrip()
    if text[-1].isspace() or any(char.isspace() for char in text):
        return None
    if text[0] in ("+", "-"):
        text = text[1:]
        if text == "":
            return None
    if text[0] in ('"', "'"):
        return None
    return text


def _merge_prioritized_search_suggestions(
    *, base_suggestions: list[str], priority_tags: list[str], priority_slots: int
) -> list[str]:
    if not isinstance(base_suggestions, list):
        raise TypeError("base_suggestions must be a list")
    if not isinstance(priority_tags, list):
        raise TypeError("priority_tags must be a list")
    if not isinstance(priority_slots, int) or priority_slots < 0:
        raise ValueError("priority_slots must be a non-negative integer")
    prioritized: list[str] = []
    seen_casefold: set[str] = set()
    for tag_name in priority_tags:
        if not isinstance(tag_name, str) or tag_name == "":
            raise TypeError("priority_tags entries must be non-empty strings")
        tag_casefold = tag_name.casefold()
        if tag_casefold in seen_casefold:
            continue
        seen_casefold.add(tag_casefold)
        prioritized.append(tag_name)
        if len(prioritized) >= priority_slots:
            break
    merged = list(prioritized)
    for tag_name in base_suggestions:
        if not isinstance(tag_name, str) or tag_name == "":
            raise TypeError("base_suggestions entries must be non-empty strings")
        tag_casefold = tag_name.casefold()
        if tag_casefold in seen_casefold:
            continue
        seen_casefold.add(tag_casefold)
        merged.append(tag_name)
    return merged


def encrypt_all_search_history_for_active_dek(*, connection, encryption_service: object) -> int:
    service = _coerce_encryption_service(encryption_service)
    if service is None:
        raise RuntimeError("Tag activity encryption migration requires an active DEK")
    return search_history_store.rewrite_persisted_entries(
        connection=connection,
        encryption_service=service,
        force_plaintext=False,
    )


def decrypt_all_search_history_for_plaintext(*, connection, encryption_service: object) -> int:
    service = _coerce_encryption_service(encryption_service)
    if service is None:
        raise RuntimeError("Tag activity decryption migration requires an active DEK")
    return search_history_store.rewrite_persisted_entries(
        connection=connection,
        encryption_service=service,
        force_plaintext=True,
    )


def _serialize_state(
    *, state: TagActivityState, encryption_service: object
) -> dict[str, object]:
    plaintext = serialize_search_history_payload(counts_by_date=state.counts_by_date)
    payload_json, nonce, tag = encode_search_history_payload(
        storage_id=state.storage_id,
        payload_json=plaintext,
        encryption_service=encryption_service,
    )
    return {
        "storage_id": state.storage_id,
        "payload_json": payload_json,
        "payload_encryption_nonce": nonce,
        "payload_encryption_tag": tag,
    }


def _deserialize_state(
    *, row: dict[str, object], encryption_service: object, require_success: bool
) -> TagActivityState | None:
    storage_id = row["storage_id"]
    if not isinstance(storage_id, str) or storage_id == "":
        raise TypeError("tag activity storage_id must be a non-empty string")
    if _row_is_encrypted(row) and _coerce_encryption_service(encryption_service) is None:
        if require_success:
            raise RuntimeError("Tag activity decryption requires an active DEK")
        return None
    plaintext = decode_search_history_payload(
        storage_id=storage_id,
        stored_payload=row["payload_json"],
        nonce=row["payload_encryption_nonce"],
        tag=row["payload_encryption_tag"],
        encryption_service=encryption_service,
    )
    return TagActivityState(
        storage_id=storage_id,
        counts_by_date=deserialize_search_history_payload(plaintext),
    )


def _upsert_stored_row(*, connection, row: dict[str, object]) -> None:
    storage_id = row["storage_id"]
    payload_json = row["payload_json"]
    if not isinstance(storage_id, str):
        raise TypeError("stored tag activity storage_id must be a string")
    if not isinstance(payload_json, str):
        raise TypeError("stored tag activity payload_json must be a string")
    nonce = row["payload_encryption_nonce"]
    tag = row["payload_encryption_tag"]
    if nonce is not None and not isinstance(nonce, bytes):
        raise TypeError("stored tag activity nonce must be bytes or null")
    if tag is not None and not isinstance(tag, bytes):
        raise TypeError("stored tag activity tag must be bytes or null")
    upsert_search_history_row(
        connection,
        storage_id=storage_id,
        payload_json=payload_json,
        payload_encryption_nonce=nonce,
        payload_encryption_tag=tag,
    )


def _row_is_plaintext(row: dict[str, object]) -> bool:
    nonce = row["payload_encryption_nonce"]
    tag = row["payload_encryption_tag"]
    if nonce is None and tag is None:
        return True
    if not isinstance(nonce, bytes) or not isinstance(tag, bytes):
        raise RuntimeError("tag activity payload has incomplete encryption metadata")
    return False


def _row_is_encrypted(row: dict[str, object]) -> bool:
    return not _row_is_plaintext(row)


def _resolve_encryption_service(token: str):
    service = None
    if token != "":
        service = get_encryption_service_with_token(token)
    if service is None:
        service = get_encryption_service()
    return service


def _coerce_encryption_service(encryption_service: object):
    return coerce_search_history_encryption_service(encryption_service)


search_history_store = SearchHistoryStore()
