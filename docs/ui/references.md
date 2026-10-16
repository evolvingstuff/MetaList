# UUID References

## Status
- One syntax for note references: `[[UUID]]`. How it shows depends on where it is:
  - **Embed**: a note whose only content is the reference shows the source in place (its whole note is the embed).
  - **Link**: with any other content in the note, even an extra line, the reference is a link.
  - An older `![[UUID]]` to a note reads the same as `[[UUID]]`; the `!` changes nothing. MetaList writes `[[UUID]]` (⌘R, ⇧⌘R, Paste Reference Into Note).
- File references keep two forms: `![[UUID]]` shows the picture or diagram, `[[UUID]]` a file card.
- `[[...]]` containing exactly a note or file UUID is always a link, even when the note has a matching `[[...]]` scoped wrapper tag (for example `[[@LaTeX]]`); other `[[...]]` text is formatted by that wrapper, and links nested inside it still render.
- A UUID can resolve to:
  - a note
  - a file attachment

## Rendering Rules
- **View mode**:
  - Note targets:
    - **Embeds.** The note holding the reference shows the source in place, tinted blue (light `#afd7fb`; dark `#173350`), drawn exactly as the main tree draws notes: the same boxes, indent, spacing and ▾/▸ arrows. An embed inside an embed (a note in the source that is itself only a reference) is a shade deeper (`#96c8f7`, then `#7db8f2`; dark `#1d3f63`, `#244b76`).
    - The holder folds as its source: its ▾/▸ collapses or expands the source everywhere (the original in the tree and every other embed of it), and its own children with it. When the source is folded anywhere, the holder shows folded. Undo reverts both. A folded embed shows the source's first line as plain text, still tinted.
    - Each note inside an embed shows the collapse saved for it, with its own ▾/▸ where it can collapse; pressing it folds that note everywhere. A note being edited is saved and left first. Full screen and floating windows show no embed arrows.
    - The holder's own children (indented under it in the tree) show after the source's children, as notes of the level around the holder (white in the main tree). They belong to the holder, not the source: the source knows nothing of them, and they cannot be moved in among the source's children.
    - An embed's `↗` (tooltip: `Go to reference source`) sits at its top right and opens the source note in a temporary reference-source context.
    - **Links.** A link is underlined link text, the referenced note's first line, followed by `↗`, in the line where it is written; no panel. A link to a note that holds an embed reads as that embed's source's first line. Clicking it opens the source in a temporary reference-source context.
    - when the referenced note's first visible line is an image or Excalidraw diagram, a link shows the same thumbnail the collapsed source shows (plus any text on that line) instead of `(empty note)`. AI chat citations stay text-only.
    - link previews retain first-line footnote superscripts, including markers attached from standalone footnote lines, without showing the reference bodies.
    - a source note with incoming note references has a `↖` button at its top right (tooltip: `Show backlinks — notes referencing this source`). It opens a temporary **Referenced by** view containing every referring note once, across the namespace, with normal ancestor/descendant context. Links and embeds both count; formatting scopes and self-references do not. The arrow remains available while collapsed and disappears when the last incoming reference is removed. A holder with backlinks shows `↖ ↗` side by side.
    - Backlink membership and occurrence counts are cached in server memory alongside the note store. Hydration builds the index; content/accepted-tag changes, additions, deletions, and bulk-tag updates maintain affected entries. Collapse/expand and view refreshes reuse it without rescanning the namespace. Lock/reset clears it; restore/reload rebuilds it. Lists preserve current tree order and derive previews only for referring notes.
    - when a link's preview is a standalone URL with a cached link title, it displays the same `title · domain` treatment as the source note instead of the raw URL. Inline/prose URLs remain raw. Quoted-text search also matches cached titles of URLs in a note (`docs/ui/search-semantics.md`).
    - right-click anywhere inside a rendered reference and choose **Go to Source** to open that source note with the same navigation behavior.
    - An embed is a window onto its source: it can change how the source is shown (collapse), never what it says. Text, tags, to-do status and children are changed in the source (↗). Clicking anywhere in an embed edits the holder (its `[[UUID]]` shows). A `@todo` / `@done` checkbox inside an embed shows the status but is not a control: pressing it does nothing (it neither toggles nor edits the holder; a note being edited stays edited).
  - File targets:
    - non-image files render a file card/link row with a deterministic type badge (`PDF`, `IMG`, `VID`, `TXT`, etc.) and the file title. `.txt`, `.md`/`.markdown`, `.csv` and `.json` files are labelled by extension (`.TXT`, `.MD`, `.CSV`, `.JSON`) whatever MIME type the browser sent; other files by their kind.
    - embedded image files (`![[UUID]]`) render an authenticated image preview with a `download image` control beneath it.
    - right-clicking the rendered image preview also offers image actions (`Copy Image`, `Save Image`, `Zoom Image`, `Open Image in New Tab`).
    - link-mode image files (`[[UUID]]`) keep the generic compact file card/link row.
    - embedded Excalidraw diagrams (`.excalidraw` files, badge `DRAW`) render their stored light or dark SVG preview; double-click or right-click **Edit Diagram** to open the full-screen editor. See `docs/ui/excalidraw.md`.
    - clicking the rendered file reference downloads the decrypted file from the server; hovering it shows the tooltip "Click to download <file name>".
    - when the host note is collapsed, non-image file references stay visible as a single compact row showing the badge and a truncated title.
    - when the host note is collapsed and the first visible line is an embedded image file or diagram, the note collapses to a compact thumbnail-only version of that preview.
  - Rendered references have no embed/link controls: a reference is an embed or a link by where it is (alone in its note, or with other content).
  - Opening a source (`↗` or a link) uses a temporary reference-source context; the internal UUID query stays hidden from the search input; the `Reference source` indicator identifies the context, and its `×` returns to the originating context.
- **Edit mode**:
  - Note/file tokens remain literal raw text (`[[UUID]]`, or `![[UUID]]` for a file shown as its picture).
  - Saved-file image actions are not available from the raw token; they are available once the token renders as an image preview in view mode.

## File Attachment Workflow
- `Attach file…` in the command palette opens the native file picker.
- If you are editing a note, the selected file is uploaded and its `![[UUID]]` token is inserted into that note.
- If no note is active, the app creates a new note first, then inserts the file reference there.
- Drag/drop follows the same attachment path for non-image files.
  - Dropping onto the actively edited note inserts into that note.
  - Dropping anywhere else creates a new top note first, then inserts there.
- Dropped text files: a dropped `.txt`, `.md`/`.markdown`, `.csv` or `.json` file also gets its text as a new child note of the note holding its pill.
  - The child is the note's last child (after any existing children), in drop order when several files are dropped together.
  - Markdown children get `@markdown`, CSV children `@csv`, JSON children `@json`, text children no render tag; a child also gets the tags a new child gets from the current search.
  - The child starts expanded, so the dropped text is visible; collapse the pill note's children to hide it.
  - The child is an ordinary note: editing, moving or deleting it never changes the stored file, and the pill still downloads the original.
  - Files over 200 KB or not in UTF-8 keep only their pill; an info banner says why. Picking a file with `Attach file…` adds no child.
  - The text is stored line for line as escaped plain text (`<br>` between lines), never read as HTML.
  - Implementation: `app/services/file_text_preview.py`, `POST /api2/notes/file-preview-child/{note_id}` (`app/usecases/create_file_preview_child.py`), `dropped-file-preview-service.js`. Tests: `tests/unit/test_file_text_preview.py`, `BROWSER_TEST_SUITE=file-drop-previews npm run test:browser`.
- Named image files dropped or pasted into the editor prompt for one of two paths:
  - `Paste Inline`: embed the image into note HTML as compressed `data:image/...`.
  - `Save as File`: upload the original file without recompression and insert its `![[UUID]]` token.
- Pasting a named image while no note is active uses the same prompt and creates the destination note at the top.
- Clipboard image-pixel paste with no meaningful source filename keeps the direct inline embed path by default.
- The attach flow saves the note immediately after insertion so the new reference survives refresh/reload.
- `Add Excalidraw diagram` attaches a new, empty `.excalidraw` file the same way and opens the diagram editor.
- Files live in a sibling SQLite database derived from the main DB path (`*.files.db`).
- Attachments are immutable except Excalidraw diagrams, which the diagram editor replaces in place under a per-file content revision (see `docs/ui/excalidraw.md`).
- Startup only loads the file UUID registry into memory; file metadata/blob rows are decrypted on demand for rendering/download.

## Failure / Safety Cases
- Missing or deleted UUID: render a "missing reference" marker (subtly red-tinted).
- Circular chain (A -> B -> A): render a "circular reference" marker and stop recursion at that point.
- Removing every note reference to a file does not delete the file automatically.
- `Trim unused files` is the explicit cleanup path for unreferenced file rows.

## Keyboard Workflow
- `Cmd/Ctrl + C` with no text selection copies a note (server clipboard + system clipboard payload).
- A reference (`![[UUID]]`) to the most recently copied note pastes where the note itself would: `Cmd/Ctrl + R` as a sibling below the edited note (or into it, when it is empty with no children), like `Cmd/Ctrl + V`; `Shift + Cmd/Ctrl + R` as its first child, like `Shift + Cmd/Ctrl + V`. The new note is saved and selected with no caret. With no note selected, `Cmd/Ctrl + R` makes a new top note. The note menu's `Paste Sibling Reference` and `Paste Child Reference` do the same.
- `Paste Reference Into Note` (the note menu, last in `Paste`, offered when you right-click in the text of the note you are editing with a note copied) puts the reference inline: where you right-clicked, on its own line (a line is split around it; an empty line gets nothing extra), or in place of text you selected before right-clicking (a word the browser selects under the pointer does not count). The note stays in edit mode with the caret after the reference; one `Cmd/Ctrl + Z` removes it.

- Deleting or cutting a note that other notes reference (link or embed, to it or to any note under it, from outside it) asks first: *"N other notes reference this note. Delete it anyway? Their references will show as missing."* (or *Cut*). A note being edited is saved and left before the dialog shows (interaction principle 6); Cancel leaves it in place, Delete or Cut goes ahead, and one undo brings it back with its references working. An unreferenced note is deleted or cut at once.

## Search Semantics
- Both embedded (`![[UUID]]`) and linked (`[[UUID]]`) note references contribute non-meta tags from the source and its complete descendant subtree, including further references within that subtree. Tags inherited from ancestors above the source are excluded. The host retains tags inherited from its own parents, and its children inherit the host's effective tags normally. Accepted and proposed tags remain separate until combined for search.
- Required and excluded tag searches, tag suggestions, inherited-tag metadata, and Untagged Notes use these effective tags. Example: a source tagged `foo`, a reference to it, and a child beneath that reference all match `foo` and are excluded by `-foo`.
- For `foo → bar → baz`, referencing `bar` matches tags on `bar` and `baz`, without inheriting tags from `foo`. Searching for a tag on `baz` shows the reference host, and an expanded embed displays `bar → baz`. Canonical notes retain ordinary ancestor-tag inheritance; link-mode references retain compact rendering.
- References do not import source text for quoted-text searches, meta tags, or tag-bar comments. Ontology implications and text matchers still run per note after inheritance.
- Reference chains propagate transitively within each referenced subtree boundary. Cycles are valid; removing tags or references recomputes the affected dependency closure from direct tags so cycles cannot retain stale tags. Explicit references to ancestors contribute their subtrees normally. Missing/file targets, self-references, and formatting scopes do not supply note tags.
- Hydration caches effective tags in the note store/search index. Edits, bulk tag changes, moves, deletion, and restoration update the affected references and descendants; collapse and view refreshes reuse the cached tags.
- UUID link-click behavior:
  - The temporary source tab searches for the referenced UUID internally while leaving the search input visually empty.
  - Temporary reference mode is registered before activating the tab, so even nested reference navigation never briefly exposes an inherited UUID query in the search field.
  - A `Reference source` or `Referenced by` mode indicator identifies the temporary view. Clicking its `×`, or pressing Escape outside editing/overlays, returns to the originating context and closes the temporary tab. Deleting that inactive temporary tab preserves the restored context's rendered root window and infinite-scroll tracking. Following a source from a backlinks view stacks another temporary context, so returning restores the backlinks view first.
  - Typing in the search input dismisses reference-source mode and keeps the temporary tab as a normal search context.
  - Opening, replacing, or returning from reference views applies note changes immediately, without note appearance/disappearance or collapse animations.
  - Target note is included.
  - Target ancestors are included.
  - Target descendants are included (not redacted).
  - Non-matching sibling branches in visible context are redacted via normal search rules.

## Related Docs
- `docs/ui/excalidraw.md`
- `docs/ui/content-formatting.md`
- `docs/ui/command-palette.md`
- `docs/ui/controls.md`
- `docs/ui/search-semantics.md`
- `docs/design/differential-view-protocol.md`
