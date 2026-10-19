from __future__ import annotations

from datetime import date, timedelta
import json
from pathlib import Path

import pytest

from app.db.session import connect_reader
from app.models.database import SafeSession
from app.security.encryption import clear_encryption_key, set_encryption_required, set_session_dek
from app.services.search_history import (
    DEFAULT_TAG_ACTIVITY_WINDOWS,
    TagActivityWindowSelection,
    is_first_search_tag_suggestion_context,
    list_search_suggestion_statistics,
    list_recent_search_tag_selections_for_first_query,
    prioritize_first_search_tag_suggestions,
    record_explicit_tag_addition_batch,
    record_explicit_tag_additions,
    record_note_interaction,
    record_search_suggestion_selection,
    record_tab_search_selection,
    reset_search_history,
)
from app.services.search_index import SearchIndex, SearchRecord, extract_tags_for_search
import app.services.search_history as search_history_module


def _build_index(
    records: list[SearchRecord], *, raw_tag_terms_by_id: dict[str, frozenset[str]]
) -> SearchIndex:
    index = SearchIndex()
    index.rebuild(
        records,
        raw_tag_terms_by_id=raw_tag_terms_by_id,
        progress_update=lambda _processed: None,
        progress_interval=1000,
    )
    return index


def _fetch_rows():
    with connect_reader("tests:tag_activity") as connection:
        return connection.execute(
            "SELECT * FROM search_interaction_history ORDER BY storage_id ASC"
        ).fetchall()


def _configure_memory_database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    set_encryption_required(False)
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    search_history_module.search_history_store.clear_persisted_state_for_tests()


def test_note_interaction_credits_raw_inherited_tags_not_ontology_tags(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_memory_database(tmp_path, monkeypatch)
    try:
        index = _build_index(
            [
                SearchRecord(
                    note_id="shell-note",
                    content_text="Backup command",
                    tags="@shell",
                    tag_terms=frozenset({"shortcut", "@shell", "inferred"}),
                )
            ],
            raw_tag_terms_by_id={"shell-note": frozenset({"shortcut", "@shell"})},
        )
        monkeypatch.setattr(search_history_module, "search_index", index)

        assert record_note_interaction(
            note_id="shell-note",
            interaction_type="command",
            token="token",
            interacted_on=date(2026, 8, 20),
        ) is True
        assert list_recent_search_tag_selections_for_first_query(
            query="shor",
            candidate_tags=["short-story", "shortcut", "inferred"],
            window_days=DEFAULT_TAG_ACTIVITY_WINDOWS,
            token="token",
            today=date(2026, 8, 20),
        ) == [TagActivityWindowSelection(tag="shortcut", window_days=1, activity_count=1)]
    finally:
        search_history_module.search_history_store.clear_persisted_state_for_tests()


def test_explicit_tag_additions_credit_only_new_case_insensitive_terms(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: list[dict[str, object]] = []
    monkeypatch.setattr(
        search_history_module.search_history_store,
        "record_interaction",
        lambda **kwargs: recorded.append(kwargs) or True,
    )

    assert record_explicit_tag_additions(
        before_tags="journal Existing",
        after_tags="journal existing new-tag @shell NEW-TAG",
        token="token",
        interacted_on=date(2026, 8, 21),
    ) is True
    assert recorded == [
        {
            "tags": ("@shell", "new-tag"),
            "token": "token",
            "interacted_on": date(2026, 8, 21),
        }
    ]


def test_search_suggestion_selection_credits_the_selected_known_tag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: list[dict[str, object]] = []
    monkeypatch.setattr(
        search_history_module.search_index,
        "list_tag_suggestion_terms",
        lambda: frozenset({"@shell"}),
    )
    monkeypatch.setattr(
        search_history_module.search_history_store,
        "record_interaction",
        lambda **kwargs: recorded.append(kwargs) or True,
    )

    assert record_search_suggestion_selection(
        tag="@SHELL",
        token="token",
        interacted_on=date(2026, 8, 21),
    ) is True
    assert recorded == [
        {
            "tags": ("@shell",),
            "token": "token",
            "interacted_on": date(2026, 8, 21),
        }
    ]


@pytest.mark.parametrize("query", ["@c", "@code", "@code=", "rec", ""])
def test_every_offered_search_suggestion_can_be_selected(monkeypatch: pytest.MonkeyPatch, query: str) -> None:
    # Picking @code=python from the list failed as "not a known tag" (2026-10-19): the
    # suggestions offered @ tags in use, the selection checked a narrower vocabulary.
    records = [
        SearchRecord(note_id=note_id, content_text="text", tags=tags, tag_terms=extract_tags_for_search(tags))
        for note_id, tags in (("python", "@code=python"), ("javascript", "@code=javascript"), ("recipes", "recipes"))
    ]
    index = _build_index(records, raw_tag_terms_by_id={record.note_id: record.tag_terms for record in records})
    recorded: list[tuple[str, ...]] = []
    monkeypatch.setattr(search_history_module, "search_index", index)
    monkeypatch.setattr(
        search_history_module.search_history_store,
        "record_interaction",
        lambda **kwargs: recorded.append(kwargs["tags"]) or True,
    )
    offered = index.suggest_all_tag_completions(query=query)
    assert offered != []
    for tag in offered:
        assert record_search_suggestion_selection(tag=tag, token="token", interacted_on=date(2026, 10, 19)) is True
    assert recorded == [(tag,) for tag in offered]


def test_tab_selection_credits_only_known_positive_tag_terms(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: list[dict[str, object]] = []
    known_tags = {
        "journal": "journal",
        "shortcut": "shortcut",
    }
    monkeypatch.setattr(
        search_history_module.search_index,
        "list_tag_suggestion_terms",
        lambda: frozenset(known_tags.values()),
    )
    monkeypatch.setattr(
        search_history_module.search_history_store,
        "record_interaction",
        lambda **kwargs: recorded.append(kwargs) or True,
    )

    assert record_tab_search_selection(
        search_query="journal -private OR shortcut 'quoted text'",
        token="token",
        interacted_on=date(2026, 8, 21),
    ) is True
    assert recorded == [
        {
            "tags": ("journal", "shortcut"),
            "token": "token",
            "interacted_on": date(2026, 8, 21),
        }
    ]


def test_repeated_tab_selections_are_never_deduplicated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_memory_database(tmp_path, monkeypatch)
    try:
        index = _build_index(
            [
                SearchRecord(
                    note_id="shortcut-note",
                    content_text="Shortcut",
                    tags="shortcut",
                    tag_terms=frozenset({"shortcut"}),
                )
            ],
            raw_tag_terms_by_id={"shortcut-note": frozenset({"shortcut"})},
        )
        monkeypatch.setattr(search_history_module, "search_index", index)
        interaction_day = date(2026, 8, 21)

        for _selection_number in range(4):
            assert record_tab_search_selection(
                search_query="shortcut",
                token="token",
                interacted_on=interaction_day,
            ) is True

        statistics = list_search_suggestion_statistics(token="token")
        assert statistics["days"] == [
            {
                "date": "2026-08-21",
                "totalTagCredits": 4,
                "tags": [{"tag": "shortcut", "count": 4}],
            }
        ]
    finally:
        search_history_module.search_history_store.clear_persisted_state_for_tests()


def test_daily_activity_reuses_one_bucket_and_one_database_row(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_memory_database(tmp_path, monkeypatch)
    try:
        index = _build_index(
            [
                SearchRecord(
                    note_id="n1",
                    content_text="Journal",
                    tags="journal workday",
                    tag_terms=frozenset({"journal", "workday"}),
                )
            ],
            raw_tag_terms_by_id={"n1": frozenset({"journal", "workday"})},
        )
        monkeypatch.setattr(search_history_module, "search_index", index)
        interaction_day = date(2026, 8, 20)

        for interaction_type in (
            "edit",
            "expand",
            "fullscreen",
            "move",
            "indent",
            "outdent",
        ):
            assert record_note_interaction(
                note_id="n1",
                interaction_type=interaction_type,
                token="token",
                interacted_on=interaction_day,
            ) is True

        rows = _fetch_rows()
        assert len(rows) == 1
        assert rows[0]["payload_encryption_nonce"] is None
        payload = json.loads(rows[0]["payload_json"])
        assert payload == {
            "version": 2,
            "counts_by_date": {
                "2026-08-20": {"journal": 6, "workday": 6},
            },
        }
    finally:
        search_history_module.search_history_store.clear_persisted_state_for_tests()


def test_search_suggestion_statistics_lists_daily_tag_credits_newest_first(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_memory_database(tmp_path, monkeypatch)
    try:
        index = _build_index(
            [
                SearchRecord(
                    note_id="n1",
                    content_text="Journal",
                    tags="journal workday",
                    tag_terms=frozenset({"journal", "workday"}),
                )
            ],
            raw_tag_terms_by_id={"n1": frozenset({"journal", "workday"})},
        )
        monkeypatch.setattr(search_history_module, "search_index", index)
        record_note_interaction(
            note_id="n1",
            interaction_type="edit",
            token="token",
            interacted_on=date(2026, 8, 18),
        )
        for interaction_type in ("expand", "fullscreen"):
            record_note_interaction(
                note_id="n1",
                interaction_type=interaction_type,
                token="token",
                interacted_on=date(2026, 8, 20),
            )

        assert list_search_suggestion_statistics(token="token") == {
            "retentionPopulatedDayLimit": 365,
            "days": [
                {
                    "date": "2026-08-20",
                    "totalTagCredits": 4,
                    "tags": [
                        {"tag": "journal", "count": 2},
                        {"tag": "workday", "count": 2},
                    ],
                },
                {
                    "date": "2026-08-18",
                    "totalTagCredits": 2,
                    "tags": [
                        {"tag": "journal", "count": 1},
                        {"tag": "workday", "count": 1},
                    ],
                },
            ],
        }
    finally:
        search_history_module.search_history_store.clear_persisted_state_for_tests()


def test_sparse_retention_keeps_365_populated_days_regardless_of_gaps() -> None:
    newest_day = date(2026, 8, 20)
    counts_by_date = {
        (newest_day - timedelta(days=index * 20)).isoformat(): {"journal": 1}
        for index in range(366)
    }

    retained = search_history_module._prune_counts_by_date(
        counts_by_date=counts_by_date,
        today=newest_day,
    )

    assert len(retained) == 365
    assert newest_day.isoformat() in retained
    assert (newest_day - timedelta(days=365 * 20)).isoformat() not in retained


def test_tag_activity_is_opaque_at_rest_and_reencrypts_same_single_row(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_memory_database(tmp_path, monkeypatch)
    set_session_dek(b"k" * 32)
    set_encryption_required(True)
    try:
        index = _build_index(
            [
                SearchRecord(
                    note_id="n1",
                    content_text="Shortcut",
                    tags="shortcut",
                    tag_terms=frozenset({"shortcut"}),
                )
            ],
            raw_tag_terms_by_id={"n1": frozenset({"shortcut"})},
        )
        monkeypatch.setattr(search_history_module, "search_index", index)

        assert record_note_interaction(
            note_id="n1",
            interaction_type="edit",
            token="token",
            interacted_on=date(2026, 8, 20),
        ) is True
        first_row = _fetch_rows()[0]
        assert "shortcut" not in first_row["payload_json"]
        assert isinstance(first_row["payload_encryption_nonce"], bytes)

        assert record_note_interaction(
            note_id="n1",
            interaction_type="command",
            token="token",
            interacted_on=date(2026, 8, 20),
        ) is True
        second_rows = _fetch_rows()
        assert len(second_rows) == 1
        assert second_rows[0]["storage_id"] == first_row["storage_id"]
        assert second_rows[0]["payload_json"] != first_row["payload_json"]
        assert second_rows[0]["payload_encryption_nonce"] != first_row["payload_encryption_nonce"]
    finally:
        set_encryption_required(False)
        clear_encryption_key()
        search_history_module.search_history_store.clear_persisted_state_for_tests()


def test_reset_tag_activity_deletes_only_the_aggregate_blob(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_memory_database(tmp_path, monkeypatch)
    try:
        index = _build_index(
            [
                SearchRecord(
                    note_id="n1",
                    content_text="Journal",
                    tags="journal",
                    tag_terms=frozenset({"journal"}),
                )
            ],
            raw_tag_terms_by_id={"n1": frozenset({"journal"})},
        )
        monkeypatch.setattr(search_history_module, "search_index", index)
        record_note_interaction(
            note_id="n1",
            interaction_type="edit",
            token="token",
            interacted_on=date(2026, 8, 20),
        )

        assert reset_search_history(token="token") == 1
        assert _fetch_rows() == []
        assert reset_search_history(token="token") == 0
    finally:
        search_history_module.search_history_store.clear_persisted_state_for_tests()


def test_search_suggestion_context_and_merge_preserve_base_order() -> None:
    assert is_first_search_tag_suggestion_context("") is True
    assert is_first_search_tag_suggestion_context("shor") is True
    assert is_first_search_tag_suggestion_context("journal next") is False
    assert prioritize_first_search_tag_suggestions(
        query="shor",
        base_suggestions=["short-story", "shortcut", "short-selling"],
        recent_tags=["shortcut"],
        priority_slots=3,
    ) == ["shortcut", "short-story", "short-selling"]


def test_batched_explicit_tag_additions_match_one_call_per_note(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    changes = (("", "Alpha beta"), ("alpha", "alpha Beta gamma"), ("x", "x"), ("", "BETA delta"))
    day = date(2026, 8, 20)
    _configure_memory_database(tmp_path, monkeypatch)
    store = search_history_module.search_history_store
    try:
        for before_tags, after_tags in changes:
            record_explicit_tag_additions(before_tags=before_tags, after_tags=after_tags, token="token", interacted_on=day)
        one_by_one = store._state.counts_by_date
        store.clear_persisted_state_for_tests()

        writes = []
        original_upsert = search_history_module._upsert_stored_row
        monkeypatch.setattr(search_history_module, "_upsert_stored_row", lambda **kwargs: (writes.append(1), original_upsert(**kwargs))[1])
        assert record_explicit_tag_addition_batch(tag_changes=changes, token="token", interacted_on=day) is True

        assert store._state.counts_by_date == one_by_one
        assert writes == [1]
    finally:
        store.clear_persisted_state_for_tests()
