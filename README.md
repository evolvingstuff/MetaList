# MetaList

A minimalist single-user note-taking app focused on server-side rendering (SSR), fast in-memory tree operations, and efficient sync/diff updates.

## Features
- Rich text editing (ContentEditable) with image support
- Drag-and-drop note reordering
- Real-time content saving
- Keyboard shortcuts / cheatsheet (press `?` in the app)
- Linked-list ordering model for efficient reorders
- Optional password protection + encryption at rest (AES-GCM)
- Multi-tab search contexts with server-persisted scroll/search state (survives browser restarts)
- Manual namespace backups/restores to a user-selected backup folder with retention controls

## Changes in 0.21.0

- **Memory usage** (command palette): the server's memory now and at its peak (on a Mac as Activity Monitor counts it), the notes it holds decrypted, how long the last unlock took and where, and *Measure what holds it*, a breakdown of each part; Copy puts it all on the clipboard.
- Much lighter and faster for large namespaces (measured on about 107,500 notes): memory down from about 1.5 GB to about 640 MB, starting the servers from 4.6 to about 2 s (the launch ends with "Ready in"), unlocking from about 9 to about 6 s. Suggestions after typing a tag and a space now come in a few hundredths of a second instead of most of a second, and searches of tags alone are faster.
- Search highlights the quoted phrases it found. `@code` finds every `@code=<language>` note, suggestions offer the family and its members, and `@code=python` can be typed directly.
- **Backup reminder** (command palette): Off, Daily, Weekly (the default), Every 2 weeks or Monthly. When this namespace's newest backup is older than that, a card floats at the bottom right.
- References have one syntax, and embedded notes are drawn like the main tree. ⌘V pastes what is on the clipboard rather than the last copied note, a pasted note keeps each copied note's collapsed or expanded state, and a click on a short Markdown list item edits that item.
- Pasted web addresses lose their tracking parameters.
- AI privacy: the text actually sent is checked against the privacy settings, private search terms are never sent, proposed tags never count toward a whitelist, and changing the privacy settings stops a request already under way.
- Exported HTML is cleaned like the note view and carries its own security policy; code lines stay whole in full screen and in exports.
- Fixed: right-clicking selected images (just pasted, for example) failed instead of opening the image menu; a refused chat Send now stays on screen with its reason; Enter and the arrow keys act only on a suggestion list made for what was typed; the banner and zoom work while editing; clicking a diagram edits it and pictures can be dragged; a move that changes nothing does nothing; a save made while a password is being set (or a backup restored) waits for it to finish instead of failing, and the "Processing" page returns to MetaList on its own; reminder fixes.
- **MetaList now needs Python 3.11 or newer.** Python 3.10 reaches its end of life this month, and Pillow's fixes below no longer support it. An install on Python 3.10 needs a newer Python before it can update.
- Security: Pillow 13.0.0 (eight advisories in decoding crafted TIFF, GIF, PPM, EPS and PDF files, which MetaList meets in remote images and attachments), pypdf 6.20.1 (crafted PDFs that loop or use too much memory), aiohttp 3.14.4 (GHSA-2g87-pp6c-29x5), certifi 2026.10.19 and uv 0.13.4. The source repository moved to [metalist-app/metalist](https://github.com/metalist-app/metalist).

## Changes in 0.20.0

- **Suggest Tags with AI** for the note being edited: right-click the note, or its tag bar past the tags, and choose 🤖 Suggest Tags with AI (for a note with children: This Note, or This Note and Its Children). The proposals appear under the tag bar for `+`/`−`, tags not yet in use marked **new** and grouped on the right; adding them can be undone. It shows only when an AI is set up and may see the note.
- The robot count (🤖 N) next to a note: click it to open every collapsed note on the way to its proposals and edit the highest one that has some; right-click it to Accept All or Reject All, one undo step.
- **Print**: the note menu's Print ▸ Note / View, the background menu's Print View, or the palette's Print view, through the browser's print dialog (Save as PDF included). Always light, fully expanded, without arrows, using the page's full width with its own margins, so the browser prints no header or footer.
- Export as HTML and Print open one dialog: a title with a smart default (the note's first line, or MetaList with the view's search), which heads the page unless the first note already says it and names an exported file; 🤖 Suggest with AI for the title, asked only when you press it, which never sees private notes, usernames, passwords or the search; and, when some would show, an Include Unredacted Passwords / Usernames checkbox (unchecked: each shows `••••••••`, whatever its length).
- Exported HTML files show the view as it is shown (its search, sort order, Untagged view; notes a search leaves out are absent), start fully expanded with MetaList's collapse arrows working in the file, and copy usernames, included passwords and `@copyable` values on click. Collapsing no longer shifts the page sideways.
- `@username` notes are private like `@password`: never sent to the AI. Username, password and email rows show just their icon, named on hover, and the value.
- Text never runs out of its note: a word too long for the line (a token, a hash, a long URL) breaks at the note's edge, and code, `@json`, `@diff`, CSV and Markdown code blocks wrap. Images shrink to fit their note or embedded note, and `@size` scales them only up to that width.
- The light theme's header bar is black again, with white icons and count, and the AI chat header now lines up with the search bar.

## Changes in 0.19.0

- Paste formats: pasting a fenced code block that names its language tags the note `@markdown`, and `@markdown` now colours that code like `@code=<language>` (with its label). Code copied from VS Code is tagged `@code=<its language>`, and cells copied from Excel, Google Sheets or Numbers become CSV text tagged `@csv`.
- Text that only looks like a format is offered, not applied: after pasting CSV-like, Markdown-like or code-like text, a small card says "Apply as CSV" / "Apply as Markdown" / "Apply as Python" (up to three close languages for code) with "Skip". The card moves nothing and never takes the keyboard; typing on, Escape or a click elsewhere closes it. It also appears when the paste makes a new note.
- Right-click a tag already in the tag bar or the search box for **About this tag**: whether the note names it, the notes it shares with your other tags, whether a parent or a rule already gives it, its synonyms and implications, how many notes have it ("Only on this note" hints at a typo); in the search box, what it finds and what leaving it out removes. Edit Tag Relationships now comes first in the tag menu, at a fixed place under the pointer.
- Tag suggestions: a web address in a note counts only by its site's name, so a YouTube link no longer suggests `HTTPS` or `V-neuron`; one letter alone no longer names a tag with longer words. A suggestion without evidence now says only what is true (what you typed matches, which part of its name the note has) instead of "Nothing in this note points to it".
- Fixed: accepting a Grammarly suggestion while editing could undo itself and end editing, when Grammarly drew its card in an element MetaList did not recognise.
- Removed the "Make pseudo-suggestions" test item from the note menu.

## Changes in 0.18.0

- Right-click a tag suggestion, in the tag bar or the search bar, to see why it is suggested. The menu starts with **Why suggested**: the words of the note that name the tag (or a synonym), the tags it goes with and on how many notes, notes sharing this note's tags, whether it already applies through a parent or a rule, or that nothing in the note points to it; then how often the tag is used. Search suggestions also say how often you worked with a tag lately (when that put it first), what your search so far finds, or what leaving it out removes. The reasons are MetaList's own ranking, not the AI's, and appear instantly.
- Fixed: right-clicking a suggestion closed the list and opened the menu of the note underneath (or the browser's own menu). The list, your typed letters and the cursor now stay as they were, and `Escape` on an open right-click menu closes only the menu instead of also leaving edit mode.

## Changes in 0.17.0

- A whole-view summary that fails or is stopped keeps the batches it finished; saying "try that again" continues it, running only the remaining batches with the original question.
- The AI remembers a failed request and the explanation you saw, so you can say "try that again" or ask why it failed. Every failure explanation now ends with where the run stopped: the step, how long it had been there, and the step before.
- Until OpenAI responds, the chat says "Waiting for OpenAI…" instead of "Thinking…". A request OpenAI never answers fails after 15 seconds at Off or Low thinking (60 s Medium, 120 s High) with a message to check the internet connection, instead of waiting up to 10 minutes.
- Questions that do not read your notes answer faster in large views: the view is no longer processed note by note up front. With diagnostic activity on, the first line shows how long preparing the view took, and each step shows how much note text it read.
- Summaries no longer fail because the AI left out its list of supporting notes (OpenAI now enforces the answer format), and a retry tells the model what was wrong.
- Fixed: pressing Stop ended in a fatal error; stray boxes and "cite" appeared around some citations; a step OpenAI never answered was described as "the reply was empty".

## Changes in 0.16.0

- Right-clicking outside any note opens a fuller menu: Add/Paste Note at Top, Undo, Redo, Go to Top, Go to Bottom, Fully Expand/Collapse All, View (All or Untagged notes), Sort by, Show (Chat, Tabs, Tags in List), Theme (System, Light, Dark), New Tab, Open/Switch Namespace, Reminders, Export View as HTML and Log Out. The current choices are ticked.
- The note menu is grouped: Copy Note, Paste, Add, Move, Outline, Focus, Export, the editing actions, and Delete Note last. Keyboard shortcuts show on the right of both menus, and actions that cannot happen from that note are hidden.
- Move to Bottom (in Move, or ⇧⌘↓) puts a note after its last sibling, or after the view's last note (the last match in a search). The view stays put: the notes above keep their place and the ones below close the gap.
- A down arrow under the up arrow goes to the bottom of the list, even when the end is not loaded yet; each arrow is dimmed when you are already at its end. Both arrows, and Focus ▸ Full Screen (now also offered while editing), save the note and leave edit mode first.
- The right-click menu closes when the pointer moves well away from it, and keys pressed in full-screen view no longer reach the list behind it.

## Changes in 0.15.0

- Pasting JSON, a chess position (FEN), a diff, a Mermaid diagram or a LaTeX block tags the note for it as you paste: the plain tag into an empty note, `((…))` around the paste in a note that already has text. ⌘Z right after the paste removes the tag with it; ⇧⌘V pastes without detection.
- New formats: `@code=python` (or any language) highlights code, `@diff` colours diffs, `@mermaid` draws a diagram without a Markdown fence, and `@chess` draws a FEN position as a board. JSON, code and diff blocks are more compact.
- Switching namespace stays in one tab: on the login screen the panel clears as you pick and the other namespace's login screen fades in under the same logo, with no white flash. In the app, Open/Switch namespace offers Open in This Tab or Open in New Tab.
- Tag suggestions: tags used elsewhere in the tree, or named in nearby notes, no longer get a boost; only the note's own text does. A new Tag Suggestions setting can also suggest tags that a parent or the rules already apply.
- Change password with no password opens Add password, and Open/Switch namespace with only one namespace opens Create namespace. The AI tag-proposal menu items now say they are about AI-proposed tags.
- Fixed: Add reminder did nothing (a missing title now says so); a password change could end on Session locked; right-clicking math or a Mermaid diagram showed the browser's menu; the Untagged notes × needed two clicks while editing a note; indented JSON and pie charts pasted into a note showed as invalid; a tiny scrollbar beside tall math; a white stripe and logo shift on the login screen with always-visible scrollbars.

## Changes in 0.14.0

- A new login screen: one dark screen with the MetaList logo. The namespace, password and OK fade in together; once the password is accepted, the loading progress slides in with the current step and the seconds elapsed. When the first login after an update backs up and upgrades the namespace, a note under OK says so. The Session locked page has the same look, and there is no white flash between them.
- Web link titles: links to Reddit (including share links), YouTube, Vimeo, TikTok, Spotify and SoundCloud get their real titles. Lookups are paced per site, so a note full of links no longer trips a site's rate limit. Login, consent and site-name-only titles ("Sign in", "Reddit") show the link instead. The new command palette action Retry failed link titles asks every failed link again, with a progress dialog.
- Quoted search also matches link titles and the URLs hidden behind link labels, and the AI sees those URLs too. Pasting into a quoted search inserts the text as copied.
- `[[note id]]` is always a link, even in a note with a `[[ ]]` formatting tag.
- The startup output in the terminal is easier to read: the version, a check mark per check, and each namespace's URLs lined up.
- Fixed: clicking the AI chat's $ or eye button twice quickly crashed with "Redundant state change".

## Changes in 0.13.0

- Dictation: text from speech-to-text tools such as Superwhisper, pasted into the search bar or any tag field, becomes your existing tags ("neural network" gives `neural-network`). Say "quote … end quote" for text, "minus" to exclude, "at" before meta tags such as `@todo`. In a note, the words after "start tags" go to its tag bar. The phrases are set in Dictation Settings, and one undo restores what was pasted.
- A quoted search with a space at its edge matches whole words: `" fat"` no longer finds "father".
- The AI keeps a record of what it did for each answer (notes read, searches, web pages opened), so questions like "did you search the web for that?" are answered from what actually happened.
- Dropping a `.txt`, `.md`, `.csv` or `.json` file stores it as before and adds its text as a child note, shown as Markdown, a table or formatted JSON. File pills show the extension (`.MD`, `.CSV`, …), and hovering a pill says that clicking downloads the file.
- Typing one letter in the tag bar now narrows the suggestions you were already shown instead of reordering them, so the tag you want is in the top five far more often.

## Changes in 0.12.0

- AI chat is now a tool-using agent: in one answer it can look up MetaList help, read and search the notes in your view, open web pages, and open menus, instead of picking a single route up front. Answers cite notes and web pages with clickable references, including each item listed from a web page.
- Nothing changes without your Yes: tag operations ask first with the exact change, and web addresses that carry words from your notes ask before opening. Summaries that fit in one pass start without a dialog, and summaries never block other edits while they run.
- "How do I change…" questions open the menu that holds the setting; release notes are part of the help. AI prompts and skills are no longer editable, and a $ button shows or hides the spend estimate.
- The AI is told only that a note is private, never which privacy setting hides it, and failed AI steps are explained in the chat.
- Leaving edit mode keeps your place, with no highlight; a collapsed note you changed stays expanded. Clicking into a note keeps the clicked spot under the pointer, including in diagrams and formulas.
- Dragging a note shows a ghost, a drop line and a direction cursor; the note lands where you dropped it without the page scrolling.
- Searches that cannot be parsed are explained politely instead of failing.

## Changes in 0.11.0

- Large namespaces stay fast while scrolling: only a band of root notes around the viewport is loaded, the server remembers what each tab shows so the browser no longer sends note hashes, and rendered notes are cached.
- Tag suggestions, searches with only exclusions (`-tag`), and the updated/content-volume sort orders respond much faster on large namespaces.
- Accepting or removing tag proposals in bulk, renaming or deleting a tag, and undoing a large delete no longer rebuild every note's inherited tags.
- Unlocking an encrypted namespace is faster, and the startup encryption audit no longer loads every attachment into memory.
- Fixed undo of deleting a note whose children have several children, and "accept all" failing on tag bars with leading or trailing spaces.
- Fixed crashes in the status check after returning to a tab and in scroll-position saving.

## Changes in 0.10.0

- Excalidraw diagrams: add one from the note's right-click menu or the command palette, and double-click a diagram to edit it full screen. Diagrams autosave, show light and dark previews, resize like images, and each editing session is one undo step. The editor is bundled locally and needs no Node server.
- The dark theme uses neutral greys with a brighter accent, the light theme header is darker, and Note Layout & Appearance adds note corner and tag style settings.
- References to a note that starts with an image or diagram show its thumbnail. Collapsed notes, reference titles, and backlink previews show only the first line.
- Fixed a command palette crash on queries with no matches.
- The database schema moves to version 10. Password-protected namespaces migrate after unlock, with the usual automatic backup first.

## Changes in 0.9.0

- AI chat can browse the web in disabled, contextual, or unrestricted mode, fetch multiple pages concurrently, and cite the specific pages used as evidence.
- Complete-scope summaries and tag suggestions can process every permitted note in bounded parallel batches after user approval, with visible per-batch progress and final synthesis.
- AI chat retains selected-note and tree context while enforcing redaction boundaries, and reference navigation uses temporary result collections without polluting search history.

## Changes in 0.8.0

- Error diagnostics now record safe request IDs, exception types, and source locations through Loguru; full tracebacks are available only in authenticated encrypted logs.
- Releases run the full cross-platform matrix once on the `main` push. The tag publishes those exact tested distributions without rerunning the matrix.

## Changes in 0.7.5

- Unexpected API 500 errors now show the exception class and MetaList source line in the browser, without exposing note contents, exception messages, or local filesystem paths.
- A local release command validates the exact cross-platform CI matrix, publishes only its tested artifacts, then verifies the public PyPI package in a clean installation.

## Changes in 0.7.4

- Updates use a private, checksum-verified uv release on Windows, macOS, and Linux. The updater does not execute a user-installed uv, and it revalidates both the cached official archive and extracted executable before each use.
- The HTTPS listener retries one bodyless safe request after a transient backend reset, records final transport failures server-side, and never replays a mutation or request body.
- Release CI builds one distribution pair, starts independent platform/Python, installed-update, browser-smoke, and browser-soak gates in parallel, and caches only hash- or lockfile-verified dependencies.

## Changes in 0.7.3

- Windows updates use a private verified uv release when an older installer is vulnerable to the reported PE-resource access-denied failure. A standalone repair ZIP can bootstrap installations whose existing updater cannot update itself.
- Release candidates now run the complete test and installed-package matrix on Windows, macOS, and Linux across Python 3.10–3.14. Real Chrome and Firefox exercise repeated cold loads and encrypted login on every operating system; Windows also checks Edge over verified LAN HTTPS and the repair path from a published older release.

## Changes in 0.7.2

- Login, hydration, and workspace requests share one initialized browser-tab identity. Losing the `sessionStorage` copy while opening the workspace no longer causes the reported missing-tab-ID crash. The external trigger for that storage loss remains unconfirmed.
- AI chat preserves the edited note and includes its permitted tree, tags, and cached URL titles. Search redaction and cloud privacy restrictions apply to every node; blocked selections expose only their availability reason.
- Added on-demand AI help and menu actions, privacy previews, and Copy Response throughout assistant message bubbles. OpenAI is the supported inference provider.
- LLM regressions use current production prompts, default to five trials with cache-aware parallel scheduling, and can run only cases affected by prompt or skill changes.
- Improved Grammarly edit preservation and search suggestions that match the complete active clause.

## Changes in 0.6.3

- Restored HTTPS connection reuse and aligned the pending accept queue with the existing worker capacity, so a browser’s six-connection startup burst is admitted.
- Every page load or refresh checks PyPI asynchronously. A newly discovered release shows a dismissible notice linking to Version Info; typing `update` in the menu also finds it.
- Managed uv installations can update from Version Info, using the existing preflight, verified immutable backups, and namespace restart flow. Source checkouts and unmanaged installations explain why in-app installation is unavailable.
- Release validation now transfers every installed startup asset through concurrent persistent HTTP/HTTPS connections on all supported platforms and Python versions. Actual Edge startup over LAN-style HTTPS is also required on Windows before publication.

## Changes in 0.6.2

- Namespace startup allows two minutes, with progress every five seconds, instead of failing after 12 seconds on a busy machine. `METALIST_STARTUP_TIMEOUT_SECONDS` can increase the allowance. Failed children are stopped and reaped.
- Updates preserve the running Python interpreter and validate a disposable installation and namespace startup before stopping live servers. uv then installs the tested package/dependency versions from its cache without network access.
- Python 3.14 is supported. Command-line legacy imports also work when Python lacks Tk's native GUI component.
- Release validation now includes the real uv update, backups, and multi-namespace restart on Windows, macOS, and Linux across Python 3.10–3.14.

## Changes in 0.6.1

- Removed the unused performance overlay, including its menu option and background state updates, fixing a fatal redundant-state error during note rearranging. Obsolete overlay preferences and command usage are discarded automatically.

## Changes in 0.6.0

- Open notes and their children in multiple live, read-only floating windows. Drag and resize them, keep them visible across searches and tabs, and follow links or copy passwords. Saved changes refresh every half second.
- Double-click selects complete tags, including punctuation and prefixes, in search and tag bars.
- Choose sorting modes from the background right-click menu. Creation sorting uses the root note's creation time; last-updated sorting includes descendants and ignores reference display-form changes.
- Context menus have icons throughout. Full-screen notes have compact spacing, and both read-only views keep steady borders on hover.
- Fixed Version Info loading and state-transition errors during editing, focus changes, tab switching, and duplication.

## Changes in 0.5.0

- Sound support is removed entirely; reminders retain their visual behavior. The live database migrates to schema 9, with encrypted namespaces migrating after unlock. Existing backups remain unchanged. See [sound removal](docs/ui/sounds.md).
- Remove Formatting supports arbitrary spans within pasted headings. Whole-note Cmd+U removes leading/trailing blank lines and retains at most one empty line between sections.
- This release includes the security, recovery, resource-limit, state-ownership, and performance work documented in the [implementation and coverage map](docs/testing/coverage-map.md).

## Technology Stack

### Backend
- FastAPI
- SQLite (via stdlib `sqlite3`) with a guard-aware wrapper (`SafeSession`)
- Mako templates for SSR

### Frontend
- Vanilla JavaScript (no framework)
- HTML5 Drag and Drop API
- ContentEditable for rich text editing
- CSS custom properties for theming

### Testing
- Python/unit tests plus manual regression passes

## Architecture (High Level)
- Server renders the base page via Mako templates.
- The browser client drives interaction via `/api2` JSON endpoints.
- Passwordless notes load into memory at startup; encrypted notes load after login. Rendering/search and ordinary authentication use memory; a read guard restricts intentional SQLite access to explicit windows.

## Security Boundary

Password protection encrypts namespace data at rest. While a namespace is
unlocked, the server must hold its data-encryption key and decrypted working
data in process memory, and the browser holds the decrypted content currently
rendered in the page. A sufficiently privileged local process, debugger,
administrator, browser extension, or process-memory dump can therefore expose
an unlocked namespace.

Explicit logout removes the live key and purges decrypted runtime stores, but
it cannot guarantee forensic overwriting of memory previously allocated by the
Python or browser runtimes. Protect the host account and operating system, and
see the detailed [security architecture and threat model](docs/security/README.md).

## Development

### Setup
For a published one-off run with uv:
```bash
uvx metalist
```

For a persistent uv tool install:
```bash
uv tool install metalist
metalist
```

For a persistent uv installation, you can update from inside MetaList: type **update** in the menu, open **Version Info**, and choose **Update to …** when a newer release is available. Each browser load or refresh asks the server to check PyPI asynchronously. A reminder-style notice links to Version Info the first time a newer version is discovered; the announced version is remembered in that namespace's client preferences. A slow or failed check does not block the app. Version Info can retry a failed check.

The in-app updater checks the selected release, creates verified backups, and restarts every namespace. Keep Version Info open to follow progress and reload when ready; closing and reopening it in the same page resumes progress. Signing in again may be necessary. Source checkouts and unmanaged installations still check for releases, but show why in-app installation is unavailable. Update job records and logs live under `~/MetaList/update-jobs/` (or the configured data directory). If installation/restart fails after servers stop, inspect the updater output and run `metalist` on the server to restart it; there is no automatic rollback.

You can also update and restart MetaList with one cross-platform command:
```bash
metalist update
```
The updater checks the installed version against the latest PyPI release first. If MetaList is already current, it reports the installed version and leaves all running namespaces untouched. When an update is available, it checks installer prerequisites and uses uv to install the candidate into a disposable tool environment with the current base Python interpreter. It checks dependencies and starts a temporary namespace to verify HTTP readiness, version, and runtime assets. A failed preflight leaves the current installation and running namespaces unchanged. After preflight succeeds, it stops running namespaces, and creates and verifies a new backup of every namespace before installation can begin. Each archive includes the complete notes/settings database, the attachments database when present, and any legacy search-history database. Locked namespaces are backed up with their encrypted data and key metadata intact, without requiring a password.

MetaList downloads its own checksum-verified uv 0.12.17 archive for the current operating system, architecture, and Linux C library. The verified archive and extracted executable are stored in the operating system's user cache; every update verifies the archive against its pinned upstream SHA-256 and the executable against the verified archive before use. That same executable performs both preflight and final installation. MetaList does not execute or replace the user's global uv. Download, verification, platform-selection, or version failures occur before any namespace is stopped. Already-installed releases retain their own updater code; the standalone repair launcher described in [recovery](docs/security/recovery.md#windows-updater-pe-resource-failure) supplies this managed installer to an older Windows updater.

Backups are saved to `~/MetaList/namespaces/<namespace>/backups/<namespace>-<timestamp>.metalist-backup.tar.gz`; the updater prints each verified path. Existing backups remain unchanged and are not pruned. If any backup fails, the update aborts with the current installation intact; run `metalist` to restart the stopped servers after resolving the failure.

Only after all backups pass does the updater hand off to an external PowerShell process on Windows or `/bin/sh` on macOS/Linux so the installed environment can unlock. It delegates installation to uv, pinning the current base interpreter and the exact tested package/dependency versions, using the cache populated during preflight with network access disabled. It then launches MetaList again, and reports the installed version (for example, `MetaList updated to v0.5.0.`). This protection requires an installed version containing the backup safeguard and applies to `metalist update` and the in-app update action; direct pip/uv install commands do not run it.

For pip, users can run `pip install metalist`. For a non-editable local install from this checkout, use `uv pip install .` or `pip install .` instead of the editable command below.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --require-hashes -r requirements/ci.txt
python -m pip install --no-deps --no-build-isolation -e ".[dev]"

npm install
```

On Windows, create the same `.venv` with `python -m venv .venv` and activate it with `.venv\Scripts\Activate.ps1` in PowerShell. Run the same `python -m pip` commands after activation. Node dependencies are developer tooling; the application itself does not require Node.

### Run

Persistent data defaults to `~/MetaList`. Set `METALIST_DATA_DIRECTORY` to an absolute directory path before launch to use a separate data root, including namespaces, backups, certificates, logs, and runtime jobs. This is used by release tests to keep their disposable data separate from real notes.
The installed entrypoint starts or restarts every known namespace, prints their URLs, and exits:
```bash
metalist
```
For source-checkout compatibility, `python main.py` performs the same orchestration. Use `metalist work`, `python main.py --namespace work`, or `python main.py work` when you want one foreground namespace process.

Shell execution is disabled by default. To enable `@shell` for every namespace
started by the top-level orchestrator, use either:

```bash
metalist --enable-shell
python main.py --enable-shell
```

This flag is propagated to every namespace child process. The top-level process
prints a conspicuous shell-enabled banner before its namespace launch results.
Use `python main.py work --enable-shell` for one foreground namespace. Shell
routes remain restricted to loopback clients using a loopback request host,
even when the rest of MetaList is intentionally exposed to a LAN.

`metalist` and explicit single-namespace source runs bind to loopback at `127.0.0.1:8000` by default. This keeps a normal laptop launch off LAN and public interfaces unless remote access is explicitly configured.
On first startup, MetaList also auto-generates a self-signed TLS pair at `~/MetaList/certs/metalist-cert.pem` and `~/MetaList/certs/metalist-key.pem`, then enables HTTPS on the same bind host at port `8443`. If you already have real PEM files, point `METALIST_TLS_CERT` and `METALIST_TLS_KEY` at them instead. Set `METALIST_AUTO_GENERATE_TLS=0` only if you explicitly want HTTP-only startup.

Database selection:
- No explicit namespace on a single-namespace launch: `~/MetaList/namespaces/default/default.metalist.db`
- `--namespace work` or `METALIST_NAMESPACE=work`: `~/MetaList/namespaces/work/work.metalist.db`
- The related files DB is derived automatically, so `namespaces/work/work.metalist.db` uses `namespaces/work/work.metalist.files.db`
- Remembered launch ports are stored as plaintext metadata inside each namespace's main `*.metalist.db`
- Launch precedence is: explicit CLI flags > env vars > saved namespace profile; if a namespace has no saved profile, launch it once with explicit ports or configure ports from the UI
- Backups stay beside the namespace data under `~/MetaList/namespaces/work/backups/` and use one archive per snapshot with filenames like `work-<timestamp>.metalist-backup.tar.gz`
- The Backup Settings modal targets one user-selected backup folder and can include multiple namespaces in a single run
- Restoring `work` into `work` is the normal overwrite path; importing a backup under a different namespace name can create a new target namespace with automatically selected conflict-free ports.

Useful env flags:
- `CRASH_SERVER_ON_FAIL=1` (default): fail-fast on validation errors
- `API_PREFIX=/api2`: override API prefix (client assumes `/api2` by default)
- `METALIST_NAMESPACE=work`: select `~/MetaList/namespaces/work/work.metalist.db`
- `METALIST_HOST=127.0.0.1` (default): bind the main app to a specific interface; use a LAN IP or `0.0.0.0` only for intentional remote access
- `METALIST_ALLOWED_HOSTS=notes.example.com,192.168.1.20`: comma-separated public/LAN hostnames accepted in HTTP `Host` headers; loopback aliases and a specific non-wildcard `METALIST_HOST` are accepted automatically
- `METALIST_PORT=8000` (default): bind the main app to a different port
- `METALIST_HTTPS_PORT=8443`: override the HTTPS port when TLS is enabled
- `METALIST_TLS_CERT=/path/to/fullchain.pem` + `METALIST_TLS_KEY=/path/to/privkey.pem`: override TLS paths
- `METALIST_AUTO_GENERATE_TLS=0`: disable automatic creation of the default self-signed TLS pair
- default TLS paths: `~/MetaList/certs/metalist-cert.pem` and `~/MetaList/certs/metalist-key.pem`
- `METALIST_FORWARDED_ALLOW_IPS=127.0.0.1,::1` (default): trust proxy headers only from those reverse-proxy IPs
- `--enable-shell`: opt in to local `@shell` execution for this launch; shell routes require a loopback client and loopback request host, and the capability is never persisted in namespace data

### Remote Access / HTTPS
LAN or VPN access must be enabled explicitly. Prefer binding the machine's specific LAN address, which also adds that address to the accepted-host set:
```bash
METALIST_HOST=192.168.1.20 metalist
```
On a fresh machine, that first launch also creates the default TLS cert pair automatically. Then open either `http://192.168.1.20:8000` or `https://192.168.1.20:8443` from the other machine.

Starting with 0.7.1, an explicit `METALIST_HOST` or `METALIST_ALLOWED_HOSTS`
configuration is saved in `~/MetaList/network-settings.json` (under
`METALIST_DATA_DIRECTORY` when overridden). Subsequent source launches, plain
`metalist` launches, and updates reuse it. Environment values override and update
the corresponding saved settings. This file stores only the bind address and
allowed hosts; namespace ports remain in their launch profiles, and shell access
still requires `--enable-shell` on each launch. Invalid settings stop startup
with an error. Fresh installations continue to bind to localhost by default.
To switch back to local-only access, run `METALIST_HOST=127.0.0.1 metalist` once.
Older installed versions do not read this file; keep supplying their LAN settings
until upgrading to 0.7.1 or later.

To keep `@shell` available on the host laptop while allowing another laptop to
use normal MetaList features, bind both interfaces and explicitly allow the LAN
address:

```bash
METALIST_HOST=0.0.0.0 \
METALIST_ALLOWED_HOSTS=10.0.0.31 \
metalist --enable-shell
```

Use `http://127.0.0.1:<namespace-http-port>` on the host laptop when running
`@shell`. Other devices may use `https://10.0.0.31:<namespace-https-port>`, but
their shell start/status requests receive `403`.

Namespaced launch example:
```bash
metalist --namespace work --port 8001
```
This starts a separate process backed by `~/MetaList/namespaces/work/work.metalist.db` on `http://127.0.0.1:8001`.
Its backup snapshots live under `~/MetaList/namespaces/work/backups/` with filenames like `work-<timestamp>.metalist-backup.tar.gz`. New backups are versioned `.tar.gz` workspace archives; legacy `.bak` backups remain restorable.

After you launch a namespace once with explicit ports, MetaList remembers them in that namespace's main DB, so later you can use the shorthand:
```bash
metalist work
```
and MetaList will reuse the saved HTTP / HTTPS ports for `work`. The same applies to the default namespace: `metalist` will reuse the saved default-namespace profile.

Equivalent explicit launch, if you want it:
```bash
METALIST_HOST=0.0.0.0 \
METALIST_ALLOWED_HOSTS=192.168.1.20 \
METALIST_PORT=8000 \
METALIST_HTTPS_PORT=8443 \
metalist
```
From the other machine, open `https://<laptop-ip>:8443`.

If you already have a real certificate and key, use the same dual-listener flow:
```bash
METALIST_HOST=0.0.0.0 \
METALIST_ALLOWED_HOSTS=192.168.1.20 \
METALIST_PORT=8000 \
METALIST_HTTPS_PORT=8443 \
METALIST_TLS_CERT=/path/to/fullchain.pem \
METALIST_TLS_KEY=/path/to/privkey.pem \
metalist
```

If you want to rotate or regenerate the default self-signed pair manually, the helper script is still available:
```bash
generate-lan-cert.sh
```

When HTTPS is enabled:
- remote HTTP requests to `http://<laptop-ip>:8000` are redirected to HTTPS
- localhost HTTP requests still stay on plain `http://127.0.0.1:8000` so the laptop can keep using the non-TLS port

If TLS is terminated by a reverse proxy on the same machine instead, keep MetaList on loopback and let the proxy forward to it:
```bash
METALIST_HOST=127.0.0.1 \
METALIST_ALLOWED_HOSTS=notes.example.com \
METALIST_PORT=8000 \
METALIST_FORWARDED_ALLOW_IPS=127.0.0.1,::1 \
metalist
```

The reverse proxy must preserve the browser-facing `Host` header and set
`X-Forwarded-Proto`. MetaList never trusts `X-Forwarded-Host`; forwarded
scheme/client metadata is accepted only from `METALIST_FORWARDED_ALLOW_IPS`.
Do not widen that list beyond the actual proxy addresses.

### Legacy Import
`convert-from-legacy.py` replaces the SQLite database referenced by `app.config.DATABASE_URL`, clears its files sidecar, and imports notes from a legacy JSON export.

This is destructive. It deletes the existing notes DB and related files DB before rebuilding the namespace.

Example usage:
```bash
convert-from-legacy.py --input /path/to/legacy-export.json
```

Target a namespaced database during import:
```bash
convert-from-legacy.py --namespace work --input /path/to/legacy-export.json
```

If `--namespace`, `--port`, or `--https-port` are omitted, the import script prompts for them and saves the resulting launch profile inside the target namespace DB. That means a one-time import into `work` can immediately seed later shorthand launches like `metalist work`.

Namespace startup allows 120 seconds per child, reports progress every five seconds, and stops/reaps a failed child instead of leaving it running after reporting failure. Set `METALIST_STARTUP_TIMEOUT_SECONDS` to a positive number of seconds to allow more time on a heavily loaded machine. A crashed child still fails immediately. This is a startup allowance, not a guarantee that any machine will finish within two minutes.

The preflight is a disposable empty namespace; it cannot guarantee startup against every real database or prevent a later disk/process failure. If installation succeeds but real namespace startup fails, the new package remains installed: resolve the reported startup issue and run `metalist` again. No automatic code/database rollback is attempted, and backups remain unchanged.

### Publishing
For the real user-facing install flow:
```bash
uvx metalist
# or:
uv tool install metalist
metalist
```

This repo now packages itself under the PyPI distribution name `metalist`. Current releases support Python 3.11 through 3.14.

Recommended release path:
1. In the existing PyPI project `metalist`, configure GitHub Trusted Publishing for `metalist-app/metalist` and the workflow file `.github/workflows/publish-pypi.yml`.
2. Develop and review the candidate on a feature branch with focused checks. Merge it into `main` and push `main` once. This runs the full `Publish to PyPI` validation matrix for that exact commit. GitHub-hosted Windows, macOS, and Linux runners install the built wheel and test application startup outside the source checkout on the supported Python endpoints, 3.11 and 3.14. Every installed-package matrix job also exercises the real `metalist update` path with uv, backups, interpreter preservation, and two-namespace restart against a local release index. The old-version fixture carries the candidate updater so this validates the mechanism being shipped; it does not retroactively fix older installed updaters. You do not need those operating systems locally. Archive verification checks runtime files, including agent Markdown resources, against both the wheel and source distribution.
3. Wait for the exact-commit main release matrix to pass, then run `.venv/bin/python scripts/release.py X.Y.Z` to create and push the tag. Any intervening change requires a new main validation run before tagging.
4. The tag job independently verifies every main-job conclusion and reuses the wheel and source distribution from that run for GitHub Trusted Publishing; it does not repeat the matrix. Manual dispatch cannot publish. The release driver compares PyPI hashes with the tested artifact and checks a clean public install. Users can then run it with `uvx metalist`, install it persistently with `uv tool install metalist`, or install it with `pip install metalist`.

If `--input` is omitted, a file picker opens (when `tkinter` and its native `_tkinter` component are available).
Notes tagged with `@implies` are converted into ontology rules and are not imported as notes. Legacy rules that are invalid under the current ontology grammar are reported and skipped while valid rules continue importing.

### Run Tests

Python/unit test examples:
```bash
source .venv/bin/activate
.venv/bin/pytest
node --test tests/unit/*.mjs
.venv/bin/python -c "from pathlib import Path; import main; main._run_startup_sanity_gates(repo_root=Path.cwd())"
```

Source-checkout development launches can enable the mandatory Python and
JavaScript sanity gates with an ignored repository-root `.env` file:

```dotenv
METALIST_ENVIRONMENT=development
```

`main.py` prints the resolved environment at startup. An explicit process
environment value takes precedence over `.env`; only `development` and
`production` are accepted. When the variable and `.env` file are absent,
MetaList runs in production mode and skips the source sanity gates.

`TEST_MODE=1` and `POST /api2/test/reset` still exist for deterministic browser automation if we decide to add a new harness later, but Cypress is not part of the current workflow.

### Diagrams
Render Mermaid diagrams to PNGs:
```bash
npm run render-diagrams
```


## Maintenance and recovery

See the [dependency and release procedure](docs/security/supply-chain.md), [recovery runbook](docs/security/recovery.md), and [current test/implementation map](docs/testing/coverage-map.md). The dated [August code review](CODE_REVIEW.md) is historical.
