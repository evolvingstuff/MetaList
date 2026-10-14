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

## More Note Formats

Renderer tags in the spirit of `@json`/`@csv` (server-side, view mode, an error badge when the text does not parse). All set aside for now as low priority:

- `@yaml` and `@toml`: validate and pretty-print. YAML needs PyYAML; TOML has `tomllib` from Python 3.11, so 3.10 needs `tomli`.
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
