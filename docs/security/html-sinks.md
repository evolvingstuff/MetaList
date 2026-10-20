# Where markup reaches the page

An inventory of every place MetaList's browser code turns a string into markup
(`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
`createContextualFragment`, `DOMParser`, `srcdoc`), taken on 2026-10-17 from
`main` at `2ccb3bfd`. It classifies each site the way ShockHarness's property
contracts will (`docs/` copy of the spec: `shockharness_property_contracts_spec.md`,
v0.5, §5.2a–§5.2b), so the P1b pilot has a prediction to measure against.

## What limits the damage

The Content-Security-Policy (`app/security/http_headers.py`) allows script only
from MetaList's own files or with the page's nonce (`script-src 'self'
'nonce-…'`). Injected `<script>`, inline handlers (`onerror=`, `onclick=`) and
`javascript:` links do not run. Images, media and requests reach only MetaList
itself (`img-src`, `connect-src 'self' data: blob:`), forms post only to it
(`form-action 'self'`), and nothing can be framed. Styles allow `'unsafe-inline'`.
So an unescaped value cannot run code; what it can do is inject markup and CSS:
fake controls or text inside the app, hidden content, broken layout, a link to
another site.

## Summary

85 sites (counting a few parse-only `DOMParser` lines):

| Kind | Sites | Meaning |
| --- | --- | --- |
| Literal | 19 | `''` or constant markup |
| Escaped template | 11 | every interpolated part goes through an escaper |
| Built by `.map(...).join('')`, each element escaped | 15 | the analyzer reports these as `unknown` until container-aware compositions exist (spec §16 question 7) |
| Our own constants interpolated raw | 17 | safe: only MetaList's own literals and constant tables reach them |
| Server-validated values interpolated raw | 6 | safe today because the server limits the characters or the type (see Fragile) |
| Server HTML | 8 | note views, full screen, floating windows, image resize, print, AI chat |
| Sanitized in the browser | 4 | paste insertion, Mermaid (DOMPurify via `securityLevel: 'strict'`), markdown-it with `html: false` (since removed), DOMPurify on save |
| Unescaped user text | **1** | the tab list (below; fixed) |
| Parse-only, or no production caller | 4 | inert `DOMParser` parsing in the paste sanitizer; `markdown-render-service.js`'s raw `innerHTML` helper (since removed) |

Every escaper at these sites escapes `& < > " '`, so every escaped value is safe
in attributes as well as text.

## The one real problem (fixed)

`mode-manager/events/keyboard-events.js` `updateSearchContextsList` (the tab
list) put each tab's search text into markup unescaped:
`` `<span class="tab-context-query">${displayQuery}</span>` ``, where
`displayQuery` is the user's search cut to 12 characters plus `...`. A quoted
text search keeps `<`, `>` and `=`, and the search is saved in the server's tab
state, so a search such as `"<b>x</b>"` rendered as markup in the tab list on
every reload. Only the user's own search text reached it, and the CSP stops
script, so it was a display bug and a markup injection rather than script
execution. It is now escaped, with the tab ids beside it, and the tab-switching
browser suite checks that such a search shows as text.

## Fragile: safe today, because of something other than escaping

Escaped since the inventory (defense in depth; every value these sites receive
today was already safe):

- the login page's namespace list (`auth.js`), the backup restore dialog's
  restored filename and namespace (`backup-restore-modal.js`), and the backup
  settings dialog's retention count: safe before only because the server limits
  namespaces to `^[a-z0-9]+(?:-[a-z0-9]+)*$` and the count is an integer;
- the password dialog's error (`password-modal.js`), and the random password and
  dictation settings dialogs' errors and copy status: every writer was a constant
  or a status number.

The print preview's frame is now sandboxed (`allow-same-origin allow-modals`, no
`allow-scripts`): nothing in the printed document can run, while MetaList can
still print it (Chrome prints a sandboxed frame only with `allow-modals`). The
export and print browser suite checks the attribute.

Still as found:

- **Backup restore and import** do not check that the posted `backup_filename`
  matches `backup_namespace`; only the browser keeps them consistent.
- **Constant tables not frozen:** `VISUAL_CUE_SECTIONS` (visual cues dialog) is
  exported and could be changed by another module.
- **Paste insertion** (`html-paste-sanitizer-service.js`) inserts sanitized
  clipboard HTML into the live page with `createContextualFragment`; its
  sanitizer is a blocklist, so a tag or attribute missing from it lives until the
  server cleans it on save (the CSP still stops script).
- **`note-html-sanitizer.js`** parses HTML into a detached element of the live
  document before DOMPurify. Fine while its callers pass only HTML already in the
  editor.

## Server HTML: sanitized last

Note HTML is cleaned by nh3 (`app/security/note_html.py`) on every write, and
once at unlock for rows stored any other way (see the security README). What the page receives is mostly not that HTML but a rendering of it
(Markdown, CSV, embeds, reference decorations, file previews, footnotes) and chat
replies rendered from the AI's Markdown. Each renderer escapes as it builds, and
since 2026-10-19 its result is also cleaned once more before it leaves the server
(`app/security/rendered_html.py`), at the five exits that send rendered HTML:

- the note view (`snapshot._render_note_view_html`, the list and its snapshots);
- full-screen notes and floating windows (`note_fullscreen.build_note_fullscreen_markup`);
- chat replies, finished and streaming (`ai_chat_rendering.render_ai_chat_markdown_to_html`
  and its streaming twin);
- the model's thinking text (`ai_chat_rendering.render_ai_chat_thinking_to_html`).
- the HTML export, downloaded or printed (`html_export._as_drawn_in_metalist`, each note's
  drawing). Its variant of the pass also keeps the file's own images inline: `<img>` data
  URLs of any image type and size (attached images, SVG diagram previews), which never run
  script. A download opens from disk, outside MetaList's policy, so the file carries its
  own Content-Security-Policy: images, inline styles, and only its own script, named by
  hash (a print gets `script-src 'none'`).

The pass allows the stored-note policy plus exactly the inert markup the
renderers add: buttons, `data-*` identifiers, ARIA, titles, renderer class names
(`note-`, `meta-`, `link-title`, `ai-chat-`, `tok-`, `json-`), the icons' inline
SVG shapes, and the size tags' `--meta-size-factor`. Attributes the renderers
write with one fixed value (`target="_blank"`, `contenteditable="false"`,
`role="img"`, ...) keep only that value. Event handlers and script-capable URLs
never pass.

Copying or cutting a note (`copy_note.py` → `models/utils.py:note_data_to_html`) writes
a rendering to the system clipboard without this pass. It never enters MetaList's page;
pasted back into MetaList it is sanitized on save, and other apps sanitize what they paste.

Two tests keep the allowlist matched to the renderers. `tests/unit/conftest.py`
checks every pass in the unit suite against the same HTML5 parse with nothing
removed, so a renderer that adds markup the allowlist lacks fails the test that
rendered it rather than losing it in the browser; and
`tests/unit/test_rendered_html.py` renders one note per renderer and formatting
tag through the pass, and feeds it unsafe markup to show it is removed.

In the browser, `server-rendered-html.js:serverRenderedHtml` declares the
server's HTML `sanitized_html` at the seven `innerHTML` sinks that take it (note
view ×2, floating window, full screen, image resize, chat reply, thinking text).
The image resize response and an edited note's snapshot are the note's stored
HTML, sanitized on save: the resize answers with what the save stored, not its own
result from before sanitizing (2026-10-19).

## Escapers

There were 20 separate HTML escapers and no shared one: each dialog added its
own copy as it was written (January to October 2026). All escaped the same five
characters, but six returned `''` for a non-string instead of failing, which
hides the bug. They are now one module, `app/static/js/modules/html-escape.js`,
whose `escapeHtml` escapes `& < > " '` and throws on anything but a string
(`tests/unit/html_escape.test.mjs`). It is the one `escaped_html` producer the
property-contracts catalog will name.

## Found along the way

- The backup retention dialog had no way to open: its only caller was removed
  on 2026-04-19, when folder backups with a keep count replaced it. The dialog,
  its command palette helpers and the unused `/api2/auth/backup/delete-oldest`
  route are removed. Folder backups prune by the keep count
  (`tests/unit/test_backups_route.py` checks that only the oldest beyond it go).
- `markdown-render-service.js` rendered markdown with a vendored markdown-it that no page loaded; its render functions had no caller. They and markdown-it are removed; the link helper the note views use moved to `link-target-service.js`.
