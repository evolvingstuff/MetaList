# Tag Bar

## Overview
- Each note has a tag string (`notes.tags`) that round-trips through the view snapshot (`snapshot.notes[*].tags`).
- The tag bar editor enforces a small grammar in the browser so invalid characters/sequences are removed as you type.
- When leaving the tag bar (Tab toggle or click-away) the input is **sanitized**: incomplete/broken items are removed.
- A lone `@` or unknown meta tag such as `@cvs` is removed on sanitization, including inside a closed wrapper. An unfinished wrapper such as `{{@ ` is also removed. If multiple renderer meta tags target the same note or wrapper (for example `@json @csv` or `{@json @csv}`), the first renderer is kept and later conflicting renderers are removed. Other valid tags remain.
- Previously saved tags with these forms do not block note rendering; editing and saving the tag bar applies the cleanup without changing note content.
- When tags are shown in the note list, one line of tags shares the note's existing row height; the row grows only when its tags wrap onto additional lines.
- The note list renders each saved tag, bracketed scope (kept whole, e.g. `{{@red @monospace}}`) and comment as its own element, separated by spaces, using `splitTagsForDisplay()` in `tag-syntax-service.js`. The text reads exactly as saved; the `Pills` tag style (Note Layout & Appearance) outlines each piece, and `Plain text` leaves them as ordinary text.

## Whitespace + Tokens
- Outside of `/* ... */` comments, tags are separated by whitespace.
- Double-click selects an entire tag, including `@`, connectors such as `-`, `_`, `.`, `/`, and assignment values such as `@size=2.0`. Inside a scoped wrapper, it selects the individual tag without the wrapper. Comments retain ordinary word selection. The search input uses the same interaction with its own query grammar.
- Runs of whitespace are normalized to single spaces.
- Wrapper tokens may contain internal spaces (e.g. `{{@red @monospace}}`), which are preserved (normalized) inside the wrapper. This means a wrapper token can contain multiple tags.
- A normal tag token allows only ASCII-printable characters and disallows: `: , " \\ > < [ ] { } ( ) * | ; ~ ``. The one exception is `:` introducing tag properties (below).
- One `=` is allowed inside regular or meta tags when valid tag characters occur on both sides (for example `abc=xyz` or `@size=2.0`). It cannot appear at the start/end, and multiple `=` characters are removed during normalization.
- Tag tokens also cannot start with `-`, `+`, or `/`.
- Exact uppercase `OR` is reserved as the search disjunction operator and cannot
  be saved as a tag, including inside a wrapper. Lowercase `or` and mixed-case
  variants remain valid tags.

## Tag Properties
A tag can carry values, written in the tag bar as one token: `jogging:miles=3`, `jogging:miles=3:duration=30`, `drug:dosage=10mg`, `run:start=10:30pm:miles=3`. Design and later steps: `docs/design/tag-properties.md`.
- The tag is everything before the first `:`; each `:name=value` after it is a property. Property names start with a letter.
- A colon followed by a letter starts the next property; any other colon belongs to the value, so times and date-times work: `start=10:30pm`, `at=2026-10-23T10:30`.
- Values have no spaces (`author=Ursula-Le-Guin`). A unit, if any, is written after the number with no space (`10mg`, `10miles`).
- While typing, properties stay as typed. On leaving the tag bar, a property without a value (`jogging:miles=` or `jogging:mi`) is removed, and so is a property repeated in the same token (`jogging:miles=3:miles=5` keeps `miles=3`).
- A note carries a tag with properties once. Adding the same tag again (`jogging` beside `jogging:miles=3`) is refused: the tag bar says "jogging is already on this note" and the second one is not saved. Put all of a tag's properties in its one token instead. Tags without properties are unaffected (`priority=high priority=low` stays).
- Meta tags (`@size=2`) and tags inside scopes (`{{...}}`) have no properties; their colons are removed as before.
- A tag with properties counts as its tag everywhere: searching `jogging` finds a note tagged `jogging:miles=3`; children and referencing notes inherit `jogging` (never its values); ontology rules about `jogging` apply; tag suggestions treat it as `jogging`. Right-clicking anywhere on the token opens the menu for `jogging`.
- Renaming a tag (Edit Tag Relationships) keeps its properties: `jogging:miles=3` becomes `running:miles=3`. Deleting the tag removes the whole token.
- The note list shows the token as written.
- Searching by values (`jogging:miles>2`, `jogging:miles?`, `date>=2024-01`): `docs/ui/search-semantics.md` (Property Terms).
- Not yet: suggestions for property names and units, finding values through implications (`exercise:miles>2` finding `jogging:miles=3`), and ontology rules that test values. Until then, typing `jogging:` in the tag bar or search box shows no suggestions.

## Wrapper Tags
A tag token may be wrapped with matching brackets:
- `[]`, `{}`, or `()`
- Repeat count: **1–3**, and the opener/closer must match.

Examples (legal):
- `[tag]`
- `((tag))`
- `{{{tag}}}`

While typing an unfinished wrapper, `{{@` and `{{@foot` suggest meta tags without a warning. Ordinary tag prefixes work inside unfinished wrappers too. Accepting a suggestion preserves the opening brackets; close them to finish the scope. A space after the inner tag (for example `{{@footnote ` or `{{@footnote bar`) shows a subtle **Close scope with }}** reminder until the matching closers are entered. Suggestions remain available for additional tags inside that scope; the reminder is informational rather than an error. Fully closed multi-tag scopes remain supported, and incomplete scopes are still omitted when leaving the tag bar.

Examples (autocorrected while typing):
- `[tag)` → `[tag`
- `((tag))}` → `((tag))`

## Meta Tags (Formatting)
- Tags starting with `@` are reserved for server-side behaviors.
- Global meta tags apply to the whole note when unwrapped (e.g. `@red`).
- Scoped meta tags apply only to regions of note content wrapped with the same bracket type + depth.
  - Example: tag bar `{{@monospace}}` applies monospace styling to `{{...}}` regions in the note.
  - Depth must match exactly: `[[...]]` matches `[[@tag]]`, not `[@tag]` or `[[[@tag]]]`.
  - Scopes may cross multiple editor blocks/lines; visual styles are rendered as valid per-block spans across the full selected range.
- Basic formatting tags:
  - `@heading` increases font size and weight.
  - `@bold`, `@italic`, `@strikethrough` apply basic text styling.
  - `@serif` switches to a serif font.
  - `@red`, `@green`, `@blue`, `@grey` apply text colors.
  - `@highlighter` adds a fluorescent-yellow, slightly irregular marker stroke behind the text.
  - `@copyable` makes the rendered content clickable to copy its raw text to the clipboard.
  - `@size=0.1`, `0.25`, `0.5`, `0.75`, `1.0`, `1.25`, `1.5`, `2.0`, or `3.0` scales a whole note or scoped region non-destructively in view mode.
  - Ontology implication rules can add these formatting tags implicitly (e.g. `bug => @red`).
- List meta tags:
  - `@list-bulleted` renders the note's immediate children with bullet markers.
  - `@list-numbered` renders the note's immediate children with numbered markers.
  - Only the **direct** children are affected (grandchildren are not).
- Credential meta tags:
  - `@username` renders a view-only user-icon row with a copyable value.
  - `@password` renders a view-only lock-icon row with a blurred, copyable value.
- Email meta tags:
  - `@email` renders a view-only envelope row with a mailto link.
- Status meta tags:
  - `@todo` renders an unchecked box icon; pressing the icon toggles the tag to `@done` on mouse down.
  - `@done` renders a checked box icon; pressing the icon toggles the tag to `@todo` on mouse down.
  - If another note is being edited, pressing a status icon saves and exits that edit session before toggling, without selecting the toggled note for editing.
- Image meta tag:
  - `@image` is inferred dynamically for search when note content contains inline image markup, a Markdown image link, or an embedded file reference whose attachment metadata is an image.
  - The tag is search-only; it is not persisted in the note's tag bar and does not change note rendering.
- Markdown meta tags:
  - `@markdown` renders note content as Markdown on the server in view mode.
  - Fenced `mermaid` blocks inside Markdown render locally as responsive SVG diagrams in the app; the Mermaid runtime is lazy-loaded only when needed, and invalid syntax preserves the source with an inline error badge.
  - Standard LaTeX regions inside Markdown render automatically: `\(...\)` or `$...$` for inline math, and `\[...\]` or `$$...$$` for display math.
  - LaTeX delimiters inside inline code or fenced code blocks remain literal.
- LaTeX meta tags:
  - `@LaTeX` renders note content as LaTeX on the server in view mode.
  - The server emits final MathML directly; the browser does not finish a second LaTeX rendering pass.
  - Use `$...$` for inline math and `$$...$$` for display math.
  - If no `$` delimiters are present, the entire note is rendered as display math.
  - Scoped LaTeX works with wrappers (e.g. `{{@LaTeX}}` renders only `{{...}}` segments) and can be combined with `@markdown`. Explicit scoped regions and automatically detected Markdown math can coexist; the scoped region is rendered once and its wrapper delimiters are still consumed normally.
- Shell meta tags:
  - `@shell` renders note content as a terminal-style script block in view mode.
  - Clicking the block starts a background shell session on the server and updates stdout/stderr inline while the command is still running.
  - Completed/error/timeout shell feedback can be dismissed with the inline `Close` button in the output header.
  - The transport is cross-platform, but note scripts still need to match the connected server host's shell and OS conventions.
- JSON meta tags:
  - `@json` pretty-prints note content as JSON; invalid JSON shows an error badge and raw text.
- CSV meta tags:
  - `@csv` renders note content as a CSV table; invalid CSV shows an error badge and raw text.
  - `((@csv))` renders only the wrapped content as a CSV table.

Wrapper regions in note content are always allowed (e.g. `((foo))`), but they are only consumed/hidden in view mode when there is a matching scoped wrapper tag in the tag bar (meta tags like `{{@red}}` or regular tags like `{{foo}}`). Otherwise the wrappers remain literal text.

Wrapper tokens can contain multiple tags separated by spaces (e.g. `{{@red @monospace}}`).

Notes:
- Multiple tags inside a wrapper are still stored as a single wrapper token in the tag bar (i.e., the internal whitespace does not “split” it into separate top-level tokens).
- Non-meta tags inside wrapper tokens are allowed (e.g. `{{foo bar}}`) for future semantic uses; currently only `@...` meta tags affect formatting.

If a wrapper is opened but not closed:
- It does not immediately warn on a bare opener like `(`.
- Once there is content (e.g. `(tag`), the tag bar shows a warning and the incomplete token is omitted from the saved tag string.
- When you leave the tag bar, the incomplete token is removed from the input.

## Comments
You can include `/* ... */` comment segments in the tag bar:
- Comments may contain spaces.
- Comment text is preserved (ASCII-printable characters only).

Comments also participate in server-side text search.

Unclosed comments behave like unclosed wrappers:
- A bare `/*` does not immediately warn.
- Once there is content (e.g. `/*comment`), the tag bar warns.
- Unclosed comments are omitted from the saved tag string and are removed when leaving the tag bar.

## Tag Suggestions
- Suggestions appear only while the tag bar input is focused.
- Enter and the arrow keys act only on a suggestion list built for the text in the tag bar. While the list for what you just typed is on its way, the one on screen is for older text: Enter then closes it and leaves what you typed alone, and the arrows wait for the new list.
- The tag bar keeps a muted tag icon inside the input before and during typing; hovering the field shows a `Tags` tooltip.
- While typing inside a tag token, matching is segment-aware for connector-separated tags: a prefix can match the start of the whole tag or the start of any connector-separated segment (`-`, `_`, `.`, `/`). Example: `wor` suggests both `workspaces` and `databricks-workspaces`, while `orksp` suggests neither.
- Typing narrows the empty-bar suggestions instead of reordering them, at every length: each further letter only removes the tags that stop matching (`q` → `qu` → `que`), and backspacing gives the shorter list back. Order: the suggestions with evidence for this note (named in its content, co-occurring with its tags, from notes with overlapping context) in their empty-bar order; then matching tags that already apply through inheritance or ontology implication (the empty bar hides them), by raw usage, so an inherited tag can still be written explicitly; then every other matching tag by raw namespace usage (explicit assignments plus hierarchy inheritance, excluding ontology implications, so implication-heavy tags such as `math` do not receive inflated rank). Example: with content naming goat's milk under an `ML3` ancestor, `m` gives `goat's-milk`, then `ML3` (268 raw uses), then `math`; with `question` inherited from the parent, `q`, `qu` and `que` all start with `question`. The offline experiment (`experiments/tag_suggestions/`, `docs/design/tag-suggestion-learnings.md`) found this better than ranking each prefix afresh after one, two and three letters. The empty-bar ranking is computed once per tag being typed and reused while nothing it depends on changes (the note's text and tags, the tree, other notes' tags, the tag rules), so each further letter costs about a millisecond; it is kept in a sensitive memo cleared on lock. Implementation: `_suggest_while_typing()` and `_typing_basis()` in `app/services/tag_suggestions.py`; tests: `tests/unit/test_typing_narrows_tag_suggestions.py`, `tests/unit/test_single_letter_tag_suggestions.py`.
- When the active prefix starts with `@`, matching meta tags are ranked by notebook usage frequency (note count), with alphabetical tiebreaks for equal counts.
- Tags that match phrases in the current note content and the strongest direct co-occurrence hits from the current note's explicit non-meta tags share the top slots together: the strongest content hit appears first, then the strongest co-occurrence hit, then the next content hit, and so on.
- Within those content hits, an exact standalone tag written in the current note is prioritized ahead of synonym-expanded recommendations. This keeps a specific literal such as `suprapubic` ahead of a generic ontology representative derived from an earlier word such as `message`.
- For blank-prefix suggestions only, if a candidate's literal content match is driven entirely by segments that are already represented in an explicit or inherited tag on the note, that candidate is suppressed as redundant. Example: with `fat.appearance` already present, content-only matches like `fat-loss` or `body-fat` do not crowd out unrelated co-occurrence suggestions such as `overindulging`.
- Where the note sits in the tree gives no boost: tags used on its children, siblings or anywhere under its parent, and tag names written in those notes' or its ancestors' text, compete like any other tag (they are not left out). A tag on two of three children does not belong on the parent, and a sibling naming Kyoto says nothing about this note. Only the note's own text counts.
- Remaining suggestions fall back to other notes whose effective context overlaps the current note's explicit/inherited/inferred non-meta tags, but the emitted non-meta suggestions still come only from explicit tags assigned on those notes.
- A literal content hit on any connector-separated segment can also surface a tag, but low-signal glue segments like `and`, `no`, `of`, `the`, `to`, or `up` do not count on their own. They still participate in exact full-phrase literal matches, so content like `No Kings` can strongly promote `no-kings` even though bare `no` would not.
- Connector-heavy tags need near-complete literal coverage before they surface from content alone: after ignoring numeric-only chunks, a tag with `k` remaining connector-separated chunks requires at least `max(1, k-1)` meaningful matches, capped by its number of meaningful non-noise chunks. Thus `gpt-6-astra` behaves like `gpt-astra`: either `GPT` or `Astra` can surface it. Decimal versions such as `5.6` are ignored in the same way. `X-Y-Z` still needs two matches and cannot surface from just `X`, `Y`, or `Z`.
- Numeric chunks remain insufficient on their own, but they count inside a contiguous near-complete connector phrase that also contains a meaningful text chunk. For example, content `5.6 sol` can promote `GPT-5.6-sol`, while content `5.6` alone does not promote `GPT-5.6`.
- When content matches connector-separated tags, the candidate covering the longest contiguous portion of the note wins first. Fewer unmatched connector segments rank ahead of more padded tags, and prefix-aligned partials beat suffix-aligned ones when coverage otherwise ties. Examples: `A B C D` prefers `B-C-D` over `C-D`, `Z` prefers `Z` over `Y-Z`, `Y` prefers `Y-Z` over `X-Y`, and `Y Z` prefers `Y-Z` over `Z` over `X-Y-Z`.
- Single-character connector segments are still ignored for lowercase noise like `a-b-test`. Uppercase one-letter segments can still count as meaningful literals for entity-like tags, but prose-like `A` and `I` are treated as noise so they do not boost unrelated suggestions. One letter alone never names a tag that also has longer words: a stray `v` does not surface `V-neuron` or `V-Shred` (with `shred` also in the text, `V-Shred` is named). Tags made only of letters (`X-Y-Z`, `Z`) still match.
- A web address in the note's text counts only by its site's name: `https://www.youtube.com/watch?v=GYx4…` reads as `youtube`, so it can name a `YouTube` tag but not `HTTPS`, `V-neuron` or `indeed.com`. The scheme, `www`/`m`, the top-level domain (and `co.uk`-style suffixes), the path and the query are dropped; an IP address has no name. Only addresses with a scheme or a leading `www.` count as addresses: `indeed.com` written in prose still names the tag. Implementation: `note_text_for_tag_matching()` in `app/services/tag_term_matching.py`; tests: `tests/unit/test_tag_matching_links.py`.
- When content-hit strength ties, more structured/specific tags rank ahead of broader/common ones. Mixed-case tags, digit-bearing tags, connector-separated tags, and prefix-aligned segment matches beat looser matches; usage frequency then breaks structurally equal ties before content position, raw tag length, or alphabetical ordering.
- Surrounding prose punctuation is ignored for content matching, so content like `(github?)` still promotes the `github` tag.
- Possessive words also match the base tag: `Julie's birthday is today...` promotes the existing `Julie` tag. Straight and curly apostrophes are equivalent, and full tags containing apostrophes (such as `goat's-milk`) still match normally.
- Case-equivalent tags are collapsed in suggestions (for example `Databricks` vs `databricks`), and the most-used spelling is shown.
- Ontology-equivalent tags are usually collapsed to one displayed suggestion. The representative is the most-used eligible tag spelling explicitly written in tag bars, not the ontology-inferred search frequency, but prefix filtering happens first, so typing `emo` can still show `emotion` even if `mood` is the more common synonym overall. If the current note content exactly matches a synonym alias, that alias can still appear immediately after the common representative within the interleaved content/co-occurrence ordering.
- Tags declared in ontology rules remain eligible for literal-content matching and typed-prefix completion even when they have never been explicitly assigned to a note. With a blank prefix, unrelated unused ontology tags are not added as generic fallback suggestions.
- Tags already present explicitly in the current tag bar are never suggested, nor are their synonyms from the tag relationships (`avocados` once `avocado` is in the bar, also while typing another tag): writing one adds nothing. The tag being typed is not in the bar yet, so its synonyms are still offered. Tests: `tests/unit/test_segment_aware_tag_suggestions.py` (`synonym`).
- With nothing typed, another spelling of a tag the note has (written, inherited or implied) is left out: its singular or plural, word by word with connectors kept (`egg` hides `eggs`, `easter-egg` hides `easter-eggs`, not `easter_eggs`). Plurals are generated from each word, never guessed back to a singular: `-s`, `-es`, `-ies`, `-ves`, `-ses`, `-men`, `-i` and a short irregular list (`children`, `mice`, `people`, …); words with digits or under three letters have none. Once anything is typed, every matching spelling is offered. Implementation: `app/services/tag_plural_variants.py`; tests: `tests/unit/test_tag_plural_variants.py`.
- Tags already present only via inheritance or ontology inference are suppressed unless they match the prefix. Once typed they come right after the matches with evidence (see above), at every length. This holds whatever evidence the tag has: a parent's `fire-alarm` that also goes with the note's tags elsewhere is still left out with nothing typed. (A Tag Suggestions setting that ranked such tags like any other was removed on 2026-10-21; a saved value is dropped when read, `_OBSOLETE_CLIENT_PREFERENCES` in `app/services/client_state_service.py`.) Tests: `tests/unit/test_segment_aware_tag_suggestions.py`, `tests/unit/test_client_preferences_in_memory.py`.
- Right-clicking a suggestion (Control-click on a Mac) opens the tag menu for it instead of the menu of the note underneath: Edit Tag Relationships, then **Why suggested** below it (the action first, so it stays at a fixed place under the pointer however long the explanation is). The list, the typed letters, the cursor and edit mode stay as they were, also once the menu closes (`Escape` closes only the menu). Tests: `scripts/browser-tag-suggestion-menu-regressions.mjs`, `tests/unit/tag_suggestions_service.test.mjs`.
- **Why suggested** lists what the ranking found, in its words, then how often the tag is used. The reasons come with the suggestions (`reasons` in the `/notes/tag-suggestions` reply, by tag), so the menu opens at once and always matches the list. They are built from the ranking's own findings, never a second guess, and only for the shown suggestions (no measurable cost on 45,000 notes). The kinds:
  - `Named in this note: "machine learning"` (every part of the tag is in the text) or `Partly named in this note: "topic"` (`topic-41`; numbers alone do not count). Quotes use the tag's own spelling, `-` and `_` read as spaces.
  - `This note names its synonym "ML"` (a synonym from the tag relationships matched), and for a synonym shown after its representative, `A synonym of "mood"`.
  - `On 4 notes together with "python"` (co-occurrence with the note's own and inherited tags: the most of them any note carries, and how many notes; `together with 1 of this note's tags` when those notes carry different ones).
  - `Named in this note as last saved: …` (the saved text names it; the current edit no longer does).
  - `On 3 notes that share "travel" and "japan" with this one` (context overlap, when no co-occurrence was found).
  - `Already applies: inherited from a parent note` / `Already applies: implied by "maple"`.
  - When none of these hold, the tag is listed by use, and only what is true is said, never what the note lacks: `Matches what you typed: "exer"`, `Part of its name is in this note's text: "exercise"` (too little of it to count as naming it, e.g. one word of `low-intensity-exercise`), then `Listed by use: you've tagged 2 notes with it`.
  - Last: `You've tagged 120 notes with it`, or `Not on any note yet; it is in your tag relationships`. Meta tags say `A built-in tag starting with "@b"` and their use.
  - A shown tag standing for collapsed synonyms also gives their findings (`Its synonym "ML" is on 4 notes together with "python"`).
  Implementation: `app/services/tag_suggestion_reasons.py` (wording) fed by `_suggest_tags()` in `app/services/tag_suggestions.py`; tests: `tests/unit/test_tag_suggestion_reasons.py`.
- Suggestions appear below the tag bar when there is room; if the tag bar is near the bottom, the list flips upward but keeps the same best-on-top ordering and initial scroll position.
- The server returns at most `MAX_TAG_SUGGESTIONS` note tag suggestions; the default is 20.

## About This Tag
- Right-clicking a tag already in the tag bar (written or just typed) opens its tag menu with **About this tag** below Edit Tag Relationships: facts, not reasons, since the tag may never have been suggested. The tag bar text, focus and edit mode stay as they were; `Escape` closes only the menu.
- The lines, as the suggestion reasons word them: `Named in this note: "slept poorly"` (or its synonym); `On 2 other notes together with "sleep"` (the note's other written and inherited tags; this note is not counted); `Also inherited from a parent note` or `Also implied by "maple"` (writing it repeats what already applies); `A synonym of "insomnia"` and `Implies "health"` (tag relationships, up to three names then "and N more"); then `You've tagged 120 notes with it`, `Only on this note` (a typo or one-off?) or `Not on any saved note yet` (just typed). Meta tags say `A built-in tag` and their use.
- The facts are looked up when the tag is right-clicked (`POST /notes/tag-details`, `app/services/tag_details.py`); the menu opens once they arrive, and a later right-click wins over a slower lookup. Tests: `tests/unit/test_tag_details.py`, `scripts/browser-tag-suggestion-menu-regressions.mjs`.

## AI Tag Proposals

- Unresolved proposals are stored separately from accepted tags. They affect inheritance, ontology-aware search/autocomplete, and Untagged Notes immediately, but do not activate formatting or tag commands.
- Direct proposals appear beneath the tag bar only while their note is edited. `+` accepts a proposal into the ordinary tag bar; `−` rejects it. Either saves what was typed first (text and tags), so an accepted tag shows in the tag bar at once beside tags typed there, and keeps focus where it was. When focus is in the tag bar (it is when the suggestions were asked for from there), `+` puts its caret right after the new tag, the last one, scrolled into view; in the note's text the caret stays (Tab reaches the tag bar's end anyway).
- When the tag bar floats at the window's bottom (a note taller than the window), the proposals float directly under it: both are sticky, the row takes the tag bar's place 15px above the window's edge, and the tag bar rides higher by the row's exact height (`--note-tag-proposals-height`, kept by a ResizeObserver) plus the 3px they have between them in place, so the gap is the same floating or not. Accepting or rejecting moves the tag bar down with the shrinking row; nothing scrolls. The row has the note's background, so text never shows through it.
- A proposal for a tag no note has yet (proposed tags don't count) carries a **new** badge, and new ones sit together after the tags already in use; accepting one creates the tag. The snapshot sends them per note (`flags.newProposedTags`), so a badge goes once the tag is accepted on any note.
- Individual proposal accept/reject controls participate in normal undo/redo; undoing an individual acceptance restores its proposal and robot count, while redo accepts it again. This does not define undo behavior for bulk operations.
- The robot count marks unresolved proposals on visible notes. A collapsed note rolls up proposals hidden in its descendant branch; inherited and ontology-derived terms do not inflate the count.
- Pressing a robot is not pressing its note (`handleRobotPress`, on the press: edit mode redraws the robot before the release). On a collapsed note it opens every collapsed note on the way to each proposal it counts (`POST /notes/{id}/tag-proposals/open`, `CmdOpenToTagProposals`), so each note with proposals shows its own robot; branches without proposals stay collapsed and notes the search hides are left alone. The openings stay after editing and are one undo step (`collapse_batch`). Then the highest note with proposals of its own, in outline order, goes into edit mode showing them: the pressed note when it has some, otherwise the first note below it (`editNoteId`). On an expanded note the robot counts only its own proposals, so that note is edited. Another edited note is saved first, as when switching notes; the caret goes to the note's end, hidden. The pressed note stays where it is and nothing scrolls.
- Right-clicking a robot offers **Accept All Suggested Tags** and **Reject All Suggested Tags** for exactly what it counts (`POST /notes/{id}/tag-proposals/resolve-all`, `CmdResolveRobotProposals`; the client sends whether the note showed collapsed and the view's search, tab and kind). One undo step (`tag_sources_batch`), unlike the bulk menu and chat operations; nothing opens, collapses or scrolls; a note being edited is saved first and keeps its caret. Pressing a robot never moves focus or the caret.
- Copy/paste and duplication preserve each note's direct unresolved proposals.
- The connector characters used for content matching are configurable via `TAG_SUGGESTION_CONNECTORS` in `app/config.py`.
- The redundant-content suppression rule is configurable via `TAG_SUGGESTION_SUPPRESS_REDUNDANT_CONTENT_VARIANTS` in `app/config.py`.

### Suggest Tags with AI (one note)

- While editing a note, its right-click menu offers **Suggest Tags with AI** (🤖) below `Add Excalidraw Diagram`, and so does a right-click in its tag bar past the tags (or in an empty bar, with nothing selected; on a tag's letters the tag menu opens as before). Either appears only when an AI is set up (`app/services/ai_setup.py`: features ask whether *an* AI is ready, never for a provider's key) and the privacy settings let the AI see the note as it is being edited: unsaved tags and text count, so typing a blacklisted tag or `@password` hides the item at once (`POST /api/ai/notes/{id}/tag-suggestions/availability`; the note's ancestors are judged as saved). It is also hidden while a request for that note is still running. Opening either menu waits for this check; in the tag bar, when the AI may not be used, nothing opens (never the browser's menu). The tag bar keeps its text, caret and focus throughout.
- For a note with children the item is a submenu: **This Note** or **This Note and Its Children** (every descendant the view shows, open or collapsed; descendants the privacy settings hide from the AI are skipped with their children). There is no size check.
- Choosing it saves the note, then asks the AI (`POST /api/ai/notes/{id}/tag-suggestions`, which writes nothing; it streams progress lines, then the proposals by note). With children the card shows how far the batches have got (*Asking the AI… 2 of 3*). Each step waits for any running command instead of being dropped (`CommandGate.runWhenFree`). Meanwhile *Asking the AI…* floats on a card above the tag bar's right end (a child of the tag bar, so it floats with it; it takes no space in the note): the note's top, the caret (or the tag bar's caret) and the page stay put, nothing scrolls, and typing goes on. The command gate is not held while the AI works.
- The answer is added as ordinary proposals (`POST /notes/{id}/tag-proposals/add`, one undo step for every note, `tag_sources_batch`): tags a note already has (its tag bar, a parent, a rule) or already proposes are left out, also as their singular or plural (`eggs` beside `egg`), and anything typed meanwhile is saved first. Children's proposals show as their robot counts; nothing opens on its own. The proposals appear under the tag bar, in-use tags first and **new** ones on the right; pressing `+` on a new one is the user's yes to creating it. The refresh that shows them keeps focus and the caret where they were (`keepEditingFocus`, as `+`/`−` do; pressing those buttons does not take focus). When nothing new comes back the card says *No new tags to suggest* until the next key (not a bare modifier), click, or the end of editing. When the AI fails a banner says why and editing goes on. Leaving edit mode while it asks still adds the proposals, which the robot count shows.
- The request is a bulk tagging run for the note or its subtree (`app/services/agent/note_tag_suggestions.py`): the same tag skill, instructions (`tag_batch_messages`), answer format and validation, plus the ancestors as context and a ranked vocabulary with counts: the tag bar's top suggestions for the note, then the most used tags, counted on notes the AI may see only, so a tag that is only on hidden notes is never sent. A subtree goes as one nested tree when it fits the tagging batch window; otherwise the note alone and each child's subtree are trees grouped into batches, each given the note's text as context. Batch 1 runs first and its new tags are offered to the rest, which run four at a time. It always allows new tags (at most two per note), whatever the bulk vocabulary setting says.

### Bulk proposal operations

Chat-requested LLM generation and menu/chat bulk acceptance or rejection use a separate atomic path from the individual proposal controls above. See [agent tagging](../design/agent-harness.md#tag-proposal-operations).

- Bulk operations are outside ordinary undo/redo, even when applied atomically. They create no individual or combined undo entry and expose no bulk Undo control.
- Successful application clears the existing undo and redo stacks using the search-context boundary mechanism. Failure, cancellation, or decline preserves the stacks. A result with no changes preserves history.
- Bulk acceptance/removal is an explicit scoped operation, not reversal of a particular generation pass. It can affect older pending proposals as well.
- Individual proposal controls retain their existing undo behavior. See [undo/redo scope](state-handling.md#undoredo-with-context-boundaries).

## Focus / Tab Behavior
- `Tab` toggles focus between the note content and the tag bar.
- Clicking the visible tag bar while editing focuses the tag input directly instead of treating the click as a note-shell selection.
- The tag bar expands into view when note editing starts and contracts out of view when editing ends, unless `Animated transitions` is off in the command palette. While it contracts, its input gives up the keyboard and is disabled (it looks unchanged), so a quick keystroke cannot reach a tag bar whose note is no longer edited; editing the same note again mid-animation re-enables it (`releaseClosingTagBarInput` in `tag-bar-service.js`; tests: `tests/unit/tag_bar_closing_input.test.mjs`).
- When leaving the tag bar (Tab or click-away), the tag string is sanitized so only valid, fully-formed tokens/comments remain.
- While the single-note tag bar is focused, note-level edit shortcuts still target the current note, including create sibling/child, delete, move up/down, move to top, indent/outdent, split, unformat, and note copy/cut/paste.
- `Cmd/Ctrl+U` removes formatting and inline imagery from the selected range, or from the entire note when no range is selected. Range removal deletes intersecting inline images and rewrites scoped delimiters around the selection so formatting outside it remains; whole-note removal removes rich HTML, all inline images, and Add Style tags while preserving links and semantic tags such as `@todo`.

## Pasting Dictated Text
- Pasting (never typing) dictated text into the tag bar turns it into tags: punctuation and filler words are dropped, spoken "dash"/"hyphen"/"underscore"/"slash" join words (Superwhisper's `foo-Dash bar` gives `foo-bar`), the longest run of words matching an existing tag becomes that tag (spelled as used most often, also when the tag is one word: "to do" gives `todo`), "at" before a built-in meta tag gives that meta tag ("at to do" gives `@todo`), the quote and exclusion phrases are dropped (tags cannot quote or exclude), and other words become new tags, lowercased unless they look like an acronym. Tags already in the bar are not added again. One undo restores the pasted text (without commas). Full rules: `docs/ui/dictation-paste.md`.

## Add from Selected Text
- Selecting 1–25 characters inside a note adds **Add as Tag** to that note's context menu.
- The action always targets the note containing the selection, including when another note is being edited.
- Existing explicit namespace tags are matched case-insensitively with spaces, `-`, `_`, `.`, and `/` treated as equivalent joiners. The most-used existing spelling and joiner style is reused.
- If the note already has an equivalent explicit tag, the action is a no-op and does not add a duplicate.
- If no equivalent tag exists, a new tag preserves the selection's capitalization, replaces whitespace with dashes, and removes characters disallowed by the tag-bar grammar. This preserves acronyms such as `GPT`.
- Selections longer than 25 characters, blank selections, selections with no usable tag characters, and exact uppercase `OR` do not show the action.

## Add Style Context Menu
- Right-clicking the actively edited note adds **Add Style**. Hovering or selecting it opens a connected flyout submenu containing the supported visual and renderer meta tags.
- **Remove Formatting** appears directly beneath Add Style and performs the same selection-aware operation as `Cmd/Ctrl+U`. For example, selecting `baz` in content `foo {{bar baz}}` with tag `{{@red}}` rewrites the content to `foo {{bar }}baz` and keeps `{{@red}}` for the remaining red range.
- With no selected range, the chosen unwrapped meta tag is added to the tag bar and applies to the entire note. **Footnote** is selection-only and is hidden without a selection.
- With a selected range, the text is wrapped and the matching scoped meta tag is added to the tag bar.
- Scope allocation prefers single `{}`, `[]`, and `()` delimiters in that order, then depth-two and depth-three forms. A candidate is skipped when its delimiter already occurs in the note content or tag bar.
- Basic styles can overlap. Applying a second style to a partially overlapping selection uses another delimiter pair, and view rendering splits the overlap into valid nested HTML.
- Renderer tags (`@markdown`, `@LaTeX`, `@json`, `@csv`, and `@shell`) can be added globally or to a scoped selection.
- Add Style also exposes fixed `@size=...` presets. Right-clicking an inline image in edit or view mode provides stepwise **Make Bigger**, **Make Smaller**, and **Reset Size** actions; stored image-file embeds expose those actions in view mode. Reset removes the size tag rather than retaining `@size=1.0`.
