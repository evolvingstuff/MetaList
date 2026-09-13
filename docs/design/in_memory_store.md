# In-Memory Note Store Design

## Goals
- Load the entire note hierarchy into memory at startup.
- Keep ordinary note rendering/search and authentication memory-owned; permit intentional runtime reads only within documented guard windows.
- Provide fast lookups for rendering, search, and hierarchy manipulation.
- Keep undo/redo viable (temporary DB reads are permitted via explicit guard overrides).

## Core Components (As Implemented)
- `app/services/note_store.py` (`store`): canonical in-memory graph holding decrypted note content, accepted/proposed tag sources, effective inherited terms, and ordering metadata.
- `app/services/content_cache.py`: decrypts each note, sanitizes its HTML, extracts plain text once, then publishes the completed content/accepted-tag/proposed-tag/text caches in bulk.
- `app/services/search_index.py`: in-memory tag postings plus case-folded note text maintained from `NoteStore` mutations. Quoted-text queries directly scan the tag-filtered in-memory strings and cache results, avoiding an expensive eager trigram index during hydration.
- `app/services/note_image_tags.py`: infers the search-only `@image` tag with compiled markup detection and cheap Markdown/reference presence gates, so ordinary notes do not instantiate HTML/reference parsers during hydration.
- `app/services/snapshot.py`: builds the view snapshot used by `POST /api2/notes/view`.
- `app/db/session.py`: provides `begin_writer()`/`connect_reader()` and enforces the post-startup SELECT guard.

## Data Model (Conceptual)
Notes are treated as a linked structure:
- `parent_id`: tree hierarchy
- `prev_id` / `next_id`: sibling ordering within a parent

The in-memory store maintains enough indices to:
- answer “get children in order” quickly
- update local link invariants on move/insert/delete
- keep accepted and proposed raw terms distinct while indexing their combined inherited and ontology-expanded search effects

## Startup Flow
At a high level (`app/main.py`):
1. Initialize DB schema + ensure settings exist.
2. If encryption is **disabled**:
   - Prefetch all note rows.
   - Populate the decrypted content cache in one sanitize/plain-text pass.
   - Hydrate the in-memory note store from the prefetched rows and cached plain text.
   - Enable the read guard so accidental runtime `SELECT` crashes loudly.
3. If encryption is **enabled**:
   - Skip cache + note-store hydration at startup.
   - Enable the read guard immediately.
   - Hydration happens after login via `/api2/auth/hydrate`, and the UI shows a first-load progress indicator.
   - Progress is reported across hydration phases (decrypt, note store, tag inference, search index, matcher inference) to keep the bar monotonic.

## View / Diff Flow
- Route: `POST /api2/notes/view` (`app/api/routes/notes.py`)
- Snapshot builder: `app/services/snapshot.build_view_state(...)`
- Diffing behavior:
  - A cold tab/view cache returns authoritative `snapshot.structure`; a warm cache returns structural `snapshot.diffOps`.
  - `snapshot.notes` is filtered to only include notes whose `hash` differs from the client’s `clientNoteUuidHashes`.
  - Snapshot rendering and metadata share request-local note/child/path/descendant caches so the hierarchy is not repeatedly walked.
  - Identical hierarchy maps bypass structural diff traversal.

See `docs/design/differential-view-protocol.md` for the wire format.

## Read Guard
The read guard rejects accidental runtime SELECTs, while explicit windows allow necessary persistence access:
- `app/db/session.py` wraps sqlite connections in `GuardedConnection` and raises `RuntimeError("Post-startup DB read forbidden")` when a `SELECT` is attempted after the guard is enabled.
- Writers (`begin_writer`) are used for write transactions.
- Explicit read windows exist via `connect_reader(reason=...)` or `allow_reads(reason=...)`.

## Undo/Redo Guard Exception
Undo/redo workflows can legitimately need DB reads (e.g., replay validation or hydration). Those should happen only inside explicit allow-read windows.

## Runtime access and concurrency

Ordinary authenticated middleware uses in-memory key/session state. Auth status/version/settings, attachment retrieval, startup/unlock/restore, first session-timeout hydration, undo replay validation, and topology checks inside mutations intentionally access SQLite. Schema bootstrap runs once per live database identity and is invalidated on restore/recovery. Read permission uses `ContextVar`, so an allowed read in one task/thread cannot enable another task's reads.

Immutable `NoteRecord` pointers are the ordering authority. `note_ordering.py` maintains derived boundaries; hydration and bulk metadata validate before publication. Sorted views reuse revision-aware subtree aggregates, and bounded view caches retain one current baseline per client/tab. See [refactor ownership](../REFACTORS.md) and [runtime budgets](../security/README.md#runtime-memory-and-shell-budgets-2026-09-12).

## Testing Notes

Python and Node suites are established regression gates. `test_refactor_ordering.py`, `test_next_batch.py`, request recovery tests, and the real browser smoke cover hierarchy/store invariants, read-guard isolation, mutation rollback, cache limits, and ordering across reload. See [the coverage map](../testing/coverage-map.md).
