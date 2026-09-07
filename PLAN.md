# Simple diagram editor

Status: User tested the v3 iteration and approved a checkpoint; further fixes remain to be identified.
Branch: `feature/embedded-diagrams`.
Last tested checkpoint: `7ff4b627` — native editor and note-paste regressions.

## Goal

Provide familiar draw.io-style manipulation with a small toolset, discoverable
styling, and predictable control of complex arrow paths. Prioritize rectangles,
rounded rectangles, text, and arrows. Extend the existing embedded-document
integration.

## Confirmed requirements

- Plain browser JavaScript, HTML/CSS controls, SVG drawing, JSON source. No React
  or Node.js runtime. No new dependencies expected; any third-party dependency
  must be MIT licensed.
- Familiar snap-to-grid behavior.
- Arrows snap to points on boxes and stay attached as boxes move.
- Draw complex arrow routes by clicking successive locations, with softly rounded
  bends and easy subsequent adjustment.
- Unattached endpoints still have arrowheads. Attachment and arrowhead appearance
  are separate concepts.
- Double-click an arrow to add or edit its label.
- Bold, italics, and font color, including selected words within a label.
- Box labels wrap at the box width and grow the box vertically to remain visible.
- Groups are invisible logical collections, primarily for moving objects together.
- Easily discoverable colors, text controls, and bring-to-front / send-to-back.
- New boxes use default styling. Copies preserve their originals' styling.
  Styling one object must not silently change subsequent new-object defaults.
- Copying connected boxes together includes their connecting arrows, reattached
  to the copied boxes.

## Proposed interaction defaults

These resolve details not explicitly answered during the interview and remain
open to adjustment during user testing.

### Workspace and properties

- Main toolbar: select, pan, rectangle, rounded rectangle, text, arrow, Undo/Redo.
  Keep existing ellipse/diamond rendering and editing compatible; place their
  creation tools in a small secondary shapes menu.
- Compact properties panel at a stable location. Canvas dimensions do not change
  when selection changes. Relevant controls are directly visible without
  Style/Text/Arrange tabs or expandable sections.
- Shape properties: fill/transparent fill, outline color, thickness, text size,
  bold, italics, and independent text color.
- Arrow properties: line color, thickness, arrowheads, and label formatting.
- Clearly labeled Group/Ungroup, Duplicate, Delete, Bring to front, and Send to back
  actions, also available through the diagram's right-click menu.
- Separate Grid and Snap toggles, adjustable spacing, and Option/Alt to temporarily
  bypass snapping. Snapping uses document coordinates at every zoom level.
- Preserve pan/zoom/Fit and keyboard nudging. Mixed selections display mixed
  property values honestly; editing a property changes only that property.

### Arrows

- Start on a visible connection point or empty canvas. Highlight the prospective
  attachment before committing it.
- Click successive route locations. Use horizontal/vertical segments with small
  rounded corners and a live preview of the next segment.
- Clicking a destination connection point finishes an attached arrow. Enter or
  double-click finishes a free endpoint; Escape cancels the unfinished arrow.
  Backspace removes the last placed bend during drawing. The finishing double-click
  must not also open the label editor.
- Selected arrows expose endpoint and bend/segment handles. Add/remove bends, drag
  segments, detach endpoints, and reattach them without recreating the arrow.
- Preserve manually placed interior route points when a connected box moves;
  adjust nearby endpoint segments instead of rerouting the entire arrow. Moving
  both endpoints together translates the route consistently.
- Start with side/corner points for rectangles. Store relative attachment positions
  so resizing preserves the chosen connection location.
- Keep legacy straight arrows visually stable. Converting one to a manually routed
  path is an explicit edit, not a side effect of opening the document.
- Render the target arrowhead from the final nonzero segment, including completely
  free arrows. One completed drawing/drag gesture creates one draft undo entry;
  canceled gestures leave the source and history unchanged.

### Text

- HTML editing overlay backed by explicit text runs with bold/italic/color fields.
  Persist validated runs rather than arbitrary HTML.
- Formatting applies to selected text; without a selected range it applies to the
  label or sets typing format inside the active text session. Clicking formatting
  controls preserves the range. Cmd+B/Cmd+I and native text undo stay in the editor.
- Render escaped SVG text/tspan content in both the live scene and saved preview.
  Text color is independent of the shape outline.
- Wrap at the available width. Grow box height after changes to text, formatting,
  font size, or width; do not shrink a deliberately tall box automatically.
  Remove the new-format label ellipsis behavior.
- Define a consistent layout contract across HTML editing, browser SVG, and server
  preview. Account for bold/italic metrics, Unicode, and long words. Verify shared
  layout fixtures; avoid a browser-only layout the server cannot reproduce.
- Arrow labels use the same formatting representation and follow the route. Begin
  with a label near the path midpoint.

### Groups, copying, and ordering

- Grouping creates membership, not a drawn container. Selecting a group moves its
  members together. Ungroup preserves geometry and styling.
- Initial groups are flat; grouping existing groups flattens membership. Group
  resizing/rotation and visible containers are outside this iteration.
- Internal arrows move with grouped boxes. Connections crossing a group boundary
  retain the external endpoint and interior route while the nearby segment adjusts.
- Allow member text editing without ungrouping.
- Copies receive fresh object/group IDs and retain relative positions, formatting,
  internal connections, and stacking. Do not accidentally connect copies to originals.
- Explicitly copied arrows retain free endpoints. If an explicitly selected arrow
  is copied with only one attached box, detach the other end at its copied position
  instead of creating an implicit link to an uncopied original.
- Unified drawing order for shapes and arrows. Front/back moves the selection while
  preserving its internal order; hit testing follows that same order. Grouping alone
  does not rearrange stacking.
- Preserve existing shape deletion semantics: attached arrows are removed. Detach
  an arrow first to preserve it when deleting its former box.

## Architecture and compatibility

- Extend `diagram-model.js` with pure document operations. Split routing, text layout,
  and grouping helpers into focused modules as needed. DOM gestures belong in the
  editor; SVG scene drawing belongs in the canvas layer.
- Add a source version for endpoints/routes, rich text, groups, drawing order, and
  document grid settings. Retain v1/v2 validation and rendering.
- Required fields and tagged endpoint variants: attached shape/relative location,
  free coordinates, and explicit floating legacy attachments if needed. A missing
  shape reference is an error, not an implicit free endpoint.
- Validate unique IDs, finite geometry, attachment references, group membership,
  drawing order, route sizes, colors, and text limits. Internal errors fail loudly.
- Upgrade legacy source only in the unsaved editor draft. Save persists the new
  format; Cancel leaves the original unchanged; saved Undo may restore old source.
  No database table/schema migration or eager document rewrite is expected.
- Extend `embedded_documents.py` validation and `diagram_rendering.py` alongside the
  browser. Preview/Fit bounds include free arrows, route excursions, labels, and
  arrowheads, including documents with no boxes.
- Persist explicit document grid settings. Camera, selection, pending gestures,
  and text-editing state remain transient.

## Integration contracts to preserve

- Multiple diagrams among note text; insertion from the context menu; clickable
  previews; full-screen Save/Cancel; collapsed thumbnails.
- Optimistic Save conflict detection and atomic note/document writes.
- Encryption, memory-first hydration, lock teardown, and reference refresh without
  resetting infinite scroll.
- Whole-note Cmd+V clones copy-time document snapshots once per distinct UUID;
  Cmd+R shares original notes/diagrams and creates a top reference when no note is
  selected. Blank-target paste resets local editor history so Cmd+Z reaches saved
  paste history. Saved undo/redo retains document identity.
- Draft undo remains separate from saved note undo. Editor keyboard/context-menu
  operations cannot affect underlying notes.
- Existing backup archives are immutable. Do not access the user's `cla` or `thomas`
  namespaces for development or validation.

## Implementation sequence

1. Add the source contract, explicit draft upgrades, pure model operations, and
   regression fixtures for legacy compatibility.
2. Implement arrow geometry and SVG rendering: free endpoints, rounded paths,
   attachment points, and complete preview bounds.
3. Add arrow drawing/editing and grid controls. Prioritize predictable manual
   routing before further styling polish.
4. Add movement groups, copying/reconnection, and front/back ordering.
5. Add formatted label editing and consistent wrapping/automatic height growth.
6. Assemble the compact toolbar/properties panel/context menu. Update implemented
   behavior in `docs/ui/diagram-widgets.md`, controls docs, and `docs/AI-SUMMARY.md`.

## Validation and completion

- Model tests: complex routes, rounded/zero-length segments, attachment/detachment,
  moves/resizes, groups, internal/external connections, duplication, stacking.
- Text tests: mixed formatting, Unicode, long words, multiline labels, height growth,
  independent text color, and safe SVG rendering.
- Interaction tests: routing finish/cancel, one undo per gesture, retained text
  selection, grid bypass, fixed new-object defaults, and preserved copy styles.
- Integration: legacy upgrade/Cancel/Save/undo, copy/reference identity, persistence
  rollback, and existing blank-paste undo/top-reference regressions.
- Targeted tests during implementation; full Python/JavaScript suites and both
  startup sanity gates before user testing.
- The user owns interactive testing. Do not launch a browser or real namespace
  server for agent UI testing. Fix feedback before any implementation commit.
- Commit implementation only after the user confirms testing and requests it.

## Deferred

Large symbol libraries, draw.io import/export, automatic obstacle avoidance,
auto-layout, visible containers, group resizing/rotation, a layers UI, freehand
sketches, richer text features, diagram-text search/AI, cross-namespace clipboard,
document garbage collection, and exact note caret restoration. Preserve the
embedded-document adapter as the extension point for future sketches.

## Implementation record

- Added v3 source/validation/rendering and draft-only legacy upgrades.
- Implemented explicit rounded routes, free/attached endpoints, click-to-draw,
  bend/segment/endpoint handles, and diagram-owned context commands.
- Added invisible movement groups, editor clipboard with connection remapping,
  stacking controls, and default-style isolation.
- Added rich-text overlay, per-run SVG formatting, wrapping/height growth, and the
  fixed properties panel plus independent grid/snap controls.
- New model, gesture, text-selection, shared renderer-fixture, schema, and saved
  copy/undo tests added. Automated suites and startup sanity gates pass.
- User confirmed testing and requested COMMIT CHECKPOINT on 2026-09-07, noting
  there are still things to fix. This is a progress checkpoint, not feature completion.
- Pre-checkpoint pytest: 1,182 passed. No agent browser/server UI tests or real
  namespace inspection were performed.
