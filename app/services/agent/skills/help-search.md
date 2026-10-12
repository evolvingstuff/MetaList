# Search and views

Use this reference to explain MetaList accurately. It describes user capabilities,
not permission or tools for you to execute every operation. You can answer and
request one supported menu/dialog opening. You cannot submit a form, change
settings, run a shell command, or mutate notes through this help response. Do not
claim that you inspected current notes or settings: none are supplied here.
Prefer user-facing steps over implementation details. If the reference does not
answer a question, say what is unknown; do not invent syntax or controls.

Sources: docs/ui/search-syntax.md, docs/ui/search-semantics.md

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
- A note’s effective tags include its own tags plus non-meta tags inherited through its parents and note references (`[[UUID]]` and `![[UUID]]`). A reference contributes tags from its source and that source's complete descendant subtree, including further references within the subtree. It excludes tags inherited from ancestors above the source. Children of the referencing note inherit its effective tags normally. Accepted and proposed tag contributions remain separate until combined for search.
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
- Searches themselves never earn credit. Intentional note engagements—edit selection, manual expansion, full-screen view, shell/todo command execution—increment the note's raw explicit/inherited searchable tags once per active tab/search flow. Leaving for another tab or executed search and later returning starts a new flow, so a later shell run can count again. Successfully adding explicit tags separately credits only those newly added tags; removals and case-only changes are neutral. Accepting a search suggestion by mouse or keyboard credits that selected tag once, with no engagement-flow deduplication. Clicking a search-context tab credits each known positive tag term in its executed query once; excluded tags and quoted text are ignored. Programmatic tab restoration/switching, collapse, search execution, hover, render, and scroll are neutral.
- After one or more completed tags, the remaining suggestions (only tags that still leave results) are ordered by how closely their notes overlap with the notes matching the tags already typed, so specific companions come before tags that are common everywhere.
- Activity uses sparse per-calendar-day counts. A window sums the relevant daily buckets, selects its highest-count matching tag, and excludes tags chosen by earlier windows. No decay calculation or all-time score exists. The latest 365 populated days are retained, so unused calendar days consume no buckets.
- In password-protected namespaces, all retained daily buckets live together in one authenticated encrypted payload. The database exposes only one random row UUID, ciphertext, nonce, and authentication tag—never dates, tag names, counts, queries, or changed-tag metadata.
- A typed prefix can match either the start of the full tag or the start of any connector-separated segment.
  - Example: `wor` suggests `workspaces` and `databricks-workspaces`.
  - Example: `orksp` suggests neither.
- Right-clicking a search suggestion (Control-click on a Mac) opens its tag menu: **Why suggested**, then Edit Tag Relationships. The search and the list stay as they were; `Escape` closes only the menu. A right-click earns no activity credit.
- **Why suggested** says what MetaList's ranking used (not the AI): how often you worked with the tag in a personalization window (`You've worked with it 12 times in the last 7 days`), the notes it shares with the tags already in the search, how many notes the search so far finds it on, how many notes leaving it out removes, or that a first tag is listed by use; last, how many notes searching for it finds.
- The server returns at most `MAX_SEARCH_SUGGESTIONS` suggestions; the default is 20.
- This affects suggestions only; actual tag search matching remains exact against effective tag terms.

### Creating Notes From Search
- New notes created while a positive tag search is active are initialized from
  the positive tags and text terms in the **first clause only**. Later `OR`
  clauses are not copied into the new note.
- If an existing case-equivalent tag spelling is already common in the namespace, that spelling is used for the new note. Example: searching `ml3` adds `ML3` when existing notes use `ML3`.
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
- Also against the titles of web pages linked in the note: for each `http(s)` URL
  in the note (written out, or hidden behind a link label), the page title
  MetaList has already fetched and stored. Titles are fetched when a URL on its own
  line is first displayed, so a note matches by title once its title has been
  fetched; a title fetched later makes the note match from then on. Titles are not
  available while the namespace is locked. The URL itself remains searchable.
- A space at the edge of the quotes marks a word boundary on that side: `"fat "` needs
  the word to end there (a space, punctuation or the end of the text follows), so it
  matches "fat cat" and "fat." but not "father"; `" fat"` needs it to start there, so
  it does not match "sulfate"; `" fat "` matches only the word "fat". Without edge
  spaces a term matches anywhere, also inside words (`"fat"` matches "father").

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

Both embedded (`![[UUID]]`) and linked (`[[UUID]]`) note references participate in tag inheritance:
- Non-meta tags on the source or its descendants supply required/forbidden tag hits for the host and its children, including through chains of references. For `foo → bar → baz`, a reference to `bar` matches tags on `bar` and `baz`, but excludes tags inherited from `foo`. Searching for a tag on `baz` includes the reference host; an expanded embed displays the full `bar → baz` subtree. Link-mode references retain their compact rendering.
- Canonical notes still inherit their own ancestors' tags. The referencing host also retains inheritance from its own parents. Source text does not supply required/forbidden quoted-text hits; source meta tags and comments do not pass through references.
- Subtree/reference cycles converge from direct tags, without importing parent inheritance. Removing a tag/reference clears stale contributions, including within cycles. An explicit reference to an ancestor still contributes that referenced subtree's tags.
- Inherited-tag metadata, suggestions, and Untagged Notes use the same computed tags. Ontology inference continues to run per note after inheritance.
- Updates are maintained in memory on edits, tag changes, moves, deletion, and restoration; collapse/expand does not rebuild tag inheritance.
