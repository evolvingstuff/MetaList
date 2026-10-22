# Notes and editing

Use this reference to explain MetaList accurately. It describes user capabilities,
not permission or tools for you to execute every operation. You can answer and
request one supported menu/dialog opening. You cannot submit a form, change
settings, run a shell command, or mutate notes through this help response. Do not
claim that you inspected current notes or settings: none are supplied here.
Prefer user-facing steps over implementation details. If the reference does not
answer a question, say what is unknown; do not invent syntax or controls.

Sources: docs/ui/controls.md, docs/ui/find.md

# Note App Controls

## Keyboard Shortcuts / Cheatsheet

### When Editing a Note
| Shortcut | Action |
|----------|--------|
| `Esc` | Exit edit mode for current note. You keep your place: the text at the caret (if it is on screen), otherwise the line you were reading about a third of the way down, stays at the same height once the note renders, with no visible jump. A collapsed note you changed stays expanded (saved that way), so you can see your changes; one you only opened collapses again, with its first line where the note's first line was (just below the search bar if that had scrolled above it). If the text you were at does not appear in the rendered note (for example Markdown syntax or Mermaid source), the note's top stays where it was instead. Nothing highlights the note or flashes. Images and Mermaid diagrams keep their space while they load, so text below them does not move. |
| `Tab` | Toggle focus between note content and tag bar (restores cursor position) |
| `⌘ + Enter` | Add new sibling note below current note |
| `⇧ + ⌘ + Enter` | Add new child note under current note |
| `⌘ + ←` | Outdent note (one level left) |
| `⌘ + →` | Indent note (one level right) |
| `⌘ + ↑` | Move current note up (one visible sibling) |
| `⇧ + ⌘ + ↑` | Move the selected root note to the top of the current root view (including filtered/search views), or move a child note to the top of its siblings |
| `⌘ + ↓` | Move current note down (one visible sibling) |
| `⇧ + ⌘ + ↓` | Move the selected note to the bottom (a child after its last sibling; a root after the view's last root, or last match in a search). The view stays put; editing ends with the note saved. |
| `⌘ + C` | Copy selection (default), or copy whole note when no selection |
| `⌘ + R` | Paste a reference to the copied note as a sibling, like `⌘ + V` |
| `⌘ + S` | Split note at selection/caret into sibling notes; selected segment becomes its own note |
| `⌘ + U` | Remove formatting and inline imagery from the selected range or current note |
| `⌘ + X` | Cut selection (default), or cut whole note when no selection |
| `⌘ + V` | Paste note as sibling (when the clipboard holds a copied note; scrolls new note into view). If the selected note has no visible content and no children, paste replaces it. |
| `⇧ + ⌘ + V` | Paste note as child (when the clipboard holds a copied note; scrolls new note into view) |
| `⇧ + ⌘ + R` | Paste a reference to the copied note as a child, like `⇧ + ⌘ + V` |
| `⌘ + Backspace/Delete` | Delete the selected note |
| `⌘ + Z` | Undo text/tag edits locally, or undo the latest saved mutation when the active editor has no local edit history |
| `⇧ + ⌘ + Z` or `⌘ + Y` | Redo text/tag edits locally, or redo the latest saved mutation when the active editor has no local edit history |

- What is pasted decides, never the last ⌘C: anything else (another app's text, dictated words) pastes as text, sanitizing external HTML.
- Dictated text pasted into a note can end with tags: everything after the phrase "start tags" (set in `Dictation Settings`) is added to the note's tags. The full rules are in the dictation help topic.
- When note paste replaces an empty target, the target keeps its search-context tags and merges in copied root tags with case-insensitive dedupe.
- A pasted copy keeps each copied note collapsed or expanded as it was when copied (the root and every child); filling an empty note gives it the copied root's state.
- A saved whole-note paste resets the local editor history baseline so the next Undo reaches application history.
- If the clipboard value came from `Generate random password…`, pasting into an empty note also adds `@password` automatically when that tag is not already present.
- See `docs/ui/paste-sanitization.md` for the full policy.
- `⌘ + R` and `⇧ + ⌘ + R` paste a reference (`[[UUID]]`, a note that embeds it) to the last copied note where `⌘ + V` and `⇧ + ⌘ + V` paste the note: a sibling below (or into an empty note without children) or the first child, saved and selected with no caret, caret or not. With no selected note, `⌘ + R` makes a new top note.
- See `docs/ui/references.md` for full reference behavior.
- `⌘ + S` splits the current editing note at the caret or selection; a caret at the front creates a blank note above, and a caret at the end creates a blank note below.
- `⌘ + S` no-ops when the entire note is selected or when split would produce no content segment.
- `⌘ + S` trims selection-edge empty nodes/whitespace so generated split notes do not get a synthetic leading blank line.
- `⌘ + S` records the full split as one undo/redo step.
- `⌘ + U` removes formatting and inline imagery from the selected range, or from the entire active note when no text is selected. Whole-note removal rewrites stored content into plain HTML while preserving links, removes all inline images plus global and scoped Add Style meta tags, and removes scope delimiters that no surviving wrapped tag still uses. Range removal deletes intersecting inline images and splits scopes around the selection so formatting outside it remains. Semantic tags such as `@todo` remain.
- `⇧ + ⌘ + ↑` is server-authoritative: for filtered/search views it inserts the root note at the top of the visible root view without corrupting the underlying root-order links.
- In any non-normal sort order, root-note reordering is disabled for drag/drop, `⌘ + ↑`, `⌘ + ↓`, and `⇧ + ⌘ + ↑`. Child-note reordering still works.
- While the single-note tag bar is focused, note-level edit shortcuts still target the current note: create sibling/child, delete, move up/down, move to top, indent/outdent, split, unformat, and note copy/cut/paste.

### General Shortcuts
| Shortcut | Action |
|----------|--------|
| `Enter` | Add new note at top (when not editing) |
| `⌘ + /` | Open command palette |
| `⌘ + F` | Find in the list: the find bar finds text in the notes the list shows, also far below what is loaded and inside folded notes, and marks each match. `Enter` / `⌘ + G` goes to the next match, `⇧ + Enter` / `⇧ + ⌘ + G` to the previous one, `Esc` closes it. While editing, it saves and leaves the note first; in a dialog it stays the browser's find. See `docs/ui/find.md`. |
| `Tab` | Focus the search input and select its full query (view mode only) |
| `?` | Open keyboard shortcuts / cheatsheet (idle mode) |
| `⌘ + Z` | Undo |
| `⌘ + Y` | Redo |

On macOS, `⌘ + Y` normally opens Safari History rather than performing native text redo. MetaList intercepts it while editing and maps it to the active editor's local redo operation; this does not call the server.

- When a non-normal sort mode is active, a floating pill above the sticky top bar shows the active mode and includes an `×` to return to normal sorting without reopening the command palette.
- These dismissible pills are **view indicators** (also called view chips). Entering or leaving a view with an indicator—sorted notes, Untagged notes, Reference source, or Referenced by—applies note changes immediately without appearance/disappearance or collapse animations, including tab switches into or out of these views.
- Scroll restoration preserves an exact top position without delayed anchor alignment. Resetting a view cancels pending scroll restores from its previous content.
- When tabs are enabled, a white outline stacked-folder icon marks the black trigger region left of the search field. Its left inset matches the results count's right inset. Hovering that region or icon opens the tab/search-context overlay, which remains available while hovering over the dropdown itself. Creating a blank tab with `Enter` does not dismiss the overlay. Open search suggestions render above the tabs.
- Left/right side lanes hide at narrower desktop widths before they can overlap the centered notes column.

### Find in the List
- `⌘ + F` (`Ctrl + F` on Windows and Linux) opens MetaList's find bar, under the search controls at the right. Unlike the browser's own find, it also finds text far below the loaded notes and inside folded notes.
- It finds what notes show (their text, the text of expanded embeds, tag-bar comments), in any case and inside words, in the current tab's notes in list order. It does not find tag names (search does) or the grey placeholder lines a search leaves.
- The count reads like `3 of 12`; `3 of 50+` means more may lie beyond what has been read, since find reads 50 matching notes at a time. `No matches` dims the arrows.
- `Enter` / `⌘ + G`: next match; `⇧ + Enter` / `⇧ + ⌘ + G`: previous; both wrap. A match in view does not scroll; one out of view moves just into view. A match inside a folded note opens that note for the moment only (its saved collapse stays) and folds back when find moves on or closes.
- `Esc`, the `×`, or clicking into a note closes find and clears its marks. The palette command `Find in list` opens it too.

### Tag Suggestions
- Suggestions appear only when the tag bar is focused.
- Prefix behavior mirrors search suggestions (segment-aware while typing, co-occurrence after a space).
- Top suggestions interleave the strongest content matches with the strongest direct co-occurrence hits from the current explicit non-meta tags before the broader hierarchy/context fallbacks.
- For blank-prefix suggestions, content-hit candidates whose matched segments are already covered by an explicit or inherited tag are suppressed as redundant.
- Literal segment hits can surface connector-separated tags, but low-signal glue segments like `and`, `no`, `of`, `the`, `to`, or `up` do not count on their own. They still contribute to exact full-phrase literal matches, so `No Kings` can strongly promote `no-kings` even though bare `no` would not.
- Connector-heavy tags need near-complete literal coverage before they surface from content alone: if a tag has `k` raw connector-separated chunks, content must cover at least `k-1` of those chunks, capped by the number of meaningful non-noise chunks in the tag. So `X-Y-Z` can surface for `X Y`, `Y Z`, or `Y X`, but not for `X`, `Y`, `Z`, or an unrelated two-chunk overlap like `W Z`.
- For connector matches, the candidate covering the longest contiguous portion of the note is ordered first: fewer unmatched connector segments beat more padded tags, and prefix-aligned partials beat suffix-aligned ones when coverage otherwise ties.
- Lowercase one-letter connector segments still count as noise. Uppercase one-letter segments can still match as meaningful literals for entity-like tags, but prose-like `A` and `I` are treated as noise.
- For otherwise tied literal content hits, more structured/specific tags beat broader plain words; frequency then breaks structurally equal ties before content position, raw tag length, or alphabetical ordering.
- Full multi-segment phrase hits rank above single-segment hits, so note content like `databricks workspaces` prefers `databricks-workspaces` over `databricks` or `workspaces`.
- Surrounding prose punctuation is ignored for content matching, so content like `(github?)` still promotes `github`.
- When the active prefix starts with `@`, matching meta-tag suggestions are ordered by notebook usage frequency (note count), with alphabetical tiebreaks for equal counts.
- Case-equivalent tags are collapsed in the suggestion list, and the most-used spelling is shown.
- Ontology-equivalent tags are collapsed the same way: only the most-used eligible synonym explicitly written in tag bars is shown, unless the current prefix only matches a less-common synonym variant.
- Tags already present via explicit tags, inheritance, or ontology inference are suppressed unless they match the prefix (then they appear at the bottom).
- Suggestions may render above the tag bar if space below is tight, but the list still keeps the same best-on-top ordering and initial scroll position.
- Arrow keys move selection; `Enter` accepts the selected suggestion without adding a trailing space.

### Command Palette Utility Entries
- Show/Hide tabs (label reflects current visibility)
- Show/Hide AI Chat (label reflects current visibility)
- AI Agent Settings… (OpenAI API key, model, cloud privacy, evidence and tagging limits; model and thinking level are selected beside chat Send)
- Create backup now (opens Backup Settings, where you choose one backup folder, select the namespaces to include, set retention, and then run the backup; typing `backups` in the palette also matches it, and the completion modal shows archive size)
- Restore from backup…
- Logout
- Generate random password…
- Keyboard Shortcuts / Cheatsheet…
- Version info… (also found by typing `update`, `upgrade`, or `release`; checks PyPI and offers an update for supported uv installations when behind)
- Memory usage… (also found by typing `memory`, `ram` or `mb`; the namespace server's memory and the notes it holds decrypted)
- Note Layout & Appearance… (top-level size, child indentation, vertical spacing, note corners, and tag style)

> Note: On Windows/Linux, use `Ctrl` instead of `⌘` (Command)

App menus close with `Escape` (only the menu: a note being edited stays in edit mode) or an outside click. The right-click menu also closes once the pointer moves about 28px away from it and any open submenu, like the tab overlay; small movements just past its edge keep it open. Every modal has a standard upper-right circular `×` matching full-screen note view and also closes with `Escape` or an outside click. Dismiss-only footer `Close`/`OK` buttons are omitted; `Enter` still submits a modal's declared primary workflow action.

When `Show tags in list` is enabled, the grey right-aligned tag column wraps and is capped at 25% of its note row so note content retains the majority of the available width.

## Tag Bar Syntax
- See `docs/ui/tag-bar.md` for the full grammar (tokens, wrappers, and `/* ... */` comments).
- Leaving the tag bar (Tab toggle or click-away) sanitizes the value by removing incomplete/broken items.


### Update notifications
Each document load/refresh starts a fresh server-side PyPI check in parallel with app startup, including on the login page. Once authenticated and ready, a newly discovered release shows a dismissible reminder-style notice linking to Version Info. `pref.update_notice_version` remembers the displayed release using namespace preferences, so refreshes do not repeat it. Failed checks leave the app usable and Version Info offers Check again. Version Info also checks when opened.

Update is a deliberate action: it preflights the reviewed release, creates verified immutable backups, and restarts all namespaces. The modal displays progress and a Reload action on completion. Closing/reopening it in the same page resumes the accepted job. Job status can be read using its opaque ID after restart, but starting an update requires authentication. Source checkouts and unmanaged installs show the eligibility reason. After a post-shutdown failure, inspect the updater output/log and restart with `metalist`; automatic rollback is not provided.
