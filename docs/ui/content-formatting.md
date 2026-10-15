# Note Content Formatting (Meta Tags)

## Overview
- Note content is stored as HTML (`notes.content`).
- The server can apply **view-only** formatting transformations based on **meta tags** (tags starting with `@`) in the tag bar (`notes.tags`).
- **Editing vs viewing:**
  - When a note is being edited by the current client, the server sends **raw content** so all delimiters remain visible.
  - Otherwise the server sends **rendered view HTML**, which may consume delimiters and wrap regions in styling spans.
  - Embedded note references use `![[UUID]]` and are rendered only in view mode.
- `⌘ + U` removes formatting and inline imagery from the selected range, or from the entire active note when no text is selected. The editing context menu's **Remove Formatting** uses the same selection behavior. Range removal deletes intersecting inline images and splits scoped delimiters around the selection so the surrounding text keeps its styles. Fully selected headings and other presentational blocks become neutral blocks; their line boundaries and links remain intact, and unselected blocks retain their formatting. Leading/trailing whitespace inside a copied heading does not need to be selected. Partial block selections use plain-text spans to override inherited heading/block typography only on the selected words; surrounding text keeps its formatting and no extra line breaks are introduced. Those spans survive saving and follow the note-size preference. Whole-note removal strips rich-text HTML and all inline images while preserving links, and removes the visual and renderer meta tags offered by Add Style. It trims blank lines from both ends and reduces internal blank-line runs to at most one empty line (two line breaks); ordinary single line breaks remain unchanged. Visible line and paragraph breaks remain intact, including literal newlines previously rendered by `white-space: pre-wrap` formatting.
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
- Standalone bare URLs, pasted URL-only anchors, and Markdown URL-only links can render as compact cached title links (`title · domain`) when the server already has a successful title fetch for that URL. Custom link labels remain unchanged.
- Compact note-reference previews reuse the same standalone URL rule, including collapsed embeds and expanded embed source links.
- Unknown, failed, unsupported, or inline URLs render as raw URL links exactly as before. Failed standalone lookups can expose their status/retry timing through the browser's normal hover tooltip.
- Lookups are polite to each site (the hostname without `www.`): one request to a site at a time, at least 2 seconds apart, so a note full of links to one site does not trip its rate limit. A site that answers HTTP 429 (too many requests) is left alone for its `Retry-After` time (1 minute to 6 hours; 10 minutes when it gives none), and lookups of its other links wait until then without being recorded as failures. The rate-limited link itself is retried after 10 minutes, 1 hour, 6 hours, 1 day, then weekly.
- Lookups only run when a link is displayed, so failures in notes that are rarely viewed wait indefinitely; the command palette's `Retry failed link titles` asks all of them again (`docs/ui/command-palette.md`).
- Title fetches are server-side background work; note rendering never waits on network I/O, and edit mode always shows the original stored URL. When background fetches complete, the server increments a link-title revision exposed by `/api2/auth/status`; the browser polling loop batches those changes and triggers a view refresh so newly resolved titles appear without a manual page reload.
- While editing, the existing 500 ms inactivity check observes the current draft and requests title prefetch after it remains unchanged for at least 600 ms (typically 1–1.5 seconds after input). `POST /api2/notes/link-titles/prefetch` uses the same view-formatting eligibility and background fetch cache without saving the draft or replacing editor HTML. Identical drafts are requested once per editing session; typing and pasting restart the pause.
- Leaving edit mode always completes a view refresh, including when another view request is in flight. Title revision refreshes defer while editing, then require a refresh so slower lookups appear automatically without disturbing typing.
- Links to Reddit, YouTube (including `youtu.be`), Vimeo, TikTok, Spotify and SoundCloud first ask the site's public oEmbed service, the preview service those sites provide, for the title. It gives the real post or video title where the page itself is blocked for automated requests or built by JavaScript. The request is paced like any request to that site. A link that forwards elsewhere (a Reddit share link such as `/r/…/s/…` forwards to its post) is also looked up at each address it forwards to. When the service has no usable answer (not a post or video, removed, private), the page is read as for any other site. X is not included: its oEmbed service returns no title.
- Otherwise, title extraction is generic HTML metadata parsing (`og:title`, `twitter:title`, `meta name=title`, `itemprop=name`, and `<title>`).
- A title that is only the site's name ("Reddit" for reddit.com, "YouTube", "BBC" for bbc.co.uk, or the domain itself) says nothing the domain does not; it is treated as no title, so the link shows its URL (Reddit's URLs name the subreddit and post). Reddit's generic page titles ("Reddit - Dive into anything") count as no title too. Saved ones are cleared at the next login.
- Challenge/interstitial titles such as verification, browser-check, or access-denied pages are treated as `no_title` and cleared from existing cache rows on startup/login so they fall back to the raw URL instead of being displayed as valid page titles. So are login, consent and not-found pages, also when the site adds its name: a title is split at the site-name separators (`|`, `·`, `–`, `—`, and ` - ` with spaces) and is not a real title when a part is only a phrase such as "Sign in", "Log in", "Sign up" or "Page not found" ("Sign in - Google Accounts", "Log in | LinkedIn"), or when it contains "before you continue" (YouTube's consent page) or "log in or sign up". Titles that merely mention these words ("How to sign in to Gmail") are kept.
- Existing rendered anchors are normalized to open in a new browser tab.
- Clicking a rendered note link (including its title/domain spans) leaves the note in view mode; links do not initiate note dragging. Links inside the active editor keep normal editing behavior.
- Internal hash-style anchors used by MetaList note-reference UI are left unchanged so in-app reference navigation still works.

## Content Wrappers
- Wrappers in note content are semantic markup regions:
  - `{{...}}`, `[[...]]`, `((...))`
  - Depth 1–3 is supported (e.g. `{{{...}}}`).
- Wrappers in content are **only consumed/hidden** in view mode when there is a matching *scoped wrapper tag* in the tag bar.
- If there is **no matching scoped wrapper tag**, wrappers are treated as literal text and remain visible even out of edit mode.
- When a matching `[[...]]` scoped wrapper tag is active, `[[...]]` is formatting syntax, except that `[[UUID]]` containing exactly a note or file UUID is always a link. `![[UUID]]` still renders as an embedded reference.

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
- `@username`: renders the note content as a credential row in view mode: a user icon (hovering it says Username), then the value; the value is click-to-copy. Like `@password`, the note is never sent to the AI, and exports and prints hide it unless the user includes it.
- `@password`: renders the note content as a credential row in view mode: a lock icon (hovering it says Password), then the value; the value is blurred and click-to-copy. Exports and prints hide it as `••••••••` unless the user chooses to include passwords there.
- Text never runs out of its note, in MetaList, exports and prints: a word too long for the line (a token, a hash, a long URL) breaks at the note's edge, and code, `@json`, `@diff`, CSV and Markdown code blocks wrap their long lines, keeping spaces and indents, instead of scrolling sideways.
- These are view-only: in edit mode you see just the raw value.

## Email meta tags
- `@email`: renders the note content as an email row in view mode: an envelope icon (hovering it says Email), then the address.
- Clicking the value opens the system email client (`mailto:`).

## Status meta tags
- `@todo`: renders the note content with an unchecked box icon in view mode; clicking the icon toggles the tag to `@done`.
- `@done`: renders the note content with a checked box icon in view mode; clicking the icon toggles the tag to `@todo`.

## Markdown meta tags
- `@markdown`: renders the note content as Markdown in view mode on the server.
- Scoped Markdown renders only the matching wrapped region.
- Fenced code that names a language (```` ```python ````, ```` ```js ````, any language name or alias `@code=` accepts, in any case) is coloured as `@code=<language>` colours it, with the language label above the block. A fence with no language, or one naming plain text (`text`, `output`, `console`) or a language MetaList does not know, stays plain, with no badge. Fenced `mermaid` blocks are unaffected.
- Fenced `mermaid` blocks render as responsive SVG diagrams in the app. They use a compact layout (13 px labels and tight spacing between nodes and rows); diagrams are never capped or scaled to fit, so large ones keep all their detail. The pinned Mermaid runtime loads locally and only when a visible note contains a Mermaid fence; no diagram source is sent to a CDN or external service.
- Mermaid source remains ordinary stored note text. It stays searchable and can be included in AI note context when that note is otherwise permitted; this differs from text drawn inside an Excalidraw attachment.
- Mermaid uses strict security mode and follows the active light/dark theme when rendering. Invalid Mermaid syntax remains visible as a code block with an `Invalid Mermaid diagram` badge.
- Paired LaTeX delimiters inside Markdown render automatically as server-side MathML: `\(...\)` and `$...$` are inline; `\[...\]` and `$$...$$` are display math.
- Math detection skips inline code and fenced code blocks. Unpaired delimiters and currency-like dollar text remain literal.
- Explicit scoped LaTeX such as content `(((\frac{1}{2})))` with tag-bar token `(((@LaTeX)))` remains supported and can coexist with automatic math in the same Markdown note.
- Collapsed notes still render a one-line preview; oversized heading styles are normalized in that preview so the first line remains visible and thumbnail behavior for images is preserved.
- For collapsed previews where the first visible content includes an image, the image thumbnail is intentionally larger (about 3x the baseline collapsed height) and contains the complete image without cropping; unused space remains inside the compact preview when aspect ratios differ.

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

## Chess meta tags
- `@chess`: reads the note content as a FEN (Forsyth–Edwards Notation) position and draws it as a chess board in view mode, White at the bottom, files a–h and ranks 1–8 labelled. Example: `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1` is the starting position.
- Only the piece placement (the first field) is required. When the FEN has them, a caption under the board gives the side to move, the move number, castling rights and the en passant square.
- Pieces use the chess symbols of the system font, coloured white or black. Hovering a square shows its name and piece (for example "e4 white pawn").
- A FEN that does not parse shows a red "Invalid FEN" badge, what to fix, and the raw content.
- Scoped wrappers (e.g. `((@chess))`) draw a board for only the wrapped FEN, inside the surrounding text.
- One position per note or wrapper; whole games (PGN) are not supported.
- A hidden extra: typed in the tag bar, not offered in the Add Style menu.

## Diff meta tags
- `@diff`: shows the note content as a unified diff (what `git diff` and `diff -u` print) in view mode: added lines (`+`) green, removed lines (`-`) red, section starts (`@@ -1,3 +1,3 @@`) purple, file headers (`---`, `+++`, `diff --git`) grey and bold, unchanged lines plain.
- Lines jotted by hand with only `+`/`-` marks work too; nothing needs to parse, so there is no error state.
- Scoped wrappers (e.g. `((@diff))`) colour only the wrapped region.

## Code meta tags
- `@code=<language>`: shows the note content as source code with syntax highlighting in view mode, for example `@code=python`, `@code=javascript`, `@code=sql`. One tag for every language: any name or alias the server's highlighter (Pygments) knows works (`py`, `js`, `c++`, `c#`...), case-insensitively. The language name is shown above the code.
- An unknown language (`@code=pyhton`) shows the code plainly with an "Unknown language" badge.
- Scoped wrappers (e.g. `((@code=sql))`) highlight only the wrapped region.

## Mermaid meta tags
- `@mermaid`: the note content is one Mermaid diagram (no Markdown fence needed), drawn in view mode like a fenced `mermaid` block under `@markdown`, in its own block. Until it is drawn, and when it is invalid (with an `Invalid Mermaid diagram` badge), the source shows as a code block.
- Scoped wrappers (e.g. `((@mermaid))`) draw only the wrapped region.

## Paste format detection
- Pasting text in an unambiguous format tags the note for it at the moment of the paste (the tag appears in the tag bar; the text renders when the note leaves editing):
  - JSON (a complete object or array) → `@json`
  - a chess FEN position → `@chess`
  - a unified diff (with `@@` section lines, `---`/`+++` headers, or `diff --git`) → `@diff`
  - Mermaid starting with a diagram keyword (`graph TD`, `sequenceDiagram`, `gantt`...) → `@mermaid`
  - a fenced code block naming its language (```` ```python ````, ```` ```mermaid ````), alone or with text around it → `@markdown` (the fence says it is Markdown; a bare ```` ``` ```` or an unclosed fence is not enough)
  - a pure LaTeX block (`$$...$$`, `\[...\]`, or `\begin{...}...\end{...}`) → `@LaTeX`
  - code copied from VS Code (two lines or more) → `@code=<its language>`, from the language VS Code puts on the clipboard (`vscode-editor-data`): `@code=python`, `@code=bash` for shell scripts, `@markdown` for Markdown files; JSON that parses stays `@json`; plain text and unlisted languages get nothing
  - cells copied from a spreadsheet (Excel, Google Sheets, Numbers: an HTML table on the clipboard) → the cells as CSV text (commas, quoting cells that hold commas, quotes or line breaks) and `@csv`
- Into an otherwise empty note (or with all of its text selected), and when pasting creates a new note, the plain tag is added. Into a note with content, the pasted text is wrapped `((...))` and `((@json))` (etc.) is added, so the existing text is untouched.
- Nothing is added at once for anything uncertain (prose, JSON-looking text that does not parse); CSV-like, Markdown-like and code-like text is offered instead (see below). Nothing is added or offered when the note already has a renderer tag, when pasting inside an existing wrapped region, or when `((...))` is already in use in that note.
- `⌘Z` right after the paste removes the added tag together with the pasted text (one undo step, like a normal paste). `⇧⌘V` (Ctrl+Shift+V) pastes as plain text without detection.
- Implementation: `paste-format-detection-service.js` (detection and planning, tests in `tests/unit/paste_format_detection.test.mjs`), wired in `keyboard-events.js`.

## Paste format guesses
- Text that only looks like a format is pasted as plain text, and a small card just below where the paste ended offers it: `Apply as Markdown` (or `Apply as CSV`, `Apply as Python`) and `Skip`. When several languages are close, it reads `Looks like code:` with up to three, best first (`Ruby`, `Python`), then `Skip`. A wrong guess costs nothing.
- What is offered:
  - CSV-like: three or more lines with the same number of comma-separated cells (two or more; commas inside quotes do not count), short cells, no sentences → `@csv`.
  - Markdown-like: two or more different kinds of signs (`#` headings, a list of two or more items, `**bold**`, `` `code` ``, `[text](url)` links, `>` quotes, a bare ```` ``` ```` fence), or a table (`| a | b |` with its `---` line) → `@markdown`. A lone bullet list is an ordinary note and is not offered.
  - Code: mostly code-like lines (ending in `;`, `{`, `)`, `:`..., indented code, assignments and calls, no sentences), or a strong sign of one language → `@code=<language>`, for SQL, Python, Ruby, JavaScript, TypeScript, Shell (`@code=bash`), HTML, XML, CSS, Java, C, C++, C#, Go, Rust, YAML and Dockerfile, each scored on its own signs (`SELECT ... FROM`, `def f():`, `do |x|`, `console.log`, `#!/bin/bash`...). Notes of `key: value` lines are not YAML; a sentence mentioning "select ... from" is not SQL.
- Only plain-text pastes are guessed: when the clipboard carries formatted text (headings, lists, links, bold from a web page), it is pasted with its formatting as before and nothing is offered. Nothing is offered where nothing would be added (see above): Markdown into a note that is already `@markdown`, code into `@code=…`, CSV into `@csv`.
- The card moves nothing and never takes the keyboard: the caret stays where the paste ended. `Skip`, `Escape` (which closes only the card, not edit mode), typing on, a click elsewhere, scrolling the page yourself, or leaving edit mode closes it without applying; when MetaList scrolls on its own (a new note settling into view) the card stays with the paste. Near the bottom of the window it opens above the paste instead; the page never scrolls to show it.
- Pasting while no note is edited makes a new note at the top, as before; its paste is checked the same way (certain formats tagged at once, likely ones offered on the card once the new note is in place).
- `Apply` adds the tag as a detected format is added: the plain tag into an otherwise empty note, or the paste wrapped `((...))` with `((@markdown))` into a note with other text. The note stays in edit mode and the text renders when it leaves editing. `⌘Z` right after removes the tag together with the paste, as for a format added at once.
- Implementation: `paste-format-guess-service.js` (the guesses; tests in `tests/unit/paste_format_guess.test.mjs`), `paste-format-offer-service.js` (the card; placement tests in `tests/unit/paste_format_offer.test.mjs`), wired in `keyboard-events.js` (`handleFormatGuessingPaste`, `applyGuessedFormat`); browser checks in `scripts/browser-paste-format-regressions.mjs` (`BROWSER_TEST_SUITE=paste-formats npm run test:browser`).
