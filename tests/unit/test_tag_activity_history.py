from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.services.search_history import rank_tag_activity_window_selections


def _ranked_tags(**ranking_inputs) -> list[str]:
    return [selection.tag for selection in rank_tag_activity_window_selections(**ranking_inputs)]


def test_rank_tag_activity_window_selections_reuses_daily_counts_across_ordered_windows() -> None:
    today = date(2026, 8, 20)
    counts_by_date = {
        today.isoformat(): {"shortcut": 2, "short-story": 1},
        (today - timedelta(days=3)).isoformat(): {"short-selling": 5},
        (today - timedelta(days=20)).isoformat(): {"short-story": 20},
    }

    assert _ranked_tags(
        counts_by_date=counts_by_date,
        candidate_tags=["short-story", "short-selling", "shortcut"],
        window_days=(1, 7, 30),
        today=today,
    ) == ["shortcut", "short-selling", "short-story"]

    assert _ranked_tags(
        counts_by_date=counts_by_date,
        candidate_tags=["short-story", "short-selling", "shortcut"],
        window_days=(30, 7, 1),
        today=today,
    ) == ["short-story", "short-selling", "shortcut"]


def test_rank_tag_activity_window_selections_controls_slot_count_and_skips_duplicates() -> None:
    today = date(2026, 8, 20)
    counts_by_date = {
        today.isoformat(): {"journal": 5, "workday": 1},
        (today - timedelta(days=12)).isoformat(): {"scratchpad": 9},
    }

    assert _ranked_tags(
        counts_by_date=counts_by_date,
        candidate_tags=["journal", "scratchpad", "workday"],
        window_days=(1, 30),
        today=today,
    ) == ["journal", "scratchpad"]
    assert _ranked_tags(
        counts_by_date=counts_by_date,
        candidate_tags=["journal", "scratchpad", "workday"],
        window_days=(),
        today=today,
    ) == []


def test_rank_tag_activity_window_selections_ignores_expired_and_non_candidate_tags() -> None:
    today = date(2026, 8, 20)
    counts_by_date = {
        (today - timedelta(days=30)).isoformat(): {"expired": 100},
        today.isoformat(): {"deleted-tag": 20, "shortcut": 1},
    }

    assert _ranked_tags(
        counts_by_date=counts_by_date,
        candidate_tags=["shortcut"],
        window_days=(1, 30),
        today=today,
    ) == ["shortcut"]


def test_rank_tag_activity_window_selections_rejects_invalid_configuration() -> None:
    today = date(2026, 8, 20)

    for invalid_windows in ((0,), (366,), (7, 7)):
        with pytest.raises(ValueError):
            _ranked_tags(
                counts_by_date={},
                candidate_tags=[],
                window_days=invalid_windows,
                today=today,
            )
