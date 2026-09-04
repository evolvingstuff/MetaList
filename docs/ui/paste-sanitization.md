# External HTML Paste Sanitization

## Scope
- Applies to **system clipboard paste** and **drag/drop files**.
  - Pasting text, rich HTML, or an image while no note is selected creates a new top note and inserts the clipboard content there.
  - Pasting an internally copied MetaList note while no note is selected creates an empty top destination and fills it with the copied note, including its tags and descendants.
  - Paste in native text-entry controls (such as search inputs and modal fields) keeps normal browser behavior and never creates a note behind the control.
  - Dropping into the actively edited note embeds the image there.
  - Dropping an image anywhere else creates a new top note, then embeds the image there.
  - Dropping a PDF or other non-image file while a note is being edited attaches it to that active note, even when pointer hit-testing lands on note chrome instead of the inner editor.
  - Dropping any file while no note is selected creates a new top note, inserts its file reference, and saves the note.
  - For named image files, the user is prompted to either paste inline with compression or save the original file and insert its file UUID token.
- Internal MetaList note clipboard paste uses the dedicated
  `data-metalist-note-clipboard="true"` marker emitted only by the explicit
  **Copy note** action. Ordinary copied note content—including selected URLs—is
  treated as external clipboard content even when its HTML contains the shared
  `note-content` CSS class.
- The structural note clipboard is process-local. If a server restart expires it,
  note paste reports that the note must be copied again instead of returning an
  internal-server error.

## Entry Points
- Clipboard/drop handler: `app/static/js/modules/mode-manager/events/keyboard-events.js`
  - `handleDragOverEvent(...)`
  - `handleDropEvent(...)`
  - `handlePasteEvent(...)`
- Sanitizer service: `app/static/js/modules/mode-manager/services/html-paste-sanitizer-service.js`
  - `sanitizeAndInsertExternalPaste(event)`
  - `sanitizeExternalClipboardHtml(rawHtml)`

## Pipeline
1. Resolve the paste destination: the active editor, a new top note when no note is selected, or native browser handling for a text-entry control/modal.
2. If clipboard contains image/file items (`image/*`), pick the largest image candidate and either paste it inline or save it as a file, depending on the image-file choice prompt.
3. If a drag/drop payload contains image files, either embed them inline or save them as files after resolving the target note (current editor or a new top note).
4. Downscale/re-encode to keep embedded payload in the configured KB range.
5. Build inline `<img src="data:image/...">` HTML (embedded content, not file links).
6. Otherwise read `text/html` from clipboard.
7. Parse with `DOMParser`.
8. Walk DOM and sanitize nodes/attributes/styles/URLs.
9. Remove paste-only academic citation artifacts: unwrap Distill `d-cite`, remove `d-footnote`, and remove standalone numeric citation markers such as `[6]`.
10. Normalize soft-wrapped prose line breaks from clipboard HTML into spaces, including hyphenated visual wraps such as `non-\nAC0`.
11. Convert meaningful literal CR/LF text-node breaks from clipboard HTML into `<br>` nodes, while ignoring formatting-only indentation whitespace. Consecutive unbulleted lines are preserved when at least three lines overwhelmingly begin like distinct titled/list items, matching YouTube descriptions that encode a list inside one `<span>`.
12. Restore flattened timestamp-link runs from sources like YouTube descriptions by inserting breaks before later timestamp anchors in the same block, while recognizing breaks inside adjacent inline wrappers so one source newline never becomes two rendered breaks.
13. Recompress any pasted external HTML `data:image/...` sources through the same embedded-image footprint controls used for direct image paste/drop.
14. Insert sanitized HTML into the resolved destination.
15. If no usable HTML remains, fallback to `text/plain`.
16. Before sanitized HTML enters the editor, remote HTTP(S) `<img>` sources are registered with the authenticated in-memory proxy and replaced with opaque same-origin proxy references. The editor displays the fetched image through a temporary `blob:` URL, while storage sanitization restores the original remote URL in the encrypted note content.

## Security Policy

### Blocked tags
- `script`, `style`, `iframe`, `object`, `embed`, `applet`, `meta`, `base`, `link`, `svg`, `math`, `form`, `input`, `button`, `textarea`, `select`, `option`, `template`, `noscript`

### Attribute rules
- Remove all `on*` event handlers.
- Remove `id`, `class`, and all `data-*`.
- Remove `srcset`.
- Sanitize URL-bearing attributes (`href`, `src`, `xlink:href`, `action`, `formaction`, `poster`, `background`, `cite`, `longdesc`).

### URL rules
- Dangerous prefixes are rejected, including encoded forms (`javascript:`, `vbscript:`, `file:`, `filesystem:`, `data:text/html`, `data:application/*`).
- Allowed `href` schemes: `http`, `https`, `mailto`, `tel`.
- Allowed `src` schemes: `http`, `https`, `blob`, and safe `data:image/*;base64,...`.
- Relative URLs and anchors are preserved.

### Data image size cap (browser-side)
- Config key: `app/static/js/modules/config.js`
  - `CONFIG.PASTE.MAX_DATA_IMAGE_BYTES`
- Current default: `10_485_760` bytes (10 MiB estimated decoded payload).
- For general URL sanitization, oversized `data:image` URLs are removed.
- For pasted external HTML `<img src="data:image/...">`, recognized image payloads are allowed through initial attribute sanitization so they can be recompressed first; if recompression still cannot get them under the hard cap, the image is removed.

### Embedded image footprint controls
- Config keys:
  - `CONFIG.PASTE.EMBED_TARGET_IMAGE_BYTES` (target compressed size, default `350_000`)
  - `CONFIG.PASTE.EMBED_MAX_DIMENSION_PX` (initial resize cap, default `1_600`)
  - `CONFIG.PASTE.MAX_CLIPBOARD_IMAGE_BYTES` (input guardrail, default `31_457_280`)
- Behavior:
  - encode attempts use lossy formats and quality steps
  - dimensions are reduced iteratively when needed
  - if target is not reached but output is still under hard max, best effort output is used
  - if output exceeds hard max, paste is rejected with an error.

### Embedded image behavior
- Clipboard image-pixel paste is embedded into note content as `data:image/...` (no `file://` links).
- With no selected note, clipboard image-pixel paste creates and immediately saves a new top note.
- Named image files from paste/drop can instead be preserved as file attachments via the image-file choice prompt.
- Pasted external HTML that already contains inline `data:image/...` sources is recompressed before insertion, so copied rich content does not bypass the embedded-image size controls.
- Pasted HTML containing remote HTTP(S) image references keeps the original URL in encrypted note content; MetaList never copies those image bytes into databases or backups.
- Browser CSP prevents direct remote image requests during paste/editing. During paste and active editing, MetaList registers remote sources before displaying them; storage serialization restores the original URL instead of persisting temporary proxy or `blob:` references. In view mode, MetaList removes remote `src` values from rendered output and emits only opaque same-origin proxy paths. Both editor and view hydration fetch those paths with the tab-bound session header and display in-memory `blob:` URLs. The proxy revalidates public network targets across redirects, caps transfers at 10 MiB and decoded dimensions at 16 megapixels, validates supported image formats, returns `no-store` responses, and persists no image bytes.
- Embedded images remain stored with note content, so they are portable across machines with the DB.
- If the user chooses `Save as File` in the image-file prompt, the original file is uploaded without inline recompression and the editor receives the file UUID token instead.
- In view mode, embedded image-file references render as an authenticated image preview with a `download image` control beneath it instead of the generic file card used for non-image attachments.
- In collapsed notes, embedded image-file references fall back to a compact thumbnail-only view so the host note still collapses to a single visual line.
- If clipboard only contains file-reference metadata (for example Finder file-icon copy) rather than image bytes, paste is blocked with an error instead of inserting icon-preview HTML.

## Formatting Preservation Policy

### Kept (allowlist)
- Text styles: `white-space`, `font-weight`, `font-style`, `text-decoration`, `text-decoration-line`, `vertical-align`
- Block indentation styles (block tags only): `margin-left`, `padding-left`, `text-indent`
- Image box styles (`img` only): `width`, `height`, `max-width`, `max-height`
- Meaningful literal CR/LF inside pasted HTML text nodes is preserved as line breaks, for sources such as YouTube descriptions that put visible structure in raw newlines instead of block tags.
- Unbulleted YouTube description lists keep one item per line even when every item lives in a single inline text node.
- Flattened timestamp-link runs from sources such as YouTube descriptions are restored into one timestamp entry per line without adding blank lines between entries, including when the source wraps each link and description in separate inline spans.
- Soft line wraps inside prose are collapsed to spaces so copied abstracts from sources such as arXiv do not paste with visual-wrap breaks in the middle of sentences.
- Numeric `vertical-align` values are retained for inline spans so copied math superscripts/subscripts can preserve their visual position.

### Rejected
- Any style containing dangerous payloads (`url(...)`, `expression(...)`, `@import`, encoded entity escapes, angle-bracket/backtick payload chars, etc.).
- Hidden content wrappers:
  - `hidden` attribute
  - `aria-hidden="true"`
  - inline style with `display:none` or `visibility:hidden`
- Paste-only academic citation artifacts:
  - Distill `d-footnote` bodies
  - standalone numeric citation markers such as `[6]`

## Avatar Clamp Heuristic
- Goal: keep thread avatars from dominating pasted comment content.
- Behavior:
  - Detect likely avatars from a weighted signal model:
    - avatar/profile/snoo-like hints in `class`/`alt`/`src`/`id`/`aria-label`
    - repeated image source frequency
    - small square-ish declared dimensions
    - nearby author/time metadata in DOM-order context
  - Clamp matched avatars to `48px x 48px`.
- Implementation detail:
  - Avatar detection runs **before** attribute stripping, then clamp is applied after attribute sanitization.

## General Image Clamp
- All pasted images are normalized to:
  - remove incoming `width`/`height` attributes
  - enforce `max-width: 100%`, `width:auto`, `height:auto`.
- Goal: prevent giant pasted icon/preview markup from dominating the editor.

## Tests
- Unit tests: `tests/unit/html_paste_sanitizer_service.test.mjs`
- Unit tests: `tests/unit/embedded_image_service.test.mjs`
- Validation command:
  - `node --test tests/unit/html_paste_sanitizer_service.test.mjs tests/unit/embedded_image_service.test.mjs`
