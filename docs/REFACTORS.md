# Refactors

## F15 architecture (2026-09-12)

Note ordering has one authority: immutable `NoteRecord.parent_id/prev_id/next_id` fields in `NoteStore._note_map`. `note_ordering.py:NoteOrdering` maintains only derived per-parent head/tail indexes and performs insertion, removal, traversal, and reciprocal-neighbor validation under the store lock. There is no second mutable `_links` map.

Retaining record pointers preserves the existing snapshot, serialization, and active usecase interfaces without allocating pointer projections on every read. Mutations replace the affected records; previously returned immutable records stay unchanged. Bulk metadata changes validate the complete replacement ordering before publishing records and indexes together. Parent changes also validate hierarchy depth/cycles. Hydration validates hierarchy and sibling connectivity before replacing the current tree; malformed links fail instead of silently reordering notes.

`store.py` remains an active adapter for usecases, backed by the same canonical `NoteStore`. It owns no second hierarchy. Cross-parent database moves publish source and destination metadata together. Subtree restoration explicitly accounts for siblings restored later in its preorder batch.

## Responsibility boundaries

| Workflow | Ownership | Preserved contract |
|---|---|---|
| Password setup/removal | `auth_service.py` prepares keys, persists rewrites, then publishes caches. `password_note_fields.py` prepares note-column changes without mutating input, DB, or cache. | Existing live-database recovery journal covers the transition, including failure during publication. Content/tags/proposals and auxiliary stores retain encryption behavior; no historical backup conversion. |
| AI chat | `api/routes/ai.py` authenticates, freezes scope, starts the provider runtime, and returns HTTP streaming. `ai_chat_stream.py:ChatTurnStream` owns turn state, event validation/rendering, error reporting, task registration, cancellation, and source closure. | Existing NDJSON fields, disclosure boundary, citations, and history semantics. Internal failures update turn status and re-raise. |
| Views | `snapshot.py:_select_view` resolves sort/filter/window/editing ancestors; `_render_view_note` produces presentation; `build_view_state` traverses topology and assembles hashes/metadata. Existing `view_diff.py` owns diffing. | Existing payloads, search redaction, collapse behavior, root windows, embeds, and hashes. |
| Hydration | `note_store.py` separates record hydration, validation/publication, search-index rebuild, matcher candidate selection, and matcher inference. | Cached plaintext reuse, progress events, implication/matcher semantics, and hierarchy limits. Matcher selection reuses the existing text mapping instead of copying it. |
| Formatting | `structured_note_renderers.py` owns JSON/CSV parsing, highlighting, and rendering. `content_formatting.py` owns tag/scope orchestration and injects CSV scope callbacks. | Existing rendering and helper import interfaces; callbacks avoid a circular dependency. |
| Tag suggestions | Content scoring returns `_ContentCandidates`; synonym expansion and combination of rankings are separate stages. | Existing segment, synonym, prefix, and hierarchy ranking. Set membership replaces repeated list scans when combining rankings. |

Functions that coordinate several ordered phases can remain longer than 50 lines where keeping their sequence visible helps review. Validation targets concrete invariants: reciprocal links, connected siblings, acyclic bounded parents, complete encryption metadata, required store/ontology interfaces, token counters, and stable stream reference scopes. It does not add assertions merely to reach a percentage.

## Removed legacy subsystem and import boundaries

A repository-wide import/reference audit found no active application entrypoint using `base_service.py`, `dependencies.py`, `note_service.py`, `query_service.py`, `transaction_manager.py`, or `undo_service.py`. Their only outside executable reference was a logging test of the old transaction manager; it now checks the active `undo_state` path. No supported external Python import API for these modules was documented. They have been removed; private consumers outside this repository would need to migrate to the active usecase/store APIs.

Routine undo imports moved to module scope in resize, expand, unformat, reference-mode, and todo usecases. Four deferred imports remain documented in `collapse.py`, `delete_subtree.py`, `move.py`, and `update_content.py`: `undo_state` imports those modules' apply functions for replay, so eager reverse imports create a cycle.

Active undo-context reset logs no longer include search text. Missing internal store/ontology capabilities and unknown metadata IDs raise instead of producing empty suggestions or ignoring updates. Move/undo invariant failures raise so transaction cleanup can execute; they no longer terminate the process with `os._exit`. Expected external failures and legitimate first-request/unsaved-note absence remain explicit.

## Validation map

- `test_refactor_ordering.py`: authoritative records, stable old snapshots, insertion/collapse/update ordering, rejected corrupt hydration, atomic bulk hierarchy validation, missing metadata IDs, real SQLite middle deletion and cross-parent move, subtree delete/restore, and rehydration.
- `test_refactor_boundaries.py`: encryption round-trip without input mutation, incomplete nonce/tag rejection, invalid stream events/reference changes with immediate cleanup, required ontology contract, and invalid move positions.
- Existing snapshot, formatting, tag-suggestion, AI route, password/recovery, privacy, and undo tests preserve behavior across the extraction.
- `scripts/browser-smoke.mjs`: rendered edit/undo and sibling move/delete/undo across reload, attachment round-trip, password setup/login/logout, encrypted restore/restart, and source archive hash invariance in a disposable namespace.

## Historical ordering defect

The original “top note gets eaten” report described a new top note jumping to the bottom after another note collapsed or expanded. The old design stored pointers both in `_links/_heads/_tails` and in records. Some mutations changed one representation, then later rebuilds rediscovered stale ordering from the other.

The interim fix synchronized both representations and asserted local invariants. The earlier proposal preferred making `_links` authoritative and projecting record pointers on demand. F15 supersedes that proposal with authoritative immutable records and derived boundaries, achieving the same single-authority goal while preserving cheap record reads.
