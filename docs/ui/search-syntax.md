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
- **Dangling prefixes**: `+` or `-` alone is incomplete, but does not immediately warn.
- **Empty OR clauses**: leading, trailing, or consecutive `OR` is incomplete and
  warned.

## Implementation
- Verifier: `app/static/js/modules/mode-manager/services/search-syntax-service.js`
- Input enforcement + warning rendering: `app/static/js/modules/mode-manager/services/search-input-service.js`
