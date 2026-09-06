# Embedded diagram widgets

## Interaction

- Right-click a note and choose **Insert diagram**, or use the command palette.
- In an edited note, insertion uses the caret captured before the menu opened.
  From a viewed note, insertion appends. With no selected note, the palette creates
  a root note when the diagram is saved.
- Multiple diagrams can sit between ordinary note text. Their previews remain
  clickable, indivisible blocks during note editing.
- The note's expand/collapse control treats diagrams like images, including notes
  containing only one diagram. A diagram on the first visible line collapses to
  an image-sized thumbnail (7.5em × 4.5em), preserving the full drawing. Expanding
  restores its normal size; clicking either preview opens the editor. As with
  images, diagrams after the first visible line are hidden when the note collapses.
- Click a diagram to open the full-screen native editor. The compact tool strip
  offers select, pan, rectangles, rounded rectangles, ellipses, diamonds, text, and
  attached arrows. Click to place a shape or drag to choose its size.
- Drag to move; use corner handles to resize one shape. Shift-click or drag a
  selection box selects multiple shapes. Delete removes selection and incident
  arrows; Duplicate copies selected shapes and their internal connections.
- Double-click a shape (or select it and press Enter) to edit text. Ctrl/Cmd+Enter
  finishes text editing; Escape discards that text edit. Long text wraps and shows
  an ellipsis when the shape cannot fit it; resizing can reveal the complete label.
- Arrow tool: click the source shape, then the destination. Connections follow
  the shapes as they move or resize. Escape cancels the pending arrow/tool/gesture.
- Selection controls expose fill, outline/text color, line weight, and text size.
  They overlay the canvas so selection does not move the drawing surface.
- Wheel/trackpad pans; Ctrl/Cmd+wheel zooms around the pointer. Space-drag or the
  hand tool pans. Fit frames the diagram; clicking the zoom percentage resets to
  100%. Optional grid snapping affects drawing, dragging, and resizing.
- Shortcuts on the canvas: V select, H pan, R rectangle, U rounded rectangle,
  O ellipse, D diamond, T text, A arrow, F fit; arrow keys nudge (Shift = 10 units).
  Ctrl/Cmd+A selects all; Ctrl/Cmd+D duplicates; Ctrl/Cmd+Z undoes and Shift+Z redoes.
  Native text-editing shortcuts stay inside the text field.
- Save commits the diagram. Cancel/Escape discards its draft. Opening the editor
  first saves surrounding note text using the existing deselect lifecycle.
- Save failures keep the draft. Conflicting source changes reject Save rather than
  overwrite the newer version. Closing returns to the prior edited note and scroll
  position; exact caret restoration is not yet implemented.

## Identity and history

Canonical note content stores `![[UUID]]`. Each UUID identifies a versioned JSON
editable document. Generated SVG previews are presentation, not canonical source.
The storage sanitizer replaces widget HTML with its token before saving note text.
Both UUID token syntaxes resolve document previews; note/file behavior is unchanged.

Whole-note Cmd+V clones all directly embedded documents in the copied subtree.
Each distinct source gets one fresh UUID per paste; repeated occurrences preserve
sharing inside that copy. Payloads are snapshotted at copy time. Sibling paste,
child paste, and blank-target replacement use the same remapping. Cmd+R references
the original note, sharing its original diagrams. Cloning does not follow embedded
note references into unrelated subtrees. Selected-fragment/external clipboard
portability is outside this prototype's independent-copy contract.

A saved diagram edit creates one ordinary note-associated undo entry; the editor's
local Undo/Redo only affects its draft. New diagram insertion and note paste use
existing saved-note history. Undo/redo reuses document UUIDs. Removing a placement
or undoing insertion retains the object so clipboard/reference/redo paths work.
Pasting into a blank note resets the local editing baseline after refresh, so the
next Undo reaches the saved paste operation instead of browser text history.
With no selected note, Cmd+R creates and saves a new top note containing the original
note reference, while Cmd+V creates independent diagram copies.
No garbage collection runs yet. AI bulk-operation undo rules are unchanged.

## Implementation

- `app/services/embedded_documents.py`: version/kind validation, memory store,
  encryption, and document validation. `diagram_rendering.py` generates safe SVG
  previews with bounds fitted around content. Kind `diagram` supports legacy v1
  rectangles and v2 shapes/arrows. The editor upgrades v1 only in its draft; Save
  persists v2, while Cancel leaves v1 unchanged. V2 requires complete geometry/style
  fields, unique IDs, and arrow endpoints within the same document. No eager data
  migration is needed. Future kinds extend validation/rendering.
- `app/services/document_references.py`: edit-mode rendering and clipboard remapping.
- `app/usecases/embedded_documents.py` + `app/api/routes/embedded_documents.py`:
  insertion/save with optimistic source comparison and required validated inputs.
- `app/static/js/modules/embedded-documents/`: shared modal, serialization, API
  requests, and the native diagram adapter. `diagram-model.js` owns pure geometry,
  identity rewiring, and draft history; `diagram-canvas.js` draws SVG shapes and
  handles; `diagram-editor.js` owns gestures and controls. No React or new third-party
  dependency. Editor selection is registered by kind. Camera/selection are transient;
  one completed gesture becomes one local undo entry (history capped at 100).
- Database version 7 adds `embedded_documents` through the live 6→7 migration
  (also created by schema initialization). The read-only prelaunch audit permits
  an absent table only before v7; when present, its schema and payloads are always
  audited. At v7 or later, a missing table is fatal. JSON payloads use namespace
  encryption when enabled. Notes and new/cloned documents share one request
  transaction. Document cache/undo publication happens after successful commit.
- Startup/hydration and logout/reset include the store. Password enable/removal
  rewrites live document rows. Standard main-DB backups include documents; restore
  hydrates them from the installed live DB. Existing backup files remain untouched.
- Preview HTML participates in note render hashes. A document Save bumps sync so
  dependent previews refresh without clearing pagination. Host note timestamps
  remain unchanged; diagram labels are not added to search or AI note evidence.

The full-screen editor owns its shortcuts and blocks underlying note input. Its
state lives in `ModeContext.modalState.embeddedDocument`; shared CommandGate wraps
preparation, reads, Save, and return-to-note refresh.
