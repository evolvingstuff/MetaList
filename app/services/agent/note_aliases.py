"""Short per-run note aliases (``n12``) for everything the model sees and cites.

Note ids are 36-character UUIDs that a model miscopies now and then, which breaks
the citation link. The agent loop shows the model ``n1``, ``n2``… instead, in tool
results and the selected-note context, translates aliases back in tool arguments,
and turns ``[[n12]]`` citations into ``[[<note id>]]`` as the answer streams (see
citation_tokens.py), so storage and rendering keep full ids.
"""

from __future__ import annotations

import re

from app.services.agent.scope import ScopedSearchSnapshot


ALIAS_RE = re.compile(r"^n[1-9]\d*$")
# Payload keys whose value is one note id, and keys whose value is a list of note ids.
_ID_KEYS = frozenset({"note_id", "root_id", "root_note_id", "parent_id"})
_ID_LIST_KEYS = frozenset({"matching_note_ids", "unread_root_ids", "too_large_root_ids"})


class NoteAliases:
    def __init__(self, note_ids: tuple[str, ...]) -> None:
        assert len(set(note_ids)) == len(note_ids), "Note ids must be unique"
        self._alias_by_id = {note_id: f"n{index}" for index, note_id in enumerate(note_ids, start=1)}
        self._id_by_alias = {alias: note_id for note_id, alias in self._alias_by_id.items()}

    @classmethod
    def from_snapshot(cls, snapshot: ScopedSearchSnapshot) -> NoteAliases:
        """Deterministic: view notes and tree structure in view order, then the selected tree."""
        ordered: list[str] = []
        for note_id in (*snapshot.ordered_note_ids, *snapshot.tree_nodes_by_id,
                        *snapshot.selected_note.reference_note_ids):
            if note_id not in ordered:
                ordered.append(note_id)
        return cls(tuple(ordered))

    def alias(self, note_id: str) -> str:
        return self._alias_by_id[note_id]

    def note_id(self, value: str) -> str:
        """The note id an alias stands for; any other value (a full id, a typo) is returned as given."""
        if value in self._id_by_alias:  # shockharness: ignore[DEF002] reason="a value that is not an alias (a full id, a typo) is returned as given"
            return self._id_by_alias[value]
        return value

    def id_by_alias(self) -> dict[str, str]:
        return dict(self._id_by_alias)

    def aliased(self, payload: object) -> object:
        """A copy of a JSON payload with its note ids replaced by aliases."""
        return self._map_ids(payload, self._to_alias)

    def unaliased(self, payload: object) -> object:
        """A copy of a JSON payload with aliases replaced by note ids (for diagnostics and judging)."""
        return self._map_ids(payload, self.note_id)

    def _to_alias(self, value: str) -> str:
        if value in self._alias_by_id:  # shockharness: ignore[DEF002] reason="a value that is not a known note id is left as written"
            return self._alias_by_id[value]
        return value

    def _map_ids(self, payload: object, convert) -> object:
        if isinstance(payload, dict):
            mapped = {}
            for key, value in payload.items():
                if key in _ID_KEYS and isinstance(value, str):
                    mapped[key] = convert(value)
                elif key in _ID_LIST_KEYS and isinstance(value, list):
                    mapped[key] = [convert(item) for item in value]
                else:
                    mapped[key] = self._map_ids(value, convert)
            return mapped
        if isinstance(payload, list):
            return [self._map_ids(item, convert) for item in payload]
        return payload
