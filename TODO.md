# TODO

## Default Namespace Identity And Recovery

- Current protection is name-based: namespace `default` cannot be deleted, but a namespace that originated as `default` and was restored/imported/renamed as another name is treated as ordinary.
- First-run startup can bootstrap literal `default` by prompting for launch ports and saving its launch profile, which creates `namespaces/default/default.metalist.db`.
- Later flows do not currently recreate `default` if it disappears, and deleting the last usable non-default namespace can leave no practical fallback.

Future fix:
- Define the intended invariant explicitly: either literal `default` must always exist, or at least one usable namespace must remain.
- Before deleting any namespace, verify the post-delete namespace set will still include a usable fallback with a database and launch profile.
- If literal `default` is missing and should be required, offer an explicit repair/bootstrap flow instead of silently recreating it.
- If identity matters beyond the literal name, add stable namespace metadata so a restored/imported namespace can be recognized without relying only on its directory name.

## Paste Format Detection: Next Steps

Rule agreed for fenced blocks: with fences it is Markdown (`@markdown`); without fences it gets its own tag (`@mermaid`, `@code=python`). Fenced Mermaid already works this way.

In order:
1. Done: spreadsheet paste → CSV text and `@csv`.
2. Done: `@markdown` highlights fenced code that names a language (`render_fenced_code()` in `code_rendering.py`, tests in `tests/unit/test_markdown_rendering.py`).
3. Done: fenced code with a language → `@markdown` on paste.
4. Done: code copied from VS Code → `@code=<language>`.
5. Done: guesses for CSV-like, Markdown-like and code-like text, offered on a card ("Apply as Markdown" / "Skip"), see docs/ui/content-formatting.md "Paste format guesses". Not yet: tab-separated text without a spreadsheet's table.

Never detect: `@shell` (pasting must not make text runnable), and formats that are a choice rather than a property of the text (`@chart`, `@qr`).

Set aside (nice but rare): Python tracebacks → `@code=pytb`, `#!` script headers → `@code=…`, `<?xml` / `<!DOCTYPE html>` → `@code=xml` / `@code=html`, SQL.

## Bulk AI Tagging: Ranked, Private Vocabulary

Today every bulk tagging batch receives `accepted_vocabulary`: every distinct tag written on any note in the disclosed scope, without counts (`tagging_run.py`, `make_batch`). That list grows with the namespace, costs tokens on every batch, gives the model no sense of which tags matter, and is not filtered by cloud privacy rules beyond the scope itself.

The single-note "Suggest Tags with AI" (feature/ai-suggest-note-tags) instead sends a ranked list with counts: the tag-bar ranking's top tags for that note plus the most-used tags, from notes the AI may see only, never blacklisted tags. Switch bulk tagging the same way, separately:

1. A cheap per-batch vocabulary: tags that occur together with the batch's tags, tags named in the batch's text, and the most-used tags, with counts.
2. Filter it through the cloud privacy boundary (`resolve_cloud_privacy_boundary`, `cloud_privacy_evaluator.exclusion_reason`): no tag that appears only on hidden notes, no blacklisted tag.
3. Keep validation (`validate_proposals`, policies `existing` / `new` / `new_only`) against the whole namespace vocabulary, so "existing only" still means existing anywhere.
4. Run the live tagging evals before and after the change on Luna Low only, and compare the saved reports on the same scenarios and expectations.

## More Note Formats

Renderer tags in the spirit of `@json`/`@csv` (server-side, view mode, an error badge when the text does not parse). All set aside for now as low priority:

- `@yaml` and `@toml`: validate and pretty-print. YAML needs PyYAML; TOML has `tomllib` built in (Python 3.11, the oldest supported).
- `@chart`: CSV with labels in the first column and series in the others, drawn as a bar or line chart (small library or hand-drawn SVG).
- `@qr`: the note's text (a URL, Wi-Fi details) as a QR code to scan with a phone (small offline library).
- ABC music notation: plain text drawn as sheet music (abcjs is sizeable; vendored files are pinned byte for byte). Could be auto-detected on paste: a tune starts with `X:` and has a `K:` line. ChordPro (lyrics with `[G]` chords, no library) is a lighter alternative.
- Dropped: `@calc` (a notepad calculator like Soulver/Numi). It is not a standard format, so it would be MetaList's own syntax rather than something pasted from elsewhere.

## Copy Note: Math And Mermaid Into Email

- Copy Note renders the note on the server and puts an HTML and a plain-text version on the clipboard (`app/usecases/copy_note.py`, `note-clipboard-write-service.js`).
- Math is copied as MathML: Gmail drops it entirely (confirmed); Outlook likely too; Apple Mail likely shows it. Its plain-text version is the characters run together (`$$\frac{1}{3}$$` copies as `13`).
- Mermaid is copied as its source text in a code block: the server never draws it (the browser does), so email shows the code, not the diagram.

Future fix (both versions, each program takes the one it understands):
- Plain text: math as its LaTeX source (the rendered math carries `data-latex-source`, which `strip_latex_source_attributes` removes for copying), Mermaid as its source (already).
- HTML: math and Mermaid as PNG images drawn in the browser at copy time. Checked in Chrome: MathML (via SVG `foreignObject`) and SVG both export to PNG without the canvas refusing. Safari is known to refuse MathML in `foreignObject`; check Firefox. Mermaid's own labels use `foreignObject` too.
- Then check in real mail clients that pasted images survive (Gmail is picky about embedded images in pasted HTML).

## Server State: Owned Stores And Redundant-Write Detection (low priority)

Idea (2026-10-17): carry the client's ApplicationState discipline (owned state, validating setters, an exception on a write that leaves a value unchanged) over to the server's client-tracking state, which drives the view diffs.

- Not a monolith: the server runs a thread pool plus the event loop, so one state object would need one lock and serialize unrelated requests. Instead, one class per store (tab state, warm views, sync, undo, ...), each owning its lock and exposing only methods, no bare module globals. The STATE001 audit (44 globals, 4 races) is the case for it.
- Validating setters: fail on an invalid value when it is written, not when it is read.
- Redundant writes: throw only for internally computed state (a warm view stored twice unchanged likely means a render or diff computed twice). Writes that come from requests can legitimately repeat a value (two tabs, a retry, an idempotent save); there the code compares explicitly, as the client does with `stateValuesEqual`, rather than turning a repeat into a 500.
- First step, before building anything: during the browser suites, wrap warm views, tab state and sync in a recorder that counts writes leaving the value unchanged, with their call sites. Adopt the pattern for those stores only if that finds the kind of waste the client rule found.
