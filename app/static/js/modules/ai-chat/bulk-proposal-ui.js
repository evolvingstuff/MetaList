import { ApplicationState } from '../application-state.js';
import { rethrowUnexpectedError } from '../expected-errors.js';
import { AiApiError } from './ai-chat-api.js';
import { createBulkElapsedClock } from './bulk-elapsed-clock.js';
import { renderSummaryBatchPreview } from './summary-batch-preview.js';
import {
    TAG_FOCUS_CHOICES,
    describeScopeQuestion,
    scopeAnswerValue,
} from './bulk-scope-question.js';
import { CommandGate } from '../mode-manager/services/command-gate-service.js';
import { buildSessionHeaders } from '../session-auth.js';
import { CONFIG } from '../config.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { actionRefreshAndMaybeSelect } from '../mode-manager/actions/ui-actions.js';
import { MS_PER_SECOND } from '../time-units.js';

// The batch list counts as scrolled to the newest batch within this distance of its end.
const FOLLOW_NEWEST_BATCH_SLACK_PX = 24;

const baseUrl = CONFIG.API.AI.CHAT.replace(/\/chat$/u, '/proposals');
const moduleState = ApplicationState.createFields('bulk-proposal-ui', {
    active: null,
    headlessCompletion: null,
});


export async function proposalRequest(path, payload, signal) {
    let response;
    try {
        response = await fetch(`${baseUrl}/${path}`, {
            method: 'POST', headers: buildSessionHeaders(true), body: JSON.stringify(payload), signal,
        });
    } catch (error) {
            rethrowUnexpectedError(error);
        if (error instanceof TypeError) throw new AiApiError('Could not reach the MetaList proposal service');
        throw error;
    }
    if (!response.ok) {
        const error = await response.json();
        throw new AiApiError(typeof error.detail === 'string' ? error.detail : 'Proposal operation failed');
    }
    return response;
}

function openProgress(abortController, chatHost, initialEvent) {
    const isSummary = initialEvent.kind === 'summary_confirmation';
    const isModal = chatHost === null;
    const dialog = document.createElement(isModal ? 'dialog' : 'section');
    dialog.className = isModal
        ? 'bulk-proposal-dialog'
        : isSummary ? 'ai-chat-summary-operation' : 'ai-chat-tag-operation';
    const operationLabel = isSummary ? 'Complete scope summary' : 'Tag proposals';
    dialog.setAttribute('aria-label', operationLabel);
    dialog.innerHTML = `<div class="modal-content"><h2>${operationLabel}</h2><progress data-progress hidden aria-label="${isSummary ? 'Summary' : 'Tagging'} progress"></progress><p data-status role="status"></p><p data-elapsed hidden></p><div data-summary-batches class="summary-batch-stack" aria-live="polite" hidden></div><div data-question></div><p data-error role="alert"></p><div class="form-actions"><button type="button" data-cancel class="cancel-btn">Cancel</button><span data-submit></span></div></div>`;
    if (!isModal) dialog.firstElementChild.className = 'ai-chat-tag-controls';
    const inertSiblings = [];
    if (isModal) {
        document.body.append(dialog);
        ModeContext.pushModal('bulkProposals');
    } else {
        chatHost.append(dialog);
        if (!isSummary) document.body.classList.add('ai-tagging-locked');
        // Keep the active chat controls usable while freezing the surrounding app.
        for (let branch = chatHost; branch.parentElement !== null; branch = branch.parentElement) {
            for (const sibling of branch.parentElement.children) {
                if (sibling === branch || sibling.inert) continue;
                if (!isSummary) {
                    sibling.inert = true;
                    if (!sibling.closest('#ai-chat-panel')) sibling.classList.add('ai-tagging-locked-region');
                    inertSiblings.push(sibling);
                }
            }
        }
    }
    const cancel = () => {
        if (!dialog.querySelector('[data-cancel]').disabled) abortController.abort();
    };
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); cancel(); });
    dialog.addEventListener('click', (event) => {
        if (!isModal || event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right
            || event.clientY < bounds.top || event.clientY > bounds.bottom) cancel();
    });
    dialog.querySelector('[data-cancel]').addEventListener('click', cancel);
    const clock = createBulkElapsedClock(() => performance.now());
    const timer = setInterval(() => {
        dialog.querySelector('[data-elapsed]').textContent = `Processing time: ${clock.seconds()}s`;
    }, MS_PER_SECOND);
    if (isModal) dialog.showModal();
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const gate = CommandGate.run('bulkProposals', async () => waiting, { disableWatchdog: true });
    moduleState.active = {
        dialog, timer, clock, completion: null, release, gate, isModal,
        inertSiblings, operation: isSummary ? 'summary' : 'tagging',
    };
}

function createTagFocusSelect(focusDefault) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Tags to suggest for this pass');
    for (const [value, label] of TAG_FOCUS_CHOICES) select.add(new Option(label, value));
    select.value = focusDefault;
    return select;
}

export function handleBulkEvent(event, abortController, chatHost) {
    if (event.type === 'bulk_preferences') {
        document.dispatchEvent(new CustomEvent('metalist:bulk-preferences', { detail: event.preferences }));
        return;
    }
    if (event.type === 'bulk_complete' && moduleState.active === null) {
        moduleState.headlessCompletion = { changed: event.changed };
        if (event.changed) ModeContext.bumpUndoContextEpoch('bulkProposals.success');
        return;
    }
    if (moduleState.active === null) openProgress(abortController, chatHost, event);
    const { dialog } = moduleState.active;
    if (event.type === 'bulk_complete') {
        moduleState.active.clock.pause();
        moduleState.active.completion = { changed: event.changed };
        if (event.changed) ModeContext.bumpUndoContextEpoch('bulkProposals.success');
        return;
    }
    dialog.querySelector('[data-status]').textContent = event.label;
    dialog.querySelector('[data-status]').hidden = false;
    if (event.type === 'bulk_progress') {
        if ('summary_batch_preview' in event) {
            if (moduleState.active.operation !== 'summary') {
                throw new Error('Only summary operations may render batch previews');
            }
            const stack = dialog.querySelector('[data-summary-batches]');
            // Follow the newest batches unless the user scrolled up to read earlier ones.
            let wasFollowingNewest = true;
            if (!stack.hidden) {
                wasFollowingNewest = (
                    stack.scrollHeight - stack.scrollTop - stack.clientHeight < FOLLOW_NEWEST_BATCH_SLACK_PX
                );
            }
            renderSummaryBatchPreview(stack, event.summary_batch_preview);
            if (wasFollowingNewest) stack.scrollTop = stack.scrollHeight;
        }
        const progressBar = dialog.querySelector('[data-progress]');
        progressBar.hidden = false;
        if ('completed_tokens' in event) {
            progressBar.max = event.total_tokens;
            progressBar.value = event.completed_tokens;
        }
        let cancelButton = dialog.querySelector('[data-cancel]');
        // Rewire the scope-question Cancel once: streamed previews arrive many times
        // per second, and replacing the button each time would swallow Cancel clicks.
        if (cancelButton.dataset.answersQuestion === 'true') {
            const progressCancel = cancelButton.cloneNode(true);
            delete progressCancel.dataset.answersQuestion;
            cancelButton.replaceWith(progressCancel);
            progressCancel.addEventListener('click', () => abortController.abort());
            cancelButton = progressCancel;
        }
        cancelButton.textContent = 'Cancel';
        cancelButton.classList.remove('operation-close');
        const formActions = dialog.querySelector('.form-actions');
        if (formActions.firstElementChild !== cancelButton) formActions.prepend(cancelButton);
        moduleState.active.clock.resume();
        dialog.querySelector('[data-elapsed]').hidden = false;
        dialog.querySelector('[data-question]').replaceChildren();
        dialog.querySelector('[data-submit]').replaceChildren();
        dialog.querySelector('[data-cancel]').disabled = event.committing;
        return;
    }
    if (event.type !== 'bulk_question') throw new Error(`Unknown bulk event ${event.type}`);
    // Summaries and tag proposals share one equivalent scope card.
    const question = describeScopeQuestion(event);
    moduleState.active.clock.pause();
    dialog.querySelector('[data-progress]').hidden = true;
    dialog.querySelector('[data-elapsed]').hidden = true;
    dialog.querySelector('[data-error]').textContent = '';
    const focusSelect = question.focusDefault === null
        ? null
        : createTagFocusSelect(question.focusDefault);
    const selectedFocus = () => (focusSelect === null ? null : focusSelect.value);
    const questionArea = dialog.querySelector('[data-question]');
    if (focusSelect === null) questionArea.replaceChildren();
    else questionArea.replaceChildren(focusSelect);
    const controls = [];
    const answer = async (value) => {
        for (const control of controls) control.disabled = true;
        // lint: allow-JS001 rationale="submit an external HTTP answer; rethrow internal failures"
        try {
            await proposalRequest('answer', {
                question_id: event.question_id,
                value,
            }, abortController.signal);
        // lint: allow-JS001 rationale="user cancellation and HTTP rejection are expected; internal errors propagate"
        } catch (error) {
            rethrowUnexpectedError(error);
            if (abortController.signal.aborted) return;
            if (!(error instanceof AiApiError)) throw error;
            dialog.querySelector('[data-error]').textContent = error.message;
            for (const control of controls) control.disabled = false;
        }
    };
    const processAll = document.createElement('button');
    processAll.type = 'button';
    processAll.textContent = question.allLabel;
    processAll.addEventListener('click', () => answer(
        scopeAnswerValue(event, 'all', selectedFocus()),
    ));
    const choiceButtons = [processAll];
    if (question.prefixLabel !== null) {
        const prefix = document.createElement('button');
        prefix.type = 'button';
        prefix.className = 'secondary-btn';
        prefix.textContent = question.prefixLabel;
        prefix.addEventListener('click', () => answer(
            scopeAnswerValue(event, 'prefix', selectedFocus()),
        ));
        choiceButtons.push(prefix);
    }
    const cancel = dialog.querySelector('[data-cancel]');
    const cleanCancel = cancel.cloneNode(true);
    cancel.replaceWith(cleanCancel);
    cleanCancel.textContent = 'Cancel';
    cleanCancel.removeAttribute('aria-label');
    cleanCancel.removeAttribute('title');
    cleanCancel.classList.remove('operation-close');
    cleanCancel.classList.add('summary-cancel-btn');
    // This button answers the question; progress rewires it to abort instead.
    cleanCancel.dataset.answersQuestion = 'true';
    cleanCancel.addEventListener('click', () => answer('cancel'));
    controls.push(...choiceButtons, cleanCancel);
    if (focusSelect !== null) controls.push(focusSelect);
    dialog.querySelector('[data-submit]').replaceChildren(...choiceButtons);
    dialog.querySelector('.form-actions').append(cleanCancel);
    if (focusSelect === null) processAll.focus();
    else focusSelect.focus();
}

async function refreshAfterBulkProposalChange() {
    await actionRefreshAndMaybeSelect({
        resetViewCacheBeforeFetch: true,
        requireExecution: true,
        context: 'bulkProposals.success',
    });
}

/**
 * A summary card that only asked for permission (prefix, single payload, or cancel)
 * has nothing left to show once the operation completes, so it closes before the
 * answer streams instead of leaving disabled choices behind. Staged summaries keep
 * their batch stack visible above the final answer.
 */
export function bulkProgressEndsAtCompletion() {
    if (moduleState.active === null || moduleState.active.completion === null) return false;
    if (moduleState.active.operation !== 'summary') return false;
    const stack = moduleState.active.dialog.querySelector('[data-summary-batches]');
    if (stack === null) throw new Error('Summary batch stack is missing');
    return stack.childElementCount === 0;
}

export async function closeBulkProgress() {
    if (moduleState.active === null) {
        if (moduleState.headlessCompletion === null) return;
        const completion = moduleState.headlessCompletion;
        moduleState.headlessCompletion = null;
        if (completion.changed) await refreshAfterBulkProposalChange();
        return;
    }
    const { dialog, timer, completion, release, gate, isModal, inertSiblings } = moduleState.active;
    clearInterval(timer);
    if (isModal) dialog.close();
    dialog.remove();
    if (isModal) ModeContext.removeModal('bulkProposals');
    for (const sibling of inertSiblings) {
        sibling.inert = false;
        sibling.classList.remove('ai-tagging-locked-region');
    }
    if (!isModal) document.body.classList.remove('ai-tagging-locked');
    moduleState.active = null;
    release();
    await gate;
    if (completion !== null && completion.changed) await refreshAfterBulkProposalChange();
}

export async function runMenuProposalOperation(payload) {
    const result = await CommandGate.run('bulkProposals.manage', async () => {
        const response = await proposalRequest('manage', payload);
        const result = await response.json();
        if (result.changed) {
            ModeContext.bumpUndoContextEpoch('bulkProposals.success');
            await refreshAfterBulkProposalChange();
        }
        return result;
    });
    if (result === null) {
        throw new Error('Proposal management was blocked by another command');
    }
    return result;
}
