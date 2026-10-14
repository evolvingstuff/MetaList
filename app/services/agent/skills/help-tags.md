# Tags and ontology

Use this reference to explain MetaList accurately. It describes user capabilities,
not permission or tools for you to execute every operation. You can answer and
request one supported menu/dialog opening. You cannot submit a form, change
settings, run a shell command, or mutate notes through this help response. Do not
claim that you inspected current notes or settings: none are supplied here.
Prefer user-facing steps over implementation details. If the reference does not
answer a question, say what is unknown; do not invent syntax or controls.

Sources: docs/ui/tag-bar.md, docs/design/ontology-rules-v1.md

# Tag Bar

## Overview
- Each note has a tag string (`notes.tags`) that round-trips through the view snapshot (`snapshot.notes[*].tags`).
- The tag bar editor enforces a small grammar in the browser so invalid characters/sequences are removed as you type.
- When leaving the tag bar (Tab toggle or click-away) the input is **sanitized**: incomplete/broken items are removed.
- Pasting (never typing) dictated text into the tag bar turns it into tags ("neural network at to do" gives `neural-network @todo`). The full rules are in the dictation help topic.
- When tags are shown in the note list, one line of tags shares the note's existing row height; the row grows only when its tags wrap onto additional lines.

## Whitespace + Tokens
- Outside of `/* ... */` comments, tags are separated by whitespace.
- Double-click selects an entire tag, including `@`, connectors such as `-`, `_`, `.`, `/`, and assignment values such as `@size=2.0`. Inside a scoped wrapper, it selects the individual tag without the wrapper. Comments retain ordinary word selection. The search input uses the same interaction with its own query grammar.
- Runs of whitespace are normalized to single spaces.
- Wrapper tokens may contain internal spaces (e.g. `{{@red @monospace}}`), which are preserved (normalized) inside the wrapper. This means a wrapper token can contain multiple tags.
- A normal tag token allows only ASCII-printable characters and disallows: `: , " \\ > < [ ] { } ( ) * | ; ~ ``.
- One `=` is allowed inside regular or meta tags when valid tag characters occur on both sides (for example `abc=xyz` or `@size=2.0`). It cannot appear at the start/end, and multiple `=` characters are removed during normalization.
- Tag tokens also cannot start with `-`, `+`, or `/`.
- Exact uppercase `OR` is reserved as the search disjunction operator and cannot
  be saved as a tag, including inside a wrapper. Lowercase `or` and mixed-case
  variants remain valid tags.

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
  - `@username` renders a view-only "Username:" row with a copyable value.
  - `@password` renders a view-only "Password:" row with a blurred, copyable value.
- Email meta tags:
  - `@email` renders a view-only "Email:" row with a mailto link.
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
- Chess meta tags:
  - `@chess` draws the note's FEN chess position as a board (White at the bottom, with a caption for side to move, move number, castling and en passant); an invalid FEN shows an error badge saying what to fix.
  - `((@chess))` draws a board for only the wrapped FEN, inside the surrounding text.
- Diff meta tags:
  - `@diff` colours a unified diff (git diff / diff -u): added lines green, removed red, `@@` section starts and file headers marked; `((@diff))` colours only the wrapped content.
- Mermaid meta tags:
  - `@mermaid` draws the note content as one Mermaid diagram (no Markdown fence needed); `((@mermaid))` draws only the wrapped content.
- Pasting JSON, a chess FEN, a unified diff, Mermaid or a pure LaTeX block adds the matching tag at once (`@json`, `@chess`, `@diff`, `@mermaid`, `@LaTeX`): the plain tag into an otherwise empty note, `((...))` and `((@json))` into a note with content. ⌘Z right after removes it with the paste; ⇧⌘V pastes without detection.
- Code meta tags:
  - `@code=<language>` (for example `@code=python`, `@code=sql`) highlights source code; any language name the highlighter knows works, and an unknown one shows an "Unknown language" badge; `((@code=python))` highlights only the wrapped content.

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
- The tag bar keeps a muted tag icon inside the input before and during typing; hovering the field shows a `Tags` tooltip.
- While typing inside a tag token, matching is segment-aware for connector-separated tags: a prefix can match the start of the whole tag or the start of any connector-separated segment (`-`, `_`, `.`, `/`). Example: `wor` suggests both `workspaces` and `databricks-workspaces`, while `orksp` suggests neither.
- The active typed prefix and note content provide complementary literal evidence. Once a prefix identifies a connector-separated segment, the remaining tag segments are matched against the note, so typing `GPT` in content containing `5.6 sol` promotes `GPT-5.6-sol` over more frequently used `GPT-*` tags.
- Typing one letter narrows the suggestions you saw before typing instead of reordering them: those with evidence for the note (named in it, going with its tags, from its place in the tree) keep their order, minus the ones not starting with that letter. Then come matching tags the note already has through inheritance or tag rules, so you can still write one explicitly, then every other matching tag by how often it is used.
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
- A web address in the note's text counts only by its site's name: `https://www.youtube.com/watch?v=GYx4…` reads as `youtube`, so it can name a `YouTube` tag but not `HTTPS`, `V-neuron` or `indeed.com`. The scheme, `www`/`m`, the top-level domain (and `co.uk`-style suffixes), the path and the query are dropped; an IP address has no name. Only addresses with a scheme or a leading `www.` count as addresses: `indeed.com` written in prose still names the tag.
- When content-hit strength ties, more structured/specific tags rank ahead of broader/common ones. Mixed-case tags, digit-bearing tags, connector-separated tags, and prefix-aligned segment matches beat looser matches; usage frequency then breaks structurally equal ties before content position, raw tag length, or alphabetical ordering.
- Surrounding prose punctuation is ignored for content matching, so content like `(github?)` still promotes the `github` tag.
- Possessive words also match the base tag: `Julie's birthday is today...` promotes the existing `Julie` tag. Straight and curly apostrophes are equivalent, and full tags containing apostrophes (such as `goat's-milk`) still match normally.
- Case-equivalent tags are collapsed in suggestions (for example `Databricks` vs `databricks`), and the most-used spelling is shown.
- Ontology-equivalent tags are usually collapsed to one displayed suggestion. The representative is the most-used eligible tag spelling explicitly written in tag bars, not the ontology-inferred search frequency, but prefix filtering happens first, so typing `emo` can still show `emotion` even if `mood` is the more common synonym overall. If the current note content exactly matches a synonym alias, that alias can still appear immediately after the common representative within the interleaved content/co-occurrence ordering.
- Tags declared in ontology rules remain eligible for literal-content matching and typed-prefix completion even when they have never been explicitly assigned to a note. With a blank prefix, unrelated unused ontology tags are not added as generic fallback suggestions.
- Tags already present explicitly in the current tag bar are never suggested.
- Tags already present only via inheritance or ontology inference are suppressed unless they match the prefix. For one-character prefixes they come right after the suggestions with evidence; for longer prefixes they appear at the bottom. The **Tag Suggestions** settings dialog has `Allow suggesting tags that already apply` (off by default): when on, tags a parent already has and tags the rules imply from them are ranked like any other tag. Tags written in the note's own bar are still never suggested.
- Right-clicking a suggestion (Control-click on a Mac) opens the tag menu for it: Edit Tag Relationships, then **Why suggested** below it. The list, the typed letters and edit mode stay as they were; `Escape` closes only the menu.
- **Why suggested** says what the ranking found, then how often the tag is used: named (or partly named) in the note's text, a synonym named in it, the rest of the tag after what was typed, on N notes together with the note's tags, named in the note as last saved, on N notes that share the note's tags, or already applying through a parent or a rule. `Listed by use` means the ranking found no evidence in this note, so it is listed because it is used often; `Part of its name is in this note's text` then shows the words that are there but too few to count. The reasons are MetaList's own ranking, not the AI's.
- Suggestions appear below the tag bar when there is room; if the tag bar is near the bottom, the list flips upward but keeps the same best-on-top ordering and initial scroll position.
- The server returns at most `MAX_TAG_SUGGESTIONS` note tag suggestions; the default is 20.

## About This Tag
- Right-clicking a tag already in the tag bar opens its menu with **About this tag** below Edit Tag Relationships (facts, since it may never have been suggested): whether the note's text names it, how many other notes have it together with this note's other tags, whether a parent or a rule already gives it (writing it repeats that), its synonyms and what it implies, and how many notes have it. `Only on this note` can mean a typo or a one-off tag; `Not on any saved note yet` means it was just typed.

## AI Tag Proposals

- Unresolved proposals are stored separately from accepted tags. They affect inheritance, ontology-aware search/autocomplete, and Untagged Notes immediately, but do not activate formatting or tag commands.
- Direct proposals appear beneath the tag bar only while their note is edited. `+` accepts a proposal into the ordinary tag bar; `−` rejects it.
- Individual proposal accept/reject controls participate in normal undo/redo; undoing an individual acceptance restores its proposal and robot count, while redo accepts it again. This does not define undo behavior for bulk operations.
- The robot count marks unresolved proposals on visible notes. A collapsed note rolls up proposals hidden in its descendant branch; inherited and ontology-derived terms do not inflate the count.
- Copy/paste and duplication preserve each note's direct unresolved proposals.
- The connector characters used for content matching are configurable via `TAG_SUGGESTION_CONNECTORS` in `app/config.py`.
- The redundant-content suppression rule is configurable via `TAG_SUGGESTION_SUPPRESS_REDUNDANT_CONTENT_VARIANTS` in `app/config.py`.

### Bulk proposal operations

Chat-requested LLM generation and menu/chat bulk acceptance or rejection use a separate atomic path from the individual proposal controls above. See [agent tagging](../design/agent-harness.md#tag-proposal-operations).

- Bulk operations are outside ordinary undo/redo, even when applied atomically. They create no individual or combined undo entry and expose no bulk Undo control.
- Successful application clears the existing undo and redo stacks using the search-context boundary mechanism. Failure, cancellation, or decline preserves the stacks. A result with no changes preserves history.
- Bulk acceptance/removal is an explicit scoped operation, not reversal of a particular generation pass. It can affect older pending proposals as well.
- Individual proposal controls retain their existing undo behavior. See [undo/redo scope](state-handling.md#undoredo-with-context-boundaries).

## Focus / Tab Behavior
- `Tab` toggles focus between the note content and the tag bar.
- Clicking the visible tag bar while editing focuses the tag input directly instead of treating the click as a note-shell selection.
- The tag bar expands into view when note editing starts and contracts out of view when editing ends, unless `Animated transitions` is off in the command palette.
- When leaving the tag bar (Tab or click-away), the tag string is sanitized so only valid, fully-formed tokens/comments remain.
- While the single-note tag bar is focused, note-level edit shortcuts still target the current note, including create sibling/child, delete, move up/down, move to top, indent/outdent, split, unformat, and note copy/cut/paste.
- `Cmd/Ctrl+U` removes formatting and inline imagery from the selected range, or from the entire note when no range is selected. Range removal deletes intersecting inline images and rewrites scoped delimiters around the selection so formatting outside it remains; whole-note removal removes rich HTML, all inline images, and Add Style tags while preserving links and semantic tags such as `@todo`.

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


# Ontology Rules (v1)

Status: DB-backed (SQLite) and hot-editable via API/UI; rules are cached in memory.

## Scope

This document describes the ontology rule language currently implemented in:
- `app/services/tag_ontology.py`

Rules are stored in:
- SQLite `ontology_rules` table (loaded at startup into memory; edits update cache)

## Syntax

One rule per non-empty, non-comment line.

Operators:
- Implication: `LHS => RHS`
- Equality: `LHS = RHS` (syntactic sugar for `LHS => RHS` and `RHS => LHS`)

Comments:
- Blank lines are ignored
- Whole-line comments are ignored when they start with `#` or `//`
- Inline comments are not supported in v1

### Tags

- Tags are plain tokens (no special prefix required).
- `#` is allowed in tag tokens.
- Tags must be a single token with no spaces.
- Exact uppercase `OR` is reserved by search and is not a valid ontology tag;
  lowercase and mixed-case variants remain valid.

### LHS forms

LHS can be either:
- A single atom: `foo => bar`
- A conjunction group: `(atom atom atom) => bar`
  - Nested parentheses are not allowed in v1.

### Atoms

Allowed atoms on the LHS:

1) Tag atom

```
foo
```

2) Text atom (quoted)

```
"some phrase"
'some phrase'
```

3) Regex atom

```
/.../
/.../i
```

Regex notes:
- `/.../i` is case-insensitive.
- Escaping a literal slash inside the pattern uses `\/`.

## Semantics

Rules are applied per note as a monotone fixed point:
- Start with a set of tags.
- Repeatedly apply rules, only adding tags.
- Stop when no new tags are produced.

### Text atom semantics (word-boundary sugar)

Quoted text atoms are compiled as whole-word matches using `\b` boundaries.

- If the phrase is all-lowercase, it is treated as case-insensitive:
  - `"todo"` behaves like `/\btodo\b/i`
- Otherwise it is treated as case-sensitive:
  - `"TODO"` behaves like `/\bTODO\b/`
  - `"Todo"` behaves like `/\bTodo\b/`

This prevents accidental substring matches (e.g. `"TODO"` does not match `TODORS`).

## Testing

- Unit tests: `tests/unit/test_ontology_rules_store_sqlite.py`

## UI Interaction Spec (v1)

This section defines the initial UI interaction model for exploring and editing ontology rules.

### Concepts

- **Focus tag**: the tag currently centered in the UI.
- **Selected rule**: the rule currently shown in the center editor.

### Columns

- **Left column (incoming, direct-only)**
  - Direct tag implications: tags `A` where `A => focusTag`, excluding tags already in the focus SCC (synonyms).
  - Direct derivation rules: rules with `RHS == focusTag` where the LHS is not a single tag.
    - Display only the LHS expression (RHS is redundant with the current focus).
- **Center column (focus + editor)**
  - Default: focus tag view (including equal/SCC members).
  - When a rule is selected: show the full rule and editing controls.
  - Editing only happens in the center column.
- **Right column (outgoing, direct-only)**
  - Only direct tag implications: tags `B` where `focusTag => B`.
  - Rules never appear in the right column in v1.

### Click behavior

Rule rows in the left column are clickable as a whole:
- Clicking the row (background/parentheses/whitespace) selects the rule for editing in the center.

Tag atoms inside rule rows are styled as chips and are clickable:
- Clicking a tag chip changes the focus tag to that tag.
- Clicking a tag chip must not also select the rule.

Text/regex atoms are styled but not clickable.

Implementation note (DOM):
- Rule row has an onClick handler for selecting the rule.
- Tag chips have their own onClick handler and call `event.stopPropagation()` to prevent the row click.

### Tag search

- An empty search loads only the namespace-wide distinct-tag count; it does not materialize thousands of hidden suggestion rows. Typing opens a capped dropdown sorted by prefix, substring, fuzzy match, then frequency.
- The footer reports the distinct catalog size as **N total unique tags** (explicit note tags plus tags referenced by ontology rules) and does not claim that every catalog entry is visible.
- The dropdown is anchored to the search input, not the adjacent **Add new tag…** action, and keeps compact suggestion rows over the columns.
- While typing, results prioritize **prefix matches**, then substring matches, then fuzzy (subsequence) matches.
- Each suggestion shows a count badge with the number of notes containing that tag.
- Arrow keys move selection (first item is selected by default); `Enter` applies the selected suggestion, fills the input, and blurs the field.

### Relationship dialogs

- The add/edit dialogs for implications, synonyms, incoming conditions, and tags keep their visible submit button.
- **Add new tag…** presents only the tag input and actions; it omits redundant introductory copy and a redundant field label.
- Editing the focused tag supports both rename and **Delete tag…**. Deletion requires a separate confirmation, removes the exact tag token from every note tag bar, and deletes every ontology rule that references the tag. Quoted text and regular-expression matchers with the same characters are not tag references and remain intact.
- Suggestions open without an automatic selection; clicking a row selects it, and one `ArrowDown` selects the first row.
- Search and relationship-dialog inputs explicitly reset inherited modal margins, keeping suggestion panels directly below the field for incoming conditions, implications, synonyms, and edits.
- While a dialog input is focused, `Enter` performs the same submit action as that button when the user has not explicitly navigated to a suggestion.
- Arrow-key navigation marks the highlighted suggestion as explicit; the next `Enter` fills the input with that suggestion without submitting the relationship.
- Clicking a suggestion fills the input without submitting it and preserves that selection boundary for the next `Enter`.

### UI Mock

![Ontology UI mock](../tag-ui.jpg)
