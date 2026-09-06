# Embedded diagram widgets

Status: Initial integration checkpoint committed. Native editor iteration and paste regressions tested by the user; checkpoint approved.
Branch: `feature/embedded-diagrams`.

## Goal and scope

Prove embedded-document placement, editing, persistence, copying, references, and
history with a deliberately tiny vector editor. Multiple diagrams may appear
between text in one note. Future sketches should reuse the document identity,
storage, modal, and clipboard infrastructure.

## Implemented decisions

- Right-click a note → **Insert diagram**. The command palette also offers it.
  While editing, capture the caret before opening the menu; otherwise append to
  the clicked note. Palette insertion with no selected note creates a new root.
- Render clickable, noneditable previews in both note view and edit modes.
  Storage remains `![[UUID]]`; saving text converts previews back into tokens.
  Existing note/file references keep their established edit-mode behavior.
- Clicking a preview opens a full-screen editor with shapes, text, connecting
  arrows, and local Undo/Redo. No external diagram-editor dependency.
- Explicit Save/Cancel; Escape cancels. New objects are persisted only on Save,
  atomically with insertion into the note. Surrounding note edits save through
  the normal deselect flow before the editor opens. Returning resumes the prior
  edited note and scroll position; exact caret restoration remains future polish.
- Save uses optimistic source comparison. A conflict/network failure retains the
  draft for retry or Cancel. Cancel creates no document or embed.
- Versioned JSON documents live in the namespace's main SQLite database, enabling
  a shared transaction with notes. SVG previews are generated from validated source.
  Runtime reads use a hydrated memory store. Password transitions, lock teardown,
  startup, restore, test reset, and encryption audits include documents.
- Whole-note copy snapshots directly embedded documents across the copied subtree.
  Cmd+V clones once per distinct document per paste, preserving internal sharing
  and rewriting UUIDs. This includes sibling/child and blank-target paste.
  Copy snapshots survive source edits; repeated pastes get independent UUIDs.
  Blank-target paste resets local edit history after refresh so Cmd+Z reaches
  the saved paste. Undo/redo covers both legacy and current diagram formats.
- Cmd+R retains the original note reference and its original diagrams. Copying
  does not recursively clone documents reached through other note references.
  With no selected note, Cmd+R creates and saves a new top note like Cmd+V.
- Saved diagram edits are ordinary note-associated undo operations. Insertion and
  pasted-note undo/redo retain stable document identities. Unused documents are
  retained for references, clipboard, and undo; no premature garbage collection.
- Diagram changes update render hashes and sync, including referenced previews,
  without resetting the search root window. They do not change host-note timestamps
  or disclose diagram labels through search/AI evidence.

## Validation completed

- Automated transaction publication/rollback, copy snapshots and independent paste,
  child/sibling/blank paste, referenced preview updates, safe SVG rendering,
  API input validation/conflicts, saved-action undo/redo, and encrypted persistence.
- Full Python and JavaScript unit suites and both startup sanity gates.
- Startup-upgrade regression: pre-v7 namespaces without the diagram table pass
  the read-only audit; v7 requires the table. Existing document payloads always
  remain audited. The live 6→7 migration creates the table transactionally.
- No agent browser/server UI testing performed; user owns interactive testing.
- User confirmed the prototype works and tested diagram collapse/expand thumbnails;
  approved COMMIT CHECKPOINT. Continue on the feature branch.

## User testing targets

- Insert two diagrams among text; open, Save, Cancel, reload, and edit note text.
- Copy/paste a subtree, edit a copied diagram, and check original independence.
- Paste as a reference and check source diagram changes appear there too.
- Undo/redo insertion, diagram Save, and copied notes; reopen the restored diagrams.
- Check editor focus, keyboard ownership, scroll return, collapsed previews,
  referenced previews, and infinite scroll in a large search context.

## Deferred

Freehand sketches, external editor libraries, exact caret
restoration, individual-widget/selected-fragment clone semantics, cross-namespace
clipboard portability, document garbage collection, and diagram-text indexing.
Do not commit until the user has tested and explicitly requested a commit.

## Native editor iteration

User constraints: plain JavaScript/HTML/CSS/SVG, no React, MIT-only third-party
candidates. This iteration adds no dependencies. Keep a small everyday toolset;
this is not intended to reproduce all of draw.io.

Implemented:
- Compact tool strip: select, pan, rectangle, rounded rectangle, ellipse, diamond,
  text, and shape-to-shape arrows. Click to place a shape or drag to choose its size.
- Drag shapes, resize a single selection with corner handles, Shift-click or drag
  a selection box for multiple shapes, duplicate, delete, and nudge with arrow keys.
- Double-click/Enter edits text in place; Ctrl/Cmd+Enter finishes, Escape discards
  the text edit. Label overflow is clipped with an ellipsis using the same wrapping
  in the browser and saved SVG preview.
- Arrows attach to shape outlines and follow moves/resizing. Deleting a shape removes
  its connections. Duplicating selected shapes also copies connections between them.
- Contextual fill/stroke/weight/text controls float over the canvas. No layout shift
  when a selection changes. Optional grid snapping, pan/zoom, Fit and 100% controls.
- Browser-only history groups a gesture into one undo step, retains redo on no-op
  gestures, and does not save camera or selection into the document.
- Source format v2 stores shapes and arrows; v1 stays readable and is upgraded in
  the unsaved editor draft. Save/Cancel, encrypted storage, copy/reference semantics,
  note undo/redo, and collapse thumbnails continue through the established document
  layer. No live database schema change or eager document rewrite is needed.

Automated validation: old-to-new Save/undo/redo/copy, strict graph/style validation,
SVG escaping and fitting, connector geometry, deletion/duplication, resizing,
local history, full Python/JavaScript suites, and startup sanity checks.
User confirmed testing and approved COMMIT CHECKPOINT, including paste undo and
Cmd+R top-note placement. Regression tests cover both behaviors; the pre-checkpoint
Python suite passed all 1,165 tests.
