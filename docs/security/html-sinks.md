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
| Sanitized in the browser | 4 | paste insertion, Mermaid (DOMPurify via `securityLevel: 'strict'`), markdown-it with `html: false`, DOMPurify on save |
| Unescaped user text | **1** | the tab list (below; fixed) |
| Parse-only, or no production caller | 4 | inert `DOMParser` parsing in the paste sanitizer; `markdown-render-service.js`'s raw `innerHTML` helper |

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

- **Raw values the server keeps safe:** the login page's namespace list
  (`auth.js`), the backup restore dialog's restored filename and namespace
  (`backup-restore-modal.js`), and the backup retention dialog's filename
  (`backup-retention-modal.js`). Safe because namespaces must match
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`. The restore and import routes do not check that
  the posted `backup_filename` matches `backup_namespace`; only the browser keeps
  them consistent.
- **Raw error text:** the password dialog shows `state.error` unescaped
  (`password-modal.js`). Every message that reaches it today is a constant or a
  status number, but a server `detail` that ever echoed input would be markup.
  The random password dialog (`error`, `copyStatus`) and the dictation settings
  dialog (`state.error`) are the same shape with only constant writers.
- **Constant tables not frozen:** `VISUAL_CUE_SECTIONS` (visual cues dialog) is
  exported and could be changed by another module.
- **Server HTML is trusted as is.** Note HTML is cleaned by nh3
  (`app/security/note_html.py`) on every write and on load, but the server's own
  later transforms (embeds, formatting, image proxy) are not cleaned again, and
  the AI chat's markdown (`app/services/markdown_rendering.py`) escapes while it
  builds HTML with no final sanitize pass.
- **Print preview** loads the export HTML into an iframe with no `sandbox`; a
  `srcdoc` frame has MetaList's origin, so a gap in the server renderer would act
  as MetaList.
- **Paste insertion** (`html-paste-sanitizer-service.js`) inserts sanitized
  clipboard HTML into the live page with `createContextualFragment`; its
  sanitizer is a blocklist, so a tag or attribute missing from it lives until the
  server cleans it on save (the CSP still stops script).
- **`note-html-sanitizer.js`** parses HTML into a detached element of the live
  document before DOMPurify. Fine while its callers pass only HTML already in the
  editor.

## Escapers

There were 20 separate HTML escapers and no shared one: each dialog added its
own copy as it was written (January to October 2026). All escaped the same five
characters, but six returned `''` for a non-string instead of failing, which
hides the bug. They are now one module, `app/static/js/modules/html-escape.js`,
whose `escapeHtml` escapes `& < > " '` and throws on anything but a string
(`tests/unit/html_escape.test.mjs`). It is the one `escaped_html` producer the
property-contracts catalog will name.

## Found along the way

- The backup retention dialog has no way to open: its only opener,
  `_maybeDeleteOldestBackupsAfterCreate` in the command palette, has no caller.
- `markdown-render-service.js` is used only by its unit test.
