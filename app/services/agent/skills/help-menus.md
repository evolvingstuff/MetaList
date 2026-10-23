# Menus and settings

Use this reference to explain MetaList accurately. It describes user capabilities,
not permission or tools for you to execute every operation. You can answer and
request one supported menu/dialog opening. You cannot submit a form, change
settings, run a shell command, or mutate notes through this help response. Do not
claim that you inspected current notes or settings: none are supplied here.
Prefer user-facing steps over implementation details. If the reference does not
answer a question, say what is unknown; do not invent syntax or controls.

Sources: docs/ui/command-palette.md

# Command Palette

Open with `⌘ + /` or the menu (`≡`) button in the upper right.

## Undo/Redo Boundary
Opening or dismissing the command palette does not clear undo/redo. Global actions establish their own boundaries; bulk tag proposal actions clear the existing stacks only after successful changes and create no undo entry. Failure, cancellation, or no changes preserves history. See [undo/redo scope](state-handling.md#bulk-operations-are-outside-ordinary-undoredo).

## Tag proposal controls

- **Accept or reject AI-proposed tags** (tags the AI chat proposed, not yet accepted) selects acceptance/removal, current context/entire vault, and an exact case-insensitive tag filter (blank means all proposals). Apply executes directly without another confirmation, model call, or progress/cancellation modal; the normal busy spinner remains visible until completion.
- **Reject all AI-proposed tags (current context)** asks for confirmation, then removes every pending proposal in the active search context. It uses the same atomic bulk path and requires no configuration form or model call. After confirmation, the normal busy spinner replaces the confirmation without opening a second modal.
- **AI tagging vocabulary** sets one categorical preference: existing tags only or allow new tags. The tagging instructions themselves are built in and cannot be edited.
- Generate proposals by explicitly requesting them in AI chat. Generation is not a menu action.

## Semantics
- Query is an unordered bag of words.
- AND-only matching against manually-authored tags.
- While you are mid-token (no trailing space), it behaves as a prefix filter.

## Results
- Booleans toggle with `Enter`.
- Boolean labels describe the next action: `Show …` while hidden and `Hide …` while visible.
- Selects cycle with `Enter` (and adjust with `←`/`→`).
- Actions run with `Enter`.

## Sort Order
- The notes-view background and side-rail right-click menus also offer **Sort by**: Normal, Datetime created, Datetime last updated, Alphabetical, and Content volume, then **Reverse Order**, a check item that combines with any of them (Normal too: the manual order bottom to top). Reversed, Alphabetical is Z to A, the date orders start from the oldest, and Content volume from the smallest; date separators flip with the notes. Picking another order keeps Reverse Order. The current mode is ticked and disabled. Choosing a mode updates the same saved per-tab setting as the command palette; Normal restores manual order.
- `Sort order` is a per-tab, server-owned view setting. Duplicating a tab inherits its current sort mode.
- Modes are exposed as distinct actions: `Sort order: Normal`, `Sort order: Datetime created`, `Sort order: Datetime last updated`, `Sort order: Alphabetical`, and `Sort order: Content volume`, plus `Sort order: Reverse`, which turns Reverse Order on or off.
- Datetime created orders roots newest-first by each root note's own creation timestamp; children do not affect its position or date group.
- Datetime last updated orders roots newest-first by the latest update timestamp anywhere in the root's subtree, including the root and all descendants. Date groups use that same timestamp.
- Changing a reference between link and embedded form preserves the host note's update time, including undo/redo and manually changing only that marker. Adding/removing references, changing their targets, or editing surrounding content still advances the timestamp.
- In alphabetical mode, root notes are ordered by root-note content without rewriting the stored manual order.
- In content-volume mode, roots are ordered largest-first by the total plain-text character count of every note in each root subtree. HTML markup does not count, and equal totals preserve manual root order. Search phrases include `character count`, `content volume`, `length`, and `longest`.
- The server returns the ordered root window plus `sortMode`/`rootSortBuckets`; the client inserts day-separator rows between visible roots.
- In a non-normal sort order, new root notes are limited and editing freezes the order: Datetime created and Datetime last updated allow a new root note only at the top (`Enter` outside edit mode, Add Note, pasting into a new note), never below a root note; Alphabetical, Content volume and any reversed order (Normal too) allow no new root notes. Child notes can always be added. Blocked actions show a banner. While a note is edited, it stays in place even if saving changes its sort position (in date orders, under its neighbour's date header); after leaving edit mode it moves to its sorted place and the screen stays on the surrounding notes. Details: `help-notes` (Sorted tabs).
- When a non-normal sort mode is active, a gray chip at the right end inside the search input names it (`Created`, `Updated`, `A–Z`, `Size`; reversed: `Created ↑`, `Updated ↑`, `Z–A`, `Size ↑`, or `Reversed` for Normal reversed; the full name is its tooltip). Its `×` returns to Normal order, not reversed. Untagged notes shows the same kind of chip, `Untagged`, before it, and a date range its own (`Updated · today`) between them.
- Changing sort mode is treated as a global view-context switch: the tab scroll state resets and undo/redo history is blanked for that tab context.
- Changing the search input resets the active tab's sort mode to Normal (and ends Reverse Order) before executing the search. Leaving a tab (picking another or opening a new one) does the same for the tab left; a new blank tab starts in Normal order. Following a reference and coming back keeps the sort.

## Date Range
- **Date range** (after Sort by in the background, side-rail and search-box right-click menus) shows only the root notes whose date is in a range, each with its children. First the date, ticked: **Last updated** (the latest update anywhere in the root's subtree) or **Created** (the root's own creation). Then the range: **Any date** (no filter), **Today**, **Last 7 days**, **Last 30 days**, **This year** (counted back from today, today included), and **Custom Range…**, a dialog with Last updated/Created and From and To dates (both included; either may be left empty). Picking the other date moves the active range to it; with no range it is used for the next one.
- Palette actions: `Date range: Last updated`, `Date range: Created`, `Date range: Any date`, `Date range: Today`, `Date range: Last 7 days`, `Date range: Last 30 days`, `Date range: This year`, `Date range: Custom range`.
- It combines with a search, Untagged notes and any sort order.
- A gray chip inside the search input names it (`Updated · today`, `Created · Oct 1–22`, `Updated · since Oct 1`); the full wording is its tooltip and its `×` shows every date again.
- Like a sort order it is kept per tab and ends with its `×`, a new search, or leaving the tab; a new tab starts without one; following a reference and coming back keeps it.
- A note being edited stays in view even when saving puts its date outside the range; after leaving edit mode it leaves the view.
- Export, Print, find (⌘F) and the AI chat's view use the tab's range.

## Untagged Notes View
- `View: Untagged notes` temporarily overrides the displayed results with notes that have no non-meta effective tags while preserving the active tab and its search. Its search box is visually blank because the preserved query is not active.
- `View: All notes` returns to the underlying tab view. The active untagged view also appears as an `Untagged` chip inside the search input, before any sort chip.
- The setting is transient and tab-agnostic: it is not persisted or inherited when a tab is duplicated.
- Clicking any tab, changing the search input, or dismissing the chip exits the untagged view. Changing it resets the active display's scroll state and undo/redo context.

## Config
- Tag mappings live in `app/static/config/command_palette_tags.json`.
- `Find in list` opens the find bar, as `Cmd+F` does (`docs/ui/find.md`).
- Any word of a command's name finds it in the palette (`edit` finds `Edit tag relationships`), besides the topic words listed for it (`ontology`, `synonym`).
- Search `LLM` or `OpenAI` to find `AI Agent Settings` for API key and model configuration.
- Endpoint definitions (behavior/labels) live in code.
- Palette preferences (`pref.*`) and command usage history are persisted per vault in the main SQLite DB via `/api2/auth/client-state*`, not in browser `localStorage`.
- `Animated transitions` is on by default and controls UI motion such as tag-bar edit transitions and note expand/collapse transitions.
- `Dictation Settings` sets the spoken phrases for pasted dictated text: the phrase that starts tags in a note (`start tags`), the phrases that start and end a quote (`quote`, `end quote`), and the phrase that excludes the next search term (`minus`). Each is words of letters, 2 to 64 characters; the quote and exclusion phrases must differ. Save applies them, Escape or a click outside closes without saving.
- `Visual Cues` opens one window of independent checkboxes, all on by default and saved immediately. Under Drag and drop: `Drag ghost` (a dashed outline of the dragged note and its visible children follows the pointer), `Drop indicator` (a grey landing line plus a faint outline on the note it lands beside or under), and `Direction cursor` (the mouse cursor itself becomes an up, down, indent or outdent icon for a possible move; impossible moves and the option turned off keep the usual grabbing hand). They change only what is shown; dragging works the same. Close the window with Escape or by clicking outside it.
- `Note Layout & Appearance` stores vault-scoped presets for top-level note size, child indentation, vertical spacing, note corners, and tag style. The defaults are `Larger`, `Standard`, `Comfortable`, `Round`, and `Pills` respectively. Note corners can be `Subtle`, `Rounded`, or `Round`; tag style shows visible note tags as outlined `Pills` or `Plain text` in both themes.
- `Search suggestion stats & settings` is the single suggestion-personalization control surface. Its ordered 1–365 day slots and default-on time-window-label and one-credit-per-note-per-search-context toggles save immediately when changed. The modal also displays retained daily tag-credit statistics and provides the confirmed activity reset. An empty slot list disables personalization; the default slots are 1, 7, and 30 days.
- `Show/Hide AI Chat` controls the resizable right-side chat panel.
- `AI Agent Settings`: configures the OpenAI API key, model, cloud privacy policy, evidence-token limit, and tagging batch size. Model and thinking level are also selected beside chat Send. See `docs/ui/ai-chat.md`.
- AI prompts and skills are built in and cannot be edited, so the AI behaves the same for every user; there is no prompt editor.
- Session idle timeout is disabled by default. It is a vault-scoped server setting stored in `app_settings` and managed via `/api2/auth/settings/session-timeout`. Expiry requires browser reauthentication but preserves the hydrated server cache for a fast login; explicit logout still purges decrypted runtime state.
- On first launch after this change, the browser imports any legacy command-palette `localStorage` values into the vault DB and then clears those legacy keys.

## Utility Actions
- `Create backup now`: opens Backup Settings, where the user chooses one backup folder, picks which vaults to include, and sets the retention count. `Back Up Now` submits those settings directly to the backend operation that persists them and creates the archives; the completion modal appears only after concrete archive results return and shows the created size per vault. Typing `backups` in the palette also matches this action.
  - Each backup snapshot is one versioned `.tar.gz` archive containing the notes DB plus sibling files DB when present.
  - The completion modal shows one result row per vault.
- `Backup reminder`: `Off`, `Daily`, `Weekly` (the default), `Every 2 weeks` or `Monthly`, saved per vault; Enter cycles it like `Theme`. When this vault's newest backup in the backup folder is older than that (or there is none), a card floats at the bottom right: `Time to back up: the last backup was 9 days ago.` with `Back Up Now` (opens Backup Settings, as `Create backup now` does) and `×` (hides it for a day). It is not a Reminders reminder. It takes no space and never takes focus; it waits while a dialog or the menu is open, stays until a backup succeeds (cancelling Backup Settings keeps it), and goes away when set to `Off`. It is checked when MetaList opens, when its tab comes back, when a dialog or the menu closes, and on the first click or key after a while.
- `Restore from backup`: opens a restore picker for configured-folder snapshots, applies the selected archive, then shows a success confirmation with `OK` before reload.
  - Restore reuses the same archive pipeline for both sources and recreates the sibling files DB from the archive contents. The source archive and legacy sidecars remain byte-for-byte unchanged; legacy search-history sidecars are ignored.
- `Export as HTML`: downloads a self-contained HTML file of the current view as shown (its search, sort order, Untagged view; notes the search leaves out are absent, not grey bars) with inline CSS, the active light/dark theme, notes starting collapsed and expanded as MetaList shows them (embeds too; the note being edited open), no command/search chrome, MetaList's collapse arrows (one collapses its note to the first line and hides its children), and click-to-copy for usernames, included passwords and `@copyable` values. A dialog comes first: the title (default selected: the note's first line, `MetaList`, `MetaList — <search>` or `MetaList — Untagged notes`; it heads the file and names it, `Spring in Kyoto.html`), `🤖 Suggest with AI` with an AI set up (only pressing it asks; it never sees private notes, passwords or the search), and, if it shows `@password` or `@username` notes, an `Include Unredacted Passwords` / `Usernames` / `Usernames and Passwords` checkbox (unchecked: each shows `••••••••`; checked: plain and readable). The title heads the file unless the first note already says it.
- `Print view`: prints the current view as shown through the browser's print dialog (Save as PDF included): always light, fully expanded, MetaList's colours kept (embed tints), no arrows. The same dialog comes first (title, `🤖 Suggest with AI`, Include passwords); Enter prints, Escape cancels. It uses the page's full width with its own margins, so the browser prints no header or footer. The title heads the first page and names the PDF.
- `Logout`: revokes the current session and returns to login.
- `Generate random password`: opens a password generator modal with editable length/character set controls, explicit `Copy` and `Regenerate` actions, the standard modal `×`, and a clipboard handoff that auto-adds `@password` when that copied value is pasted into an empty note.
- Password alphabets ignore line breaks and duplicate characters; each distinct Unicode code point has equal selection probability. Length counts Unicode code points, so an ordinary emoji counts as one; combined emoji sequences may contain several code points.
- `Session idle timeout`: opens a modal for changing the vault-scoped inactivity window before reauthentication is required again, or disabling idle timeout entirely.
- `Reminders`: opens the privacy-first in-app reminder registry and builder. Reminders are vault-local, encrypted with the vault when password protection is enabled, and never use browser/system push notifications. See `docs/ui/reminders.md`.
- `Keyboard Shortcuts / Cheatsheet`: opens the keyboard shortcuts cheatsheet from the command palette; `cheatsheet` is a searchable keyword.
- `Version info`: opens a read-only runtime/version modal with app version, SQLite `user_version`, vault, auth, encryption, encryption format version, KDF, and cache readiness fields.
- `Memory usage`: opens a read-only modal with this vault's server process memory now and at its peak (on macOS the footprint Activity Monitor shows, elsewhere resident memory; a Measured as row says which), how many notes it holds decrypted in memory and the size of their text, and how long the server has run; Refresh reads them again. Measure what holds it measures, in a few seconds, how much each part of the server holds (the note text cache, the note store, the search index, rendered views, open views, link titles, attachments, undo history) and what is left for Python and its libraries; sizes only, never content, and saving waits while it measures. Copy puts everything the dialog shows on the clipboard as plain text (the breakdown too, once measured). It is the server process (which holds the decrypted notes), not the browser's memory.
- `Note Layout & Appearance`: previews and saves the note hierarchy presets. Search terms include `layout`, `appearance`, `font`, `size`, `spacing`, `indentation`, and `hierarchy`.
- `Search suggestion stats & settings`: combines ordered personalized-window editing, promoted-suggestion label visibility, default-on per-context note-credit suppression, retained daily tag-credit statistics, and confirmed activity reset. It does not collect search text or note content.
- `AI Agent Settings`: configures the OpenAI API key, model, cloud privacy policy, evidence-token limit, and tagging batch size. Model and thinking level are also selected beside chat Send. See `docs/ui/ai-chat.md`.
- `Open/Switch vault`: opens a simple vault picker with two buttons. `Open in This Tab` loads the selected non-current vault in the same tab, on its login screen, so switching back and forth keeps one tab (Back returns to the previous vault). `Open in New Tab` opens it in a new browser tab and leaves the current tab as it is. With no other vault yet, it opens Create vault instead.
  Either way, a running vault with an unchanged launch profile keeps its process and warm cache; stopped vaults launch, and changed port profiles restart the target. Each vault still permits only one active browser tab/session.
- `Create vault`: opens a vault creation modal with defaulted HTTP / HTTPS ports that skip both saved MetaList reservations and ports with active OS listeners, saves the profile, launches the vault, and opens it. Launch-time port races fail without terminating the process that owns the port. Running vault servers revalidate their on-disk vault identity every five seconds and terminate themselves if their database or launch profile disappears.
- `Manage vault ports`: opens a table of saved launch profiles from each vault's main DB; saving this table only updates future launch profiles and does not switch tabs, launch vaults, or restart the current process. Current-vault port edits apply on the next MetaList launch.
- `Delete vault`: asks which vault to delete, then opens a destructive confirmation view for that target. The confirm button is red and the user must type the vault name. Deletion never requires the vault password, so an inaccessible encrypted vault can still be removed. Deleting the active vault moves the tab to a dedicated vault-removal status page; deleting an inactive vault stays in the current tab and reports completion in the modal.
- `Attach file`: opens the native file picker, uploads the selected file, and inserts an embedded file reference token into the current note. If no note is active, it creates a new note first.
- `Add Excalidraw diagram`: attaches a new, empty Excalidraw diagram to the current note (or a new note when none is active) and opens the full-screen diagram editor.
- `Trim unused files`: deletes file rows whose UUIDs are no longer referenced anywhere in note content. This is the only automatic cleanup path for orphaned attachments.
- `Retry failed link titles`: asks every web link whose title lookup failed (rate limited, refused, login or verification page, no title, timed out, page not found and other errors) again now. It opens a dialog saying how many links it would ask; nothing runs until its **Retry N links** button (or Enter). Unsupported links (such as PDFs) and private-network links are not retried. It uses the usual polite pacing: one request per site at a time, 2 seconds apart; a site that answers "too many requests" is skipped for the rest of the run and its links keep their normal retry schedule. The same dialog then shows progress: links asked, titles found, what still fails and why, and skipped sites. It does not block the app: closing the dialog (×, Escape or a click outside) leaves the retry running, and running the action again shows its progress instead of starting another. **Stop** drops the lookups not yet started; logging out, locking or logging in also stops it. Titles found appear in notes at the next view refresh.
- `Prioritize tag to front (global)`: opens a warning modal with single-tag input and suggestions from all root notes. Applying it stably moves all matching root notes to the front of the global root order while preserving relative order inside the matching and non-matching groups. Cmd+Z cannot undo this action; the undo/redo queue is cleared.
- `Prioritize tag to back (global)`: same as above, but stably moves all matching root notes to the back of the global root order.
- `Alphabetize root notes A-Z (current view)`: after confirmation, permanently rearranges only root-level notes in the active search context by root-note content. Hidden roots and child notes are not reordered. Cmd+Z cannot undo this action; the undo/redo queue is cleared like a view-context switch.
- `Alphabetize root notes Z-A (current view)`: same as A-Z, but descending by root-note content.
- `Repair: reset updated time to created time (current view)`: after confirmation, resets every note inside each matching root subtree in the active search context so `updated_at = created_at`. Notes outside the current view are not changed. Cmd+Z cannot undo this action; the undo/redo queue is cleared.

## Collapse/Expand All
"(current view)" means the full active search context (not just rendered DOM).
The implementation uses `POST /api2/notes/set-collapsed-in-context`.

- **Expand all root notes** and **Collapse all root notes** update only the roots in that context. Child and deeper descendant notes retain their saved states.
- **Fully expand all notes** and **Fully collapse all notes** recursively update every descendant under those roots, including descendants that are not currently rendered because an ancestor is collapsed.

These are treated as **global** actions:
- The client bumps the undo-context epoch.
- The server clears undo/redo history for the active undo context.
