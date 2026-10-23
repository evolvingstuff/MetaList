# Tag Properties

Status: design, not built. Settled in a brainstorm on 2026-10-23. Items marked
**Proposed** are smaller details suggested while writing this down; confirm them
before building.

## Goal

Let a tag carry structured values (`jogging:miles=3:duration=30`), searchable with
comparisons (`jogging:miles>2`) and usable in ontology rules
(`jogging:miles>10 => long-run`). This is groundwork: totals, charts and other
aggregation come later, once real use shows what is needed.

Like Tana's fields, but with no schema to declare first: a property exists as soon
as a note uses it. Two things make it more than Tana's fields:

- **Upward search.** Properties are read through the implication graph:
  `exercise:miles>2` finds `jogging:miles=3` because `jogging => exercise`. Ask at
  any level of abstraction and find every specific instance.
- **Rules over values.** Ontology rules can infer tags from property values.

## Model

Everything is a triple on a note: *tag*, *property*, *value*.

- `jogging:miles=3` on a note: the tag `jogging` with property `miles` = `3`.
- `jogging=3` is the existing `tag=value` form; it reads as `jogging`'s implicit
  property `value` (`jogging:value=3`). Today's valued tags (`priority=high`) keep
  working unchanged and become a special case of the model.
- A note carries each tag at most once, so a tag's properties all live in one token.
- Values belong to the note they are written on. Child notes and notes referencing
  it inherit the **tag** (as non-meta tags inherit today), never its **values**.
  Otherwise a child of a 3-mile run would itself match `jogging:miles>2`, and any
  later totals would count those miles twice.

## Syntax in the tag bar

```
jogging:miles=3
jogging:miles=3:duration=30
run:start=10:30:miles=3
meeting:at=2026-10-23T10:30:room=b2
book:author=Ursula-Le-Guin
```

- The tag is everything before the first `:`. It follows today's tag grammar.
- After it, each property is `name=value`, introduced by `:`.
- **Property names start with a letter.** Then they follow tag characters.
- **A colon followed by a letter starts the next property. Any other colon belongs to
  the value.** This is what lets values hold times and date-times: in
  `run:start=10:30:miles=3`, `10:30` is the start and `miles` the next property.
  `https://…` stays inside a value too (the colon is followed by `/`).
- Values have no spaces (tags never do): `author=Ursula-Le-Guin`.
- A value cannot contain a colon followed by a letter (`ref=abc:def` would split).
  Accepted as rare.
- Each property appears at most once per token. The tag bar removes a repeated one
  while typing, as it removes a second `=` today. Properties keep the order typed;
  nothing sorts them.
- `jogging=3:miles=3` (implicit value plus named properties) is allowed but unusual:
  suggestions never offer this form.
- `>` and `<` stay forbidden in tags; only search uses them.

**Proposed:**
- A second token for a tag already on the note (`jogging` beside
  `jogging:miles=3`) is refused, with the reason in a tooltip, rather than merged.
- Properties apply to regular tags only. Meta tags (`@size=2`, `@code=python`) keep
  their single value and gain no named properties.
- Property tokens inside scoped wrappers (`{{jogging:miles=3}}`) are not allowed.
- Property names match with the same case rule as tag names in search.

## Types

A value is read as the first type it parses as:

| Type | Written | Compares |
|---|---|---|
| Number | `3`, `3.5`, `-2`, `1500` | numerically (`3` = `3.0`) |
| Date | `2026`, `2026-10`, `2026-10-23` | by its first day: `2026-10` is 2026-10-01 |
| Date-time | `2026-10-23T10:30`, `2026-10-23T10:30:15` | by the moment |
| Time **(Proposed)** | `10:30`, `10:30:15` | by time of day |
| Text | anything else | case-insensitively, alphabetically |

- **Mixed types are skipped, not errors.** A comparison applies only to values of its
  own type: `jogging:miles>2` ignores a note with `miles=far`. Keeping one property
  to one type is the user's convention.
- **Units are the user's convention.** The name says the unit:
  `swimming:meters=1500`, `jogging:miles=3`. A vague name like `distance` is
  allowed; MetaList does not stop anyone from mixing meters and miles in it.

## Search

```
jogging:miles>2
jogging:miles>2 jogging:duration<40
exercise:miles>=3 date>=2024-01
jogging:miles?
jogging:miles
-jogging:miles>10
```

- One property per term. Operators: `=`, `>`, `<`, `>=`, `<=`. Terms combine as
  today: space is AND, `OR` separates clauses, `-` excludes.
- Since a note has each tag once, `jogging:miles>2 jogging:duration<40` means the
  same note satisfies both, so search needs no chained conditions in one term.
- `jogging:miles?` finds notes **missing** the property: notes with `jogging` but no
  `miles`. It is for auditing incomplete data.
- **Proposed:** `jogging:miles` with no operator finds notes that have the property
  with any value. This replaces the outline's `jogging:miles=?`.
- **A plain tag finds its property tokens.** `jogging` finds a note tagged only
  `jogging:miles=3`, as `priority` finds `priority=high` today.
- `date>=2024-01` is the implicit `value`: `date:value>=2024-01`.

### Upward search through implications

A note matches `T:p op v` when one of its own property tokens `S:p=w` has `S = T`,
or `S` implying `T` through the ontology (any chain, synonyms included), and `w op v`
holds for `w`'s type.

- `exercise:miles>2` finds `jogging:miles=3` (`jogging => exercise`) and
  `trail-run:miles=5` (`trail-run => jogging => exercise`).
- **Any value matching is enough.** A note with `jogging:miles=1 cycling:miles=10`
  matches both `exercise:miles>2` and `exercise:miles<2`. That is correct by these
  rules; giving each activity its own note avoids it.
- `exercise:miles?` finds notes whose tags imply `exercise` and none of which has
  `miles`.
- **Proposed:** `?` looks only at notes that carry the tag themselves, or carry a tag
  implying it. Not at notes that inherit it from a parent: every child of a run
  would otherwise be reported as missing its miles.

### Known gotchas (accepted)

- **Names drift.** In March `jogging:miles=3`, in June `cycling:distance=12`:
  `exercise:miles>2` misses the ride. Suggestions are the defence (below); renaming
  properties and property synonyms come later.
- **Units clash** in a vaguely named property, as above.

## Suggestions

Suggestions are what keep names and units consistent. They show you what you used
before, so you write `miles` again rather than `distance`.

- **Tag bar:** after `jogging:`, suggest the property names used with `jogging` and
  with the tags `jogging` implies (`exercise`), most used first. This is the downward
  inheritance from the original outline ("`exercise` has `duration`, `jogging =>
  exercise`, so `jogging` can have `duration`"): with no declared schema, its use is
  suggestions.
- **Search box:** after `exercise:`, also suggest property names used with tags that
  imply `exercise` (`jogging`'s `miles`), since upward search finds those.
- Never suggest the `jogging=3:miles=3` form.
- **Proposed:** after `miles=`, suggest nothing at first. Value suggestions can come
  later if they turn out to help.
- Activity credit (search suggestion statistics) goes to the tag, as today, never to
  properties.

## Ontology rules

Property atoms on the left-hand side, with the search operators:

```
jogging:miles>10 => long-run
(jogging:miles>=26.2 race) => marathon
exercise:duration>60 => long-workout
```

- Upward matching applies as in search: `exercise:duration>60` matches
  `swimming:duration=75`.
- An inferred tag is a plain tag; rules do not create values.
- **Later:** setting a value on the right-hand side
  (`marathon => jogging:miles=26.2`).

## Renaming and deleting

- **Renaming a tag** (Edit Tag Relationships) rewrites the tag part of its property
  tokens: `jogging:miles=3` becomes `running:miles=3`.
- **Deleting a tag** removes its whole tokens, properties included.
- **Later:** renaming a property (`jogging:mi` → `jogging:miles` across notes) and
  property synonyms in the ontology.

## Display

- The tag bar and the note list show the raw token: `jogging:miles=3:duration=30`.
  No grouping or pretty form.

## Storage and compatibility

- Properties live in the note's tag string (`notes.tags`), stored and encrypted as
  tags are today. **No database schema change**, so no `CURRENT_DATABASE_VERSION`
  bump and no encryption-audit change.
- Older MetaList versions forbid `:` in tags and would strip it when editing such a
  tag bar. Nobody runs older versions, so this is accepted.

## Where it touches the code

- **Tag grammar:** the tag-bar tokenizer and sanitizer in the browser
  (`tag-syntax-service.js` and related), and the server's tag tokenization. Today `:`
  is forbidden and only one `=` is allowed.
- **Search syntax verifier** (client, `docs/ui/search-syntax.md`): property terms,
  comparison operators, `?`.
- **Search parsing and semantics** (`parse_search_query`, `SearchIndex`): property
  postings by tag and property, typed values, upward matching through the ontology
  closure, the plain-tag match for property tokens.
- **Suggestions:** `SearchIndex.suggest_tag_completions` and the tag-bar suggestions,
  for property names.
- **Ontology rules** (`app/services/tag_ontology.py`): property atoms on the LHS.
- **Rename and delete** (`app/services/tag_rename.py`).
- **Other tag paths that must accept or ignore the form:** Add as Tag from a selection,
  dictation paste cleanup in the search box, new notes created from a search (they
  copy its positive tags, which should not include comparison terms), tag counts.
- **Docs and AI help:** `search-semantics.md`, `search-syntax.md`, `tag-bar.md`,
  `ontology-rules-v1.md`, and the help skills (`help-search.md`, `help-tags.md`,
  `help-ontology.md`).

## Build order (Proposed)

1. Tag grammar: accept and normalize property tokens in the tag bar and on the
   server.
2. Search: property terms, types and operators, `?` and bare-name terms, the
   plain-tag match.
3. Upward search through implications.
4. Suggestions for property names.
5. Ontology rule atoms.
6. Rename and delete.

Each step usable on its own, tried before the next.

## Later

- Renaming properties; property synonyms in the ontology.
- Totals, averages and sorting by a property (for example "miles this month" beside
  the result count, or Sort by `jogging:miles`).
- Values set by rules.
- Value suggestions.
