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

## Paste Spreadsheet Cells As A Table

- Copying cells from Excel, Google Sheets or Numbers puts tab-separated text and an HTML table on the clipboard; pasting into a note does not give a usable table today.
- Tabs make poor stored content: notes are HTML, a tab shows as one space while editing, and the Tab key is taken by the editor.

Future fix:
- First check what each spreadsheet puts on the clipboard (plain text and HTML versions) and what MetaList's paste keeps.
- On paste, convert the cells to ordinary CSV text (commas, quoting where needed) so the stored text stays visible and editable, and render it with `@csv` (possibly tagging the note `@csv`, as part of paste format detection).
- The clipboard's HTML table proves the paste is a table, so this is certain enough to tag automatically (unlike CSV typed or pasted as plain text).

## Paste Format Detection: Next Steps

Rule agreed for fenced blocks: with fences it is Markdown (`@markdown`); without fences it gets its own tag (`@mermaid`, `@code=python`). Fenced Mermaid already works this way.

In order:
1. Spreadsheet paste → `@csv` (see Paste Spreadsheet Cells As A Table).
2. `@markdown` highlights fenced code that names a language: ```` ```python ```` is coloured by the same server-side highlighter as `@code=python`, with the same names and aliases and the language label above the block. A fence with no language or one Pygments does not know (`text`, `output`, `console`) stays plain, with no "Unknown language" badge. ```` ```mermaid ```` is unchanged. Change in `markdown_rendering.py` reusing `code_rendering.py`; tests for a highlighted fence, an alias, unknown/missing language, Mermaid, and escaping.
3. Fenced code with a language → `@markdown` on paste (certain: the fence names it).
4. Code copied from VS Code (no fences) → `@code=<language>`: VS Code puts the editor language on the clipboard (`vscode-editor-data`), so no guessing.
5. Later: a suggestion tier for uncertain formats (CSV typed as plain text, Markdown): offer the tag as a tag-bar suggestion instead of adding it, so a wrong guess costs nothing. Rough rules: CSV needs 3+ lines with the same comma count, 2+ columns and no sentence-like lines; Markdown needs 2+ strong signs (`#` headings, `**bold**`, `[text](url)`, lists, tables).

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
