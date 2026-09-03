# Agent Harness: Single-Payload Read-only Investigation

## Contract

MetaList owns orchestration and evidence access. The selected model can either
answer normally or investigate the exact result scope visible when the user pressed
Send. It cannot search outside that boundary or mutate notes.

Supported providers are MetaList-managed Ollama and the OpenAI API. Instructor owns
the small structured routing call; final prose streams through the provider's native
client. LiteLLM is not part of the current path.

## Runtime Flow

```text
POST /api2/ai/chat + AgentScopeDescriptor
  → verify the visible tab and originating scope tab
  → resolve canonical search/sort/date membership server-side
  → apply the provider disclosure boundary
  → freeze immutable ScopedSearchSnapshot S0
  → select provider and verify its runtime/credential
  → Instructor route: respond | investigate_current_scope
      respond:
        stream final prose without note content
      investigate_current_scope:
        activate scoped-investigation skill
        walk complete root trees in canonical order
        retain the longest leading prefix within the provider token limit
        serialize one full nested evidence payload
        stream the final answer directly from that payload
  → complete the in-memory chat turn
```

There is no paging cursor, next-page decision, working summary, source-ranking
memory, facet browser, or automatic tag narrowing. A request gets at most one
evidence payload.

## Scope and Ordering

`app/services/agent/scope.py` freezes:

- normalized scope kind and label;
- canonical search, sort, and date descriptor;
- matching note IDs in visible hierarchy order;
- ordered result-tree roots and structural ancestor paths;
- disclosure-safe note content, directly assigned raw tags, direct unresolved tag proposals, and timestamps.

Supported scope kinds are Search, All notes, and Untagged notes. A temporary AI
Reference source keeps the originating search as the evidence boundary for later
questions. Clicking another AI reference replaces that temporary reference query;
ordinary references followed inside notes retain their separate stacked navigation
behavior.

Only true matches are evidence. An ancestor retained solely to preserve a path is a
contentless structural object. Search-redacted content never enters the snapshot.
The snapshot stores frozen records, not live note handles, so edits and navigation
cannot alter an in-flight request.

## Disclosure Boundary

`@password` notes and their complete descendant subtrees are always excluded.

Cloud providers additionally share one namespace-level policy with tag/text
whitelists and blacklists. Entries on each side are OR; blacklist wins. Tag rules
use canonical inherited, implied, and synonym-expanded effective tags. Text rules
are case-insensitive literal substrings. A hidden ancestor hides every descendant.
Ollama ignores the configurable cloud lists but still respects `@password`.

Filtering happens before counts, token sizing, serialization, citations, or Agent
Debug. The hover preview calls the same evaluator and gives hidden notes a readable
gray background; the preview is explanatory, while server filtering is the security
boundary.

## One Evidence Payload

`app/services/agent/investigation.py` performs one lazy ordered prefix walk after
the route chooses `investigate_current_scope`:

1. Serialize and estimate each complete root tree in canonical order.
2. Retain it if the cumulative estimate remains within the provider limit.
3. Stop before the first root that would overflow.
4. Omit that root and every following root.
5. Fail visibly if the first complete root alone exceeds the limit.

A root is atomic and never split. Retained notes contain their full disclosure-safe
content; there is no per-note character limit or truncation metadata. Token sizing
is not performed during startup, normal note interaction, route selection, or search
rendering.

The payload is a `result_trees` array. Each root is a JSON object with recursively
nested `children`. Evidence nodes contain `note_id`, `content_text`, created/updated
timestamps, directly assigned raw `tags` when present, and direct `proposed_tags`
when present. Proposed tags remain separate from accepted tags; inherited and
ontology-expanded terms are not serialized as stored sources. Leaf nodes omit
`children`; nesting communicates parent/root relationships.
Contentless structural ancestors contain only their ID, `is_evidence: false`, and
the retained child path.

The final request includes exact original/included/omitted note and root counts. If
anything was omitted, the model is told not to claim exhaustive scope coverage.
The current user request, rather than the broad search topic, defines relevance.

## Configuration

The only retrieval setting is a provider-specific maximum approximate evidence
token count:

- Ollama default 5,000; allowed 500–24,000.
- OpenAI default 250,000; allowed 500–500,000.

The deterministic estimator covers the serialized JSON, not just note text. The
same estimate is used for retention and developer feedback.

Old preferences for maximum note characters, character-sized pages, roots per
page, ranked tags per facet, working-summary characters, and ideal narrowed-scope
tokens are obsolete. They are ignored and removed during normal preference writes.

## Routing and Prompts

The route sees canonical conversation history plus a content-free block containing
the exact current user request, user search, scope kind/label, sort/date state, and
note/root counts. It does not serialize note content to choose a route.

`respond` is for general conversation and corrections that do not explicitly ask
for fresh saved-note evidence. An explicit request to summarize, search, review, or
otherwise use saved notes is bound by validation to
`investigate_current_scope`.

The packaged scoped skill describes one authoritative payload and direct final
answer. No skill or prompt describes page traversal, summary mutation, facet
selection, or context narrowing.

## Citations and References

Evidence note IDs are valid citation sources. The model cites a supporting claim by
copying `[[UUID]]` from the same note object whose `content_text` supports it. The
server rejects invented, stale, prior-turn, or undisclosed UUIDs, deduplicates
repeated adjacent citations, orders citation groups numerically, and renders
clickable superscript numbers.

The References disclosure is assembled after streaming completes and starts
collapsed. Visible reference links are deduplicated by root for navigation, while
their hidden queries retain the exact cited child UUIDs so unrelated siblings remain
redacted. Opening all references uses an OR query over the exact cited UUIDs without
changing the visible search field.

## Session, Cancellation, and Debugging

Conversation, activities, scope, evidence, and traces are server-memory session
state. Only user and completed assistant prose become later canonical conversation
context. Clear Chat and Stop abort active provider work; logout, auth reset, lock,
or process restart releases run state.

Developer-eye mode shows route validation, selected action/reason, root-prefix
retention, evidence payload size, retries, final writing, approximate token counts,
and per-step duration. Agent Debug always retains the latest run in session memory
so it can be opened after a failure. Its evidence event contains the exact one
payload sent for answer generation, and Copy all produces complete formatted JSON.
Traces are never persisted.

## Provider Details

Ollama is started lazily on `127.0.0.1:11435`, cloud disabled, with managed runtime
ownership and context verification before inference.

OpenAI calls set `store: false`. Encrypted namespaces store the API key encrypted
with the namespace DEK; plaintext namespaces hold it only in authenticated server
session memory. The raw key is never returned to the browser or included in traces.

Completed OpenAI calls contribute API-reported uncached input, cached input,
cache-write input, and output usage to a process-memory cost tracker. The tracker
uses model-specific and long-context pricing, is labeled estimated because an
interrupted request may not return final usage, and is cleared only by Reset or
process restart.

## Main Files

- `app/services/agent/runtime.py`: orchestration and streaming.
- `app/services/agent/scope.py`: immutable user-bounded scope.
- `app/services/agent/investigation.py`: ordered complete-root retention.
- `app/services/agent/evidence_serialization.py`: full nested evidence JSON.
- `app/services/agent/context.py`: route and direct final request assembly.
- `app/services/agent/retrieval_settings.py`: provider evidence-token limit.
- `app/services/agent/cloud_privacy.py`: cloud disclosure policy.
- `app/services/agent/trace.py`: session-only debug events.
