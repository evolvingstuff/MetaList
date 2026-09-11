# UUID References

## Status
- Implemented reference syntaxes:
  - `![[UUID]]` = embedded mode
  - `[[UUID]]` = link mode
- If the note has a matching `[[...]]` scoped wrapper tag (for example `[[@LaTeX]]`), `[[...]]` is parsed as content formatting instead of link mode. Use `![[UUID]]` for embedded references in that case, or use a different formatting wrapper delimiter.
- A UUID can resolve to:
  - a note
  - a file attachment
  - an editable document (currently diagrams; see `diagram-widgets.md`)

## Rendering Rules
- **View mode**:
  - Note targets:
    - `![[UUID]]` renders the referenced note as an embedded block with its complete descendant subtree whenever the host note is expanded. Saved collapse states on the referenced root or any descendant are ignored inside the embed.
    - `[[UUID]]` renders a compact link-style block showing only the referenced note's first line.
    - when the host note is collapsed, both note-reference modes render as a single compact link row showing the referenced note's first line; an embed never expands inside a collapsed host.
    - compact source previews retain first-line footnote superscripts, including markers attached from standalone footnote lines, without showing the reference bodies. The preview and its superscripts share the existing source-navigation link.
    - an expanded embed begins with an arrow-only `↗` link (tooltip: `Go to reference source`) that opens the source note in a temporary reference-source context. All embedded content shares a small left inset for that arrow; there is no footer link. Compact references retain their `↗ title` link.
    - when a note contains only one note reference (including ordinary editor wrappers/whitespace), the entire note uses the reference background and the reference has no separate inner panel. References mixed with other content keep their panels. Nested references retain their own panels.
    - a source note with incoming note references has a `↖` button (tooltip: `Show backlinks — notes referencing this source`). It opens a temporary **Referenced by** view containing every referring note once, across the namespace, with normal ancestor/descendant context. Both link and embedded references count; formatting scopes and self-references do not. The arrow remains available while collapsed and disappears when the last incoming reference is removed.
    - when that compact source preview is a standalone URL with a cached link title, it displays the same `title · domain` treatment as the source note instead of the raw URL. Inline/prose URLs remain raw.
    - right-click anywhere inside a rendered reference and choose **Go to Source** to open that source note with the same navigation behavior.
  - File targets:
    - non-image files render a file card/link row with a deterministic type badge (`PDF`, `IMG`, `VID`, `TXT`, etc.) and the file title.
    - embedded image files (`![[UUID]]`) render an authenticated image preview with a `download image` control beneath it.
    - right-clicking the rendered image preview also offers image actions (`Copy Image`, `Save Image`, `Zoom Image`, `Open Image in New Tab`).
    - link-mode image files (`[[UUID]]`) keep the generic compact file card/link row.
    - clicking the rendered file reference downloads the decrypted file from the server.
    - when the host note is collapsed, non-image file references stay visible as a single compact row showing the badge and a truncated title.
    - when the host note is collapsed and the first visible line is an embedded image file, the note collapses to a compact thumbnail-only version of that image preview.
  - Rendered references have no internal expand/collapse or embed/link controls; edit the raw token to change between `![[...]]` and `[[...]]`.
  - The embed always renders on its own visual line (block), even when written inline.
  - The referenced note's child subtree is included.
  - Embedded notes have no inner collapse controls; the host note owns the only collapse behavior for the rendered reference.
  - Clicking a link-mode reference opens a temporary reference-source context for that note (it does not enter edit mode on the target note). The internal UUID query stays hidden from the search input; the `Reference source` indicator identifies the context, and its `×` returns to the originating context.
- **Edit mode**:
  - Note/file tokens remain literal raw text (`![[UUID]]` or `[[UUID]]`).
  - Editable-document tokens render as clickable noneditable previews. Saving note
    text restores their tokens; clicking opens the full-screen Save/Cancel editor.
  - Saved-file image actions are not available from the raw token; they are available once the token renders as an image preview in view mode.

## File Attachment Workflow
- `Attach file…` in the command palette opens the native file picker.
- If you are editing a note, the selected file is uploaded and its `![[UUID]]` token is inserted into that note.
- If no note is active, the app creates a new note first, then inserts the file reference there.
- Drag/drop follows the same attachment path for non-image files.
  - Dropping onto the actively edited note inserts into that note.
  - Dropping anywhere else creates a new top note first, then inserts there.
- Named image files dropped or pasted into the editor prompt for one of two paths:
  - `Paste Inline`: embed the image into note HTML as compressed `data:image/...`.
  - `Save as File`: upload the original file without recompression and insert its `![[UUID]]` token.
- Pasting a named image while no note is active uses the same prompt and creates the destination note at the top.
- Clipboard image-pixel paste with no meaningful source filename keeps the direct inline embed path by default.
- The attach flow saves the note immediately after insertion so the new reference survives refresh/reload.
- Files live in a sibling SQLite database derived from the main DB path (`*.files.db`).
- Startup only loads the file UUID registry into memory; file metadata/blob rows are decrypted on demand for rendering/download.

## Failure / Safety Cases
- Missing or deleted UUID: render a "missing reference" marker (subtly red-tinted).
- Circular chain (A -> B -> A): render a "circular reference" marker and stop recursion at that point.
- Removing every note reference to a file does not delete the file automatically.
- `Trim unused files` is the explicit cleanup path for unreferenced file rows.

## Keyboard Workflow
- `Cmd/Ctrl + C` with no text selection copies a note (server clipboard + system clipboard payload).
- `Cmd/Ctrl + R` while editing copies as embedded reference (`![[UUID]]`) using the most recently copied note UUID.
- Insert behavior:
  - The token is inserted on its own line.
  - If caret is in the middle of a line, the line is split around the inserted reference.

## Search Semantics
- Embedded references are a **view transform**, not a search expansion.
- Referenced note tags do **not** affect search matching for the host note (neither positive nor negative).
- Host note search behavior continues to use host note content/tags plus existing inheritance/ontology rules.
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
- `docs/ui/content-formatting.md`
- `docs/ui/command-palette.md`
- `docs/ui/controls.md`
- `docs/ui/search-semantics.md`
- `docs/design/differential-view-protocol.md`
