# Agent Harness: the Tool-using Agent

## Contract

MetaList owns orchestration, evidence access and every change. The selected model
answers each chat message by calling tools as needed (product help, notes in the
view, web pages, menus) and then writing one answer. Tools read only the exact
result scope visible when the user pressed Send, through the privacy boundary.
Nothing changes notes without the user's explicit Yes: tag proposal operations and
whole-view summaries hand over to application-owned operations that ask first.

The supported provider is the OpenAI API; the agent talks to it only through the
provider-neutral tool-calling interface (`tool_calling.py`,
`InferenceAdapter.stream_tool_turn`), implemented with the Responses API. Instructor
remains for the structured summary and tagging batches. LiteLLM is not used.

## Runtime Flow

```text
POST /api2/ai/chat + AgentScopeDescriptor
  → verify the visible tab and originating scope tab
  → resolve canonical search/sort/date membership server-side
  → apply the provider disclosure boundary
  → freeze immutable ScopedSearchSnapshot S0
  → AgentRuntime.stream_agent (agent_loop.py), at most 8 model turns:
      instructions (prompts/agent.md) + web skill when web access is on
      + conversation + view/selected-note and web-access context
      each turn: the model streams text and/or calls tools
        read-only tools run and their results are appended
        open_menu asks the browser and reports what opened
        full-mode web addresses carrying note text ask Yes/No first
        summarize_view / propose_tag_* hand over to their operation (ends the run)
      a turn without tool calls is the answer
  → complete the in-memory chat turn
```

A rejected tool call (unknown tool, invalid arguments) is explained back to the
model. Two failed tool turns in a row, or the eighth turn, ask the model to answer
with what it has; a turn that ends silently gets one reminder before the run fails
with a clear message. References may grow while the answer streams but never shrink.

## The Agent's Record of Earlier Answers

The history the model receives is the text of earlier turns only, so on its own it
cannot know what it did for an earlier answer (asked "did you search the web?", it
used to guess, and wrongly said no). Each answer therefore keeps the agent's own
action log (`action_log.py` `describe_action`): one entry per tool call with what
was asked and what came of it, never the returned content: help topics, notes in
view and trees read or left unread, the search words, each web address with its
status and title, the menu and whether it opened, and the operation's arguments.
A rejected call is recorded as rejected.

The loop collects the entries and attaches them to the run's `done` event (also
after an operation hands over). `ChatTurnStream.complete` stores them with the
answer through `AiChatSessionStore.complete_turn(actions=…)` and removes them from
the event, so the browser never receives them. `earlier_actions()` returns
`{answer, question, actions}` for the completed answers the model still sees, in the
order of `provider_messages()` (a privacy boundary change drops them with the
history). The next request carries them as an `EARLIER_ACTIONS` context message, and
the instructions say to answer how an earlier answer was made only from that record
and to say it cannot tell otherwise. The user never sees the record; Agent Debug and
the LLM history export already show the same steps.

## Conversation disclosure boundaries

The display transcript stays visible when the provider or disclosure boundary
changes. Model-visible history starts fresh at that boundary. The server hashes
the provider, configured privacy policy, and the namespace-wide set of permitted
note IDs before each turn. A policy edit, newly applied/inherited `@password`
restriction, changed ontology/content match, or removal of previously permitted
notes invalidates prior history. Unknown history provenance is excluded
conservatively. Every agent request consumes this filtered
history, including when the current evidence scope is empty. Returning to an old
provider does not automatically restore its previous context.

Citation removal alone does not sanitize answer prose. This boundary prevents
automatic reuse of earlier note-derived answers; text the user deliberately types
or pastes into the new message is still sent to the selected provider. It cannot
recall information already sent in an earlier request.

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

Chat interactions preserve the current edit session. Send first saves the latest
draft without deselecting it, then supplies a required `selected_note_id` (empty
when no note is selected). After checking authoritative visible-view membership,
the server freezes the permitted portions of the containing top-level tree:
ancestors, siblings, and descendants, including collapsed notes. Search-redacted
branches are excluded using the server's visible-view membership, even if a user
has temporarily revealed or selected them for editing. Blacklisted and password
branches are independently excluded. Each permitted node carries its complete
text, direct tags, parent ID, and an `is_selected` marker identifying the edited
node. Unrelated top-level trees are not added through selection. The same disclosure
policy removes private branches before serialization, token sizing, or citations.
Shared agent text extraction writes a web link whose label hides its URL as
`label (URL)`, so the model sees the address of a pasted link such as a video
title, and also includes already-cached URL titles alongside their URLs, labeled as metadata rather than fetched page content. This applies to
selected trees, broader investigation, and tagging inputs. It reads only the
in-memory successful-title cache after note disclosure filtering; it never starts
a URL fetch, rewrites stored notes, or attaches titles from excluded notes. Titles
are frozen with the note text and counted in the evidence budget. A title on a
parent URL remains associated with that parent for citations.
A note selected in a temporary reference view is checked against that visible
view; its containing tree is supplied separately without replacing the originating
search scope. The whole selected tree counts toward the evidence token budget;
an oversized tree fails visibly before provider calls rather than being clipped.

`SELECTED_NOTE_CONTEXT` accompanies every agent request. The model uses
selection, conversation, and the request together to infer the intended target;
there is no keyword or singular/plural rule. `has_selection` distinguishes
no selection from a selected but unavailable note. Unavailable selections expose
only status, selection presence, a reason (`private`, `search_redacted`, or
`not_found`) and the same in plain words ("The user is editing a note you cannot
see: it is excluded by the current search."). `private` covers every AI privacy setting (blacklist, whitelist,
password protection); the model is never told which one, and the specific setting
stays internal. Restrictions inherited from ancestors also apply; reasons never
expose the matching rule, note ID, tags, or content. The AI explains the restriction
without suggesting reselection or pasting blocked content as a workaround. With no
selection, a request about "this note" is answered by saying the AI does not know
which note is meant. Each Send replaces prior selection
context. This adds no note editing or child-creation capability.

For broader search investigation, only true matches are evidence. An ancestor
retained solely to preserve a search path is a contentless structural object.
The separately supplied selected tree can include nonmatching ancestors retained
as visible search context, but never search-redacted relatives. Both search and
privacy restrictions apply before content, tags, or citation IDs are serialized.
The snapshot stores frozen records, not live note handles, so edits and navigation
cannot alter an in-flight request.

## Disclosure Boundary

`@password` notes and their complete descendant subtrees are always excluded.

Cloud providers additionally share one namespace-level policy with tag/text
whitelists and blacklists. Entries on each side are OR; blacklist wins. Tag rules
use canonical inherited, implied, and synonym-expanded effective tags. Text rules
are case-insensitive literal substrings. A hidden ancestor hides every descendant.

Filtering happens before counts, token sizing, serialization, citations, or Agent
Debug. The hover preview calls the same evaluator and gives hidden notes a readable
gray background; the preview is explanatory, while server filtering is the security
boundary.

## Reading Notes in the View

The note tools (`agent_tools.py`) read only the frozen, privacy-filtered snapshot:

- `view_overview`: the view label, counts, the selected note's tree, and a preview of
  each root tree, listed until a quarter of the evidence budget.
- `search_view_notes`: notes whose text or tags contain every query word, then the
  trees they belong to.
- `read_view_notes`: whole trees for requested notes (any note selects its tree), or
  the view from its first tree.

Reads use `InvestigationState.read_root_trees()`: trees in view order until the next
one would exceed the evidence budget. A tree is atomic and never split. The result
reports `unread_root_ids` (read them in a later call), `too_large_root_ids` (larger
than the budget alone) and `unknown_ids`. Retained notes contain their full
disclosure-safe content.

The payload is a `trees` array. Each root is a JSON object with recursively nested
`children`. Evidence nodes contain `note_id`, `content_text`, created/updated
timestamps, directly assigned raw `tags` when present, and direct `proposed_tags`
when present. Proposed tags remain separate from accepted tags; inherited and
ontology-expanded terms are not serialized as stored sources. Contentless
structural ancestors contain only their ID, `is_evidence: false`, and the retained
child path.

The model sees short per-run note aliases (`n1`, `n2`…, `note_aliases.py`) in every
tool result and in the selected-note context instead of 36-character UUIDs, which it
sometimes miscopied. Aliases in `read_view_notes` arguments are translated back.
In contextual web mode, a note tool result also lists `web_addresses_now_openable`:
addresses written in the notes it returned.

## Complete-scope Staged Summaries

The `summarize_view` tool is for requests that summarize, compare, or synthesize
the complete frozen result scope; a question about part of it is answered by
searching and reading notes. In an empty view the tool reports that there is
nothing to summarize, without a card. Otherwise it hands over to the staged summary,
which starts right away when the entire scope fits in one payload (one ordinary model call, nothing to choose) and otherwise asks the user before model work begins. When multiple payloads
are necessary, the dialog reports the root and batch counts, the minimum number of
model calls, and offers either complete processing, the previous leading-prefix
behavior, or cancellation.

For complete processing, `plan_complete_root_batches()` partitions all permitted
root trees in canonical order. There is no cap on the number of batches. A root is
atomic and cannot be divided; if one root cannot fit, the operation fails visibly.
Batch 1 runs alone to seed the provider cache. Remaining batches are drained by a
pool of at most four workers; a worker emits a `writing` preview only after taking a
batch, throttled `streaming` previews while the model writes, and a `complete`
preview afterward. Batches waiting for a worker are reported as queued, never as
writing. Streaming previews come from Instructor's partial objects: the structured
inference capture stores the latest partial on the current attempt and attaches it
to `output_progress` events as `partial_output`. Each preview carries only the
finding count, the output-token estimate, and at most the last 240 characters of
the newest finding (the first finding on completion), at most once per 0.3 seconds
per batch. Responses are placed back into their original batch order regardless of
completion order. Duplicate or out-of-sequence preview transitions fail loudly on
both server and client. The first worker failure cancels the other
workers and propagates; closing the stream also cancels them.

The application attaches the exact roots supplied to each structured batch result;
the model returns only findings. Every batch and reduction prompt also carries
`SELECTED_NOTE_CONTEXT`, so a finding may cite disclosed note IDs from its batch
(or reduction inputs) or from the permitted selected-note tree. Unavailable
selected notes (blacklisted, search-redacted, password-protected, not whitelisted,
or missing) contribute no citable IDs, and any other ID is rejected. Tree nodes
serialized as `is_evidence: false` are structural ancestors whose content was not
disclosed and are never citable. When a batch or reduction cites an uncitable ID,
MetaList sends one correction request that names each rejected ID and its reason
(structural placeholder, present in the request but not citable evidence such as
earlier conversation, or absent from the request). A second failure aborts the
summary with those reasons and records a `SUMMARY_CITATION_REJECTED` trace event. The final
synthesis reference catalog likewise includes the permitted selected-note tree. If
the combined findings cannot fit in one synthesis request, MetaList recursively
groups and condenses them, preserving application-owned root coverage and
original-note citations at every level. The final answer is generated
only after all batches and reductions succeed. Failure or cancellation aborts
outstanding work and produces neither a partial summary nor a claim of complete
coverage.

## Configuration

The only retrieval setting is a provider-specific maximum approximate evidence
token count:

- OpenAI default 500,000; allowed 500–500,000.

The deterministic estimator covers the serialized JSON, not just note text. The
same estimate is used for retention and developer feedback.

Old preferences for maximum note characters, character-sized pages, roots per
page, ranked tags per facet, working-summary characters, and ideal narrowed-scope
tokens are obsolete. They are ignored and removed during normal preference writes.

## Instructions, Tools and Default Order

`prompts/agent.md` holds the agent's instructions; prompts and skills are packaged
and not editable. Tools (`agent_tools.py`), in their default order:

1. `lookup_metalist_help` (help topics, including release notes generated from the
   README) and `open_menu`;
2. `view_overview`, `search_view_notes`, `read_view_notes`;
3. `open_web_pages` (only when web access is on);
4. `propose_tag_generation`, `propose_tag_review`, `summarize_view`.

Independent tools follow that order; a later group may come first only when it
needs an earlier result (a web page whose address came from a note, reading notes a
search found, proposing tags after reading the notes). The live evals check the
order. Questions about MetaList itself are answered only from help; a request only
to open a menu needs no help lookup, and no menu opens for a feature MetaList lacks.
Every tool argument is required and independent of the others, so the schema alone
describes each valid call (OpenAI strict mode enforces it).

When the selected note's tree already answers the question, the model answers from
it without note tools. Selected-note evidence must fit the evidence limit before any
provider request.

## Citations and References

The model cites a note as `[[n12]]`, copying the alias of the note whose
`content_text` supports the claim, and a web page or a link found on it as
`[[web:N]]` (per-session numbers from the web evidence store). The agent loop
(`citation_tokens.py`) translates both into full `[[UUID]]` and `[[web:UUID]]`
tokens as the answer streams, holding back a token split across chunks; storage
and rendering only ever see full tokens. The server rejects invented, stale,
prior-turn, or undisclosed ids, deduplicates repeated adjacent citations, orders
citation groups numerically, and renders clickable superscript numbers.

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

Developer-eye mode shows each agent turn, the tools it used and their results,
confirmations, approximate token counts, and per-step duration. Agent Debug always retains the latest run in session memory
so it can be opened after a failure. Its tool-call events contain exactly what each tool returned to the model, and
Copy all produces complete formatted JSON.
Traces are never persisted.

## Web Pages

Each run freezes `pref.ai.web_access_mode` with the note scope. `none` offers no
`open_web_pages` tool. In `contextual` mode the agent may open only addresses from
user messages, the selected-note tree, notes a note tool returned (reported as
`web_addresses_now_openable`) and pages opened earlier in the chat; every redirect
hop is checked the same way, and a `#fragment` is ignored when comparing.

In `full` mode any public page may be opened, through the application-owned fetcher
(independent of the inference provider). Against prompt injection, `NoteTextGuard`
(`web_actions.py`) asks the user Yes/No before opening an address that contains
words from notes shown to the model that the user did not type and that were not
part of an address already seen; Google Search and Google Finance are exempt, and
every redirect hop gets the same check. The `web_browsing_v1` skill describes
batching, citations, partial failures and the untrusted-content boundary.

Opened pages enter a bounded, session-owned evidence store. The agent does not carry
earlier pages in its prompt: a follow-up re-opens the page, served from that store
without another fetch. HTML extraction records visible labeled links as separate
`page_link` references; listing items from a list page cites each item's own link,
so the References entries open the actual destinations.

## Provider Details

OpenAI calls set `store: false`. Encrypted namespaces store the API key encrypted
with the namespace DEK; plaintext namespaces hold it only in authenticated server
session memory. The raw key is never returned to the browser or included in traces.

Completed OpenAI calls contribute API-reported uncached input, cached input,
cache-write input, and output usage to a process-memory cost tracker. The tracker
uses model-specific and long-context pricing, is labeled estimated because an
interrupted request may not return final usage, and is cleared only by Reset or
process restart.

## Main Files

- `app/services/agent/runtime.py`: run start/recording and the staged summary.
- `app/services/agent/agent_loop.py`: the tool-using loop and confirmations.
- `app/services/agent/agent_tools.py`: tool definitions and read-only tools.
- `app/services/agent/tool_calling.py`: provider-neutral tools and conversation.
- `app/services/agent/openai_inference.py`: the OpenAI (Responses API) adapter.
- `app/services/agent/note_aliases.py`, `citation_tokens.py`: short ids for the model.
- `app/services/agent/web_actions.py`, `web_fetch.py`: opening pages and their guards.
- `app/services/agent/scope.py`: immutable user-bounded scope.
- `app/services/agent/investigation.py`: whole-tree reads within the budget.
- `app/services/agent/evidence_serialization.py`: nested evidence JSON.
- `app/services/agent/context.py`: agent and summary request assembly.
- `app/services/agent/cloud_privacy.py`: cloud disclosure policy.
- `app/services/agent/trace.py`: session-only debug events.

## Tag Proposal Operations

Only an explicit chat request leads the agent to `propose_tag_generation` (the current view) or `propose_tag_review` (accept or remove, current view or whole namespace, one named tag or all). Questions about tagging, hypotheticals and quoted commands are answered from help. Both tools hand over to `TaggingRun` and end the run.

Generation captures the search-visible trees. Visible ancestors supply content, but unseen sibling branches do not enter tagging evidence. Parent proposals inherit normally to unseen descendants. Privacy exclusions remain enforced before disclosure.

- Existing vocabulary is accepted tags in the entire disclosed search context, computed before batching and shared by all requests; never the namespace catalog or pending proposals. `pref.ai.tagging.vocabulary` is one categorical permission (`existing`/`new`), while `pref.ai.tagging.focus` remembers the exact last selector choice (`existing`/`new`/`both`). Submitting existing-only saves existing permission; new-only or both permits new tags. There is no separate vocabulary setup question.
- Tag suggestion guidance is the packaged `tag_proposals_v1` skill (`skills/tag-proposals.md`, title "Suggest tags"). Like every prompt and skill it is not editable; a tagging prompt saved by an older version (`pref.ai.prompt.tagging`) is ignored and dropped. The agent records its activation, and every tagging batch sends it as an `ACTIVE_SKILL` system message; validation-critical rules (vocabulary mode, 12-tag limit, note-ID scope) stay in code.
- Every batch receives the exact generation request. A named subject is a binding semantic filter rather than a general hint: examples disambiguate its intended meaning, proposals favor specific concepts/methods/entities inside that subject, and unrelated notes or broad neighboring classifications are omitted.
- Existing-only requests explicitly require exact supplied vocabulary terms, without synonyms or variants. Every batch payload also carries an explicit machine-readable pass mode. New-only instructions require a final case-insensitive comparison against the supplied accepted vocabulary before output.
- Each batch tolerates up to 10% invalid tag assignments, dropping those assignments and omitting notes left without valid tags. A separate 10% threshold applies to duplicate or non-batch note-ID entries; tolerated entries are discarded whole. Validation distinguishes an ID in another batch of the current permitted scope, a real namespace note outside the current permitted scope, and a nonexistent ID. It uses frozen ID-set membership only and never reads an out-of-scope note. A real out-of-scope ID may have been disclosed under an earlier conversation scope, so it is not labeled proof of a new disclosure leak. The denominators are distinct case-insensitive note/tag assignments and total proposal entries respectively. Existing-only accepts terms found either in disclosed context vocabulary or, after inference, in accepted namespace tags; the latter are canonicalized without disclosing the namespace catalog to the model. New-only rejects accepted tags disclosed in the context. If a new-only candidate happens to match an accepted tag elsewhere in the namespace that was never disclosed to the model, validation silently drops it without counting it as a model error. Both mode permits existing or new terms. Invalid syntax and command tags are invalid in every mode. Above either threshold, the model receives the cumulative validation failures and may regenerate the complete batch up to three times; if the third correction still fails, the pass fails atomically. Malformed response structure remains strict.
- Generation intent never selects the per-pass focus. Every generation request asks the three-way structured focus question, preselects the exact previous choice, and keeps all choices available. The answer updates both the remembered focus and the two-way vocabulary permission in one submission. Request wording and model interpretation cannot skip the question, including explicit requests for existing, new, or both. Existing focus validates output against batch vocabulary.
- The configured evidence budget determines batching. Every generation pass asks one `tag_scope_confirmation` card before model work, equivalent to the complete-scope summary card: the scope size as a multiple of the evidence budget, the three-way focus selector, and "Tag all N", "Use first K only" (only above 1×: the leading canonical-order roots that fit one evidence payload, `leading_tree_count_within_budget()`, reported in the completion message), and Cancel. Answers combine focus and scope (`focus_*` or `prefix_focus_*`); there is no separate focus question. `bulk-scope-question.js` derives both cards' labels and answer values. Randomize visible root-tree order before batching so display-adjacent roots do not systematically share requests. Complete visible root trees remain together and preserve their internal hierarchy/order; every requested tree is reviewed. Processing time is hidden and paused during questions; no predicted duration. Proposal dialogs reuse the shared modal-content and form-actions styles.
- New-only focus strictly excludes disclosed accepted vocabulary terms (case insensitive). The namespace catalog remains undisclosed, so post-inference validation silently drops a collision with an accepted namespace tag the model could not know about.
- Every pass uses token-sized requests, configured alongside the evidence limit in AI settings: `pref.ai.openai.tagging.batch_tokens` (default 100,000). Bounds match the corresponding evidence setting (500–500,000). Shared vocabulary overhead counts toward every batch. Whole roots may exceed the target window, but the full request must still fit the model context. There is no fixed note-count subdivision or partial-JSON parsing. The inline progress bar advances by completed input-token weight after each validated batch.
- Chat tag generation renders its choice and progress controls inside the transcript. The focus selector has three real options and no explanation paragraph or placeholder; Continue explicitly submits the selected option. No preparation overlay. Chat input and surrounding UI are locked while operation controls stay usable. Non-chat regions are inert, greyed, slightly blurred, and use a not-allowed cursor. Transcript rerenders preserve the live operation element and its selected value/focus. Programmatic acceptance/removal stays in the ordinary chat working state through its atomic update and never creates a progress or cancellation panel. Menu choice and confirmation dialogs use normal modals, but submitting a programmatic acceptance/removal operation shows only the application busy state with no second progress modal.
- An application-owned modal locks normal interaction while the batch guard rejects conflicting server mutations. Pending question answers remain available, and Cancel aborts the stream before final application. The final synchronous commit phase disables Cancel.
- Validated proposals accumulate only in session memory. Batch 1 runs alone so its new terms can be supplied separately to every later batch as optional `prior_batch_new_tags`, allowing consistent reuse without treating them as accepted or required vocabulary. Remaining batches run in waves with at most four concurrent requests; there is no cap on the total number of batches, and validated results are merged in original batch order. Parallel batches do not consume one another's new terms. All batches must succeed before one database transaction writes the result. A failed or cancelled batch aborts outstanding work and applies nothing. Canonical note sources and inheritance/search indexes are then published without an async yield, and existing undo/redo is cleared only when changes were applied. No bulk undo entry is created. After a successful mutation, the client discards the active view's root window and pagination terminal state before fetching a fresh first window, so proposal-driven search-membership changes cannot strand infinite scroll.
- A successful generation response lists each newly added proposal and cites every note that received it. Inline numbered markers remain clickable, while the ordinary expandable References section is replaced for this response type by one **Show all new tag proposals** link. That link uses the same combined exact-note query as Open all references. Canonical conversation history retains the tag names while stripping citation UUIDs before later model calls; subsequent tagging also reads each note's authoritative pending proposals and explicitly excludes duplicates.
- Failure/cancellation applies no pending results; no-change results preserve history. Individual proposal controls retain their undo semantics.

Bulk acceptance/removal resolves the complete requested target set programmatically, independent of provider disclosure and token limits. Current context is the default; entire-namespace scope must be explicit. Menu and chat support an exact case-insensitive tag filter or all proposals. From chat, a Yes/No `change_confirmation` first states exactly what will change (how many proposals, of which tag, across how many notes, where); nothing changes without Yes. The Accept or reject AI-proposed tags menu executes directly. Removing proposals creates no rejection memory.

Implementation: `app/services/agent/tagging.py`, `tagging_run.py`, `app/services/bulk_operation.py`, and `app/usecases/bulk_tag_proposals.py`. Structured questions and direct menu operations use authenticated `/api2/ai/proposals/*` endpoints.


## Session History and Live Evals

`history.py` binds an inference recorder to each run using task-local context. The
OpenAI adapter records logical call inputs, actual HTTP bodies, tool turns,
structured attempt outputs and raw stream chunks, including errors and cancellation.
`AgentTraceStore` retains every run for the session while its debug snapshot still
returns the latest run. Authenticated `GET /api2/ai/history` exports chronological
input/output pairs with `Cache-Control: no-store`. Clear Chat/logout/reset remove
history; there is no persistence or provider-side storage.

`python -m evals agent` runs fixed cases through the real agent loop with current
production instructions, skills and tool schemas, on Luna at Low thinking. Each case
checks required and forbidden tool calls, the default order, whether a confirmation
was asked, and a judged answer, against fixture notes and recorded web pages; tag
operations are recorded, never applied. See [the suite guide](../../evals/README.md).

## Help Lookup and Menus

`lookup_metalist_help` returns the selected help skills (`skills/help-*.md`) and the
installed version; help text is transient and never becomes conversation history.
The `releases` topic is generated from the README "Changes in" sections by
`scripts/sync_release_notes_help.py`; a unit test fails when they drift.

`open_menu` accepts only ids from the shared JSON menu catalog, the
application-owned destination allowlist. `dialog` invokes an existing form-opening
handler; `palette` opens and highlights an existing entry without invoking its
operation. Opening never changes a setting or submits a form, so it needs no
confirmation. The browser checks scope/cancellation/modal availability and visible
DOM, then POSTs `{request_id, status, detail}` to `/ai/menu-result`. Requests are
bound to the authenticated session, single use, and expire after 30 seconds.
Unknown, wrong-session and replayed acknowledgments return 409; malformed input
returns 422. The actual status goes back to the model as the tool result.

`AgentTraceStore.export_history` associates `MENU_REQUESTED` and `MENU_RESULT`
with the producing output pair under `application_events`.
