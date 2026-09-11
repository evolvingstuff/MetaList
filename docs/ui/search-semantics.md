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
- A note’s effective tags include its own tags plus non-meta tags inherited through parents and note references (`[[UUID]]` and `![[UUID]]`). References contribute the source's inherited tags too; children of the referencing note inherit those tags normally. Accepted and proposed tag contributions remain separate until combined for search.
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
- For a blank query or the first tag prefix in a query, ordered calendar-day windows promote matching tags into the first suggestion slots. The default is `[1, 7, 30]`, and the command-menu editor can add, remove, or reorder 1–365 day windows; an empty list disables personalization.
- Prefix matching happens against the complete candidate set before the visible suggestion limit is applied, so an interacted `shortcut` cannot be discarded merely because 50 unrelated tags rank above it globally and leave frequency-ranked `short-story` first.
- Case-equivalent tags are collapsed in suggestions, and the most-used spelling is shown.
- Searches themselves never earn credit. Intentional note engagements—edit selection, manual expansion, full-screen view, shell/todo command execution—increment the note's raw explicit/inherited searchable tags once per active tab/search flow. Leaving for another tab or executed search and later returning starts a new flow, so a later shell run can count again. Successfully adding explicit tags separately credits only those newly added tags; removals and case-only changes are neutral. Accepting a search suggestion by mouse or keyboard credits that selected tag once, with no engagement-flow deduplication. Clicking a search-context tab credits each known positive tag term in its executed query once; excluded tags and quoted text are ignored. Programmatic tab restoration/switching, collapse, search execution, hover, render, and scroll are neutral.
- Activity uses sparse per-calendar-day counts. A window sums the relevant daily buckets, selects its highest-count matching tag, and excludes tags chosen by earlier windows. No decay calculation or all-time score exists. The latest 365 populated days are retained, so unused calendar days consume no buckets.
- In password-protected namespaces, all retained daily buckets live together in one authenticated encrypted payload. The database exposes only one random row UUID, ciphertext, nonce, and authentication tag—never dates, tag names, counts, queries, or changed-tag metadata.
- A typed prefix can match either the start of the full tag or the start of any connector-separated segment.
  - Example: `wor` suggests `workspaces` and `databricks-workspaces`.
  - Example: `orksp` suggests neither.
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
- Source non-meta tags supply required/forbidden tag hits for the host and its descendants, including through chains of references. A reference to a source tagged `foo` and a child beneath it both match `foo`; `-foo` excludes both.
- Source text does not supply required/forbidden quoted-text hits. Source meta tags, comments, and tags belonging only to the source's descendants are not inherited through the reference.
- Cycles converge on the tags reachable through parent/reference dependencies. Removing a tag/reference clears stale contributions, including within cycles.
- Inherited-tag metadata, suggestions, and Untagged Notes use the same computed tags. Ontology inference continues to run per note after inheritance.
- Updates are maintained in memory on edits, tag changes, moves, deletion, and restoration; collapse/expand does not rebuild tag inheritance.
