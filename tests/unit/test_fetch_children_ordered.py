"""Sibling order read straight from the database: corrupt links fail loudly,
as the in-memory note store does when it loads them."""

import sqlite3
from datetime import datetime, timezone

import pytest

from app.db.notes_sql import fetch_children_ordered, insert_note
from app.db.schema import initialize_schema


def _database(links: list[tuple[str, str | None, str | None]]) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    now = datetime.now(timezone.utc)
    for note_id, prev_id, next_id in links:
        insert_note(
            connection, note_id=note_id, content="", encryption_nonce=None, encryption_tag=None,
            tags="", tags_encryption_nonce=None, tags_encryption_tag=None, proposed_tags="",
            proposed_tags_encryption_nonce=None, proposed_tags_encryption_tag=None,
            parent_id=None, prev_id=prev_id, next_id=next_id, is_collapsed=False, created_at=now, updated_at=now,
        )
    return connection


def test_siblings_come_back_in_link_order() -> None:
    connection = _database([("b", "a", "c"), ("c", "b", None), ("a", None, "b")])
    assert [row["id"] for row in fetch_children_ordered(connection, None)] == ["a", "b", "c"]


@pytest.mark.parametrize("links, problem", [
    ([("a", None, "missing")], "missing"),
    ([("a", None, "b"), ("b", "a", "a")], "cycle"),
    ([("a", None, None), ("b", "a", None)], "disconnected"),
    ([("a", "b", "b"), ("b", "a", "a")], "head"),
])
def test_corrupt_sibling_links_fail_loudly(links, problem) -> None:
    with pytest.raises(RuntimeError, match=problem):
        fetch_children_ordered(_database(links), None)
