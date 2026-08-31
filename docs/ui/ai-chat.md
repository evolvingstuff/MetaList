# AI Chat and Scoped Read-only Agent

## Scope

- MetaList chats with one user-selected Ollama or OpenAI model through an
  authenticated, application-owned agent runtime.
- Every Send freezes the currently displayed MetaList result scope. The agent can
  investigate only matching notes inside that boundary; it cannot run a new
  namespace-wide search or escape to hidden notes.
- The runtime is read-only. It cannot create, edit, move, tag, trash, or delete
  notes.
- Instructor owns structured route/investigation calls. Final natural-language
  prose streams directly from the selected provider; OpenAI requests disable
  provider-side storage.
- While a provider generates, the active eye-mode panel shows an approximate output-token
  count that updates in place with a subtle pulse; completed panels retain the final
  count separately from their input estimate.
- Every generation is bounded over the wire: route selection uses 512 output tokens,
  query requests use 1,024, and final prose uses 1,024 with Ollama and 8,192 with
  OpenAI. If OpenAI reports that this limit
  truncated its output, the run fails visibly instead of presenting partial prose
  as complete.

## Scope at Send

The browser captures one required view descriptor from the active tab:

- normal search, All notes, Untagged notes, or temporary Reference source;
- executed search text;
- sort mode and date filter;
- reference UUIDs where applicable;
- a human-readable scope label.

The server verifies that the descriptor targets the active tab and matches its
canonical search/sort/date state, then resolves actual note membership itself.
The browser never submits a trusted corpus-sized UUID list. Later typing, tab
switches, or reference navigation do not change the running request.

The assistant turn does not repeat this scope above its response. When developer
diagnostics are visible, the scope-freezing activity panel shows the label and
note/tree counts.

With developer diagnostics hidden, an in-progress turn uses one stable
`Working…` row whose dots animate without replacing the label or resizing the
panel. If the evidence limit omits trailing roots, an amber notice appears before
the answer as `Context truncated · using X of Y root notes`; detailed retention
counts remain in Agent Debug.

The same note/tree counts are supplied to the route-selection model before note
content is loaded. Evidence sizing is deferred until the selected action actually
needs saved-note content; evidence panels then report the retained payload and its
approximate token count.

Only true matching nodes become evidence. Ancestors needed to make the result tree
readable appear only as contentless structural objects. Gray/redacted content is
excluded. A protected `@password` note hides itself and its complete descendant
subtree from every model.

Before a cloud scope is frozen, MetaList also applies the namespace's shared cloud
privacy policy. Tag whitelists and blacklists use inherited and ontology-expanded
effective tags; text lists use case-insensitive literal substrings. Entries in a
whitelist are OR, entries in a blacklist are OR, and blacklists win. If any ancestor
is hidden, every descendant is hidden as well. The resulting filtered set—not the
original search set—drives counts, evidence, references, and debug payloads.

## Investigation Behavior

The first structured call chooses:

- `respond` for ordinary conversation/general knowledge that does not require the
  user's saved notes;
- `investigate_current_scope` when the answer depends on evidence in the frozen
  result view.

The routing request also receives a content-free `ACTIVE_METALIST_SCOPE` block
with the exact active user search query, scope label/kind, sort/date state, and
result counts. Explicit saved-note requests cannot validate as a direct `respond`.
Note content enters the model context only after investigation is selected.

An investigation walks matching root trees in visible order and retains the longest
leading prefix of complete trees that fits the selected provider's evidence-token
limit. It then sends that one nested payload directly to final response generation.
There is no second evidence page, working summary, facet selection, tag-narrowing
step, or source-rehydration pass.

Every retained note carries its full disclosure-safe content. If a later root would
overflow the limit, that root and every following root are omitted. The final model
receives exact included/omitted note and root counts and is forbidden from claiming
exhaustive coverage when anything was omitted.

The agent cannot expand beyond the frozen scope, request another evidence payload,
or cite an undisclosed note ID. Those boundaries are enforced programmatically.

## Ordering and Evidence Limit

- Evidence uses MetaList's canonical top-level result-tree order and visible node
  order. SearchIndex membership never becomes ordering.
- Results near the top are generally newer or more highly user-ranked, which is a
  prioritization hint rather than relevance proof.
- MetaList greedily packs complete result trees into one payload. Ollama defaults
  to 5,000 approximate tokens and is configurable from 500–24,000. OpenAI defaults
  to 250,000 and is configurable from 500–500,000. The providers have independent
  settings.
- A root tree is never divided. If the first root alone exceeds the limit, the run
  fails visibly; otherwise the first root that would overflow and all following
  roots are omitted.
- Matching notes are not character-truncated. The evidence limit applies only to
  the complete serialized payload.
- The estimate covers compact serialized JSON, including content, UUIDs, tags,
  timestamps, hierarchy, object keys, and punctuation. The same deterministic
  estimator drives the debug-panel token estimates.
- The payload is a `result_trees` array of root note objects with recursively nested
  `children`, not a flat note list. Content-bearing nodes expose note IDs, content,
  created/updated timestamps, and directly assigned raw tags in tag-bar order.
  Untagged notes omit `tags`; leaf notes omit `children`; parent/root IDs are not
  repeated because nesting already communicates the hierarchy.
  Contentless `is_evidence: false` ancestors preserve paths to nested matches
  without disclosing gray/redacted note information.

The only retrieval control in `AI Agent Settings…` is the provider-specific maximum
approximate evidence-token count.

## Configuration and Managed Ollama

- Open `AI Agent Settings…` from the command palette or chat gear to select an
  installed model, download a named model, and edit the evidence-token limit.
- The same settings modal has one Cloud privacy section shared by all cloud
  providers. Its four one-entry-per-line fields configure whitelisted tags,
  whitelisted text phrases, blacklisted tags, and blacklisted text phrases. Ollama
  ignores these configurable lists; the automatic `@password` boundary still
  applies. The policy is namespace-scoped and is encrypted with client preferences
  when the namespace is password-protected.
- Hovering the AI chat column asks the server to preview that boundary over the
  current note view. Notes the selected provider cannot receive keep readable text
  but receive a gray background until the pointer leaves chat.
- The compact composer controls choose model and Thinking Off/Low/Medium/High.
  Selection persists immediately; GPT-OSS does not offer Thinking Off.
- Selecting OpenAI reveals a compact estimated-spend tracker directly below the
  chat header. Its four token totals are New input, Cached input, Cache writes, and
  Output. Values come from OpenAI's response usage rather than MetaList's prompt
  estimator and update after each completed intermediate or final request. Reset
  returns the process-local aggregate to `$0.00`; clearing chat does not. Nothing
  from this tracker is persisted, and an interrupted request that never returns
  final usage may be absent from the estimate.
- MetaList lazily starts one owned Ollama daemon shared by namespaces at
  `127.0.0.1:11435` with `OLLAMA_CONTEXT_LENGTH=32768`, cloud/history/request-body
  logging disabled, and one parallel request.
- Runtime ownership is coordinated through
  `~/MetaList/runtime/ollama/ollama-runtime.json`; the bounded log is
  `~/MetaList/logs/ollama-managed.log`.
- Every run preloads the selected model, checks `/api/show` and `/api/ps`, records
  maximum/loaded/required context in Agent Debug, and refuses an undersized active
  allocation.

Open `Agent prompts…` to inspect/override packaged prompt Markdown and registered
skills. Skills are collapsed with a disclosure arrow and trigger label. Overrides
are encrypted namespace preferences where applicable and affect the next run.
`Restore packaged defaults` removes all overrides. If an older scoped-skill or
Search-skill override exists, the editor shows an explicit incompatible-contract
notice; it is preserved but never applied until Save or Restore removes it.

## Panel and Cancellation

- `Show/Hide AI Chat` is available in the command palette and notes-view context
  menu. Chat and the right-side activity calendar are mutually exclusive.
- Chat starts at one third of the viewport and narrows the notes area. Dragging its
  separator persists width while retaining at least 280 px for chat and 480 px for
  notes. Composer height also persists.
- The header contains a default-off developer eye toggle, Agent Debug, Clear,
  settings, and close. Eye visibility is namespace-scoped and survives restart.
- With eye mode hidden, an active request still shows one compact Working indicator
  with phase and elapsed time. With eye mode visible, tinted panels report scope,
  model attempts/retries, selected action and reason, retained/omitted root counts,
  the exact evidence payload, and response writing. Logical start/completion events update one
  panel; retries remain separate. Every panel includes approximate input tokens;
  model-generation panels also show approximate output tokens as chunks arrive.
  Every panel shows its own retained duration; the current panel counts live and
  completed durations remain visible after reopening the chat.
- The composer remains editable during generation. Send becomes red Stop and aborts
  browser/server Ollama work. Clear Chat cancels and awaits any active request before
  clearing transcript and latest trace. No status/error line is placed below the
  composer.
- A Thinking disclosure appears only if the model emits real reasoning; Thinking
  Off never shows a fake heading.

## Rendering and References

- Assistant output is rendered as Markdown during streaming. Completed LaTeX and
  fenced Mermaid are supported. Blank lines between ordered-list items produce one
  loose list rather than restarting numbering. Explicit non-one list starts are
  honored, and repeated model-generated section markers are normalized to sequential
  numbering.
- The final model receives exact evidence-note sources with a ready-to-copy
  `[[UUID]]` token beside each source. Every note-derived paragraph or list item is
  prompted to copy the token from the same evidence object that supports its claim.
  Invented, stale, unobserved, and prior-turn references are stripped; the server
  assigns the visible reference numbers programmatically. Tokens are written
  directly after claims without model-generated `Note ID`/`Source` labels.
  Standalone model-generated source bullets and links are removed programmatically;
  any valid citation token on that line is retained on the preceding claim.
- While a response streams, an incomplete trailing `[[UUID]]` token is withheld
  until both closing brackets arrive. It therefore appears atomically as the final
  numbered citation instead of briefly rendering as a note-title mention.
- Inline markers render as clickable superscript `[1]` links. A separate References
  section contains preview-labeled links deduplicated by top-level result tree;
  `Open all references` is available for multiple roots. References are withheld
  until streaming completes, then appear inside a collapsed disclosure. Completion
  scrolls slightly past the answer so the disclosure heading is visible without
  automatically exposing or scrolling through the reference list.
- Root deduplication is presentational only. Each reference retains the exact cited
  child UUIDs as its hidden navigation query. If multiple cited children share a
  root, the query is `UUID1 OR UUID2`; normal search behavior preserves both paths
  and gray-redacts unrelated siblings.
- Individual/all-reference navigation uses the temporary Reference source context,
  leaves the visible search field empty, and provides the dismissible X to return
  to the prior tab context.
- Common UUID dash substitutions are normalized programmatically. UUIDs in fenced
  code/existing links remain literal.
- Right-click a completed answer and choose `Copy Response` to copy Markdown tagged
  `@markdown @llm` into the MetaList note clipboard and rich/plain content onto the
  system clipboard.

## Session and Debug Boundaries

- Transcript/activity state lives only in server memory keyed by authenticated
  session token hash. Refresh rehydrates it; logout, auth reset, runtime lock, or
  restart clears it.
- The OpenAI usage/cost aggregate is separate process-wide server memory. Browser
  refresh and chat clearing retain it; its Reset button or server restart clears it.
- Canonical future context includes only user text and completed assistant prose.
  Scope, skills, actions, tool payloads, reasoning, and
  citations are transient.
- The latest debug trace is always captured so Agent Debug can be opened after a
  failure. Starting another run replaces it.
- Exact detail is shown by default and may be toggled after a run without changing
  capture. The outline records every exact outbound Ollama body and response,
  retry/validation state, frozen scope/counts, action reason, retained/omitted
  roots, the bounded evidence payload, timing, and final
  response.
- Every investigation request has an `Evidence payload sent to Ollama` entry with
  the exact compact note tree for that request. `Copy all` copies the complete
  current/most-recent run—including all events and payloads—as formatted JSON.
- Traces are never stored in SQLite, files, browser storage, or canonical history.

See `docs/design/agent-harness.md` for service and invariant details.
