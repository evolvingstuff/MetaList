# Search and views

Use this reference to explain MetaList accurately. It describes user capabilities,
not permission or tools for you to execute every operation. You can answer and
request one supported menu/dialog opening. You cannot submit a form, change
settings, run a shell command, or mutate notes through this help response. Do not
claim that you inspected current notes or settings: none are supplied here.
Prefer user-facing steps over implementation details. If the reference does not
answer a question, say what is unknown; do not invent syntax or controls.

Sources: docs/ui/search-syntax.md, docs/ui/search-semantics.md, docs/ui/controls.md

# Search Syntax

## Scope
- This document describes the **client-side search query syntax verifier**.
- It does **not** describe search semantics (what matches what).
- Search execution is gated by syntactic completeness: incomplete queries do not execute.
- Search queries do not provide created/updated date constraints.
- The untagged-notes view is also outside search syntax. Select it from the command palette rather than entering `@untagged`.

## Terms
Search queries are a whitespace-separated list of **terms** and optional `OR`
operators. Terms next to each other form an implicit-AND clause; `OR` separates
clauses.

When explaining a query, split at unquoted uppercase `OR` first and describe each
clause separately. Count clauses separately from terms: `OR` is a separator, not
a term or an extra clause. A quoted phrase is one text term, regardless of how
many words it contains. For example, `A B OR C` has two clauses and three terms.

### OR Operator
- Only exact uppercase, unquoted `OR` is an operator.
- Every clause must contain at least one term, so leading, trailing, and
  consecutive `OR` operators are invalid.
- `+OR` and `-OR` are invalid because uppercase `OR` is reserved and cannot be
  used as a tag.
- Lowercase or mixed-case forms such as `or` and `Or` remain ordinary tag terms.
- Quoted `"OR"` and `'OR'` remain ordinary text terms.

Examples:
- `A B C OR D E`
- `A OR B OR C D`

### Tag Terms
- `foo`
- `-foo`
- `+foo`

Notes:
- `+`/`-` semantics are out of scope here; they are just syntactic prefixes.
- Tag tokens follow the same character rules as tag-bar *non-wrapper* tokens.
- A tag with a value (`@code=python`) is searched whole or by its name: `@code` finds every `@code=<language>` note and `-@code` excludes them all; `@code=python` finds Python notes only. Typing `@c` or `@code` suggests `@code` and the languages in use.
- Bracket wrappers (`[foo]`, `{foo}`, `((foo))`) are **not** part of search syntax.

### Text Terms
A text term is a quoted string using either quote character, as long as the opener and closer match:
- Double-quoted: `"some text"`
- Single-quoted: `'some text'`
- Negated forms: `-"some text"`, `-'some text'`

Escapes inside quoted text (backslash approach):
- Within `"..."`: allow `\\` and `\"`
- Within `'...'`: allow `\\` and `\'`

Searching for quote characters without escaping:
- Search for a literal `"`: use single quotes: `'"'`
- Search for a literal `'`: use double quotes: `"'"`

Highlighting: the notes list marks each required quoted phrase (from every `OR` clause)
in yellow wherever it occurs: in note text, embedded notes, children shown with a match,
and tag-bar comments. Excluded phrases and tags are not marked, nor is the note being
edited (until the user leaves edit mode), full screen, floating windows, export or print.

## Normalization
- Runs of whitespace are normalized to single spaces.
- Leading/trailing whitespace is trimmed.
- The verifier actively rewrites the input while typing (cursor/selection is preserved).

## Pasting Dictated Text
- Pasting (never typing) dictated text, for example from Superwhisper, turns it into tags: "neural network minus python" becomes `neural-network -python`. The full rules are in the dictation help topic.

## Completeness + Warnings
The verifier produces:
- `normalizedText`: the normalized query string.
- `sanitizedText`: only complete terms.
- `isComplete`: whether the full query is syntactically complete.
- `warningMessage`: user-facing warning text (or `null`).

Rules:
- **Unclosed quotes**: incomplete. Warn once there is content inside the quote.
  - Example: `"unclosed` → warn `Close quote with "`
- **Empty quoted strings**: incomplete and warned.
  - Examples: `""` and `''` → warn `Enter text inside quotes`
- **Dangling prefixes**: `+` or `-` must be directly followed by its tag or quoted text; a space after it (`- tag`) is not accepted as `-tag`. A lone prefix at the end is still being typed: incomplete, not warned. Once a term follows a prefix and a space, the field shows "In a search, + or - must be directly followed by the tag or quoted text, with no space (for example -tag)", the query is incomplete (nothing new runs), and that term is left out of the sanitized text, so it is never searched with the opposite meaning (a restored `- tag` does not run as `tag`). If such a search is still sent (pressing Enter, or adding a note while it is the search), the server's rejection appears as a polite banner with the same explanation.
- **Empty OR clauses**: leading, trailing, or consecutive `OR` is incomplete and
  warned.

## Implementation
- Verifier: `app/static/js/modules/mode-manager/services/search-syntax-service.js`
- Input enforcement + warning rendering: `app/static/js/modules/mode-manager/services/search-input-service.js`


# Search Semantics

This document describes **server-side search behavior** (what matches what).

For input grammar, normalization rules, and completeness gating, see:
- `docs/ui/search-syntax.md`

## Term Types

Search queries are a whitespace-separated list of terms.

### Tag Terms (unquoted)
- `foo` and `+foo` are equivalent (required tag).
- `-foo` excludes notes that have tag `foo`.

Tag matching uses the note’s tag-bar string (`notes.tags`) tokenized with the same
rules as the tag bar:
- Wrapper tokens (e.g. `{{foo bar}}`) contribute inner terms (`foo` and `bar`).
- `/* ... */` comment regions are ignored.

In addition, notes implicitly inherit **non-meta** tag terms from parents and referenced notes:
- A note’s effective tags include its own tags plus non-meta tags inherited through its parents and note references (`[[UUID]]`, links and embeds). A reference contributes tags from its source and that source's complete descendant subtree, including further references within the subtree. It excludes tags inherited from ancestors above the source. Children of the referencing note inherit its effective tags normally. Accepted and proposed tag contributions remain separate until combined for search.
- Tags starting with `@` (meta tags like `@monospace`) are **not** inherited.
- Tag-bar `/* ... */` comments are **not** inherited (they only affect text search for the note that contains them).

Ontology rules also add **inferred tags** before search matching:
- Implication + matcher rules are applied per note, and inferred tags are added to the effective tag set.
- See `docs/design/ontology-rules-v1.md` for the rule language and semantics.

### Untagged Notes View
- `View: Untagged notes` is a temporary, tab-agnostic view selected from the command palette, not an `@untagged` search token.
- Selecting it preserves the active tab and its search while temporarily showing notes whose full effective tag set has no non-meta tags. The search box is visually blank while this override is active because the preserved tab query is not being applied.
- Inherited and ontology-inferred tags count as tags; formatting/meta tags beginning with `@` do not.
- The dismissible `Untagged notes` pill returns to the underlying tab view and restores its query in the search box. Clicking any tab or changing the search input also dismisses the temporary view.
- Changing the search input additionally resets the active tab's sort mode to Normal before executing the search.

### Search Suggestions
- Search-bar tag suggestions are segment-aware for connector-separated tags.
- A suggestion must leave at least one matching note in the active `OR` clause, satisfying every completed tag, text term, and exclusion. For example, after `prediction-future`, typing `security` only suggests `computer-security` if that combination actually matches a note. Partial tag overlap alone is insufficient. Matching uses the same effective tags as search, including inheritance, references, and ontology inference. This filtering happens before personalization and the visible limit; note-tag recommendations can still propose new combinations.
- For a blank query or the first tag prefix in a query, ordered calendar-day windows promote matching tags into the first suggestion slots. The default is `[1, 7, 30]`, and the command-menu editor can add, remove, or reorder 1–365 day windows; an empty list disables personalization.
- Prefix matching happens against the complete candidate set before the visible suggestion limit is applied, so an interacted `shortcut` cannot be discarded merely because 50 unrelated tags rank above it globally and leave frequency-ranked `short-story` first.
- Case-equivalent tags are collapsed in suggestions, and the most-used spelling is shown.
- Enter and the arrow keys act only on a suggestion list built for the text in the box. While the list for what you just typed is on its way, the one on screen is for older text: Enter then closes it and keeps what you typed (it does not add a note), and the arrows wait for the new list.
- Searches themselves never earn credit. Intentional note engagements—edit selection, manual expansion, full-screen view, shell/todo command execution—increment the note's raw explicit/inherited searchable tags once per active tab/search flow. Leaving for another tab or executed search and later returning starts a new flow, so a later shell run can count again. Successfully adding explicit tags separately credits only those newly added tags; removals and case-only changes are neutral. Accepting a search suggestion by mouse or keyboard credits that selected tag once, with no engagement-flow deduplication. Clicking a search-context tab credits each known positive tag term in its executed query once; excluded tags and quoted text are ignored. Programmatic tab restoration/switching, collapse, search execution, hover, render, and scroll are neutral.
- After one or more completed tags, the remaining suggestions (only tags that still leave results) are ordered by how closely their notes overlap with the notes matching the tags already typed, so specific companions come before tags that are common everywhere.
- Activity uses sparse per-calendar-day counts. A window sums the relevant daily buckets, selects its highest-count matching tag, and excludes tags chosen by earlier windows. No decay calculation or all-time score exists. The latest 365 populated days are retained, so unused calendar days consume no buckets.
- In password-protected vaults, all retained daily buckets live together in one authenticated encrypted payload. The database exposes only one random row UUID, ciphertext, nonce, and authentication tag—never dates, tag names, counts, queries, or changed-tag metadata.
- A typed prefix can match either the start of the full tag or the start of any connector-separated segment.
  - Example: `wor` suggests `workspaces` and `databricks-workspaces`.
  - Example: `orksp` suggests neither.
- Right-clicking a search suggestion (Control-click on a Mac) opens its tag menu: Edit Tag Relationships, then **Why suggested** below it. The search and the list stay as they were; `Escape` closes only the menu. A right-click earns no activity credit.
- **Why suggested** says what MetaList's ranking used (not the AI): how often you worked with the tag in a personalization window (`You've worked with it 12 times in the last 7 days`), the notes it shares with the tags already in the search, how many notes the search so far finds it on, how many notes leaving it out removes, or that a first tag is listed by use; last, how many notes searching for it finds.
- Right-clicking a tag already typed in the search box opens its menu with **About this tag** below Edit Tag Relationships: how many notes searching for it finds (or `No note has this tag`, often a typo), how many notes it shares with the other tags in the search, what leaving out a `-tag` removes, which synonyms and implying tags it also finds, and how often you worked with it recently.
- The server returns at most `MAX_SEARCH_SUGGESTIONS` suggestions; the default is 20.
- This affects suggestions only; actual tag search matching remains exact against effective tag terms.

### Creating Notes From Search
- New notes created while a positive tag search is active are initialized from
  the positive tags and text terms in the **first clause only**. Later `OR`
  clauses are not copied into the new note.
- If an existing case-equivalent tag spelling is already common in the vault, that spelling is used for the new note. Example: searching `ml3` adds `ML3` when existing notes use `ML3`.
- If the new note already inherits a case-equivalent non-meta tag from an ancestor, the inherited tag is treated as satisfying the search and is not duplicated.

### Text Terms (quoted)
- Required text: `"some text"` or `'some text'`
- Forbidden text: `-"some text"` or `-'some text'`

Text matching is:
- Case-insensitive (`casefold`).
- Against **visible text**, extracted by stripping HTML (scripts/styles ignored).
- Also against tag-bar `/* ... */` comment text (whitespace-normalized).
- Also against the URL of a web link whose label hides it (for example a link
  pasted from a web page that shows a video title): the note is searched as
  "Video title (https://...)".
- Also against the names of files the note references (a PDF or other file shown by
  its name): `"congratulation"` finds a note holding `0025018697_CongratulationLetter.pdf`.
  Find (⌘F) finds file names in the list too.
- Also against the titles of web pages linked in the note: for each `http(s)` URL
  in the note (written out, or hidden behind a link label), the page title
  MetaList has already fetched and stored. Titles are fetched when a URL on its own
  line is first displayed, so a note matches by title once its title has been
  fetched; a title fetched later makes the note match from then on. Titles are not
  available while the vault is locked. The URL itself remains searchable.
- A space at the edge of the quotes marks a word boundary on that side: `"fat "` needs
  the word to end there (a space, punctuation or the end of the text follows), so it
  matches "fat cat" and "fat." but not "father"; `" fat"` needs it to start there, so
  it does not match "sulfate"; `" fat "` matches only the word "fat". Without edge
  spaces a term matches anywhere, also inside words (`"fat"` matches "father").

### Property Terms
Tags can carry values (`jogging:miles=3`, `drug:dosage=10mg`; see the tag bar's Tag
Properties and `docs/design/tag-properties.md`). A search compares a note's own values:

- `jogging:miles>2`: notes whose `jogging` has `miles` over 2. Operators: `>`, `<`,
  `>=`, `<=`, `=`.
- `jogging:miles?`: notes carrying `jogging` themselves (not only inheriting it) with no
  `miles`: incomplete data to fill in.
- `jogging:miles`: notes whose `jogging` has `miles`, with any value.
- `date>=2024-01`: a valued tag's own value (`date=2024-03-05`); `>`, `<`, `>=`, `<=`.
  (`date=2024-01` stays the valued tag it has always been.)
- `-` excludes, spaces combine, `OR` separates clauses, as for tags:
  `jogging:miles>2 jogging:duration<40`, `jogging -jogging:miles>10`.
- One property per term: `jogging:miles>2:duration<40` is refused with how to write it.
- Values are compared by kind: numbers, dates (`2024-01` is its first day; a year alone,
  `2026`, is a number), date-times (`2024-01-15T10:30`), times of day (`10:30`, `22:30`,
  `10:30pm`, `10am`; `12am` is midnight) and text (any case). A value of another kind is
  skipped: `miles>2` ignores `miles=far`.
- Units are labels: `drug:dosage>5mg` compares only `mg` values; `drug:dosage>5` compares
  every unit (`10mg`, `10kg`, `10`), which shows when a search should name one.
- Values belong to the note they are written on: a child of a 3-mile run inherits
  `jogging`, never `miles=3`.
- A note added while such a search is active gets the term's tag; an `=` term also gives
  it the value (`jogging:miles=3` adds `jogging:miles=3`). Other comparisons name no
  value, so the new note has the tag only.
- Not yet: finding `jogging` values through implications (`exercise:miles>2`), and
  suggestions for property names and units.

### UUID Terms
- UUIDs in positive terms are treated as direct note targets (including when pasted as `[[UUID]]`).
- This is additive with normal tag/text matching.

## Matching Rules

Terms within a clause are AND-ed:
- A note must contain **every required tag**.
- A note must contain **every required text term** as a substring.

Forbidden terms exclude matches from their own clause:
- A note must contain **none** of the forbidden tags.
- A note must contain **none** of the forbidden text substrings.

Exact uppercase, unquoted `OR` separates clauses, and a note matches if any
complete clause matches. For example:
- `A B C OR D E` means `(A AND B AND C) OR (D AND E)`.
- `A OR B OR C D` means `A OR B OR (C AND D)`.
- `A -X OR B` means `(A AND NOT X) OR B`; `-X` does not exclude a note that
  matches the `B` clause.

Leading, trailing, and consecutive `OR` operators are invalid. Lowercase `or`
is an ordinary tag term, and quoted `"OR"` is an ordinary text term. Uppercase
`OR` is reserved across tag-entry paths and cannot be created as a tag.

## Tree Inclusion

The UI renders a tree, so search returns context:
- All matching notes are included.
- All ancestors of a matching note are included (so matches are reachable).
- Non-matching descendants are not promoted to full matches just because an ancestor matched.
- Within a visible root, excluded child/sibling branches are rendered as redacted placeholders on the client (fixed-height grey lines) rather than disappearing.
- Clicking a redacted placeholder reveals the whole redacted set within that note's local subtree in the current tab; the revealed notes stay visually dimmed so excluded search context is still obvious.
- For UUID-direct targeting specifically:
  - The target note is included.
  - Its ancestors are included.
  - Its descendants are included and not redacted.
  - Non-matching sibling branches remain redacted according to normal search behavior.

## Windowing / Infinite Scroll

Results are still **windowed by root notes**:
- The server sends an initial window of matching roots.
- Scrolling near the end triggers additional root windows.

## Embedded References and Search

Note references (`[[UUID]]`), links and embeds alike, participate in tag inheritance:
- Non-meta tags on the source or its descendants supply required/forbidden tag hits for the host and its children, including through chains of references. For `foo → bar → baz`, a reference to `bar` matches tags on `bar` and `baz`, but excludes tags inherited from `foo`. Searching for a tag on `baz` includes the reference host; an expanded embed displays the full `bar → baz` subtree. Link-mode references retain their compact rendering.
- Canonical notes still inherit their own ancestors' tags. The referencing host also retains inheritance from its own parents. Source text does not supply required/forbidden quoted-text hits; source meta tags and comments do not pass through references.
- Subtree/reference cycles converge from direct tags, without importing parent inheritance. Removing a tag/reference clears stale contributions, including within cycles. An explicit reference to an ancestor still contributes that referenced subtree's tags.
- Inherited-tag metadata, suggestions, and Untagged Notes use the same computed tags. Ontology inference continues to run per note after inheritance.
- Updates are maintained in memory on edits, tag changes, moves, deletion, and restoration; collapse/expand does not rebuild tag inheritance.

# Search Bar (typing and suggestions)

From docs/ui/controls.md.

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
- Each configured window chooses its highest-count matching tag, excluding tags already chosen by earlier windows. The remaining suggestions retain normal vault-frequency ordering.
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
