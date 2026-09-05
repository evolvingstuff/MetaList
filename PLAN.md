# Chat-requested AI tag proposals and bulk proposal management

Status: Approved; implementation in progress on codex/ai-tagging-batches.

Latest batching contract: randomize visible root-tree order for each pass, then plan requests using the configurable tagging batch token window (AI settings, separate Ollama/OpenAI values; defaults 2,000/8,000). Collect accepted vocabulary once over the entire disclosed context and include it in every batch, counting its overhead. Keep complete visible roots and their internal hierarchy/order; an oversized root gets its own batch, subject to the model's hard context check. Feed new terms from completed batches to later batches as optional reuse vocabulary, without treating them as accepted or required. No 64-note grouping or partial-JSON counter. The inline progress bar measures completed batch input tokens / total batch input tokens. Final results still apply atomically.

## Objective

Let the user explicitly ask AI chat to propose tags throughout the current search-visible context. Process the entire context, using multiple model requests when necessary, and apply all resulting proposals atomically. Provide equivalent menu and chat access to bulk acceptance/removal of proposals.

## Agreed product contract

- Batch validation tolerates up to 10% invalid distinct tag assignments, dropping them, and separately up to 10% duplicate or non-batch note-ID entries, dropping those entire entries. Classify IDs as another current-scope batch, a real namespace note outside current scope, or nonexistent using ID-set membership only; never dereference out-of-scope notes. A real out-of-current-scope ID may have been legitimately disclosed under an earlier conversation scope and is not by itself proof of a new leak. Validity follows existing-only/new-only/both mode; command or malformed tags are always invalid. Above either 10% threshold, allow up to three complete-response correction attempts with cumulative feedback, then fail atomically. Malformed response structure remains strict. No vocabulary indices or large tag-enum schema. A syntactically valid suggestion that was absent from disclosed context vocabulary but already exists as an accepted namespace tag is valid and canonicalized in existing/both mode; this post-validation lookup does not disclose the namespace catalog to the model. In new-only mode, silently discard such a collision because the model could not know about an undisclosed namespace tag. Disclosed existing tags remain invalid in new-only mode.

- Generation starts only from an explicit user request in chat. No automatic tagging after edits, opportunistic tagging during unrelated conversations, background scheduler, or menu-triggered generation in this version.
- Evidence contains search-visible root trees, including visible ancestors' content and hierarchy. If A has children B and C and only B matches, supply A and B; do not disclose C or propose directly on C.
- Proposals on A inherit normally, including to unseen C. This is intentional.
- Preserve each search-visible root tree within one batch. Do not silently truncate the overall requested context to a leading portion.
- When all evidence fits the configured provider evidence budget, use one tagging batch. Otherwise explain why processing requires multiple batches and extra time, then cover the entire captured context.
- Use the configured evidence budget; the user's intended large-context setting is 500,000 tokens. Inspect current provider defaults before implementing any settings change rather than silently changing all providers.
- Existing vocabulary means accepted tags collected from the entire permitted search context before batching and supplied to every batch. Do not send the namespace-wide catalog (approximately 11,000 tags). Pending proposals do not establish accepted vocabulary.
- A single categorical preference controls `existing tags only` versus `allow new tags`. Track whether the user has explicitly chosen it. A broad request always asks through one structured existing-only/new-only/both selector and updates this permission from the submitted choice. Do not infer a choice from silence.
- Separately resolve the current pass's focus: missing existing tags, new tags where existing vocabulary falls short, or both (favoring existing tags). Remember the exact last selector choice and preselect it on the next broad request while leaving all three choices available. Explicit focus skips the selector. An explicit new/both request under a saved existing-only policy explains how to change the setting and stops without proposals.
- When new tags are allowed, emphasize existing evidence vocabulary but permit useful new terms. A generated term already existing elsewhere is harmless.
- Provide an editable tagging prompt through the existing prompt menu. Initial guidance favors parent tags describing a group and child tags describing specific children, avoiding redundant inherited classifications. Visible children need not be exhaustive.
- Rejection/removal simply clears proposals. No rejection memory, suppression history, or learning from negative actions in this version.
- Tag generation requires an upfront warning and explicit acceptance or rejection whenever estimated evidence tokens exceed 1× the configured evidence budget. Note count does not determine confirmation. Use the same rule for any future menu generation entry point.
- Bulk acceptance/removal is programmatic and executes directly from chat or the configurable management form, regardless of note/proposal count. The dedicated destructive menu shortcut for removing every current-context suggestion asks for confirmation to prevent accidental activation.
- Show elapsed processing time and actual progress only. Hide and pause the timer during user questions. Do not predict total duration or time remaining.
- Use one existing-only/new-only/both choice for every broad request. Remember and preselect the prior exact choice while keeping all three options selectable. The submitted choice also updates vocabulary permission; do not ask a separate setup question. Combine over-budget confirmation with this question when applicable. New-only output must exclude supplied accepted vocabulary. Use shared modal-content and form-actions styles.
- Tag generation locks the ordinary UI while batches run. Progress, elapsed time, and cancellation remain available until commit. Programmatic bulk acceptance/removal uses the ordinary busy/thinking state and exposes no intermediate progress or cancellation panel.
- Generate and validate every batch before applying any proposals. Apply the complete result in one atomic mutation; a failed or cancelled pass applies nothing.
- Bulk generation, bulk acceptance, and bulk rejection/removal are outside ordinary undo/redo. On successful application, clear the existing undo and redo stacks using the same boundary mechanism as a search-context change. Do not record the bulk operation as an undoable action.
- Failed, cancelled, or declined bulk operations preserve the existing undo/redo stacks. Individual accept/reject actions keep their existing undo behavior.
- Do not add a multi-note undo record, Undo affordance for bulk operations, or per-pass reversal system. An offscreen operation spanning potentially thousands of notes cannot be meaningfully represented as an ordinary current-view Undo action. Bulk accept/remove commands are explicit scoped operations, not undo commands.

## Bulk proposal management

Support identical deterministic operations through the menu and explicit chat requests:

1. Accept all pending proposals of a specified tag within the current context.
2. Remove all pending proposals of a specified tag within the current context.
3. Accept all pending proposals within the current context.
4. Remove all pending proposals within the current context.

Namespace-wide scope must be explicitly selected/requested; default to the current context. Match tag names consistently with existing case-insensitive proposal handling. Bulk removal is not an exact reversal of a tagging pass: it may remove older proposals too.

These operations use application-resolved target sets, not the model's evidence window. Capture targets before mutating, because inheritance and search membership can change during application.

## Preflight and structured questions

- Chat-requested choices and progress live inside the chat transcript, not a modal. Lock chat input and the rest of the app; only operation controls remain usable. Grey and slightly blur the entire non-chat section and show a not-allowed cursor over locked controls. Preserve Cancel until commit and restore interaction on every exit.

- UI refinement: the focus dialog shows only the three choices and action buttons, with existing-only selected initially and Continue required. No placeholder, explanatory paragraph, or intermediate preparation/timer dialog. Timed progress starts with tagging. An explicit-focus request that needs over-budget confirmation still uses its confirmation dialog.

- Introduce an application-owned pending interaction for categorical preference answers and over-budget generation confirmation. When confirmation is required, the original chat request alone must not authorize execution.
- Keep the preference as one categorical setting; choose its exact control presentation during UI design rather than treating its values as separate independent settings.
- Preserve the requested operation and its scope while a question is pending. Revalidate before execution if intervening changes invalidate the preflight.
- For over-budget generation, show action, scope, estimated evidence-to-budget ratio, and planned batches. Explain that multiple model calls are required and the ordinary UI will remain locked, without estimating duration. Future menu generation must use this same contract.
- Generation preflight reports notes to review and planned batches; proposal count is unknown until inference finishes. Acceptance/removal can report exact affected-note and proposal counts.
- Require explicit generation confirmation strictly above 1× the configured evidence budget; at or below 1×, proceed without this additional confirmation. Bulk acceptance/removal requires no extra confirmation because it does not involve model inference.
- Declining a question must leave notes and undo/redo unchanged.

## Implementation sequence

### 1. Verify current boundaries and resolve narrow implementation choices

- Read relevant design/UI documentation and inspect AI route selection, scope freezing, provider inference, prompt settings, proposal mutations, transaction handling, UI command gating, and undo boundaries.
- Verify ancestor content actually meets the agreed A/B evidence contract. Earlier code exploration suggested structural ancestors may be contentless; reconcile implementation with the agreed semantics while preserving provider privacy exclusions.
- Reuse `@password` subtree exclusion and configured cloud disclosure filtering for every batch. Never widen disclosure merely to fill ancestor context.
- Inspect memory-first write-through behavior and rollback handling so atomicity covers canonical in-memory state as well as SQLite.
- The command palette currently bumps the undo epoch when opened (`command-palette-controller.js`, `commandPalette.open`). Reconcile that eager boundary with bulk proposal success-only invalidation: opening the menu or reaching a cancelled/failed/no-change operation must not preemptively destroy the history this contract promises to preserve. Validate the complete menu entry flow, not just the mutation endpoint.
- Implement the agreed generation threshold: estimated evidence tokens divided by the configured evidence budget greater than 1. Do not introduce note-count or proposal-count confirmation thresholds.
- Honor the configured provider-specific evidence budget; changing provider defaults is outside this feature's scope.

### 2. Add settings and pending chat interactions

- Add the categorical new-tag preference and explicit-choice metadata using namespace settings, hydration, and encryption patterns.
- Add the editable tagging prompt using the existing prompt editor/reset conventions.
- Add structured responses for preference selection and operation confirmation, with server-owned pending state, validated answers, cancellation, and session cleanup.
- Preserve normal read-only chat behavior unless the user explicitly requests a proposal operation.

### 3. Add operation preflight and scope capture

- Resolve explicit chat intent into generation, bulk acceptance, or bulk removal with an unambiguous target scope and optional tag filter represented by appropriate distinct request variants.
- Build an immutable operation snapshot and deterministic target set using runtime stores, not runtime SQLite reads.
- Capture accepted vocabulary, existing proposals, hierarchy, disclosure-safe content, and relevant state for validation.
- Randomize search-visible root-tree order, then partition it into batches of complete roots within the configured budget. Preserve internal hierarchy/order. Account for prompt/schema overhead and bounded output size; never silently discard notes or incomplete output.
- Apply shared warning/confirmation rules before starting expensive work.

### 4. Implement the locked batch lifecycle

- Acquire an application-owned active-operation guard and lock ordinary UI interaction before work begins. Guard conflicting server mutations too, so correctness does not rely solely on disabled browser controls.
- Show stages, batch progress, reviewed-note counts, elapsed time, and Cancel. Report generated counts as pending, never as already applied.
- Run structured tagging inference through the existing provider abstraction. Each batch receives only its authorized evidence, the shared accepted vocabulary, and new terms proposed by completed batches as optional reuse vocabulary.
- Validate note IDs against supplied evidence, tag syntax, preference constraints, duplicates, and existing/inherited classifications. Permit a valid empty suggestion result.
- Accumulate validated proposals in session memory without changing canonical proposals. Feed earlier new terms forward separately for optional reuse; never present them as accepted vocabulary.
- Treat bounded provider retries as part of generation; if a batch ultimately fails, discard all pending results. Cancellation must abort provider work and prevent later publication.
- Revalidate scope/session/state immediately before commit. Surface unexpected state changes without partial application.

### 5. Apply atomic mutations and undo boundaries

- Refactor/reuse single-note proposal validation and persistence for a bulk application path that bypasses individual-action undo recording entirely. Create neither per-note undo records nor a combined bulk undo record.
- Keep model/network calls outside the database transaction. Use one short transaction for final writes and coordinate cache/store/index publication so normal readers never observe a partially applied pass.
- Apply all proposal additions or all requested accept/remove changes, update inheritance/search state, and publish the completed sync state.
- After successful application of any bulk generation, acceptance, or rejection/removal operation, clear the existing undo and redo stacks and advance the boundary using the search-context-change mechanism. This is history invalidation, not recording a reversible operation. If no changes are produced, report that nothing changed and preserve history; there is no mutation to invalidate it.
- Preserve body `updated_at` semantics and existing explicit-tag activity behavior on acceptance.
- Make the final commit phase non-cancellable once mutation begins; clearly distinguish cancellation before commit from an already completed operation.
- Release the operation guard/UI lock on every terminal path. Preserve existing fail-fast transaction policy; do not mask internal failures.

### 6. Connect menu and chat bulk management

- Add menu controls for scoped accept/remove operations and wire them to the same preflight, lock, execution, and result contracts as chat. Execute explicit requests without an additional confirmation.
- Keep model reasoning out of deterministic target enumeration and mutation.
- Show the actual scope and affected counts on completion. Keep individual proposal controls working as before.
- On successful generation, list each newly applied proposal with clickable inline references to every affected note and one **Show all new tag proposals** link that opens their combined exact-note view. Do not show the expandable References disclosure for these responses. Preserve tag names in canonical conversation history so follow-up discussion knows what was proposed; later tagging also uses the notes' pending-proposal state and avoids duplicates.

### 7. Validate and document

- Test explicit-request routing, first-use preference selection, saved preference enforcement, and new-tag behavior.
- Test A/B visibility with unseen C: A content is available, C is not sent or directly targeted, and a proposal on A still inherits to C.
- Test privacy exclusions and per-batch accepted vocabulary without namespace catalog disclosure or reinforcement from pending proposals.
- Test one-batch and multi-batch complete coverage, tree preservation, zero-proposal batches, malformed output, and provider failure/cancellation in later batches.
- Test no canonical changes before commit, all-or-nothing persistence and runtime publication, conflicting mutations, session teardown, and UI unlocking.
- Test generation confirmation above 1×, no additional confirmation at or below 1×, declines, and absence of duration predictions. Test direct menu/chat bulk acceptance/removal without additional confirmation, deterministic global/context operations, exact target capture, successful undo clearing, and unchanged undo on failure/cancellation. Retain individual-action undo tests.
- For each bulk operation type, verify that successful application removes pre-existing undo and redo history and creates no new undo entry. Verify that empty results preserve history. Do not introduce a bulk Undo UI or test reversal of a bulk operation through ordinary Undo.
- Exercise large synthetic scopes/proposal sets for memory, output volume, final commit time, and UI responsiveness. Use fixture data rather than live notes.
- Update agent harness and relevant UI/settings documentation to describe narrowly authorized proposal mutations, batching, locking, confirmation, atomicity, and undo boundaries.
- Have the user test the implemented behavior before any code commit under the repository workflow.

## Acceptance criteria

- An explicit chat tagging request covers the entire authorized search-visible context, regardless of whether it needs one model call or several.
- No hidden note content or global vocabulary is disclosed, and direct proposals target only supplied evidence notes.
- No proposed tags become visible or affect search before the entire generation pass succeeds.
- Generation above 1× the configured evidence budget cannot start without explicit confirmation. Bulk acceptance/removal executes directly without extra confirmation; note counts do not govern either rule.
- Ordinary UI is locked during tag generation, with progress and cancellation available before commit. Programmatic acceptance/removal shows the ordinary busy/thinking state and exposes no mid-operation cancellation panel.
- Successful bulk generation, acceptance, and rejection/removal are atomic, clear the pre-existing undo/redo stacks, and create no undo entry. Failure, decline, or cancellation changes neither proposals nor undo/redo. Empty results make no mutation and preserve history.
- Bulk accept/remove works consistently from chat and menu; individual proposal review retains its existing behavior.

## Approval checkpoint

The user approved implementation after documentation checkpoint 676469ee. Implementation changes must remain uncommitted until the user has tested them and explicitly authorizes a code checkpoint or feature commit.


## Implementation status

- Implemented chat routing, full-context batching, structured vocabulary/confirmation questions, editable tagging settings, locked generation progress, atomic proposal application, direct menu/chat bulk acceptance/removal without an intermediate cancelable panel, and a confirmed menu shortcut to remove every suggestion in the current context.
- Removed command-palette open-time history invalidation. Bulk changes clear existing undo/redo only after success and create no undo entry; individual controls remain undoable.
- Automated validation: 1,122 Python tests and 575 JavaScript tests passed; Python and JavaScript startup sanity gates passed. An isolated browser preview verified the categorical preference dialog and disabled Proceed before selection. Synthetic coverage includes remembered three-way focus selection, tag-result combined-view links, 2,000 roots, later-batch failure/cancellation, bounded correction retries, unchanged history on no-ops, exact bulk filters, programmatic removal without a progress panel, unseen-sibling inheritance, and root-only versus recursive collapse behavior. Live model quality and full application interaction still require user testing. The latest completed checkpoint is `dbce614b`; this follow-up fix remains uncommitted pending user testing.
