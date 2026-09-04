# Command Palette

Open with `⌘ + /` or the menu (`≡`) button in the upper right.

## Undo/Redo Boundary
Opening the command palette creates an explicit undo/redo boundary.
After you open it, subsequent undo/redo should not traverse operations that occurred before.

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
- `Sort order` is a per-tab, server-owned view setting. Duplicating a tab inherits its current sort mode.
- Modes are exposed as distinct actions: `Sort order: Normal`, `Sort order: Datetime created`, `Sort order: Datetime last updated`, `Sort order: Alphabetical`, and `Sort order: Content volume (largest first)`.
- In the datetime modes, root notes are ordered by the newest matching timestamp anywhere in that root subtree, not just on the root note itself.
- In alphabetical mode, root notes are ordered by root-note content without rewriting the stored manual order.
- In content-volume mode, roots are ordered largest-first by the total plain-text character count of every note in each root subtree. HTML markup does not count, and equal totals preserve manual root order. Search phrases include `character count`, `content volume`, `length`, and `longest`.
- The server returns the ordered root window plus `sortMode`/`rootSortBuckets`; the client inserts day-separator rows between visible roots.
- When a non-normal sort mode is active, the UI shows a floating dismissible pill above the sticky top bar so the view override is visually obvious and can be cleared in one click.
- Changing sort mode is treated as a global view-context switch: the tab scroll state resets and undo/redo history is blanked for that tab context.
- Changing the search input resets the active tab's sort mode to Normal before executing the search.

## Untagged Notes View
- `View: Untagged notes` temporarily overrides the displayed results with notes that have no non-meta effective tags while preserving the active tab and its search. Its search box is visually blank because the preserved query is not active.
- `View: All notes` returns to the underlying tab view. The active untagged view also appears as a dismissible pill above the sticky top bar.
- The setting is transient and tab-agnostic: it is not persisted or inherited when a tab is duplicated.
- Clicking any tab, changing the search input, or dismissing the pill exits the untagged view. Changing it resets the active display's scroll state and undo/redo context.

## Config
- Tag mappings live in `app/static/config/command_palette_tags.json`.
- Endpoint definitions (behavior/labels) live in code.
- Palette preferences (`pref.*`) and command usage history are persisted per namespace in the main SQLite DB via `/api2/auth/client-state*`, not in browser `localStorage`.
- `Animated transitions` is on by default and controls UI motion such as tag-bar edit transitions and note expand/collapse transitions.
- `Note Layout & Appearance…` stores namespace-scoped presets for top-level note size, child indentation, and vertical spacing. The defaults are `Larger`, `Standard`, and `Comfortable` respectively.
- `Search suggestion stats & settings…` is the single suggestion-personalization control surface. Its ordered 1–365 day slots and default-on time-window-label and one-credit-per-note-per-search-context toggles save immediately when changed. The modal also displays retained daily tag-credit statistics and provides the confirmed activity reset. An empty slot list disables personalization; the default slots are 1, 7, and 30 days.
- `Show/Hide AI Chat` controls the resizable right-side chat panel.
- `AI Agent Settings…` shows the MetaList-managed loopback Ollama runtime, selects a downloaded model, and configures namespace-scoped maximum characters per returned note and matching result trees per search page. MetaList owns one shared on-demand daemon at `127.0.0.1:11435` with a required 32,768-token context window; the URL is not user-editable. The read-only agent may search and read hydrated notes through application-owned tools; no mutation action exists. See `docs/ui/ai-chat.md`.
- `Agent prompts…` inspects all three packaged runtime prompts plus collapsible
  registered skills and saves validated namespace-specific overrides. Reset removes
  every prompt/skill override and resumes using packaged defaults; changes apply to
  the next agent run and never enter conversation history.
- Session idle timeout is disabled by default. It is a namespace-scoped server setting stored in `app_settings` and managed via `/api2/auth/settings/session-timeout`. Expiry requires browser reauthentication but preserves the hydrated server cache for a fast login; explicit logout still purges decrypted runtime state.
- On first launch after this change, the browser imports any legacy command-palette `localStorage` values into the namespace DB and then clears those legacy keys.

## Utility Actions
- `Create backup now`: opens Backup Settings, where the user chooses one backup folder, picks which namespaces to include, and sets the retention count. `Back Up Now` submits those settings directly to the backend operation that persists them and creates the archives; the completion modal appears only after concrete archive results return and shows the created size per namespace. Typing `backups` in the palette also matches this action.
  - Each backup snapshot is one versioned `.tar.gz` archive containing the notes DB plus sibling files DB when present.
  - The completion modal shows one result row per namespace.
- `Restore from backup…`: opens a restore picker for configured-folder snapshots, applies the selected archive, then shows a success confirmation with `OK` before reload.
  - Restore reuses the same archive pipeline for both sources and recreates the sibling files DB from the archive contents. The source archive and legacy sidecars remain byte-for-byte unchanged; legacy search-history sidecars are ignored.
- `Export as HTML`: downloads a self-contained HTML file for the current view with inline CSS, the active light/dark theme, all exported notes fully expanded, no command/search chrome, no collapse arrows, and `@password` note values redacted to matching-length `X` characters while keeping the blur styling.
- `Logout`: revokes the current session and returns to login.
- `Generate random password…`: opens a password generator modal with editable length/character set controls, explicit `Copy` and `Regenerate` actions, the standard modal `×`, and a clipboard handoff that auto-adds `@password` when that copied value is pasted into an empty note.
- `Session idle timeout…`: opens a modal for changing the namespace-scoped inactivity window before reauthentication is required again, or disabling idle timeout entirely.
- `Reminders…`: opens the privacy-first in-app reminder registry and builder. Reminders are namespace-local, encrypted with the namespace when password protection is enabled, and never use browser/system push notifications. See `docs/ui/reminders.md`.
- `Keyboard Shortcuts / Cheatsheet…`: opens the keyboard shortcuts cheatsheet from the command palette; `cheatsheet` is a searchable keyword.
- `Version info…`: opens a read-only runtime/version modal with app version, SQLite `user_version`, namespace, auth, encryption, vault, KDF, and cache readiness fields.
- `Note Layout & Appearance…`: previews and saves the note hierarchy presets. Search terms include `layout`, `appearance`, `font`, `size`, `spacing`, `indentation`, and `hierarchy`.
- `Search suggestion stats & settings…`: combines ordered personalized-window editing, promoted-suggestion label visibility, default-on per-context note-credit suppression, retained daily tag-credit statistics, and confirmed activity reset. It does not collect search text or note content.
- `AI Agent Settings…`: configures the loopback Ollama endpoint and bounded note-retrieval page/size limits used by the read-only agent harness. The chat composer loads installed models and keeps its model and thinking-level selectors immediately left of Send.
- `Agent prompts…`: opens the prompt-and-skill editor. Template placeholders and
  skill text are validated before saving, and protected namespaces encrypt these
  overrides through the existing client-state path.
- `Switch namespace…`: opens a simple namespace picker, leaves the current namespace tab open, and opens the selected non-current namespace in a new browser tab. A running namespace with an unchanged launch profile keeps its process and warm cache; stopped namespaces launch, and changed port profiles restart the target. Each namespace still permits only one active browser tab/session.
- `Create namespace…`: opens a namespace creation modal with defaulted HTTP / HTTPS ports that skip both saved MetaList reservations and ports with active OS listeners, saves the profile, launches the namespace, and opens it. Launch-time port races fail without terminating the process that owns the port. Running namespace servers revalidate their on-disk namespace identity every five seconds and terminate themselves if their database or launch profile disappears.
- `Manage namespace ports…`: opens a table of saved launch profiles from each namespace's main DB; saving this table only updates future launch profiles and does not switch tabs, launch namespaces, or restart the current process. Current-namespace port edits apply on the next MetaList launch.
- `Delete namespace…`: asks which namespace to delete, then opens a destructive confirmation view for that target. The confirm button is red and the user must type the namespace name. Deletion never requires the namespace password, so an inaccessible encrypted namespace can still be removed. Deleting the active namespace moves the tab to a dedicated namespace-removal status page; deleting an inactive namespace stays in the current tab and reports completion in the modal.
- `Attach file…`: opens the native file picker, uploads the selected file, and inserts an embedded file reference token into the current note. If no note is active, it creates a new note first.
- `Trim unused files`: deletes file rows whose UUIDs are no longer referenced anywhere in note content. This is the only automatic cleanup path for orphaned attachments.
- `Prioritize tag to front (global)…`: opens a warning modal with single-tag input and suggestions from all root notes. Applying it stably moves all matching root notes to the front of the global root order while preserving relative order inside the matching and non-matching groups. Cmd+Z cannot undo this action; the undo/redo queue is cleared.
- `Prioritize tag to back (global)…`: same as above, but stably moves all matching root notes to the back of the global root order.
- `Alphabetize root notes A-Z (current view)…`: after confirmation, permanently rearranges only root-level notes in the active search context by root-note content. Hidden roots and child notes are not reordered. Cmd+Z cannot undo this action; the undo/redo queue is cleared like a view-context switch.
- `Alphabetize root notes Z-A (current view)…`: same as A-Z, but descending by root-note content.
- `Repair: reset updated time to created time (current view)…`: after confirmation, resets every note inside each matching root subtree in the active search context so `updated_at = created_at`. Notes outside the current view are not changed. Cmd+Z cannot undo this action; the undo/redo queue is cleared.

## Collapse/Expand All
"(current view)" means the full active search context (not just rendered DOM).
The implementation uses `POST /api2/notes/set-collapsed-in-context`.
Only root notes in that context are expanded or collapsed. Child and deeper descendant notes retain their individual saved expanded/collapsed states.

These are treated as **global** actions:
- The client bumps the undo-context epoch.
- The server clears undo/redo history for the active undo context.
