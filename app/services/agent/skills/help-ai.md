# MetaList AI and tagging

Explain MetaList from this reference, without pretending to inspect the user's
saved settings or notes. Defaults below do not establish their current values.

MetaList uses OpenAI; Ollama/local model support has been removed. AI agent
settings (also found by searching AI, LLM, or OpenAI in the menu) configures the
API key, model, **Maximum approximate evidence tokens**, tagging batch token
window, and **Web access**. **Maximum approximate evidence tokens** is the exact evidence/context
field label shown in the dialog; use this label when directing the user to it.
The defaults are gpt-5.6-luna, 500,000 evidence tokens and 100,000 tagging
batch tokens. The evidence field accepts 500–500,000. Evidence/context and tagging
batch window are different controls: 250k context means evidence 250,000, not
250,000 tagging tokens. Composer controls can change model and thinking level.

Web access has three modes and defaults to **No web access**. In that mode the
agent cannot open pages. **Open links from permitted context** lets it
batch-open public HTTP(S) URLs already present in user-authored chat, disclosed
note evidence, or retained web evidence. It cannot follow new links
found inside opened pages. URLs that occur only in privacy-blocked, password,
redacted, or omitted notes are not disclosed and cannot be opened. **Open any
public web page** lets the agent propose direct public HTTP(S) page URLs even when
they are absent from context. It can open a Google results URL and then open useful
result pages; both use MetaList's page opener rather than an LLM-provider search
service. MetaList has no separate search-engine action. Before opening an address
that contains words from the user's notes that the user did not type (for example
one a web page tricked the AI into building to send note text elsewhere), the chat
shows the address in a Yes/No box; nothing opens without Yes. Google Search and
Google Finance addresses never ask, since they only reach Google; redirects get
the same check. Page text is untrusted
evidence, supports HTML, plain text, and PDF, and must be cited. Web
evidence is retained only in the current chat session and Clear Chat removes it.
Changing the Web access selection applies on the next message.

Evidence is the permitted result view active when Send is pressed, including
matching notes not yet rendered on screen. Privacy filtering happens before
counts or note data reach the model. The AI uses tools on that view: an overview,
a word search (every word must appear in a note's text or tags), and reading whole
result trees in visible order. Each read returns as many whole trees as fit the
evidence limit; a tree is never divided, trees left unread can be read in a later
step, and a tree too large for the limit on its own is reported instead of read.
The AI keeps a private record of what it did for each answer in the chat (help it looked up, notes it read, searches and pages it opened), so it can say truthfully how an earlier answer was made; the record is cleared with the chat. Notes within returned trees are complete. A whole-view summary packs trees in
visible order and asks before using several batches. The limit estimates
serialized evidence, not the entire conversation/model context. Raising it can
include more evidence and increase cost. A reference-source view
opened by an AI citation retains the originating search as the next Send scope.
The note being edited at Send goes along with its whole tree. If AI privacy
settings hide it, the AI is told only that it is private, never which setting
(blacklist, whitelist or password protection) or rule. With no note selected, it
asks which note "this note" means.

The chat AI decides which tools a request needs, in a default order (MetaList
help, then notes in the view, then the web, then a change), and may use several
for one request, up to 8 steps. General conversation needs no tools. Product
questions look up selected MetaList help topics, including release notes (what
changed in each version and the installed version); help text is transient and is
not automatically added to future turns. Explicit requests to generate/accept/remove
tag proposals or summarize the whole view hand over to those operations, which
ask first. Asking about that workflow is not permission to run it. The help action can explain and open dialogs only; it cannot set a
model/token limit or submit a form. If a user supplies a desired value, open the
appropriate settings and explain which field/value to save, honestly stating
that the value has not been changed automatically.

Proposed tags are separate from accepted tags. Tagging works on current-context
whole root trees, includes ancestors, randomizes roots before batching, and
collects results before atomic application. The vocabulary selector offers
existing only, new only, or both. Existing namespace vocabulary is shared across
batches; tags proposed in earlier batches are optional reuse vocabulary but
remain unaccepted. Existing pending proposals are not generated again. Above
one evidence budget, generation asks confirmation before proceeding. Tagging
batch size is independently configurable. Bulk accept/remove can target current
context or the namespace, optionally an exact tag. Asked in chat, accept/remove
first shows a Yes/No box with exactly what will change (how many proposals, of
which tag, across how many notes, where) and changes nothing without Yes. Successful bulk changes clear
undo/redo and create no bulk undo entry. There is no persistent rejection memory
or automatic background proposal generation. Individual proposal controls differ
from bulk operations; do not promise bulk undo.

Accepting a proposal converts it to an accepted tag. Removing/rejecting proposals
discards only pending, unaccepted proposals; it cannot remove accepted tags or
reverse a completed bulk acceptance. Do not offer proposal removal as a workaround
for missing bulk undo. Removing an accepted tag requires editing that note's tags,
which this chat workflow cannot do. An explanation of these limits does not itself
request opening the proposal-management dialog.

Accept or reject AI-proposed tags opens the bulk acceptance/removal form. AI tagging vocabulary
chooses existing tags only, or existing and new tags. The AI's prompts and skills
(including the tagging instructions and these help texts) are built into MetaList
and cannot be edited, so the AI behaves the same for everyone; instructions saved
by older versions are ignored. A model's knowledge of an operation does not make
that operation available as a tool.

Chat history and its debug traces are session-only. Clear Chat/logout removes
them; a server restart removes them. A page reload in the same authenticated
session retains them. Export LLM history (download arrow in the chat header)
exports a list of input/output pairs, including actual provider requests,
attempts/retries/errors and activated skills. It makes no additional model call.
Agent Debug shows the latest run. When an AI step fails, the red message in the
chat explains it on its own: the step that failed, what went wrong on each attempt
(for example the reply was cut off at the output limit after the model spent its
budget thinking, or its answer broke a format rule, with what it chose), the model,
thinking level and web access, and what to try (such as a lower thinking level). The separate opt-in regression suite lives in
the source repo, excluded from PyPI; cases default to five trials with up to four
concurrent requests and report percentages and cached-token usage.
Neither export nor ordinary tests automatically sends a test suite to OpenAI.

The estimated spend display is hidden by default; the $ button in the chat
header shows or hides it (remembered per namespace) and it keeps counting while
hidden. It uses provider usage, tracks new/cached input, cache writes and output,
and is process-local. Resetting it does not affect billing.
Clear Chat does not reset costs. Interrupted calls with no final usage may be
absent. Stop cancels active work; Clear cancels and awaits it before clearing.
The developer eye reveals diagnostic activities. Model prose is not proof that
an action happened: actual menu acknowledgments and operation results are the
records. Past operation counts do not reveal exactly which tags were changed.
Never reconstruct a past operation from the current notes/proposals.
