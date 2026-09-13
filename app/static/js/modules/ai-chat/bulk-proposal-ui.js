import { ApplicationState } from '../application-state.js';
import { rethrowUnexpectedError } from '../expected-errors.js';
import { AiApiError } from './ai-chat-api.js';
import { createBulkElapsedClock } from './bulk-elapsed-clock.js';
import { CommandGate } from '../mode-manager/services/command-gate-service.js';
import { buildSessionHeaders } from '../session-auth.js';
import { CONFIG } from '../config.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { actionRefreshAndMaybeSelect } from '../mode-manager/actions/ui-actions.js';

const baseUrl = CONFIG.API.AI.CHAT.replace(/\/chat$/u, '/proposals');
const moduleState = ApplicationState.createFields('bulk-proposal-ui', {
    active: null,
    headlessChanged: false,
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

function openProgress(abortController, chatHost) {
    const isModal = chatHost === null;
    const dialog = document.createElement(isModal ? 'dialog' : 'section');
    dialog.className = isModal ? 'bulk-proposal-dialog' : 'ai-chat-tag-operation';
    dialog.setAttribute('aria-label', 'Tag proposals');
    dialog.innerHTML = '<div class="modal-content"><h2>Tag proposals</h2><progress data-progress hidden aria-label="Tagging progress"></progress><p data-status role="status"></p><p data-elapsed hidden></p><div data-question></div><p data-error role="alert"></p><div class="form-actions"><button type="button" data-cancel class="cancel-btn">Cancel</button><span data-submit></span></div></div>';
    if (!isModal) dialog.firstElementChild.className = 'ai-chat-tag-controls';
    const inertSiblings = [];
    if (isModal) {
        document.body.append(dialog);
        ModeContext.pushModal('bulkProposals');
    } else {
        chatHost.append(dialog);
        document.body.classList.add('ai-tagging-locked');
        // Keep the active chat controls usable while freezing the surrounding app.
        for (let branch = chatHost; branch.parentElement !== null; branch = branch.parentElement) {
            for (const sibling of branch.parentElement.children) {
                if (sibling === branch || sibling.inert) continue;
                sibling.inert = true;
                if (!sibling.closest('#ai-chat-panel')) sibling.classList.add('ai-tagging-locked-region');
                inertSiblings.push(sibling);
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
    }, 1000);
    if (isModal) dialog.showModal();
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const gate = CommandGate.run('bulkProposals', async () => waiting, { disableWatchdog: true });
    moduleState.active = { dialog, timer, clock, changed: false, release, gate, isModal, inertSiblings };
}

export function handleBulkEvent(event, abortController, chatHost) {
    if (event.type === 'bulk_preferences') {
        document.dispatchEvent(new CustomEvent('metalist:bulk-preferences', { detail: event.preferences }));
        return;
    }
    if (event.type === 'bulk_complete' && moduleState.active === null) {
        moduleState.headlessChanged = event.changed;
        if (event.changed) ModeContext.bumpUndoContextEpoch('bulkProposals.success');
        return;
    }
    if (moduleState.active === null) openProgress(abortController, chatHost);
    const { dialog } = moduleState.active;
    if (event.type === 'bulk_complete') {
        moduleState.active.clock.pause();
        moduleState.active.changed = event.changed;
        if (event.changed) ModeContext.bumpUndoContextEpoch('bulkProposals.success');
        return;
    }
    dialog.querySelector('[data-status]').textContent = event.label;
    dialog.querySelector('[data-status]').hidden = event.type === 'bulk_question' && event.kind === 'focus';
    if (event.type === 'bulk_progress') {
        const progressBar = dialog.querySelector('[data-progress]');
        progressBar.hidden = false;
        if ('completed_tokens' in event) {
            progressBar.max = event.total_tokens;
            progressBar.value = event.completed_tokens;
        }
        const cancelButton = dialog.querySelector('[data-cancel]');
        cancelButton.textContent = 'Cancel';
        cancelButton.classList.remove('operation-close');
        dialog.querySelector('.form-actions').prepend(cancelButton);
        moduleState.active.clock.resume();
        dialog.querySelector('[data-elapsed]').hidden = false;
        dialog.querySelector('[data-question]').replaceChildren();
        dialog.querySelector('[data-submit]').replaceChildren();
        dialog.querySelector('[data-cancel]').disabled = event.committing;
        return;
    }
    if (event.type !== 'bulk_question') throw new Error(`Unknown bulk event ${event.type}`);
    const cancelButton = dialog.querySelector('[data-cancel]');
    cancelButton.textContent = '×';
    cancelButton.setAttribute('aria-label', 'Cancel tagging');
    cancelButton.title = 'Cancel tagging';
    cancelButton.classList.add('operation-close');
    dialog.querySelector('h2').after(cancelButton);
    moduleState.active.clock.pause();
    dialog.querySelector('[data-progress]').hidden = true;
    dialog.querySelector('[data-elapsed]').hidden = true;
    dialog.querySelector('[data-error]').textContent = '';
    const area = dialog.querySelector('[data-question]');
    area.replaceChildren();
    let select = null;
    if (event.kind === 'focus') {
        select = document.createElement('select');
        select.setAttribute('aria-label', 'Tags to suggest for this pass');
        const choices = [['focus_existing', 'Existing tags only'],
            ['focus_new', 'New tags only'], ['focus_both', 'Both, favoring existing tags']];
        for (const [value, label] of choices) {
            select.add(new Option(label, value));
        }
        if (!choices.some(([value]) => value === event.default_value)) {
            throw new Error('Tag focus question requires a valid default_value');
        }
        select.value = event.default_value;
        area.append(select);
    }
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = event.kind === 'confirmation' ? 'Start tagging' : 'Continue';
    submit.addEventListener('click', async () => {
        submit.disabled = true;
        if (select !== null) select.disabled = true;
        // lint: allow-JS001 rationale="report expected HTTP answer failures and user cancellation; rethrow internal errors"
        try {
            await proposalRequest('answer', { question_id: event.question_id, value: select === null ? 'proceed' : select.value }, abortController.signal);
        // lint: allow-JS001 rationale="user cancellation is expected; internal errors are rethrown"
        } catch (error) {
            rethrowUnexpectedError(error);
            if (abortController.signal.aborted) return;
            if (!(error instanceof AiApiError)) throw error;
            dialog.querySelector('[data-error]').textContent = error.message;
            submit.disabled = false;
            if (select !== null) select.disabled = false;
        }
    });
    dialog.querySelector('[data-submit]').replaceChildren(submit);
    if (select !== null) select.focus();
    else submit.focus();
}

async function refreshAfterBulkProposalChange() {
    await actionRefreshAndMaybeSelect({
        resetViewCacheBeforeFetch: true,
        requireExecution: true,
        context: 'bulkProposals.success',
    });
}

export async function closeBulkProgress() {
    if (moduleState.active === null) {
        const changed = moduleState.headlessChanged;
        moduleState.headlessChanged = false;
        if (changed) await refreshAfterBulkProposalChange();
        return;
    }
    const { dialog, timer, changed, release, gate, isModal, inertSiblings } = moduleState.active;
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
    if (changed) await refreshAfterBulkProposalChange();
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
