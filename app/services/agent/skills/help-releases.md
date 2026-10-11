# MetaList release notes

What changed in each MetaList version, newest first, from the packaged
README. Changes made after the newest listed version are not described here.
Compare with installed_version from the help lookup to tell the user whether
they already have a release. Version info offers updates (see the data topic).

## 0.16.0

- Right-clicking outside any note opens a fuller menu: Add/Paste Note at Top, Undo, Redo, Go to Top, Go to Bottom, Fully Expand/Collapse All, View (All or Untagged notes), Sort by, Show (Chat, Tabs, Tags in List), Theme (System, Light, Dark), New Tab, Open/Switch Namespace, Reminders, Export View as HTML and Log Out. The current choices are ticked.
- The note menu is grouped: Copy Note, Paste, Add, Move, Outline, Focus, Export, the editing actions, and Delete Note last. Keyboard shortcuts show on the right of both menus, and actions that cannot happen from that note are hidden.
- Move to Bottom (in Move, or ⇧⌘↓) puts a note after its last sibling, or after the view's last note (the last match in a search). The view stays put: the notes above keep their place and the ones below close the gap.
- A down arrow under the up arrow goes to the bottom of the list, even when the end is not loaded yet; each arrow is dimmed when you are already at its end. Both arrows, and Focus ▸ Full Screen (now also offered while editing), save the note and leave edit mode first.
- The right-click menu closes when the pointer moves well away from it, and keys pressed in full-screen view no longer reach the list behind it.

## 0.15.0

- Pasting JSON, a chess position (FEN), a diff, a Mermaid diagram or a LaTeX block tags the note for it as you paste: the plain tag into an empty note, `((…))` around the paste in a note that already has text. ⌘Z right after the paste removes the tag with it; ⇧⌘V pastes without detection.
- New formats: `@code=python` (or any language) highlights code, `@diff` colours diffs, `@mermaid` draws a diagram without a Markdown fence, and `@chess` draws a FEN position as a board. JSON, code and diff blocks are more compact.
- Switching namespace stays in one tab: on the login screen the panel clears as you pick and the other namespace's login screen fades in under the same logo, with no white flash. In the app, Open/Switch namespace offers Open in This Tab or Open in New Tab.
- Tag suggestions: tags used elsewhere in the tree, or named in nearby notes, no longer get a boost; only the note's own text does. A new Tag Suggestions setting can also suggest tags that a parent or the rules already apply.
- Change password with no password opens Add password, and Open/Switch namespace with only one namespace opens Create namespace. The AI tag-proposal menu items now say they are about AI-proposed tags.
- Fixed: Add reminder did nothing (a missing title now says so); a password change could end on Session locked; right-clicking math or a Mermaid diagram showed the browser's menu; the Untagged notes × needed two clicks while editing a note; indented JSON and pie charts pasted into a note showed as invalid; a tiny scrollbar beside tall math; a white stripe and logo shift on the login screen with always-visible scrollbars.

## 0.14.0

- A new login screen: one dark screen with the MetaList logo. The namespace, password and OK fade in together; once the password is accepted, the loading progress slides in with the current step and the seconds elapsed. When the first login after an update backs up and upgrades the namespace, a note under OK says so. The Session locked page has the same look, and there is no white flash between them.
- Web link titles: links to Reddit (including share links), YouTube, Vimeo, TikTok, Spotify and SoundCloud get their real titles. Lookups are paced per site, so a note full of links no longer trips a site's rate limit. Login, consent and site-name-only titles ("Sign in", "Reddit") show the link instead. The new command palette action Retry failed link titles asks every failed link again, with a progress dialog.
- Quoted search also matches link titles and the URLs hidden behind link labels, and the AI sees those URLs too. Pasting into a quoted search inserts the text as copied.
- `[[note id]]` is always a link, even in a note with a `[[ ]]` formatting tag.
- The startup output in the terminal is easier to read: the version, a check mark per check, and each namespace's URLs lined up.
- Fixed: clicking the AI chat's $ or eye button twice quickly crashed with "Redundant state change".

## 0.13.0

- Dictation: text from speech-to-text tools such as Superwhisper, pasted into the search bar or any tag field, becomes your existing tags ("neural network" gives `neural-network`). Say "quote … end quote" for text, "minus" to exclude, "at" before meta tags such as `@todo`. In a note, the words after "start tags" go to its tag bar. The phrases are set in Dictation Settings, and one undo restores what was pasted.
- A quoted search with a space at its edge matches whole words: `" fat"` no longer finds "father".
- The AI keeps a record of what it did for each answer (notes read, searches, web pages opened), so questions like "did you search the web for that?" are answered from what actually happened.
- Dropping a `.txt`, `.md`, `.csv` or `.json` file stores it as before and adds its text as a child note, shown as Markdown, a table or formatted JSON. File pills show the extension (`.MD`, `.CSV`, …), and hovering a pill says that clicking downloads the file.
- Typing one letter in the tag bar now narrows the suggestions you were already shown instead of reordering them, so the tag you want is in the top five far more often.

## 0.12.0

- AI chat is now a tool-using agent: in one answer it can look up MetaList help, read and search the notes in your view, open web pages, and open menus, instead of picking a single route up front. Answers cite notes and web pages with clickable references, including each item listed from a web page.
- Nothing changes without your Yes: tag operations ask first with the exact change, and web addresses that carry words from your notes ask before opening. Summaries that fit in one pass start without a dialog, and summaries never block other edits while they run.
- "How do I change…" questions open the menu that holds the setting; release notes are part of the help. AI prompts and skills are no longer editable, and a $ button shows or hides the spend estimate.
- The AI is told only that a note is private, never which privacy setting hides it, and failed AI steps are explained in the chat.
- Leaving edit mode keeps your place, with no highlight; a collapsed note you changed stays expanded. Clicking into a note keeps the clicked spot under the pointer, including in diagrams and formulas.
- Dragging a note shows a ghost, a drop line and a direction cursor; the note lands where you dropped it without the page scrolling.
- Searches that cannot be parsed are explained politely instead of failing.

## 0.11.0

- Large namespaces stay fast while scrolling: only a band of root notes around the viewport is loaded, the server remembers what each tab shows so the browser no longer sends note hashes, and rendered notes are cached.
- Tag suggestions, searches with only exclusions (`-tag`), and the updated/content-volume sort orders respond much faster on large namespaces.
- Accepting or removing tag proposals in bulk, renaming or deleting a tag, and undoing a large delete no longer rebuild every note's inherited tags.
- Unlocking an encrypted namespace is faster, and the startup encryption audit no longer loads every attachment into memory.
- Fixed undo of deleting a note whose children have several children, and "accept all" failing on tag bars with leading or trailing spaces.
- Fixed crashes in the status check after returning to a tab and in scroll-position saving.

## 0.10.0

- Excalidraw diagrams: add one from the note's right-click menu or the command palette, and double-click a diagram to edit it full screen. Diagrams autosave, show light and dark previews, resize like images, and each editing session is one undo step. The editor is bundled locally and needs no Node server.
- The dark theme uses neutral greys with a brighter accent, the light theme header is darker, and Note Layout & Appearance adds note corner and tag style settings.
- References to a note that starts with an image or diagram show its thumbnail. Collapsed notes, reference titles, and backlink previews show only the first line.
- Fixed a command palette crash on queries with no matches.
- The database schema moves to version 10. Password-protected namespaces migrate after unlock, with the usual automatic backup first.

## 0.9.0

- AI chat can browse the web in disabled, contextual, or unrestricted mode, fetch multiple pages concurrently, and cite the specific pages used as evidence.
- Complete-scope summaries and tag suggestions can process every permitted note in bounded parallel batches after user approval, with visible per-batch progress and final synthesis.
- AI chat retains selected-note and tree context while enforcing redaction boundaries, and reference navigation uses temporary result collections without polluting search history.

## 0.8.0

- Error diagnostics now record safe request IDs, exception types, and source locations through Loguru; full tracebacks are available only in authenticated encrypted logs.
- Releases run the full cross-platform matrix once on the `main` push. The tag publishes those exact tested distributions without rerunning the matrix.

## 0.7.5

- Unexpected API 500 errors now show the exception class and MetaList source line in the browser, without exposing note contents, exception messages, or local filesystem paths.
- A local release command validates the exact cross-platform CI matrix, publishes only its tested artifacts, then verifies the public PyPI package in a clean installation.

## 0.7.4

- Updates use a private, checksum-verified uv release on Windows, macOS, and Linux. The updater does not execute a user-installed uv, and it revalidates both the cached official archive and extracted executable before each use.
- The HTTPS listener retries one bodyless safe request after a transient backend reset, records final transport failures server-side, and never replays a mutation or request body.
- Release CI builds one distribution pair, starts independent platform/Python, installed-update, browser-smoke, and browser-soak gates in parallel, and caches only hash- or lockfile-verified dependencies.

## 0.7.3

- Windows updates use a private verified uv release when an older installer is vulnerable to the reported PE-resource access-denied failure. A standalone repair ZIP can bootstrap installations whose existing updater cannot update itself.
- Release candidates now run the complete test and installed-package matrix on Windows, macOS, and Linux across Python 3.10–3.14. Real Chrome and Firefox exercise repeated cold loads and encrypted login on every operating system; Windows also checks Edge over verified LAN HTTPS and the repair path from a published older release.

## 0.7.2

- Login, hydration, and workspace requests share one initialized browser-tab identity. Losing the `sessionStorage` copy while opening the workspace no longer causes the reported missing-tab-ID crash. The external trigger for that storage loss remains unconfirmed.
- AI chat preserves the edited note and includes its permitted tree, tags, and cached URL titles. Search redaction and cloud privacy restrictions apply to every node; blocked selections expose only their availability reason.
- Added on-demand AI help and menu actions, privacy previews, and Copy Response throughout assistant message bubbles. OpenAI is the supported inference provider.
- LLM regressions use current production prompts, default to five trials with cache-aware parallel scheduling, and can run only cases affected by prompt or skill changes.
- Improved Grammarly edit preservation and search suggestions that match the complete active clause.

## 0.6.3

- Restored HTTPS connection reuse and aligned the pending accept queue with the existing worker capacity, so a browser’s six-connection startup burst is admitted.
- Every page load or refresh checks PyPI asynchronously. A newly discovered release shows a dismissible notice linking to Version Info; typing `update` in the menu also finds it.
- Managed uv installations can update from Version Info, using the existing preflight, verified immutable backups, and namespace restart flow. Source checkouts and unmanaged installations explain why in-app installation is unavailable.
- Release validation now transfers every installed startup asset through concurrent persistent HTTP/HTTPS connections on all supported platforms and Python versions. Actual Edge startup over LAN-style HTTPS is also required on Windows before publication.

## 0.6.2

- Namespace startup allows two minutes, with progress every five seconds, instead of failing after 12 seconds on a busy machine. `METALIST_STARTUP_TIMEOUT_SECONDS` can increase the allowance. Failed children are stopped and reaped.
- Updates preserve the running Python interpreter and validate a disposable installation and namespace startup before stopping live servers. uv then installs the tested package/dependency versions from its cache without network access.
- Python 3.14 is supported. Command-line legacy imports also work when Python lacks Tk's native GUI component.
- Release validation now includes the real uv update, backups, and multi-namespace restart on Windows, macOS, and Linux across Python 3.10–3.14.

## 0.6.1

- Removed the unused performance overlay, including its menu option and background state updates, fixing a fatal redundant-state error during note rearranging. Obsolete overlay preferences and command usage are discarded automatically.

## 0.6.0

- Open notes and their children in multiple live, read-only floating windows. Drag and resize them, keep them visible across searches and tabs, and follow links or copy passwords. Saved changes refresh every half second.
- Double-click selects complete tags, including punctuation and prefixes, in search and tag bars.
- Choose sorting modes from the background right-click menu. Creation sorting uses the root note's creation time; last-updated sorting includes descendants and ignores reference display-form changes.
- Context menus have icons throughout. Full-screen notes have compact spacing, and both read-only views keep steady borders on hover.
- Fixed Version Info loading and state-transition errors during editing, focus changes, tab switching, and duplication.

## 0.5.0

- Sound support is removed entirely; reminders retain their visual behavior. The live database migrates to schema 9, with encrypted namespaces migrating after unlock. Existing backups remain unchanged. See sound removal.
- Remove Formatting supports arbitrary spans within pasted headings. Whole-note Cmd+U removes leading/trailing blank lines and retains at most one empty line between sections.
- This release includes the security, recovery, resource-limit, state-ownership, and performance work documented in the implementation and coverage map.
