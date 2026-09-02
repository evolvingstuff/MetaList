# Note App Controls

## Keyboard Shortcuts / Cheatsheet

### When Editing a Note
| Shortcut | Action |
|----------|--------|
| `Esc` | Exit edit mode for current note |
| `Tab` | Toggle focus between note content and tag bar (restores cursor position) |
| `⌘ + Enter` | Add new sibling note below current note |
| `⇧ + ⌘ + Enter` | Add new child note under current note |
| `⌘ + ←` | Outdent note (one level left) |
| `⌘ + →` | Indent note (one level right) |
| `⌘ + ↑` | Move current note up (one visible sibling) |
| `⇧ + ⌘ + ↑` | Move the selected root note to the top of the current root view (including filtered/search views), or move a child note to the top of its siblings |
| `⌘ + ↓` | Move current note down (one visible sibling) |
| `⌘ + C` | Copy selection (default), or copy whole note when no selection |
| `⌘ + R` | Paste embedded reference from the most recently copied note UUID |
| `⌘ + S` | Split note at selection/caret into sibling notes; selected segment becomes its own note |
| `⌘ + U` | Remove formatting and inline imagery from the selected range or current note |
| `⌘ + X` | Cut selection (default), or cut whole note when no selection |
| `⌘ + V` | Paste note as sibling (when note clipboard active; scrolls new note into view). If the selected note has no visible content and no children, paste replaces it. |
| `⇧ + ⌘ + V` | Paste note as child (when note clipboard active; scrolls new note into view) |
| `⇧ + ⌘ + R` | Paste embedded reference from the most recently copied note UUID as a new child note |
| `⌘ + Backspace/Delete` | Delete the selected note |
| `⌘ + Z` | Undo text/tag edits locally, or undo the latest saved mutation when the active editor has no local edit history |
| `⇧ + ⌘ + Z` or `⌘ + Y` | Redo text/tag edits locally, or redo the latest saved mutation when the active editor has no local edit history |

- If note clipboard conditions are **not** met and edit mode is active, `⌘ + V` uses browser clipboard paste and runs external HTML sanitization before insertion.
- When note paste replaces an empty target, the target keeps its search-context tags and merges in copied root tags with case-insensitive dedupe.
- If the clipboard value came from `Generate random password…`, pasting into an empty note also adds `@password` automatically when that tag is not already present.
- See `docs/ui/paste-sanitization.md` for the full policy.
- `⌘ + R` inserts the reference token on its own line; if the caret is mid-line, the line is split around the inserted token. `⇧ + ⌘ + R` creates a child note first, then inserts the reference token there.
- `⌘ + R` avoids adding a synthetic extra blank line when caret is already on an empty line.
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
| `Tab` | Focus the search input and select its full query (view mode only) |
| `?` | Open keyboard shortcuts / cheatsheet (idle mode) |
| `⌘ + Z` | Undo |
| `⌘ + Y` | Redo |

On macOS, `⌘ + Y` normally opens Safari History rather than performing native text redo. MetaList intercepts it while editing and maps it to the active editor's local redo operation; this does not call the server.

- When a non-normal sort mode is active, a floating pill above the sticky top bar shows the active mode and includes an `×` to return to normal sorting without reopening the command palette.
- The right-side activity calendar defaults to `Created`, with `Updated` available as the second metric. Clicking a day or dragging across days applies a date filter for the active tab; editing the search input clears that date filter.
- When tabs are enabled, a white outline stacked-folder icon marks the black trigger region left of the search field. Its left inset matches the results count's right inset. Hovering that region or icon opens the tab/search-context overlay, which remains available while hovering over the dropdown itself. Creating a blank tab with `Enter` does not dismiss the overlay. Open search suggestions render above the tabs.
- Left/right side lanes hide at narrower desktop widths before they can overlap the centered notes column.

### Search Input Behavior
- The search field keeps a muted search icon inside the input before and during typing; hovering the field shows a `Search` tooltip.
- Pressing `Enter` while focused in the search input creates a new **root** note.
- Pressing `Esc` while focused in the search input blurs the field and dismisses search suggestions, without clearing the current query or search results.
- The right side of the black search header shows only the result's root-note count.
  MetaList does not tokenize search results during startup, ordinary interaction,
  or snapshot refresh merely to populate this UI. The existing `Show/Hide search
  result count` preference controls the count.
- If the search query contains required tag terms (unquoted tokens like `asdf`), the new root note is created with those tags in its tag bar.
- When creating a child (`⇧ + ⌘ + Enter`) or sibling (`⌘ + Enter`) note under a note that already provides the required **non-meta** tags via inheritance, the new note is **not** redundantly tagged.
- Sort modes do not change canonical insertion behavior. New roots are still inserted into the manual root order first, then rendered in the active sort order.

### Search Suggestions
- Suggestions are **tag-only** (no text suggestions).
- For a blank search or the first tag prefix in a query, the first suggestion slots can be personalized from ordered activity windows. The default windows are 1, 7, and 30 calendar days.
- Case-equivalent tags are collapsed in the suggestion list, and the most-used spelling is shown.
- Search execution, typing, scrolling, hovering, rendering, collapsing, and programmatic tab switches do not earn credit.
- Entering edit mode, manually expanding a note, entering full-screen note view, running a shell note, toggling todo/done, and successfully reordering/indenting/outdenting a note count as intentional note engagements. Structural no-ops do not count.
- Each engagement increments every raw searchable tag on the note, including inherited tags and meta tags, before ontology inference. This lets an `@shell` child under `shortcut` credit both raw tags without rewarding unrelated inferred tags.
- By default, each note can earn only one engagement credit in the same active tab and executed-search context, even when other notes are engaged between two interactions with it. The context limits repetition but does not filter the credited note tags. Leaving that context and later returning starts a fresh flow.
- Successfully adding one or more explicit tags awards one credit to each newly added tag. It does not re-credit tags already present or inherited from ancestors; removals and case-only changes award nothing.
- Accepting a search suggestion by click or `Enter` awards one credit to the selected tag every time. Clicking a search-context tab awards one credit to each known positive tag term in that tab's executed query; excluded tags and quoted text do not earn credit.
- Counts are stored in sparse daily buckets. Days without activity have no bucket and do not consume retention capacity; the latest 365 populated days are retained.
- Each configured window chooses its highest-count matching tag, excluding tags already chosen by earlier windows. The remaining suggestions retain normal namespace-frequency ordering.
- `Cmd/Ctrl+/` → `Search suggestion stats & settings…` is the single place for suggestion activity controls. Changes to its ordered 1–365 day slots, default-on time-window labels, and default-on one-credit-per-note-per-search-context limit persist immediately. It also shows every retained populated date and tag-credit count and includes a confirmed `Reset activity` action. Disabling the credit limit makes every qualifying interaction count; removing every slot disables personalization.
- Confirmations, errors, and completion notices use MetaList modals, login-state messaging, or banners; native browser `alert`, `confirm`, and `prompt` dialogs are forbidden by the development startup sanity gate.
- While typing a partial tag token, suggestions are segment-aware for connector-separated tags: a prefix can match the start of the full tag or the start of any connector-separated segment (`-`, `_`, `.`, `/`).
- Example: `wor` can suggest `workspaces` and `databricks-workspaces`; `orksp` suggests neither.
- When the active prefix starts with `@`, matching meta-tag suggestions are ordered by notebook usage frequency (note count), with alphabetical tiebreaks for equal counts.
- After completing a tag and adding a space, suggestions are ordered by tag co-occurrence with all existing tag tokens in the query (strict overlap count > Jaccard within overlap).
- Suggestions appear only when the search input is focused.
- Moving the pointer below the suggestion popup, or horizontally outside the centered notes column, hides open search suggestions while keeping focus in the search input. After that pointer dismissal, suggestions stay closed until the user resumes typing or clicks the search input again.
- Arrow keys move selection; `Enter` accepts the selected suggestion without adding a trailing space.
- Suggestion matching is broader than actual filtering: search results still match exact effective tag terms only.

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

### Mouse Controls
| Action | Result |
|--------|--------|
| Click `+` button | Add new note at top |
| Click menu (`≡`) button | Open command palette |
| Click `↑` button | Scroll the page to the top and jump the right-side calendar to newest activity. The button stays enabled at page top when the calendar is not at newest. |
| Click note arrow | Toggle collapse/expand note. If the arrow is within the current edited note subtree, that edit session remains active; outside that subtree, the current edit saves/exits first. |
| Click `⋮` under the edited note's tag bar | Expand that collapsed parent note to reveal its hidden children. |
| Click note or blank space inside its outer card | Edit/select that note. Parent-note whitespace still counts as the parent until you click into a child note/card. |
| Click redacted note | Reveal the full redacted set in that note's subtree for the current tab; the revealed notes stay dimmed to show they are still excluded by the active search |
| Click link-mode reference text | Open the referenced note in a temporary `Reference source` context; the UUID query remains hidden |
| Click `×` on the `Reference source` indicator | Return to the originating context and close the temporary source tab |
| Type in search while viewing a reference source | Dismiss reference-source mode and keep the current tab as a normal search context |
| Right-click anywhere inside a rendered note reference | Choose **Go to Source** to open the same temporary reference-source context |
| Press `@todo` / `@done` checkbox | Toggle the note status on mouse down. If another note is being edited, save + exit edit mode first and do not enter edit mode for the toggled note. |
| Press note shell / blank space | Select/edit that note on mouse down. Note content waits until click so drag/drop can disambiguate click vs drag. |
| Click the tag bar while editing | Focus the tag input without re-selecting the note shell. Mouse or keyboard focus adds a soft focus ring and, when Animated Transitions is enabled, a single subtle outward halo. |
| Drag note body (while not editing) | Reorder among visible siblings based on vertical drop position, or indent/outdent on horizontal drags. Once movement crosses the drag threshold, releasing back over the source note does not count as a click. |
| Drag-select text in note | Available only in edit mode; releasing mouse outside note keeps edit mode + selection |
| Right-click external link | Open a link-only context menu with `Copy Link` and `Open Link in New Tab`. Note actions are hidden for link targets. |
| Right-click note | Open the note context menu (`Copy Note`, `View Full Screen`, `Paste Sibling Note`, `Paste Child Note`, `Paste Sibling Reference`, `Paste Child Reference`, `Add Sibling Note`, `Add Child Note`, `Delete Note`, `Move Note to Top`, `Export Note as HTML`, `Export View as HTML`). A dark, non-interactive footer at the bottom always shows the note's locally formatted `Created` and `Updated` date/times. `View Full Screen` is available only outside edit mode; it renders the selected note edge-to-edge with its complete descendant subtree but without ancestors, hides the menu and scroll-to-top controls, and closes with the upper-right `×` or `Esc`. While actively editing that note, `Add Style` opens a connected formatting flyout and `Remove Formatting` performs the same operation as `Cmd/Ctrl+U`. Paste actions appear only when a note has been copied. |
| Right-click selected note text | Open the note context menu with `Copy` for the selected text instead of `Copy Note`; while editing, `Add Style` scopes the chosen formatting tag to that range and `Remove Formatting` removes formatting only from that range. |
| Right-click image in note | Adds image actions to the note context menu: `Copy Image`, `Save Image`, `Zoom Image`, `Open Image in New Tab` |
| Right-click completed AI response | Choose `Copy Response` to place its raw Markdown on the MetaList note clipboard with `@markdown @llm`, while also writing rendered HTML and raw Markdown to the system clipboard. It can be pasted as a note but not as a reference until inserted. |
| Right-click notes view background | Outside edit mode, open the view context menu with dynamic `Show/Hide Tabs`, `Show/Hide Calendar View`, `Show/Hide AI Chat`, `Show/Hide Tags in List`, and `Export View as HTML` actions |
| Right-click tag in search input, tag bar, or their suggestion lists | Open tag context menu (Edit Tag Relationships). If a note is being edited, it is saved and the view refresh completes first, restoring view-only rendering such as cached URL titles. |
| Right-click left or right lane | Open the same view menu: show/hide tabs, calendar, AI chat, or note-list tags, or export the current view as HTML |
| Hover left side of search bar | Show the tab/search-context overlay |
| Hover/click search input | Hide the tab/search-context overlay |

> Tip: You can right-click directly on a tag without selecting the full text first (selection still works).
> In non-normal sort modes, drag/drop cannot reorder root notes, but it can still reorder children within a root.
> Saved-file image actions are available in view mode on rendered image previews; edit mode only contains the raw UUID token for those files.
> Collapse arrows reflect the server-provided `isCollapsible` flag, plus a browser-side promotion when rendered note content visibly wraps beyond one line. Overlapping inline fragments on the same visual line count as one line even when nested formatting uses different font sizes, such as a standalone link title followed by its smaller domain.
> The arrow glyph and click target are slightly enlarged; the 27×27px control is offset to preserve the arrow's original visual center.
> While editing, collapse arrows ignore content length and appear only for notes with children, because the edited note already shows its full content.
> Collapsed notes receive compact server-rendered content that starts at the first non-blank text or image line.
> Note expand/collapse transitions animate by default and are controlled by `Animated transitions` in the command palette.
> Selecting a collapsed note for editing shows that note's full editable content but keeps its child subtree hidden until the note is explicitly expanded. If the collapsed note has hidden children, an inline `⋮` affordance appears under the tag bar and expands the note.

### Command Palette Utility Entries
- Show/Hide tabs (label reflects current visibility)
- Show/Hide calendar view (label reflects current visibility)
- Show/Hide AI Chat (label reflects current visibility; opening chat closes the calendar)
- AI Agent Settings… (MetaList-managed loopback Ollama status, downloaded model, and retrieval limits; model and thinking level are selected beside chat Send)
- Create backup now (opens Backup Settings, where you choose one backup folder, select the namespaces to include, set retention, and then run the backup; typing `backups` in the palette also matches it, and the completion modal shows archive size)
- Restore from backup…
- Logout
- Generate random password…
- Keyboard Shortcuts / Cheatsheet…
- Version info…
- Note Layout & Appearance… (top-level size, child indentation, and vertical spacing)

> Note: On Windows/Linux, use `Ctrl` instead of `⌘` (Command) 

App menus close with `Escape` or an outside click. Every modal has a standard upper-right circular `×` matching full-screen note view and also closes with `Escape` or an outside click. Dismiss-only footer `Close`/`OK` buttons are omitted; `Enter` still submits a modal's declared primary workflow action.

When `Show tags in list` is enabled, the grey right-aligned tag column wraps and is capped at 25% of its note row so note content retains the majority of the available width.

## Tag Bar Syntax
- See `docs/ui/tag-bar.md` for the full grammar (tokens, wrappers, and `/* ... */` comments).
- Leaving the tag bar (Tab toggle or click-away) sanitizes the value by removing incomplete/broken items.
