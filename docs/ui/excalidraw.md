# Excalidraw Diagrams

Hand-drawn diagrams drawn with the Excalidraw editor, stored as `.excalidraw` file attachments.

## Storage
- A diagram is an ordinary file attachment in `*.files.db` whose file kind is `excalidraw` (MIME type `application/vnd.excalidraw+json` or the `.excalidraw` extension). Notes reference it with `![[UUID]]` like any other file; `[[UUID]]` shows the usual compact file card.
- Diagrams are the only attachments MetaList replaces in place. Every save increments the file's `content_revision`; a save that names a stale revision is refused (HTTP 409) so a second window cannot silently overwrite the first. Other attachments stay immutable.
- Database version 10 adds the revision column and the `file_previews` table to `*.files.db` (migration 9→10, `app/db/editable_files_migration.py`).
- Two SVG previews, `light` and `dark`, are rendered in the browser when the editor closes and stored encrypted in `file_previews`, keyed by file and variant and tagged with the revision they were rendered from. Encryption changes, restores, and file trimming treat them like file content (deleting a file deletes its previews).
- Previews are transparent unless the drawing has its own canvas colour, so they sit on the note background in either theme.
- Excalidraw runs from a vendored, locally built bundle (`app/static/js/vendor/excalidraw-0.18.1.min.js` plus its assets). There is no Node server, no CDN, and no change to the Content Security Policy. See `scripts/vendor/excalidraw/README.md` and `docs/security/supply-chain.md`.

## View Mode
- `![[UUID]]` for a diagram renders the stored preview for the current theme as an `<img>` (never inline SVG). The editor bundle is not loaded until a diagram is opened for editing.
- Hovering a diagram outlines it; its tooltip reads `Double-click to edit the diagram`.
- A single click anywhere on a diagram edits its note, as a click on the note's text does. It waits out the double-click window first (400 ms, `DIAGRAM_SINGLE_CLICK_EDIT_DELAY_MS` in `mouse-events.js`): in edit mode the diagram shows only as its reference, so editing at once would take the diagram away from the second click of a double-click. A double-click opens the diagram editor, and the note never enters edit mode on the way. A press-and-drag that starts on a diagram moves the note. Full-screen notes and floating windows stay read-only. `BROWSER_TEST_SUITE=diagram-clicks` checks all three.
- Placeholders: `Loading diagram...`, `Empty diagram. Double-click it to start drawing.`, `This diagram has not been rendered yet. Double-click it to open the editor.` (no preview stored yet), and `Diagram preview unavailable` (request failed).
- Size uses the same size wrapper and size tag as saved images (`Make Bigger`, `Make Smaller`, `Reset Size`).
- When the host note is collapsed and the diagram is its first visible line, it collapses to a compact thumbnail of the whole diagram for the current theme, like an image. Compact references to that note (link mode, or an embed inside a collapsed note) show the same thumbnail after their `↗`; clicking it opens the source note.
- HTML export embeds the light preview as a data URL, or a file card if the diagram was never rendered.
- Full-screen notes and floating windows show diagrams too; editing is started from the main view.

## Edit Mode
- The note editor shows only the raw `![[UUID]]` token. The diagram's JSON is never edited as note text.

## Opening the Diagram Editor
- Double-click a rendered diagram, or right-click it and choose **Edit Diagram**.
- To add one, choose **Add Excalidraw Diagram** from the right-click menu while editing a note, or `Add Excalidraw diagram` in the command palette. An empty diagram is attached to the note being edited (or a new note when none is) and the editor opens immediately.
- The editor covers the window. Its bar shows the save status, **Discard changes**, and **Done**.

## Saving and Closing
- Changes autosave 2 seconds after drawing stops, one save at a time. The bar shows `Unsaved changes`, `Saving…`, `All changes saved`, or `Could not save. Retrying…` (failed saves retry after the same delay).
- **Done** or `Cmd/Ctrl+Enter` saves anything pending, renders and stores both previews, closes the editor, and refreshes every copy of the diagram on screen. If a save cannot complete, the editor stays open and says so.
- `Escape` belongs to Excalidraw (for example to cancel a tool) and never closes the editor.
- **Discard changes** needs a second click within 4 seconds. It restores the diagram and previews exactly as they were when the editor opened, then closes.
- If another window saves the same diagram, autosave stops with a message to close and reopen the diagram. Done then closes without overwriting the other save; Discard leaves the other window's version in place.
- Closing or reloading the browser tab with unsaved changes asks for confirmation.
- While the editor is open, MetaList keyboard shortcuts, clicks, and context menus are disabled so they reach Excalidraw instead.
- Excalidraw's own file open/save and theme toggle are hidden; the editor follows the app theme.

## Undo
- Opening the editor starts an editing session on the server, which keeps a snapshot of the diagram and its previews.
- **Done** ends the session and records it as a single MetaList undo step, however many autosaves it contained. `Cmd/Ctrl+Z` in the main view restores the diagram and previews as they were when the editor opened; redo restores the finished drawing. Undo inside the editor is Excalidraw's own, step by step.
- No undo step is recorded when the session changed nothing, when another window saved after it, or when it was discarded.
- Sessions live in server memory with the undo stacks: they are dropped when the app locks, the namespace changes, or undo history is reset, and after 8 hours or when more than 8 are open. A session dropped this way still keeps its saves; only its undo step is lost.
- A new diagram's first session records no step of its own: the step that inserted the diagram into its note covers it. One undo removes the diagram and returns the note to how it was; redo brings the diagram back as drawn. Later sessions each add their own step. (Previews of the empty drawing are stored before the editor opens, so a new diagram closed without drawing shows as empty.)

## Not Yet Supported
- Text inside diagrams is not searchable, not used for tags, and not sent to AI.
- Only the English Excalidraw UI is bundled, and the Liberation Sans and Xiaolai (CJK) fonts are left out.
- Excalidraw's AI features, Mermaid-to-diagram import, and collaboration are disabled.

## Related Docs
- `docs/ui/references.md`
- `docs/ui/controls.md`
- `docs/ui/command-palette.md`
