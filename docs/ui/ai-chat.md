# AI Chat, Product Help and Scoped Investigation

## Scope

- MetaList chats with one user-selected OpenAI model through an
  authenticated, application-owned agent runtime.
- Every Send freezes the currently displayed MetaList result scope. The agent can
  investigate only matching notes inside that boundary; it cannot run a new
  namespace-wide search or escape to hidden notes.
- Investigation is read-only. Explicit requests can generate, accept, or remove
  tag proposals through the separate bulk proposal workflow. The agent cannot
  create, edit, move, trash, or delete note bodies.
- Product questions load selected MetaList help skills. Requests can open an
  existing settings/help dialog or highlight a menu command. Highlighting does
  not execute that command; forms are not submitted and settings are not changed.
- The agent answers by calling tools (help lookup, menus, reading notes in the
  view, opening web pages, tag operations, summaries) and then streams its answer
  directly from the selected provider. Instructor remains for the structured
  summary and tagging batches. OpenAI requests disable provider-side storage.
- While a provider generates, the active eye-mode panel shows an approximate output-token
  count that updates in place with a subtle pulse; completed panels retain the final
  count separately from their input estimate.
- Every generation is bounded over the wire. Each agent turn and each structured
  step (summaries, tag work) allows at least 8,192 output tokens with OpenAI: its
  reasoning models count hidden thinking against that limit, so even a short reply
  needs room to think first. If OpenAI reports that the
  limit truncated its output, the run fails visibly instead of presenting partial prose
  as complete.
- When a structured step's reply is rejected on every attempt (cut off at the output
  limit, not matching the required format, empty, or refused), the chat explains the
  failure in the error itself: which step failed, what went wrong on each attempt in plain words (including the
  rule broken and what the model chose), the setup (model, thinking level, web
  access), and what to try. The explanation is saved with the turn, so a screenshot is
  enough to diagnose it; Agent Debug remains for the raw requests and responses
  (`app/services/agent/failure_explanations.py`).
- OpenAI models sometimes wrap a citation in ChatGPT's own markup (U+E200 `cite` U+E202 … U+E201), which would show as boxes and a stray "cite". `ChatTurnStream` removes it as the answer streams (`strip_provider_citation_markup`, holding back markup that has not closed yet), keeping MetaList's own `[[…]]` citations inside it, so the chat, the saved answer and copied text never contain it.
- A whole-view summary that fails or is stopped keeps its finished batches for the chat (the explanation says how many); asking again ("try that again") continues it: only the remaining batches run, with the original question, and the progress shows "Reused N of M batches from your earlier attempt". A different question starts fresh.
- Until OpenAI sends its first signal for a request, the heading reads "Waiting for OpenAI…" with the elapsed seconds instead of "Thinking…", so a network stall does not look like thinking.
- A request OpenAI never answers fails after a silence limit instead of the library's 10 minutes: 15 s at Off and Low thinking (measured on Luna: first signal in 0.7–2 s and streaming gaps under 0.4 s, also with a 180,000-token input), 60 s at Medium and 120 s at High (generous, not measured, since a model may think silently before its first word). The explanation says "OpenAI did not respond for 15 seconds. Check your internet connection and ask again."
- Every failure explanation ends with where the run stopped: the step it was in (and for how long) or had just finished, the step before, and an operation's latest progress, for example `Where it stopped: during "Thinking" (15.2 s into that step), step 3 of the run; before that: "Scope ready · …".`
- The first activity line says how long preparing the view took ("Scope ready · All notes · 45,479 notes in … result trees · prepared in 0.2 s"). Preparing records which notes are in view and their content as of Send, but extracts a note's text only when a tool first reads it, so a question that reads no notes does not pay for the whole view. Cloud privacy rules that match phrases still read every note's text at Send to decide what is private.
- A step that extracted note text says how much on its line, for example "Search complete · … · text extracted for 45,480 notes in 3.8 s" (the first search in an answer reads every note in view; later steps reuse the text). A whole-view summary reports it on its "Planned N evidence batches" line.
- Stop no longer ends in a fatal error: the "Cancelling request" activity carries the fields every activity needs.
- The AI remembers a failed request and the explanation you saw, so you can follow up
  with "try that again" or ask why it failed (`docs/design/agent-harness.md`).
- A Send that MetaList refuses before the AI starts (the AI is not set up, the active tab changed, a message it rejects) stays in the chat with the reason, so the message is not lost and the reason says what to fix. The server keeps no record of such a turn, so the chat is not reloaded from it after the refusal.

## Web access

**AI Agent Settings** has three enforced browsing modes:

- **No web access** is the default. The agent cannot open pages and
  explains that limitation when a request needs the web.
- **Open links from permitted context** can open only exact URLs supplied by the
  user or present in note/evidence content that passed the same disclosure
  boundary as the rest of the prompt. Links found inside an opened page do not
  become available.
- **Open any public web page** lets the agent propose direct public HTTP(S) page
  URLs even when they are not in the current note or conversation. Ordinary
  lookups open a Google results page and then useful result pages through the same
  MetaList page opener. No LLM provider supplies search or retrieval, and MetaList
  has no separate search-engine action.

The web-browsing skill tells the agent to batch up to eight URLs,
reuse duplicate pages, treat page text as untrusted evidence, and explain what
the active mode permits. Page opens support HTML, plain text, and PDF. Individual
pages can fail or be truncated without discarding successful siblings.

Successful pages remain in bounded server-memory chat evidence for follow-up
questions. Clear Chat, logout, a disclosure-boundary change, server restart, or
runtime reset removes that evidence. Web claims use their own external reference
links; responses can cite disclosed notes and web pages together. A direct article
summary references the opened article. For an aggregator, directory, index, or
search-results summary, named items reference the visible destination links from
that page instead of only the containing site. Those destination references do not
mean MetaList opened or read the linked pages, and they do not make the links
available to contextual browsing.

## Product help and menus

Questions about MetaList itself are answered only from help: the agent looks up
the relevant topics (notes, search, tags, formatting, references, menus,
reminders, AI, privacy, data, or release notes) and answers from those skills.
Help text is not retained in later conversation turns; the export records exactly
what the model saw. "Where do I…" and "how do I change…" questions look up help and then open the menu
that holds the setting.
A request only to open a menu opens it directly, and no menu opens for a feature
MetaList does not have.

Examples: “How does tag inheritance work?” explains from the tags skill.
“Open AI settings” opens that dialog. “How do I change context to 250k?” opens
AI settings and identifies Maximum approximate evidence tokens = 250000, leaving
the user to save. “Open Create backup in the menu” highlights its command without
creating a backup.

Before opening, the browser checks the originating scope, cancellation and other
open dialogs. It acknowledges actual visibility, and the agent is told whether the
menu opened. Missing acknowledgment times out after 30 seconds and is reported as
unavailable. Exported LLM history includes the requested destination and browser
result, rather than treating model prose as proof of execution.

## Scope at Send

The browser captures one required view descriptor from the active tab:

- normal search, All notes, Untagged notes, or temporary Reference source;
- executed search text;
- sort mode;
- reference UUIDs where applicable;
- a human-readable scope label.

The server verifies that the descriptor targets the active tab and matches its
canonical search/sort state, then resolves actual note membership itself.
The browser never submits a trusted corpus-sized UUID list. Later typing, tab
switches, or reference navigation do not change the running request.

The assistant turn does not repeat this scope above its response. When developer
diagnostics are visible, the scope-freezing activity panel shows the label and
note/tree counts.

With developer diagnostics hidden, an in-progress turn uses one stable
`Working…` row whose dots animate without replacing the label or resizing the
panel. If the evidence limit omits trailing roots, a calm informational notice
appears before the answer as `Only using X of Y root notes for answer`; detailed retention
counts remain in Agent Debug.

The same note/tree counts are supplied to the agent before note content is loaded.
Note content reaches the model only through the note tools; their activity panels
report what was read and its approximate token count.

Every Send captures a fresh authoritative MetaList scope. Conversation history is
used to resolve follow-ups, but earlier assistant claims about unavailable notes do
not override the newly captured scope. Retrying an unresolved note-dependent task
after changing the search or context re-investigates that current scope.

Only true matching nodes become evidence. Ancestors needed to make the result tree
readable appear only as contentless structural objects. Gray/redacted content is
excluded. A protected `@password` or `@username` note hides itself and its complete
descendant subtree from every model.

Before a cloud scope is frozen, MetaList also applies the namespace's shared cloud
privacy policy. Tag whitelists and blacklists use inherited and ontology-expanded
effective tags; text lists use case-insensitive literal substrings. Entries in a
whitelist are OR, entries in a blacklist are OR, and blacklists win. If any ancestor
is hidden, every descendant is hidden as well. The resulting filtered set—not the
original search set—drives counts, evidence, references, and debug payloads.

## Investigation Behavior

The agent decides from the conversation which tools it needs; there is no keyword
classifier. General conversation needs no tools. When the selected note's tree
already holds the answer, it answers from that. Otherwise it reads the frozen
result view with:

- `view_overview`: counts, the selected note's tree and a preview of each tree;
- `search_view_notes`: notes containing every query word, with their trees;
- `read_view_notes`: whole trees for given notes, or the view in order.

Reads take complete trees in visible order until the evidence limit; a result says
which trees were left unread (readable in a later call) or are too large on their
own. The model sees short note ids (`n1`, `n2`…) instead of UUIDs and cites them as
`[[n12]]`; MetaList turns these into ordinary note references as the answer streams.

`summarize_view` is for summarizing, comparing or synthesizing the complete view.
In an empty view the agent says there is nothing to summarize.

When the whole scope fits in one evidence payload, the summary is one ordinary model
call and starts without a question. When it needs several batches, it asks for
permission before any summary call. The
dialog shows how many roots and evidence batches will be processed and the scope's
size as a multiple of the evidence budget. Tag proposals ask the same single card,
with the tag-focus selector (existing, new, or both) added above the buttons:
"Tag all N", "Use first K only" when the scope exceeds the evidence budget, and
Cancel (last and tinted red in both). If multiple
batches are required, the user can summarize everything, use only the leading
single-payload prefix, or cancel. Complete processing keeps every root tree intact,
has no cap on the total number of batches, and runs at most four model requests at
once. The first batch runs alone to seed provider caching; later batches run in
parallel waves and are restored to original scope order before synthesis.
The progress widget sits in the conversation immediately above the answer it is
producing: earlier messages and the current request stay above it, and the final
answer streams in below it. Its status line reports the total batch count and how
many batches are complete, writing, and queued. As soon as a batch request starts,
a compact card appears for it: a pulsing heading with a live finding and token
count, and a fixed two-line window that streams the tail of the newest finding
as the model writes it (a thin shimmer stands in until the first text arrives).
When that batch completes, the same card collapses to one ellipsized line such as
"✓ Batch 3 of 9 · 4 findings — first finding…". The full findings are not
repeated in the widget. Cards stay in canonical batch-number order even when later
batches finish first, and the scrollable stack follows the newest batches unless
the user has scrolled up. Stream previews are throttled on the server, and the
widget's Cancel button is never replaced while previews arrive. After every batch succeeds the status changes to writing the
final answer, and the batch cards remain visible above it. When the user chooses
the leading prefix (or cancels), the permission card closes before the answer
streams rather than leaving disabled choices behind.

If the verified batch findings are themselves too large for one synthesis call,
MetaList condenses them through additional ordered stages until they fit. Exact
root coverage and disclosed original-note citations are validated at each stage.
The final answer appears only after every batch succeeds. Failure or cancellation
stops outstanding work and never presents a partial result as complete.

Every retained note carries its full disclosure-safe content. The agent is told
exactly which trees it has not read and must not claim exhaustive coverage of them.

The agent cannot expand beyond the frozen scope or cite an undisclosed note ID. Those boundaries are enforced programmatically.

## Ordering and Evidence Limit

- Evidence uses MetaList's canonical top-level result-tree order and visible node
  order. SearchIndex membership never becomes ordering.
- Results near the top are generally newer or more highly user-ranked, which is a
  prioritization hint rather than relevance proof.
- Each note read packs complete result trees up to the limit. OpenAI defaults
  to 500,000 approximate tokens and is configurable from 500–500,000.
- A root tree is never divided. If the first root alone exceeds the limit, the run
  fails visibly; otherwise the first root that would overflow and all following
  roots are omitted.
- Matching notes are not character-truncated. The evidence limit applies only to
  the complete serialized payload.
- The estimate covers compact serialized JSON, including content, UUIDs, tags,
  timestamps, hierarchy, object keys, and punctuation. The same deterministic
  estimator drives the debug-panel token estimates.
- The payload is a `trees` array of root note objects with recursively nested
  `children`, not a flat note list. Content-bearing nodes expose note IDs, content,
  created/updated timestamps, and directly assigned raw tags in tag-bar order.
  Untagged notes omit `tags`; leaf notes omit `children`; parent/root IDs are not
  repeated because nesting already communicates the hierarchy.
  Contentless `is_evidence: false` ancestors preserve paths to nested matches
  without disclosing gray/redacted note information.

The only retrieval control in `AI Agent Settings…` is the provider-specific maximum
approximate evidence-token count.

## OpenAI Configuration

- Defaults: `gpt-5.6-luna`, 500,000 approximate evidence tokens, and 100,000
  tagging batch tokens. Saved model and token-limit overrides are retained.

- Open `AI Agent Settings…` from the command palette or chat gear to select an
  supported OpenAI model, configure an API key, and edit the evidence-token limit.
- The same settings modal has one Cloud privacy section shared by all cloud
  providers. Its four one-entry-per-line fields configure whitelisted tags,
  whitelisted text phrases, blacklisted tags, and blacklisted text phrases.
  The automatic `@password` and `@username` boundaries also apply. The policy is namespace-scoped and is encrypted with client preferences
  when the namespace is password-protected.
- Hovering the AI chat column asks the server to preview that boundary over the
  current note view. Notes the selected provider cannot receive have a gray
  background and blurred content until the pointer leaves chat. Excluded
  descendants are blurred too.
- The compact composer controls choose model and Thinking Off/Low/Medium/High.
  Selection persists immediately.
- A compact estimated-spend tracker appears directly below the
  chat header when the header's **$** button is on (off by default, remembered per
  namespace as `pref.ai.show_spend`; it keeps counting while hidden). Its four token totals are New input, Cached input, Cache writes, and
  Output. Values come from OpenAI's response usage rather than MetaList's prompt
  estimator and update after each completed intermediate or final request. Reset
  returns the process-local aggregate to `$0.00`; clearing chat does not. Nothing
  from this tracker is persisted, and an interrupted request that never returns
  final usage may be absent from the estimate.

- Ollama support has been removed. Legacy local-provider preferences are discarded
  on load/save. If Ollama was selected, any saved OpenAI model selection is also
  cleared so the default OpenAI model is used. Existing OpenAI
  configurations retain their model, credential, privacy policy, and limits.
  MetaList no longer launches local model servers or downloads models. Existing
  external installations, downloaded models, runtime files, and backups are untouched.

Prompts and skills are packaged and not editable, so every user gets the behavior
the evals measure. Overrides saved by older versions (`pref.ai.prompt.*`,
`pref.ai.skill.*`) are ignored when preferences load and dropped the next time
preferences are saved (`RETIRED_PROMPT_PREFERENCE_KEYS` and
`RETIRED_SKILL_PREFERENCE_KEYS`).

## Panel and Cancellation

- `Show/Hide AI Chat` is available in the command palette and notes-view context
  menu.
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
  browser/server provider work. Clear Chat cancels and awaits any active request before
  clearing transcript and latest trace. No status/error line is placed below the
  composer.
- A Thinking disclosure appears only if the model emits real reasoning; Thinking
  Off never shows a fake heading.

## Rendering and References

- Right-click anywhere inside a completed response bubble, including its padding
  and links, to choose **Copy Response**. Streaming and failed responses do not
  offer this action.
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
- Tag-generation result messages keep their clickable inline markers but replace
  the References disclosure with one **Show all new tag proposals** link. It opens
  the same combined exact-note view as `Open all references`.
- Root deduplication is presentational only. Each reference retains the exact cited
  child UUIDs as its hidden navigation query. If multiple cited children share a
  root, the query is `UUID1 OR UUID2`; normal search behavior preserves both paths
  and gray-redacts unrelated siblings.
- Individual/all-reference navigation uses the temporary Reference source context,
  leaves the visible search field empty, labels the temporary tab `Reference source`
  instead of displaying its internal exact-note filter, excludes that filter from
  search history, and provides the dismissible X to return to the prior tab context.
- Common UUID dash substitutions are normalized programmatically. UUIDs in fenced
  code/existing links remain literal.
- Right-click a completed answer and choose `Copy Response` to copy Markdown tagged
  `@markdown @llm` into the MetaList note clipboard and rich/plain content onto the
  system clipboard. After pasting that response as a note, its References disclosure
  remains interactive in view mode: opening or closing it does not enter edit mode
  or begin a note drag.

## Session and Debug Boundaries

- The agent keeps a private record of what each answer did (tools, searches and pages
  opened, notes read), so questions such as "did you search the web?" are answered
  from what actually happened. Only the model sees it; it is cleared with the chat
  history (`docs/design/agent-harness.md`).

- Transcript/activity state lives only in server memory keyed by authenticated
  session token hash. Refresh rehydrates it; logout, auth reset, runtime lock, or
  restart clears it.
- The OpenAI usage/cost aggregate is separate process-wide server memory. Browser
  refresh and chat clearing retain it; its Reset button or server restart clears it.
- Canonical future context includes only user text and completed assistant prose.
  Scope, skills, actions, tool payloads, reasoning, and
  citations are transient.
- The latest debug trace is always captured so Agent Debug can be opened after a
  failure. Starting another run replaces the debug view; session history retains
  earlier runs for export.
- Exact detail is shown by default and may be toggled after a run without changing
  capture. The outline records every exact outbound provider body and response,
  retry/validation state, frozen scope/counts, action reason, retained/omitted
  roots, the bounded evidence payload, timing, and final
  response.
- Every investigation request has an `Evidence payload sent to OpenAI` entry with
  the exact compact note tree for that request. `Copy all` copies the complete
  current/most-recent run—including all events and payloads—as formatted JSON.
- Traces are never stored in SQLite, files, browser storage, or canonical history.

See `docs/design/agent-harness.md` for service and invariant details.


## Export LLM history

The chat header's **⇩ Export LLM history** button downloads the current session's
chronological `[input, output]` pairs as JSON. Inputs include the exact provider
request and original application invocation; outputs include responses or stream
chunks and completed/running/error/cancelled status. Agent turns and tool
results, tagging, retries, and final answers are included. Exporting makes no model call.

Page reloads retain server-session history. Clear Chat, logout, and server restart
clear it. The existing Agent Debug dialog and Copy all still concern the latest
run. See [prompt regression authoring](../../evals/README.md) to turn an exported
failure into an agent case.
