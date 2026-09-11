# Note Content Formatting (Meta Tags)

## Overview
- Note content is stored as HTML (`notes.content`).
- The server can apply **view-only** formatting transformations based on **meta tags** (tags starting with `@`) in the tag bar (`notes.tags`).
- **Editing vs viewing:**
  - When a note is being edited by the current client, the server sends **raw content** so all delimiters remain visible.
  - Otherwise the server sends **rendered view HTML**, which may consume delimiters and wrap regions in styling spans.
  - Embedded note references use `![[UUID]]` and are rendered only in view mode.
- `⌘ + U` removes formatting and inline imagery from the selected range, or from the entire active note when no text is selected. Range removal deletes intersecting inline images and splits scoped delimiters around the selection so the surrounding text keeps its styles. Whole-note removal strips rich-text HTML and all inline images while preserving links, and removes the visual and renderer meta tags offered by Add Style. Visible line and paragraph breaks remain intact, including literal newlines previously rendered by `white-space: pre-wrap` formatting.
- A delimiter remains when another surviving wrapped tag still uses the same bracket type and depth. Semantic tags such as `@todo`, credential tags, comments, and ordinary tags are preserved.
- The actively edited note's context menu exposes the same selection-aware operation as **Remove Formatting**, directly beneath **Add Style**.

## Embedded Note References
- Syntax: `![[UUID]]`
- In **view mode**, the token renders as an embedded note block:
  - It always renders as a block on its own visual line, even when written inline (for example `blah ![[UUID]] yada`).
  - The referenced note's full child subtree is rendered inside the embed.
  - Embedded rendering ignores the referenced note's collapsed/expanded state.
  - A collapsed host shows the embed as a compact source-note link instead of rendering its contents.
  - An expanded embed ends with a `↗ title` link to the source note; compact references use the same visual language, and the arrow tooltip reads `Link to reference source`.
  - Missing UUIDs render a "missing reference" marker.
  - Circular reference chains render a "circular reference" marker and stop at that point.
- In **edit mode**, the token remains literal text (`![[UUID]]`).
- Full reference behavior and shortcut workflow: `docs/ui/references.md`.

## Links In View Mode
- Bare `http://...` and `https://...` text in rendered note content is auto-linked in view mode.
- Standalone bare URLs can render as compact cached title links (`title · domain`) when the server already has a successful title fetch for that URL.
- Compact note-reference previews reuse the same standalone URL rule, including collapsed embeds and expanded embed source links.
- Unknown, failed, unsupported, or inline URLs render as raw URL links exactly as before. Failed standalone lookups can expose their status/retry timing through the browser's normal hover tooltip.
- Title fetches are server-side background work; note rendering never waits on network I/O, and edit mode always shows the original stored URL. When background fetches complete, the server increments a link-title revision exposed by `/api2/auth/status`; the browser polling loop batches those changes and triggers a view refresh so newly resolved titles appear without a manual page reload.
- Title extraction is generic HTML metadata parsing (`og:title`, `twitter:title`, `meta name=title`, `itemprop=name`, and `<title>`). It does not use domain-specific APIs.
- Challenge/interstitial titles such as verification, browser-check, or access-denied pages are treated as `no_title` and cleared from existing cache rows on startup/login so they fall back to the raw URL instead of being displayed as valid page titles.
- Existing rendered anchors are normalized to open in a new browser tab.
- Internal hash-style anchors used by MetaList note-reference UI are left unchanged so in-app reference navigation still works.

## Content Wrappers
- Wrappers in note content are semantic markup regions:
  - `{{...}}`, `[[...]]`, `((...))`
  - Depth 1–3 is supported (e.g. `{{{...}}}`).
- Wrappers in content are **only consumed/hidden** in view mode when there is a matching *scoped wrapper tag* in the tag bar.
- If there is **no matching scoped wrapper tag**, wrappers are treated as literal text and remain visible even out of edit mode.
- When a matching `[[...]]` scoped wrapper tag is active, that wrapper is treated as formatting syntax instead of a UUID link reference. `![[UUID]]` still renders as an embedded reference.

Scoped wrapper tags do not need to be meta tags:
- Example: tag bar `[foo]` causes all `[...]` regions in the note to render without the brackets in view mode.

## Meta Tags

### Global meta tags
- A meta tag with no wrapper applies to the entire note content.
- Example: `@red` makes the whole note red.

### Scoped meta tags
- A wrapped meta tag applies only to content wrapped with the same bracket **type** and **depth**.
- Examples:
  - Tag bar: `{{@monospace}}` → applies to `{{...}}` regions.
  - Tag bar: `[[[@red]]]` → applies to `[[[...]]]` regions.
- Depth must match exactly:
  - `[[...]]` matches `[[@tag]]`
  - `[[...]]` does **not** match `[@tag]` or `[[[@tag]]]`
- A selected scope may cross multiple editor blocks/lines. View rendering closes and reopens visual formatting spans at each block boundary so every selected line keeps the style without producing invalid HTML.

Multiple tags can appear inside the same wrapper token (space-separated), and all recognized meta tags apply:
- Example: `{{@red @monospace}}`

Other (non-meta) tags may also appear inside wrapper tokens (e.g. `{{foo bar}}`). Those tags are currently inert for formatting, but the presence of the wrapper token still enables consuming the matching content delimiters in view mode.

### Nesting
- Scoped regions can be nested within each other.
- If the tag bar contains multiple scoped meta tags, the rendered view content may contain nested spans.
- Crossing basic-format scopes are supported as well. A range such as `[[bold {both]] italic}` is rendered by closing and reopening the crossing style so the overlap becomes valid nested HTML.

## Initial meta tags
- `@monospace`: renders the (scoped) region using a monospace/code font.
- `@red`: renders the (scoped) region in red.
## Basic formatting tags
- `@heading`: increases font size and weight.
- `@bold`: renders bold text.
- `@italic`: renders italic text.
- `@strikethrough`: renders struck-through text.
- `@serif`: renders with a serif font.
- `@green`: renders text in green.
- `@blue`: renders text in blue.
- `@grey`: renders text in grey.
- `@highlighter`: adds a fluorescent-yellow, slightly irregular marker stroke behind the text.
- Ontology implication rules can add these formatting tags implicitly (e.g. `bug => @red`).

## Footnotes
- `@footnote` is scoped only: an unwrapped `@footnote` has no effect on the whole note.
- Example: content `blah{{foo}}` and tag bar `{{@footnote}}` renders `blah` with a superscript `[1]`, followed by an always-visible **References:** section containing `[1]: foo`.
- Numbers follow first appearance within each note and update automatically. Identical footnote text reuses its first number and reference row, including across scopes with different visual styles; the first occurrence determines the reference styling. Links or images with different destinations remain separate references.
- Footnote and AI-reference sections use smaller body text, regular-weight reference numbers, and lighter headings; inline citation numbers use medium-weight superscripts.
- Clicking a superscript smoothly scrolls to and focuses its reference in that same rendered note. Collapsed previews retain the first line’s footnote markers; clicking one expands the note before scrolling to its reference. The References section stays hidden while collapsed. Reduced-motion preferences disable the smooth animation.
- URL-only link labels in reference bodies use the existing cached `title · domain` display, including plain URLs, Markdown links, and pasted HTML links. Missing titles enqueue the usual background fetch and appear on a subsequent view refresh when available; custom link labels remain unchanged.
- Reference bodies preserve rich content and render Markdown links without requiring `@markdown` on the whole note. Scoped visual styles and selections across paragraphs are supported.
- Spaces immediately before footnotes are hidden in view mode: `and even {{moar stuff}}` renders as `and even` immediately followed by its superscript. For scopes mixed with ordinary text, line breaks and spaces after the marker remain intact.
- A line or paragraph containing only a footnote attaches its marker to the preceding visible paragraph. Consecutive footnote-only lines attach to the same paragraph; empty continuation blocks of long footnotes are removed. The following prose keeps one paragraph break, without accumulating empty lines. A footnote at the start of a note keeps its marker in place. The original line and paragraph layout remains unchanged while editing.
- While editing, all original content, spaces, and delimiters remain visible; generated numbers and References are never stored in the note.
- Select text while editing, then right-click → **Add Style → Footnote**. The action reuses an existing dedicated footnote scope when available. It is hidden without a selection.
- **Remove Formatting** also removes footnote tags/scopes and leaves their original text in place.

## Size meta tags
- `@size=0.1`, `@size=0.25`, `@size=0.5`, `@size=0.75`, `@size=1.0`, `@size=1.25`, `@size=1.5`, `@size=2.0`, and `@size=3.0` scale the whole note or matching scoped region in view mode without modifying image bytes or file metadata.
- Inline-image context menus expose **Make Bigger**, **Make Smaller**, and **Reset Size** in both edit and view modes. View mode refreshes immediately; edit mode shows the updated raw delimiters and numeric tag.
- Stored image-file embeds expose the same actions in view mode. Reset removes `@size` and removes delimiters only when no surviving tag owns that scope.

## List meta tags
- `@list-bulleted`: renders the note's immediate children as a bulleted list in view mode.
- `@list-numbered`: renders the note's immediate children as a numbered list in view mode.
- Only direct children are affected (grandchildren are not).

## Credential meta tags
- `@username`: renders the note content as a credential row (user icon + "Username:") in view mode; the value is click-to-copy.
- `@password`: renders the note content as a credential row (lock icon + "Password:") in view mode; the value is blurred and click-to-copy.
- These are view-only: in edit mode you see just the raw value.

## Email meta tags
- `@email`: renders the note content as an email row (envelope icon + "Email:") in view mode.
- Clicking the value opens the system email client (`mailto:`).

## Status meta tags
- `@todo`: renders the note content with an unchecked box icon in view mode; clicking the icon toggles the tag to `@done`.
- `@done`: renders the note content with a checked box icon in view mode; clicking the icon toggles the tag to `@todo`.

## Markdown meta tags
- `@markdown`: renders the note content as Markdown in view mode on the server.
- Scoped Markdown renders only the matching wrapped region.
- Fenced `mermaid` blocks render as responsive SVG diagrams in the app. The pinned Mermaid runtime loads locally and only when a visible note contains a Mermaid fence; no diagram source is sent to a CDN or external service.
- Mermaid uses strict security mode and follows the active light/dark theme when rendering. Invalid Mermaid syntax remains visible as a code block with an `Invalid Mermaid diagram` badge.
- Paired LaTeX delimiters inside Markdown render automatically as server-side MathML: `\(...\)` and `$...$` are inline; `\[...\]` and `$$...$$` are display math.
- Math detection skips inline code and fenced code blocks. Unpaired delimiters and currency-like dollar text remain literal.
- Explicit scoped LaTeX such as content `(((\frac{1}{2})))` with tag-bar token `(((@LaTeX)))` remains supported and can coexist with automatic math in the same Markdown note.
- Collapsed notes still render a one-line preview; oversized heading styles are normalized in that preview so the first line remains visible and thumbnail behavior for images is preserved.
- For collapsed previews where the first visible content includes an image, the image thumbnail is intentionally larger (about 3x the baseline collapsed height) to keep image context readable.

## LaTeX meta tags
- `@LaTeX`: renders the note content as LaTeX on the server in view mode.
- The server emits final MathML directly, so normal app rendering and HTML export use the same rendered output.
- Invalid LaTeX shows a red "Invalid LaTeX" badge and the raw content.
- Inline math uses `$...$`; display math uses `$$...$$`.
- If no `$` delimiters are present, the entire note is rendered as display math.

## Shell meta tags
- `@shell`: renders the note content as a terminal-style script block in view mode.
- Scoped shell rendering applies only to the matching wrapped region.
- Shell execution requires a `--enable-shell` launch, a loopback client, and password protection on the active namespace. Otherwise, clicking the block shows an inline error and no process is started.
- In a password-protected namespace, clicking the block starts a background shell session on the connected server and streams stdout/stderr inline while it runs.
- Finished shell feedback stays inline until the user dismisses it with the `Close` button in the output header.
- The transport is cross-platform (Windows/macOS/Linux), but the script itself still runs inside the server host's shell, so command syntax must match that host environment.

## JSON meta tags
- `@json`: parses the note content as JSON and pretty-prints it in view mode.
- Scoped JSON rendering applies only to the matching wrapped region.
- Invalid JSON shows a red "Invalid JSON" badge and the raw content.

## CSV meta tags
- `@csv`: parses the note content as CSV and renders it as a table in view mode.
- Invalid CSV shows a red "Invalid CSV" badge and the raw content.
- Scoped wrappers (e.g. `((@csv))`) render only the wrapped region as a CSV table.
