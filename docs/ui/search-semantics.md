# Search Semantics

This document describes **server-side search behavior** (what matches what).

For input grammar, normalization rules, and completeness gating, see:
- `docs/ui/search-syntax.md`

## Term Types

Search queries are a whitespace-separated list of terms.

### Tag Terms (unquoted)
- `foo` and `+foo` are equivalent (required tag).
- `-foo` excludes notes that have tag `foo`.
- A tag with a value, `name=value` (`@code=python`, `@size=2`), can be searched whole
  (`@code=python` finds Python notes only) or by its name alone: a tag without `=`
  also matches every `tag=value` (`@code` finds every `@code=<language>` note, `-@code`
  excludes them all, `priority` finds `priority=high`). The family is the part before
  `=`, never a shorter prefix (`@cod` finds nothing). One `=` can be typed in a search
  tag, as in the tag bar; it is never a tag's first character. Ontology rules still
  match tags exactly.

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
- After one or more completed tags, the remaining candidates (those that still leave results) are ordered by overlap with the typed tags: notes carrying both the candidate and the typed tags, divided by notes carrying either (Jaccard), then case and alphabetical tiebreaks (`SearchIndex.suggest_tag_completions`). This favors specific companions over tags common everywhere. An offline experiment found it a good compromise: ordering by specificity (lift) surfaces forgotten rare tags more often after a narrower first tag, but makes common second tags after a broad first tag cost about 1.4 more keystrokes; see `docs/design/search-suggestion-learnings.md`.
- Activity uses sparse per-calendar-day counts. A window sums the relevant daily buckets, selects its highest-count matching tag, and excludes tags chosen by earlier windows. No decay calculation or all-time score exists; in the same experiment, smooth recency decay did not beat the fixed windows. The latest 365 populated days are retained, so unused calendar days consume no buckets.
- In password-protected namespaces, all retained daily buckets live together in one authenticated encrypted payload. The database exposes only one random row UUID, ciphertext, nonce, and authentication tag—never dates, tag names, counts, queries, or changed-tag metadata.
- A typed prefix can match either the start of the full tag or the start of any connector-separated segment.
  - Example: `wor` suggests `workspaces` and `databricks-workspaces`.
  - Example: `orksp` suggests neither.
- `@` (meta) tags are suggested from the built-in list (`@markdown`, `@size=2`…) and from
  the `@` tags notes carry, with each valued tag's family: `@c` suggests `@code` and
  `@code=python`, `@code` suggests `@code=python` and `@code=javascript`. Plain tags with a
  value are suggested whole (`priority=high`), without their family name.
- The server returns at most `MAX_SEARCH_SUGGESTIONS` suggestions; the default is 20.
- This affects suggestions only; tag search matches effective tag terms exactly, except that
  a tag without a value also matches its `tag=value` family (above).

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
- Also against the names of files the note references (`[[id]]` or `![[id]]`, which
  MetaList shows by the file's name): `"congratulation"` finds a note holding
  `0025018697_CongratulationLetter.pdf`. Names are read from the files database the
  first time a note is indexed (in an encrypted vault, once it is unlocked) and kept in
  memory (`FileRegistry.referenced_file_names`); a file's name never changes after upload.
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

### Highlighted Phrases
The required quoted phrases of the search, from every `OR` clause, are marked in soft
yellow (a dark gold in the dark theme) wherever they occur in the notes list: in each
note's text, in embedded notes, in a matching note's children shown with it, and in
tag-bar comments. A mark follows the matching rules above (any case, also inside words,
edge spaces for word edges); a phrase running through formatting or across a line
break is one mark. Excluded phrases and tags are never marked.

- The note being edited is not marked; leaving edit mode marks it again.
- Full screen, floating windows, export, print and copied text are not marked.
- Marks are painted over the text (`search-highlight-service.js`, the CSS Custom
  Highlight API): no note's HTML changes, and nothing moves or scrolls.
- The server sends the phrases with each view (`searchHighlightPhrases`, its own
  reading of the search), so the browser never parses the search itself.
- Phrases the browser cannot see are not marked: a web page title or a hidden link
  URL the note matched by.

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
