# Differential View Protocol

## Overview
- `POST /api2/notes/view` now serves two flows:
  - **Bootstrap**: the server returns a compact `structure` chunk for initial load.
  - **Incremental**: after bootstrap, the server caches each tab’s view and returns `diffOps` (insert/move/remove/update instructions) plus sparse payloads.
- Clients no longer re-send the entire structure every time; hashes identify stale nodes and a single `visibleRootAnchorId` tells the server where to extend the window.
- Legacy `/api/*` routes remain blocked.

## Request Shape
```json
{
  "clientId": "client-uuid",
  "editingNoteId": null,
  "undoContext": "tab:tab-uuid|search:optional query",
  "search": "optional query",
  "tabId": "tab-uuid",
  "visibleRootAnchorId": "root-uuid-13",
  "clientNoteUuidHashes": {
    "note-uuid-1": "expandedHashWithFlags",
    "note-uuid-2": "expandedHashWithFlags"
  }
}
```

### Notes
- Keys above are required.
- `visibleRootAnchorId`: the root note currently near the center of the viewport. The server expands the window around this anchor (plus a buffer) so infinite scroll is driven entirely on the backend.
- `clientNoteUuidHashes`: map of `noteId -> hash` representing the client cache.
  - Omit entries the client does not currently have rendered.
  - The cache is **tab-scoped**.
  - When a new search query is executed, the client should clear this cache first so the server does not suppress payloads for nodes that are about to be inserted.
  - After deleting a note, the client removes that note/subtree from this cache before refreshing so the next `/notes/view` request can stay incremental.
- `search` and `editingNoteId` are passed through for server-side rendering/flagging.
- `undoContext`: a client-computed context boundary (currently tab+search). When this changes, the server clears the undo/redo stack for that client so `Cmd+Z` never crosses tab/search contexts.
- `tabId`: client-maintained active tab UUID; the server caches one view per `(clientId, tabId, search)` tuple.
- A companion `/api2/notes/tab-state` + tab create/delete endpoints keep each tab's search + scroll metadata in the namespace SQLite DB so reconnects and server restarts can hydrate the same contexts before the next `/notes/view` call.
- When the namespace is password-protected, the persisted tab-state payload is encrypted at rest with the active DEK; passwordless namespaces keep the same row in plaintext.

## Response Shape (Bootstrap)
```json
{
  "snapshot": {
    "structure": [
      {
        "id": "note-uuid-1",
        "parentId": null,
        "prevId": null,
        "nextId": "note-uuid-2",
        "hash": "expandedHashWithFlags"
      }
    ],
    "notes": {
      "note-uuid-2": {
        "content": "<div>rendered html</div>",
        "tags": "tag1 tag2",
        "proposedTags": "suggested-tag",
        "flags": {
          "isEditing": false,
          "isCollapsed": false,
          "proposalCount": 1
        },
        "hash": "expandedHashWithFlags"
      }
    },
    "locks": {
      "note-uuid-1": "client-uuid"
    },
    "rootIds": ["root-uuid-1", "root-uuid-2"],
    "updateUUID": "sync-token",
    "version": "app-version",
    "currentClientId": "client-uuid",
    "searchQuery": "optional query",
    "editingNoteId": null
  },
  "updateUUID": "sync-token"
}
```

### Notes
- `snapshot.structure` includes every visible node in the current window. This path is only used when the server lacks a cached view for `(clientId, tabId, search)`.
- `snapshot.notes` is sparse: only nodes whose `hash` differs from the client’s reported hashes.
- Each note payload includes:
  - `content`: HTML that is **rendered for view mode** unless the note is actively being edited by the current client.
    - When `flags.isEditing` is true (and the lock owner is the current client), the server sends **raw editable HTML** so wrapper delimiters like `{{...}}` remain visible.
    - Otherwise the server may apply view-only transforms (e.g. meta-tag formatting that consumes matching wrapper delimiters).
    - Embedded references (`![[UUID]]`) are resolved in this view-only content rendering path; hashes include the rendered embed output so host notes can update when embedded targets change.
  - `tags`: tag-bar string: whitespace-separated tokens outside `/* ... */` comments.
  - `proposedTags`: the note's direct unresolved proposal tokens; inherited and ontology-derived terms are not duplicated here.
  - `flags.proposalCount`: direct proposal count for an expanded note, or the current visible branch's rolled-up count for a collapsed note.
  - `hash`: covers `content` + `tags` + `proposedTags` + flags + structural pointers.
- The client sanitizes invalid/incomplete tokens (e.g. unclosed wrappers/comments) before saving.
- `rootIds` lists the visible root ordering so the client can refresh infinite-scroll metrics without the full structure.
- `updateUUID` mirrors `snapshot.updateUUID` for convenience.

## Response Shape (Incremental)
```json
{
  "snapshot": {
    "diffOps": [
      {"type": "remove", "noteId": "a", "parentId": null, "fromIndex": 0},
      {"type": "insert", "noteId": "b", "parentId": null, "toIndex": 0},
      {"type": "move", "noteId": "c", "parentId": "a", "fromIndex": 2, "toIndex": 0}
    ],
    "notes": {
      "b": {"content": "<div>rendered html</div>", "tags": "tag1 tag2", "proposedTags": "", "flags": {"isCollapsed": false, "proposalCount": 0}, "hash": "..."}
    },
    "locks": {"c": "client-uuid"},
    "lockDiffs": {"c": "client-uuid", "d": ""},
    "rootIds": ["root-uuid-1", "root-uuid-2"],
    "updateUUID": "sync-token",
    "currentClientId": "client-uuid",
    "editingNoteId": null,
    "version": "app-version"
  },
  "updateUUID": "sync-token"
}
```

### Notes
- `diffOps` is an ordered list of DOM operations generated by diffing the cached view with the latest store state:
  - `remove`: delete the note (and its subtree) at `fromIndex` under `parentId`.
  - `insert`: create a new note at `toIndex` under `parentId` (payload supplied via `snapshot.notes`).
  - `move`: reparent/reorder an existing note under `parentId`.
- `notes` remains sparse and only includes nodes whose hash changed or newly inserted nodes.
- If the client still reports a note id that is gone from the current view but was present in the server's cached prior view, the server treats it as a normal deletion and returns a `remove` diff instead of forcing a full snapshot.
- `lockDiffs` only lists locks that changed since the cached view. `locks` still contains the full visible lock map for reference.
- `rootIds` keeps infinite-scroll metrics in sync without re-sending the full structure array.
- The server stores the newly generated view in-memory per `(clientId, tabId, search)` so subsequent requests can stay incremental.

## Reconciliation Efficiency
- Snapshot construction uses a request-local traversal cache for note records, ordered child lists, ancestor paths, and descendant counts. A hierarchy branch is read once even though rendering and per-note metadata both need it.
- If a viewport anchor disappears between client polling and server reconciliation, windowing continues from the furthest client-known root still present in the current view so infinite scrolling can keep extending.
- If the cached and current `children_by_parent` maps are identical, the server skips branch-by-branch structural diffing and only computes sparse note/lock updates.
- An incremental response with no structural, note, or lock changes returns from client reconciliation immediately. Lock-only and structure-only responses also skip media hydration unless note content was actually replaced.

## Client Reconciliation
- Tab switch optimization: clients may detach/cache the `#notes-container` subtree per tab and restore it instantly on return, then call `/notes/view` to reconcile diffs.
- If a persisted tab is restored after a server restart but its detached DOM cache is gone, tab duplication falls back to an empty client cache and lets the next `/notes/view` round-trip bootstrap the new tab from server state.
- Bootstrap path: identical to the legacy behavior (diff against `snapshot.structure`, update DOM and hash cache, reset root tracking).
- Incremental path:
  - Apply `diffOps` in order (remove/move/insert) directly to the DOM.
  - Removed notes animate through an identity-free placeholder clone: the live note node is removed from `[data-note-id]` lookup and client hash caches immediately, while the clone collapses out of the layout before being discarded.
  - For each affected note id present in `snapshot.notes`, refresh the DOM content, flags, and cached hash.
  - Apply `lockDiffs` by toggling lock styling/editability without re-rendering content.
  - Update `ModeContext`’s root tracking via the provided `rootIds` array.
- Active editor preservation: when a note is being edited by the current client and the edit session has user edits, `/notes/view` refreshes may update flags, locks, collapse state, and the snapshot hash, but must not replace the note content DOM. The DOM content hash remains tied to the actual rendered editor content until the client intentionally saves or exits editing.
- Both paths keep the `clientNoteUuidHashes` map authoritative so follow-up requests remain incremental. Because caches are tab-scoped, a tab switch simply swaps the active map—no mass invalidation necessary and each `/notes/view` request only sends hashes for what that tab rendered last time.

### Scroll State Note
- When caching/restoring the notes DOM during a tab switch, the browser can temporarily clamp `window.scrollY` if the page height changes. Scroll persistence should be suppressed during the switch so per-tab `scrollY` snapshots are not overwritten.
- Prefer storing a content-based `scrollAnchor` (anchor note + neighbor belt + intra-note offset) via `/api2/notes/tab-state` so restoration survives insertions/deletions/reorders across overlapping tab result sets.
- Undo/redo responses additionally return a `scrollRestore.focusNoteId` so the client can scroll the affected note into view (below the sticky search controls) even when the viewport anchor is root-based.
- Undo/redo scroll restoration identifies the affected saved mutation through `opType`, `focusNoteId`, and `viewAnchorRootId`; selection-only edit-mode transitions are not part of application history.

## Manual Verification Checklist
- CRUD sequences: create, edit, delete and confirm only changed nodes rerender.
- Structural mutations: move across parents/siblings and verify order updates without full redraw.
- Collapse/expand toggles: child containers + flags stay accurate.
- Undo/redo flows: structure diff realigns with no stale nodes.
- Search: query round-trips per tab and updates `undoContext` boundaries.
- Search filtering: server-side and windowed by root notes (infinite scroll extends matching roots as needed).
- Lock acquisition/release: lock icons/styling update without full refresh.
