# In-Memory Note Store Design

## Goals
- Load the entire note hierarchy into memory at startup.
- Keep ordinary note rendering/search and authentication memory-owned; permit intentional runtime reads only within documented guard windows.
- Provide fast lookups for rendering, search, and hierarchy manipulation.
- Keep undo/redo viable (temporary DB reads are permitted via explicit guard overrides).

## Design Rationale
Why the whole hierarchy lives in server memory instead of being queried from SQLite:

- **Search over encrypted data.** With a namespace password, note content and tags are stored encrypted, so the database cannot search or filter them. Decrypting once (at startup, or at login for protected namespaces) and searching in memory is what makes search possible at all.
- **Speed, even without encryption.** Rendering, search, sorting and tag inheritance never wait on the database, which makes them dramatically faster than per-request queries. This applies to plaintext namespaces too.
- **Single-user by design.** The approach is affordable because one process serves one user's notes. It would not scale to one instance serving hundreds or thousands of users, whose combined data would not fit in memory. Do not "fix" the memory use by moving ordinary reads back to the database.
- **Thin client, small wire.** The server also remembers what each tab displays, so the browser sends only which roots it can see and receives only what changed. See `differential-view-protocol.md`.

Consequences accepted: memory use grows with the namespace, large encrypted namespaces take time to hydrate after login, and an unlocked process holds decrypted data in RAM (see the threat model in `docs/security/README.md`).

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
  - A tab with no warm view gets authoritative `snapshot.structure`; otherwise the server diffs against the tab's warm view (`app/services/view_cache.py`) and returns `snapshot.diffOps`.
  - `snapshot.notes` includes only notes whose `hash` differs from the warm view.
  - Only a band of roots around the browser's visible roots is built, and rendered HTML is cached per note, so view cost does not grow with scrolling.
  - Snapshot rendering and metadata share request-local note/child/path/descendant caches so the hierarchy is not repeatedly walked.
  - Identical hierarchy maps bypass structural diff traversal.

See `docs/design/differential-view-protocol.md` for the wire format.

## Incremental Updates
- Tag inheritance is recomputed incrementally: mutations pass the changed notes (and moved subtrees) to `_recompute_effective_tag_terms_locked`, which re-propagates only through affected components and publishes the resulting search-index updates in one batch.
- Bulk operations (accept/remove proposals, rename/delete tag via `apply_bulk_tag_sources`, subtree restore via `add_notes_from_db`) apply all their changes, then recompute once, instead of per note or with a full rebuild.
- The search index applies tag changes as diffs (terms removed and added), not by rewriting every posting of the note.
- Incremental state must match a fresh hydration; the unit suite checks this against rebuilds.

## Read Guard
The read guard rejects accidental runtime SELECTs, while explicit windows allow necessary persistence access:
- `app/db/session.py` wraps sqlite connections in `GuardedConnection` and raises `RuntimeError("Post-startup DB read forbidden")` when a `SELECT` is attempted after the guard is enabled.
- Writers (`begin_writer`) are used for write transactions.
- Explicit read windows exist via `connect_reader(reason=...)` or `allow_reads(reason=...)`.

## Undo/Redo Guard Exception
Undo/redo workflows can legitimately need DB reads (e.g., replay validation or hydration). Those should happen only inside explicit allow-read windows.

## Runtime access and concurrency

Ordinary authenticated middleware uses in-memory key/session state. Auth status/version/settings, attachment retrieval, startup/unlock/restore, first session-timeout hydration, undo replay validation, and topology checks inside mutations intentionally access SQLite. Schema bootstrap runs once per live database identity and is invalidated on restore/recovery. Read permission uses `ContextVar`, so an allowed read in one task/thread cannot enable another task's reads.

Immutable `NoteRecord` pointers are the ordering authority. `note_ordering.py` maintains derived boundaries; hydration and bulk metadata validate before publication. Sorted views keep per-root subtree aggregates and, after an edit, re-aggregate only the roots whose notes changed (found by comparing immutable records by identity). The view cache holds one warm view per client/tab for the tab's lifetime. See [refactor ownership](../REFACTORS.md) and [runtime budgets](../security/README.md#runtime-memory-and-shell-budgets-2026-09-12).

## Search Speed: Measured Limits and Future Options

Measured 2026-10-20 on a synthetic 107,500-note namespace (Apple M4):

- **Text-only quoted searches scan every note: about 106 ms.** Each note's lowercased text is searched in C, but the loop over 107,500 notes runs in Python (about 1 µs a note). A text term matches inside words ("fat" finds "father"), so a word index cannot answer it. Good enough for now (text search is rarely used; it still runs about ten times a second). Searches combining tags and text check only the tags' notes and are unaffected. If it ever needs to be faster:
  1. Keep the lowercased text joined into blocks of about 1,000 notes, separated by a character no term can contain, and search each block with one `str.find` (in C), mapping a hit back to its note by a binary search of the block's note offsets. The separator is not alphanumeric, so word-edge terms (" fat", "fat ") behave as at a note's start or end. Memory stays about the same (the blocks replace the per-note strings); an edit rebuilds one block. Expected: about 15–25 ms.
  2. While typing, search only the previous term's results when the new term contains the old one and the old one has no word-edge spaces ("journa" ⊆ "journ" results).
  A trigram index would make the first keystroke a few milliseconds, but at hundreds of MB and seconds more at unlock.
- **Tag postings stay sets of note numbers.** Sorted arrays (about 104 MB to 9 MB) and bitmaps for large tags (to about 15–30 MB) were both tried and rejected: Python intersects two sets in C, but a set with an array or a bitmap needs a Python-level conversion, so suggestions after a tag and a space (thousands of candidate tags) became noticeably slower. Speed comes first here (cloud CPUs are slower than the M4); any change to search or suggestions must be benchmarked on "broad tag + space" against the previous version.
- **Tag-only clauses skip the per-note check** (`_matching_note_int_ids_for_clause_locked`): the postings already hold exactly the live notes carrying the tags, with excluded tags' notes removed.

## Testing Notes

Python and Node suites are established regression gates. `test_refactor_ordering.py`, `test_next_batch.py`, request recovery tests, and the real browser smoke cover hierarchy/store invariants, read-guard isolation, mutation rollback, cache limits, and ordering across reload. See [the coverage map](../testing/coverage-map.md).
