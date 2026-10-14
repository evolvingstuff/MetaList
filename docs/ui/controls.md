# Note App Controls

What happens on screen after each action (where things stay, when the page may scroll, why nothing is highlighted) follows [the interaction principles](interaction-principles.md).

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
| `⇧ + ⌘ + ↓` | Move the selected note to the bottom: a root after the last root of the current view (in a search, the last matching root), a child after its last sibling. The view stays put: in a short list you see it land, otherwise it leaves sight and the notes below close the gap. Moving the note being edited saves it and leaves edit mode. |
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
- A saved whole-note paste resets the local editor history baseline so the next Undo reaches application history.
- If the clipboard value came from `Generate random password…`, pasting into an empty note also adds `@password` automatically when that tag is not already present.
- See `docs/ui/paste-sanitization.md` for the full policy.
- `⌘ + R` inserts the reference token on its own line; if the caret is mid-line, the line is split around the inserted token. `⇧ + ⌘ + R` creates a child note first, then inserts the reference token there.
- `⌘ + R` avoids adding a synthetic extra blank line when caret is already on an empty line.
- With no selected note, `⌘ + R` creates and saves a reference in a new top note, matching the destination used by `⌘ + V`. It retains the original note identity.
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
- These dismissible pills are **view indicators** (also called view chips). Entering or leaving a view with an indicator—sorted notes, Untagged notes, Reference source, or Referenced by—applies note changes immediately without appearance/disappearance or collapse animations, including tab switches into or out of these views.
- Scroll restoration preserves an exact top position without delayed anchor alignment. Resetting a view cancels pending scroll restores from its previous content.
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
- **Sorted tabs: adding and editing notes.** In any non-normal sort order a new or edited root note could land far from where you are, so:

  | Sort | While you edit a note | New root note at the top (`Enter` outside edit mode, Add Note, pasting or dropping into a new note) | New root note below a root note (`⌘ + Enter`, Split, paste as sibling) |
  |---|---|---|---|
  | Normal | — | allowed | allowed |
  | Datetime created | order frozen (editing never changes it anyway) | allowed: it lands at the top | blocked |
  | Datetime last updated | order frozen | allowed: it lands at the top | blocked |
  | Alphabetical | order frozen | blocked | blocked |
  | Content volume | order frozen, also while editing a child note | blocked | blocked |

  - Child notes (`⇧ + ⌘ + Enter`, paste as child, or a sibling of a child note) can always be added: the sort orders only root notes.
  - A blocked action does nothing and shows a banner saying why (switch to Normal order, or add a child note). Pasting a copied note onto an empty note fills that note, so it is never blocked.
  - **Order frozen while editing:** the note you are editing (or the root note containing it) stays where it was, even when saving changes its date, name or size. In the date orders it shows under its neighbour's date header meanwhile.
  - **Leaving edit mode:** the note then moves to its sorted place, and the screen stays on the surrounding notes (like a mail app), so nothing you are looking at jumps. If the note keeps its place, your caret or reading line stays put as usual.
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
- Moving the pointer below the suggestion popup, or horizontally outside the centered notes column, hides open search suggestions while keeping focus in the search input (not while a suggestion's right-click menu is open: the pointer is on the menu). After that pointer dismissal, suggestions stay closed until the user resumes typing or clicks the search input again.
- Right-clicking a search suggestion (Control-click on a Mac) opens its tag menu: Edit Tag Relationships, then **Why suggested** below it. The search text, cursor, list and results stay as they were; `Escape` or moving the pointer away closes only the menu, and moving onto the menu does not count as leaving the list. A right-click is not a pick: it earns no activity credit.
- **Why suggested** says what the ranking used: `You've worked with it 12 times in the last 7 days` (`today` for the 1-day window) when a personalization window put it first; then `On 4 notes together with "python"` after completed tags, `Your search so far finds it on 1 note` after only text, `Leaving it out removes 4 of the 5 notes your search finds` for an exclusion, or `Tags are listed by how many notes have them` for a first tag; last, `Searching for it finds 230 notes`. Meta tags say `A built-in tag starting with "@bo"`. Implementation: `SearchIndex.describe_search_suggestions()` and `search_suggestion_reasons()` in `app/services/tag_suggestion_reasons.py`; tests: `tests/unit/test_tag_suggestion_reasons.py`, `scripts/browser-tag-suggestion-menu-regressions.mjs`.
- Right-clicking a tag already typed in the search box opens its tag menu with **About this tag** below Edit Tag Relationships: `Searching for it finds 230 notes` or `No note has this tag`; `On 34 notes together with "python"` (the other tags the search requires; not with `OR`); for `-tag`, `Leaving it out removes 4 of the 5 notes the rest of your search finds`; `Also finds notes tagged "ML"` (synonyms) and `Also finds notes tagged "maple", which implies it` (search matches effective tags); and `You've worked with it 12 times in the last 7 days` (the first activity window with any). Looked up on right-click (`POST /notes/search-tag-details`, `app/services/tag_details.py`). The search text and focus stay; `Escape` closes only the menu.
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
| Click `↑` button | Go to the top of the list (dimmed when already there). While editing, it first saves and leaves edit mode as `Esc` would. With notes unloaded above, the view is rebuilt from the first note instead of scrolling. |
| Click `↓` button | Go to the bottom of the list, the last note's bottom at the bottom of the window (dimmed when already there; both arrows are dimmed when the list fits the window). It scrolls smoothly, or with notes unloaded below it rebuilds the view at the end. While editing, it first saves and leaves edit mode. Search, Untagged and sort orders go to the end of what the view shows. |
| Click note arrow | Toggle collapse/expand note. Collapsing the note currently being edited saves it and exits edit mode before collapsing. Other arrows within the edited note's descendant subtree keep that edit session active; arrows outside that subtree save and exit first. |
| Click `⋮` under the edited note's tag bar | Expand that collapsed parent note to reveal its hidden children. |
| Click note or blank space inside its outer card | Edit/select that note. Parent-note whitespace still counts as the parent until you click into a child note/card. What you clicked stays under the pointer while the note switches to its editable source, and the caret goes there: on the clicked text when it appears in the source (also when the source adds markup around it, such as `- ` list markers or `#` heading marks); on a Mermaid diagram box, at that box's label in the diagram source, with that source line under the pointer; elsewhere on a Mermaid diagram, at the start of its ```` ```mermaid ```` source, which starts where the diagram did; on a rendered LaTeX formula, at the start of its TeX source, which goes where the formula was. CSV rows, JSON keys and Markdown table rows map through their text. Leaving edit mode with the caret inside a formula's source keeps the rendered formula where that source was. |
| Click redacted note | Reveal the full redacted set in that note's subtree for the current tab; the revealed notes stay dimmed to show they are still excluded by the active search |
| Click link-mode reference text | Open the referenced note in a temporary `Reference source` context; its internal exact-note filter remains hidden from the search field, tab label, and search history |
| Click `×` on the `Reference source` indicator | Return to the originating context and close the temporary source tab |
| Reload the page while a `Reference source` / `Referenced by` tab is open | The indicator and hidden query survive (kept per browser tab in `sessionStorage` and re-validated against the reloaded tab's search); raw note IDs never appear in the search field |
| Type in search while viewing a reference source | Dismiss reference-source mode and keep the current tab as a normal search context |
| Right-click anywhere inside a rendered note reference | Choose **Go to Source** to open the same temporary reference-source context |
| Press `@todo` / `@done` checkbox | Toggle the note status on mouse down. If another note is being edited, save + exit edit mode first and do not enter edit mode for the toggled note. |
| Press note shell / blank space | Select/edit that note on mouse down. Note content waits until click so drag/drop can disambiguate click vs drag. |
| Click the tag bar while editing | Focus the tag input without re-selecting the note shell. Mouse or keyboard focus adds a soft focus ring and, when Animated Transitions is enabled, a single subtle outward halo. |
| Click a Grammarly suggestion card | Keep the current note in edit mode while the assistant applies the correction. A subsequent ordinary outside click or `Escape` saves and exits as usual. |
| Double-click a tag in the search input or tag bar | Select the complete tag, including prefixes and internal punctuation (`foo-bar`, `@red`), without surrounding whitespace. Scoped groups select only the individual tag. Quoted search text and tag-bar comments keep native word selection. |
| Drag note body (while not editing) | Reorder among visible siblings based on vertical drop position (overshooting below the lowest sibling moves the note to the end of its siblings, and above the first sibling to the start; it never leaves its parent), or indent/outdent on horizontal drags. Once movement crosses the drag threshold, releasing back over the source note does not count as a click. While dragging, a dashed grey ghost of the note and its visible children follows the pointer on the drag's axis (vertical for reordering, horizontal for indent/outdent) and only within legal moves: between the first and lowest sibling, one level in under the note above, or one level out to the parent. A grey line marks where the note will land, with a faint outline on the note it lands beside or under; when a release would change nothing the ghost turns lighter and no line shows. The mouse cursor itself changes to name the action: an up or down arrow (the Move to Top icon and its mirror) for reordering, or indent/outdent icons for horizontal drags. A move that is not possible from there (dragging the first note up, indenting with nothing above to nest under, outdenting a root note) shows no icon, only the plain grabbing hand. The note lands where the drop line showed: its top on the line when moved up, its bottom on it when moved down, and the page does not scroll, whether the note is short or taller than the window. Only when that edge would land behind the search bar does the page scroll, just enough to put the note right below the bar with no extra space. Each of the three (ghost, drop indicator, direction cursor) can be turned on or off in the command palette's `Visual Cues` window; all are on by default and none changes the notes themselves. |
| Drag-select text in note | Available only in edit mode; releasing mouse outside note keeps edit mode + selection |
| Right-click external link | Open a link-only context menu with `Copy Link` and `Open Link in New Tab`. Note actions are hidden for link targets. |
| Right-click note | Open the note menu, grouped: what you clicked (image, diagram or reference actions) first; `Copy Note`; a `Paste` submenu (`Paste Sibling Note`, `Paste Child Note`, `Paste Sibling Reference`, `Paste Child Reference`, only when a note has been copied); an `Add` submenu (`Add Sibling Note`, `Add Child Note`, and `Add Note at Top` outside edit mode); a `Move` submenu (`Move to Top`, `Move Up`, `Move Down`, `Move to Bottom`, each only when that move can happen from this note, all hidden for a root while a sort order is active); an `Outline` submenu (`Fully Expand`, `Fully Collapse` when the note has children; `Indent`, `Outdent` when possible); a `Focus` submenu (`Full Screen`, `Floating Window`; while editing, `Full Screen` first leaves edit mode as `Esc` would, saving the note, so closing it returns to the note's normal view); an `Export` submenu (`Note as HTML`, `View as HTML`); while editing that note `Add Style`, `Remove Formatting`, `Add Excalidraw Diagram` and `Suggest Tags with AI` (only when an AI is set up and may see the note, see [tag-bar.md](tag-bar.md#suggest-tags-with-ai-one-note)); and `Delete Note` last. A group with a single possible action shows it in place instead of a submenu. Keyboard shortcuts are shown on the right; the moves act on the clicked note just as their shortcuts act on the edited one, saving another edited note first. Fully expanding/collapsing applies recursively to the selected note and all descendants, including descendants hidden by collapsed ancestors. A dark, non-interactive footer at the bottom always shows the note's locally formatted `Created` and `Updated` date/times. `View Full Screen` renders the selected note edge-to-edge with its complete descendant subtree but without ancestors, hides the menu and scroll-to-top controls, and closes with the upper-right `×` or `Esc`. `Add Style` opens a connected formatting flyout and `Remove Formatting` performs the same operation as `Cmd/Ctrl+U`. |
| Focus ▸ Floating Window (note menu) | Open that note and its complete descendant subtree in a read-only floating window. The title shows a ↗ reference link that opens the source note in ML3; password titles stay masked. Open multiple windows, drag the title-bar grip or empty space, and resize using the bottom-right handle (or focus the handle and use arrow keys). Windows stay fixed while the background scrolls and survive searches and ML3 tab changes. Saved changes appear live. Links, password/username copying, copyable text, and file downloads remain interactive; note references open another floating window. Close with × or Escape while focused. Windows close on page reload, logout, or namespace navigation. |
| Right-click selected note text | Open the note menu with `Copy` and `Add as Tag` for the selected text instead of `Copy Note`; while editing, `Add Style` scopes the chosen formatting tag to that range and `Remove Formatting` removes formatting only from that range. |
| Right-click image in note | Adds image actions to the note context menu: `Copy Image`, `Save Image`, `Zoom Image`, `Open Image in New Tab` |
| Right-click Excalidraw diagram in note | Adds diagram actions to the note context menu: `Edit Diagram`, `Make Bigger`, `Make Smaller`, `Reset Size`, `Zoom Diagram`, `Save Diagram File` |
| Double-click Excalidraw diagram | Open the full-screen diagram editor. A single click on a diagram does not enter edit mode for its note. In the editor, changes autosave after 2 seconds; `Done` or `Cmd/Ctrl+Enter` saves and closes; `Escape` stays with Excalidraw; `Discard changes` (click twice) restores the diagram as it was opened. Each editing session is one undo step in the main view. See `docs/ui/excalidraw.md`. |
| Right-click the note being edited | Also offers `Add Excalidraw Diagram`, which attaches an empty diagram to the note and opens the editor |
| Right-click anywhere in a completed AI response bubble (including padding and links) | Choose `Copy Response` to place its raw Markdown on the MetaList note clipboard with `@markdown @llm`, while also writing rendered HTML and raw Markdown to the system clipboard. It can be pasted as a note but not as a reference until inserted. |
| Interact with AI chat while editing a note | Keep the note in edit mode while using the chat input, controls, or transcript. Send saves the current draft without deselecting it and supplies its entire containing top-level tree—including ancestors, siblings, collapsed descendants, and per-note tags—separately from the broader result context, subject to search redaction and AI privacy rules. Previously fetched URL titles are included with permitted notes, including parent URLs. The edited note is explicitly marked when permitted; revealing or editing an excluded note does not share it with AI. Chat receives only selection presence and a coarse reason (private, excluded by the current search, or missing), so it can explain why without learning which privacy setting hides the note. With nothing selected, a question about "this note" gets an answer saying the AI doesn't know which note is meant. The model interprets the request using both contexts; selecting a note does not automatically narrow every question to it. Explicit reference navigation can still change the view. |
| Right-click notes view background | Open the view menu. Outside edit mode it starts with `Add Note at Top`, `Paste Note at Top` (only when a note has been copied), `Undo` and `Redo`; while a note is edited these are hidden because the editor owns `Enter`, `⌘V` and `⌘Z`. Then `Go to Top` and `Go to Bottom` (each only when not already at that end), `Fully Expand All`, `Fully Collapse All`; a `View` submenu (All notes / Untagged notes), `Sort by`, a `Show` submenu (Chat, Tabs, Tags in List) and a `Theme` submenu (System, Light, Dark), each ticking the current choice; `New Tab`, `Open/Switch Namespace…`, `Reminders…`; `Export View as HTML`; and `Log Out`. Keyboard shortcuts are shown on the right. Items that do not apply are hidden rather than greyed. |
| Right-click the tag bar past its tags (or an empty tag bar) | Open a menu with `Suggest Tags with AI` when an AI is set up and may see the note; otherwise nothing opens. The tag bar keeps its text, caret and focus. Right-click never shows the browser's own menu anywhere in MetaList. |
| Right-click tag in search input, tag bar, or their suggestion lists | Open tag context menu (Edit Tag Relationships); below it a suggestion's menu (tag bar or search) says **Why suggested**, a tag already in the tag bar or search box **About this tag**. A suggestion list, the typed letters and edit mode stay as they were. Choosing Edit Tag Relationships saves an edited note first and completes the view refresh, restoring view-only rendering such as cached URL titles. |
| Right-click left or right lane | Open the same view menu |
| Hover left side of search bar | Show the tab/search-context overlay |
| Hover/click search input | Hide the tab/search-context overlay |

> Tip: You can right-click directly on a tag without selecting the full text first (selection still works).
> In non-normal sort modes, drag/drop cannot reorder root notes, but it can still reorder children within a root.
> Saved-file image actions are available in view mode on rendered image previews; edit mode only contains the raw UUID token for those files.
> Collapse arrows reflect the server-provided `isCollapsible` flag, plus a browser-side promotion when rendered note content visibly wraps beyond one line. Overlapping inline fragments on the same visual line count as one line even when nested formatting uses different font sizes, such as a standalone link title followed by its smaller domain.
> The arrow glyph and click target are slightly enlarged; the 27×27px control is offset to preserve the arrow's original visual center.
> While editing, collapse arrows ignore content length and appear only for notes with children, because the edited note already shows its full content.
> Collapsed notes receive compact server-rendered content that starts at the first non-blank text or image line and contains only that line. A line ends at a line break or where a block element starts or ends, so text typed before Enter stays separate from the lines after it (the same rule gives reference and backlink previews their first line).
> Note expand/collapse transitions animate by default and are controlled by `Animated transitions` in the command palette.

> Visual cues are controlled in the command palette's `Visual Cues` window: under Drag and drop, three independent checkboxes (`Drag ghost`, `Drop indicator`, `Direction cursor`). All are on by default.
> Selecting a collapsed note for editing shows that note's full editable content but keeps its child subtree hidden until the note is explicitly expanded. If the collapsed note has hidden children, an inline `⋮` affordance appears under the tag bar and expands the note. Leaving edit mode after changing the note keeps it expanded (its children then show too); leaving without a change collapses it again.

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
- Note Layout & Appearance… (top-level size, child indentation, vertical spacing, note corners, and tag style)

> Note: On Windows/Linux, use `Ctrl` instead of `⌘` (Command) 

App menus close with `Escape` (only the menu: a note being edited stays in edit mode) or an outside click. The right-click menu also closes once the pointer moves about 28px away from it and any open submenu, like the tab overlay; small movements just past its edge keep it open. Every modal has a standard upper-right circular `×` matching full-screen note view and also closes with `Escape` or an outside click. Dismiss-only footer `Close`/`OK` buttons are omitted; `Enter` still submits a modal's declared primary workflow action.

When `Show tags in list` is enabled, the right-aligned tag column wraps and is capped at 25% of its note row so note content retains the majority of the available width. With the default `Pills` tag style (Note Layout & Appearance), each tag is an outlined pill, with meta tags and bracketed scopes dashed and `/* comments */` in italics; `Plain text` shows the saved tag string as grey text.

## Tag Bar Syntax
- See `docs/ui/tag-bar.md` for the full grammar (tokens, wrappers, and `/* ... */` comments).
- Leaving the tag bar (Tab toggle or click-away) sanitizes the value by removing incomplete/broken items.


### Update notifications
Each document load/refresh starts a fresh server-side PyPI check in parallel with app startup, including on the login page. Once authenticated and ready, a newly discovered release shows a dismissible reminder-style notice linking to Version Info. `pref.update_notice_version` remembers the displayed release using namespace preferences, so refreshes do not repeat it. Failed checks leave the app usable and Version Info offers Check again. Version Info also checks when opened.

Update is a deliberate action: it preflights the reviewed release, creates verified immutable backups, and restarts all namespaces. The modal displays progress and a Reload action on completion. Closing/reopening it in the same page resumes the accepted job. Job status can be read using its opaque ID after restart, but starting an update requires authentication. Source checkouts and unmanaged installs show the eligibility reason. After a post-shutdown failure, inspect the updater output/log and restart with `metalist`; automatic rollback is not provided.
