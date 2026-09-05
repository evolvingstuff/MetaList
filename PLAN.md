# Embedded diagram widgets

Status: Minimal prototype implemented and user-tested; checkpoint approved.
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
- Clicking a preview opens a full-screen editor. Tools: add, drag, label, delete
  rectangles; local Undo/Redo. No external diagram-editor dependency.
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
- Cmd+R retains the original note reference and its original diagrams. Copying
  does not recursively clone documents reached through other note references.
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
- No browser/server UI testing performed; user explicitly owns interactive testing.
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

Connectors, other shapes, freehand sketches, external editor libraries, exact caret
restoration, individual-widget/selected-fragment clone semantics, cross-namespace
clipboard portability, document garbage collection, and diagram-text indexing.
Do not commit until the user has tested and explicitly requested a commit.
