# Persistent AI Tag Proposals

## Objective

Add persistent, per-note AI tag proposals without changing the existing `notes.tags`
column or tag/search syntax. Proposals are unresolved suggestions: they are shown
separately from accepted tags and can be accepted or rejected, but they participate
in search, inheritance, ontology inference, autocomplete, and the Untagged Notes
view immediately.

The first implementation uses a deterministic **Make pseudo-suggestions** action.
No LLM integration is included yet.

## Settled Semantics

- Keep `notes.tags` unchanged.
- Add `notes.proposed_tags` as a second tag-bar-style `TEXT` value.
- In encrypted namespaces, proposals receive the same authenticated-encryption
  treatment as accepted tags.
- A proposal is not an accepted tag and must never trigger normal tag-driven note
  formatting or commands before acceptance.
- For search, proposals are another effective-tag source, analogous to inherited
  accepted tags.
- A note's effective searchable tag set contains:
  1. its own accepted tags;
  2. inherited non-meta accepted tags;
  3. its own proposed tags;
  4. inherited non-meta proposed tags; and
  5. ontology terms inferred from the combined sources.
- Children inherit proposals from ancestors under the same non-meta inheritance
  rule as accepted tags. Proposed `@...` tags do not inherit.
- Ontology rules apply to proposals. Changing ontology rules recomputes proposal
  search effects from current state.
- Positive, negative, conjunctive, and `OR` searches treat effective proposed tags
  exactly like the corresponding effective accepted tags.
- A note with any effective non-meta accepted or proposed tag does not appear in
  Untagged Notes.
- Search autocomplete can expose raw proposed terms and ontology-derived terms, so
  obscure proposals remain discoverable.
- AI-facing note evidence includes each note's direct proposals in a field distinct
  from accepted tags.
- Only proposals attached directly to a note are displayed as actionable proposals
  on that note. Inherited proposals affect search but do not appear as child actions.
- Accepting a proposal adds it through the ordinary accepted-tag mutation rules and
  removes the proposal only after the accepted-tag write succeeds.
- Rejecting a proposal removes the persisted proposal. No rejection tombstone is
  retained, so a future generation pass may propose it again.
- Generation, acceptance, and rejection are undoable tag-source transitions. Undoing
  acceptance restores the proposal and removes its accepted form; redo reapplies the
  acceptance without losing either source state.
- Repeated generation merges with existing proposals, deduplicates
  case-equivalent entries, and omits proposals already satisfied by the note's
  effective accepted tags.
- Proposal counts count unresolved proposal records at their originating notes;
  they are not multiplied by inheritance or ontology expansion.
- Notes and proposals persist across reloads and server restarts.
- Copying, duplicating, and pasting notes preserves each copied note's direct
  proposals.

## Scope Boundaries

### Included

- Persistent storage, encryption, hydration, caching, and mutation of proposals.
- Effective-tag computation shared by search, autocomplete, and Untagged Notes.
- A separate proposal row beneath the accepted tag bar on the actively edited note.
- Per-proposal accept (`+`) and reject (`-`) controls.
- Robot/count indicators in the visible note tree.
- Deterministic pseudo-proposal generation from the edited note's context menu.
- Proposal-preserving note copy, paste, duplication, and AI evidence serialization.
- Focused automated coverage and a human test matrix.
- Documentation updates for the database, in-memory store, tag UI, and search.

### Not included

- Calling an LLM or defining prompts/model policy.
- `~tag`, `=tag`, or any other new tag/search syntax.
- Bulk accept/reject operations.
- Confidence scores, explanations, ranking controls, or a review inbox.
- Rejection history or suppression of a proposal across later generation passes.
- Allowing proposed tags to activate formatting, renderers, status controls, or
  other `@...` behavior before acceptance.

## Data Model and Migration

1. Extend `notes` with required/defaulted proposal storage:

   ```sql
   proposed_tags TEXT NOT NULL DEFAULT ''
   proposed_tags_encryption_nonce BLOB
   proposed_tags_encryption_tag BLOB
   ```

2. Add the columns through the existing forward-only live-database schema/migration
   path. Do not enumerate, rewrite, rename, or otherwise modify historical backups.
3. Treat proposal encryption metadata as an all-or-nothing pair and assert that it
   agrees with the namespace encryption state during hydration.
4. Extend password enable/disable and live-database migration flows so proposals are
   encrypted/decrypted alongside `tags`.
5. Ensure newly created notes always receive an explicit empty proposal string and
   matching encryption representation.
6. Keep proposals on the note row so note deletion naturally removes them. Preserve
   proposals when moving a note; recompute the affected subtree's inherited search
   state afterward.
7. Include `proposed_tags` as a required field in internal note duplication and
   clipboard subtree serialization. Copy/paste must preserve every copied note's own
   unresolved proposals. Human-readable HTML/plain-text exports remain based on
   accepted note presentation and do not render proposal controls.

## Canonical Proposal Representation

1. Store `proposed_tags` as a normalized, whitespace-separated string of ordinary
   tag tokens, parallel to the accepted tag string.
2. Reuse the existing tag tokenizer and token rules. Do not create a second proposal
   grammar or duplicate tag validation logic.
3. Generated proposals must each be exactly one complete tag token. Comments,
   wrappers containing multiple tags, reserved `OR`, and malformed tokens are
   invalid generator output and must fail loudly.
4. Keep accepted and proposed strings independent even when deriving a combined
   effective search set.
5. Deduplicate proposals case-insensitively while preserving a deterministic display
   spelling and order.

## Backend Architecture

### Hydration and Note Store

1. Extend note-row deserialization, the decrypted content cache, and `NoteRecord`
   with required `proposed_tags` data.
2. Hydrate accepted and proposed strings together for both plaintext and encrypted
   namespaces before publishing the completed in-memory store.
3. Derive separate raw term sets for accepted and proposed tags, then combine them
   only at the effective-search layer.
4. Rebuild effective proposal inheritance for startup, note moves, accepted-tag
   changes, proposal changes, and ontology changes without runtime database reads.
5. Preserve fail-fast invariants: incomplete encryption metadata, absent required
   fields, unknown note IDs, or cache/store disagreement must raise immediately.

### Search and Autocomplete

1. Give the search index the combined effective searchable terms while retaining
   source-specific raw terms where autocomplete/counting needs them.
2. Apply ontology inference after accepted and proposed inheritance have been
   combined, so matcher/context rules see the same effective tag context.
3. Verify proposals in every Boolean search position:
   - required tag;
   - forbidden tag;
   - conjunction with accepted/inherited tags;
   - each side of `OR`;
   - ontology-implied target; and
   - ontology-equivalent spelling.
4. Include proposed terms in autocomplete's candidate universe. Keep the existing
   prefix, case-collapse, and ontology-collapse behavior; do not invent a proposal
   prefix or special search mode.
5. Count proposals as non-meta effective tags for Untagged Notes, including inherited
   proposals and ontology terms inferred from proposals.
6. Confirm that accepted-only consumers such as formatting and tag-driven commands
   continue reading `tags`, not the combined effective search source.

### Proposal Mutations

1. Add narrowly scoped operations to generate, accept, and reject proposals for one
   exact note ID.
2. Generation uses a fixed deterministic pseudo-proposal set suitable for manually
   configuring ontology rules and repeating tests. Repeated invocation merges rather
   than replacing unresolved proposals.
3. Acceptance performs one writer transaction that:
   - verifies the proposal exists on that note;
   - adds it using the existing accepted-tag normalization/deduplication rules;
   - removes it from `proposed_tags`;
   - updates encryption metadata while preserving the existing tag-only
     `updated_at` semantics; and
   - updates the cache, note store, search index, and affected descendant subtree.
4. Rejection performs one writer transaction that verifies and removes only that
   proposal, then updates in-memory projections.
5. Do not catch or downgrade unexpected write, cache, contract, or indexing errors.
   A failed invariant is a server error to diagnose, not a recoverable UI state.

### AI-Facing Evidence

1. Extend frozen agent scope records and read-only agent tool payloads with direct
   `proposed_tags`, kept distinct from accepted `tags`.
2. Include proposals in evidence token estimation and serialization so model context
   budgeting accounts for them.
3. Preserve privacy filtering and `@password` redaction rules; proposals never bypass
   the existing note evidence boundary.
4. Expose direct proposals, not inherited or ontology-expanded duplicates—the model
   can distinguish stored suggestions from computed search effects.

## API and Snapshot Contract

1. Add explicit request/response contracts for proposal mutations; required fields
   remain required.
2. Include each delivered note's own proposal list/string in the differential view
   payload.
3. Include proposal state in the note snapshot hash so proposal-only changes produce
   note payload updates.
4. Project robot counts from current note/store state during snapshot construction:
   - a visible note accounts for its own unresolved proposals;
   - unresolved proposals on descendants hidden by a collapsed branch roll up once
     to the nearest visible collapsed ancestor;
   - visible descendants retain their own indicators;
   - no indicator is emitted for a branch absent from the current view; and
   - counts never include inherited or ontology-expanded terms.
5. Keep structural diff operations independent from proposal count changes unless
   tree structure actually changes.
6. Audit every note creation, hydration, snapshot, and mutation constructor so the
   new required field cannot cause Enter-to-create, note selection, or ordinary save
   requests to return HTTP 500.

## UI Behavior

1. Add **Make pseudo-suggestions** to the context menu only when right-clicking the
   actively edited note. It targets only that exact note.
2. Render an AI-proposal row immediately beneath the ordinary tag bar only while its
   owning note is actively edited and has direct unresolved proposals.
3. Render each direct proposal with clear `+` accept and `-` reject controls.
4. Do not merge inherited proposals into that row and do not display ontology-derived
   terms as additional proposals.
5. Update the proposal row and tree indicators from the authoritative mutation/view
   response; do not optimistically alter accepted tags before success.
6. Render a robot/count indicator on the projected visible note. Clicking it selects
   and opens that note through the ordinary note-selection path.
7. Preserve current keyboard/focus behavior, especially Enter-to-create, Tab between
   content and tags, click-to-select, click-away save, and tag suggestions.
8. Ensure `+` and `-` controls do not accidentally trigger the surrounding note's
   selection, creation, or editing handlers.

## Implementation Sequence

1. **Contract inventory and regression tests**
   - Identify all note-row, cache, record, snapshot, encryption, copy, and save paths.
   - Add baseline tests proving create, click/view, content save, and tag save work
     before proposal behavior is introduced.
2. **Schema and encryption**
   - Add columns, migration assertions, encryption lifecycle support, and round-trip
     tests for plaintext and encrypted namespaces.
3. **In-memory source model**
   - Hydrate/store raw proposal terms and implement combined effective-tag inheritance.
4. **Search behavior**
   - Integrate combined terms with ontology, Boolean matching, autocomplete, and
     Untagged Notes.
5. **Mutation API and pseudo generator**
   - Implement deterministic generation plus atomic accept/reject operations.
6. **Snapshot projection**
   - Add proposal payloads, proposal-aware hashes, and fresh visible robot counts.
7. **UI**
   - Add the context-menu action, proposal row, controls, indicators, and interaction
     isolation.
8. **Regression and documentation pass**
   - Run focused suites, then the full test suite; update relevant docs after behavior
     is stable.

## Automated Test Matrix

### Storage and Security

- Existing DB gains empty required proposal storage without modifying accepted tags.
- New note round-trips empty proposals in plaintext and encrypted namespaces.
- Generated proposals survive reload/hydration and remain absent from plaintext DB
  inspection when encryption is enabled.
- Enabling/disabling a password transforms live proposal storage correctly.
- Incomplete proposal encryption metadata crashes hydration.
- Backup creation/restore includes the live schema while historical backup files stay
  byte-for-byte untouched.

### Search Semantics

- Own proposal matches direct search.
- Parent proposal matches child search; sibling/unrelated notes do not inherit it.
- Proposed meta tag does not inherit or activate formatting.
- Proposal implication chain and equality rules match the same notes as accepted tags.
- Ontology changes update results without rewriting proposals.
- Accepted tag plus proposed tag satisfies conjunction.
- Forbidden proposed tag excludes the note from its clause.
- `OR` clauses behave normally with proposals.
- A proposal and its inherited/ontology effects exclude affected notes from Untagged
  Notes.
- Rejecting removes all direct, inherited, and inferred search effects.
- Accepting preserves search results while changing the source from proposed to
  accepted.
- Moving a proposed-tag ancestor recomputes old and new descendant results.

### Counts and UI Projection

- Direct proposal count appears on its visible owner.
- Multiple proposals count individually; inferred tags do not increase the count.
- Expanded descendants retain their own indicators.
- Collapsed descendants roll up exactly once to the nearest visible collapsed
  ancestor.
- Branches outside the current view emit no indicator.
- Proposal row shows only the edited note's direct proposals.
- Indicator click follows normal selection/open behavior.
- Accept/reject clicks do not invoke surrounding note handlers.
- Repeated pseudo-generation is deterministic and deduplicated.
- Undo/redo across generation and multiple accept/reject actions restores each
  intermediate proposal count and finishes with the exact persisted source state.
- Copy/paste and internal duplication preserve direct proposals throughout a subtree.
- AI scope/tool payloads expose direct proposals separately from accepted tags.

### Critical Regressions

- Pressing Enter creates a new top note without an HTTP 500.
- Clicking an ordinary note selects it without an HTTP 500.
- Editing and saving content without changing tags succeeds.
- Editing and saving accepted tags succeeds.
- Creating, moving, collapsing, expanding, deleting, copying, undoing, and redoing
  notes preserve existing behavior.
- A namespace with no proposals behaves identically to the current application.

## Human Verification

1. Start with a note that has an accepted tag, enter edit mode, and invoke **Make
   pseudo-suggestions**.
2. Reload the app and verify proposals and robot counts persist.
3. Search one raw proposal, a term it implies, a conjunction with the accepted tag,
   and a negative form.
4. Add a child and verify it inherits the parent's proposal for search without showing
   the parent's proposal as its own action.
5. Collapse the parent and verify hidden descendant proposal counts roll up once.
6. Accept one proposal and verify it moves into the ordinary tag bar while search
   results remain stable.
7. Reject another and verify all of its search effects disappear.
8. Open Untagged Notes and verify accepted or proposed effective tags both exclude a
   note.
9. Exercise Enter-to-create, ordinary note clicking, content save, tag save, Tab focus,
   move, collapse, undo, and redo before considering the feature ready.
10. Copy and paste a proposed-tag subtree and verify proposals survive on the pasted
    notes; inspect an AI-facing note request and verify proposals are disclosed in a
    distinct field.

## Completion Criteria

- All automated tests pass.
- The human verification matrix passes without HTTP 500s or interaction regressions.
- No existing tag/search syntax changes are present.
- `notes.tags` remains unchanged and proposals remain a distinct persistent source.
- Encrypted namespaces never persist proposal plaintext.
- Relevant Markdown documentation reflects the final implementation.
- No commit occurs until the user confirms the feature was tested successfully.
