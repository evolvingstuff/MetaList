# Embedded diagram widgets

## Interaction

- **Theme** selects **Hand-drawn** or **Clean** for the entire diagram. New diagrams
  start Hand-drawn: white paper, gently varying ink weight, slightly skewed shapes,
  and a single sweeping stroke per edge. Fills follow the drawn edges; rounded
  corners stay smooth. Marks stay repeatable across redraws. The theme includes
  open pen arrowheads and a handwritten font stack (Chalkboard SE / Comic Sans MS /
  cursive). Clean uses crisp lines and sans-serif text. Font availability follows
  the viewing system; no remote font or new library is loaded.
- New shapes have white fills and dark gray outlines/text; arrows start dark gray.
  Both themes use white paper and gray grid lines. Color is an explicit styling
  choice; saved/custom colors are preserved.
- Themes affect box text, arrow labels, outlines, and paper in both the editor and
  saved previews. Shape colors, geometry, connections, and text formatting stay
  intact. Switching themes is undoable. Legacy diagrams open Clean; choose
  Hand-drawn and Save to change their appearance.

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
- Click a diagram to open the full-screen SVG editor. Primary tools are select,
  pan, rectangles, rounded rectangles, text, and arrows. Ellipse/diamond creation
  remains in **More shapes**. Click to place a box or drag to size it.
- The properties panel stays beside the canvas. Fill, transparency, outline/line
  color, thickness, font size, bold, italics, and independent font color are directly
  visible. Controls show mixed values for mixed selections. Styling a selection
  never changes the defaults for newly drawn boxes.
- Grid visibility and Snap are independent; spacing is adjustable from 5 to 100.
  Hold Option/Alt to bypass snapping and endpoint attachment temporarily.
- Arrow tool: start at a highlighted box connection point or empty canvas. Click
  successive route locations, then click a destination connection point to finish.
  Enter or double-click finishes in empty space; Backspace removes the last placed
  route point; Escape cancels. Arrowheads are independent of attachment.
- New arrows use horizontal/vertical segments with rounded bends. Drag circular
  bend handles, square segment handles, or endpoints to edit a selected arrow.
  Endpoints can detach and reattach. Right-click provides Add bend here, Remove
  bend, and Detach start/end. Legacy straight arrows remain straight until edited.
- Moving one connected box preserves manual interior route points and adjusts the
  endpoint connection. Moving both boxes together translates their internal route.
- Double-click a box or arrow to edit its text. Select words before applying bold,
  italics, or color; formatting controls preserve the selection. Cmd/Ctrl+B and I
  use the text editor. Cmd/Ctrl+Enter finishes; Escape discards the text edit.
  Text wraps and boxes grow vertically as needed; shorter text does not shrink an
  intentionally taller box. Labels are limited to 5,000 characters.
- Shift-click or drag a selection rectangle for multiple objects. Group/Ungroup
  creates/removes invisible movement groups; grouping preserves drawing order.
  There are no visible group containers or group resize/rotate handles. Double-click
  a member to edit its label without ungrouping it.
- Duplicate or copy/paste retains styling and includes arrows between copied boxes.
  Internal attachments reconnect to copies. An explicitly copied arrow with an
  uncopied endpoint detaches that endpoint, avoiding a hidden link to the original.
- Bring to front/Send to back works across boxes and arrows while preserving order
  within the selected group. These actions, grouping, and duplication are available
  both in the properties panel and the diagram right-click menu.
- Delete removes selected objects and arrows attached to deleted boxes. Detach an
  arrow before deleting its former box if the arrow should remain.
- Wheel/trackpad pans; Ctrl/Cmd+wheel zooms around the pointer. Space-drag or Pan
  moves the viewport. Fit includes routed/free arrows and their labels. Clicking
  the zoom percentage resets to 100%.
- Canvas shortcuts: V select, H pan, R rectangle, U rounded rectangle, T text,
  A arrow, F fit. Arrow keys nudge; Shift nudges by the configured grid spacing.
  Cmd/Ctrl+A selects all; D duplicates; C/X/V copies/cuts/pastes within the editor;
  G groups and Shift+G ungroups; Z undoes and Shift+Z/Y redoes. Native text editing
  keeps its own shortcuts. Gestures create one draft undo step each.
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

- `diagram-theme.js` and `diagram_theme.py` generate matching deterministic pen
  paths using object identity. No random movement during drag/zoom, bitmap filters,
  or changes to attachment/hit-test geometry.
- `app/services/embedded_documents.py`: memory store, encryption, version dispatch,
  and legacy validation. `diagram_schema.py` validates v3/v4: explicit attached/free/
  floating endpoints, route points, rich-text runs, groups, order, and grid settings.
  Fields are required; IDs, references, membership, sizes, and ordering are checked.
- `diagram_rendering.py` preserves v2 previews; `diagram_vector.py` renders v3/v4 safe
  SVG including rounded paths, labels, arrowheads, and bounds outside boxes.
  Browser and server use matching conservative glyph advances and SVG textLength
  for deterministic formatted label layout. Labels are stored as runs, not HTML.
- V1/v2/v3 stay readable. V4 adds a required theme. The editor upgrades only the draft to v4; Save persists v4,
  Cancel leaves the old source unchanged, and saved Undo can restore it. No eager
  migration or new database schema is involved.
- `app/services/document_references.py`: editable preview rendering and whole-note
  clipboard document remapping. `app/usecases/embedded_documents.py` and its API
  routes retain atomic insertion/save and optimistic source comparison.
- `app/static/js/modules/embedded-documents/diagram-document.js`: v3 upgrades,
  pure routing/text/group/order/copy operations. `diagram-scene.js` renders SVG and
  selection controls. `diagram-editor.js` owns gestures and UI; `diagram-text-editor.js`
  owns the HTML text overlay and permitted formatting. Legacy model/canvas helpers
  remain available. No React or new dependency; no Node.js runtime.
- Camera, selection, gestures, and draft history are transient. Grid options live
  in source. Browser draft history remains capped at 100 completed operations.
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

## Future refinements

The current editor and themes were user-tested and accepted on 2026-09-10.
Further hand-drawn styling can refine stroke starts, finishes, and corner joins
while retaining smooth edges and grayscale defaults. Freehand sketches, automatic
routing, group resizing/rotation, and diagram-text search remain future work.
