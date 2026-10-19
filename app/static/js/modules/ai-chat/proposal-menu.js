import { HttpRequestError, rethrowUnexpectedError } from '../expected-errors.js';
import { AiApiError } from './ai-chat-api.js';
import { CONFIG } from '../config.js';
import { buildSessionHeaders } from '../session-auth.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { captureActiveAgentScope } from './ai-chat-panel-controller.js';
import { runMenuProposalOperation } from './bulk-proposal-ui.js';
import { handleDictationPasteEvent } from '../mode-manager/services/dictation-paste-service.js';

export async function removeAllTagSuggestionsFromCurrentContext() {
    return await runMenuProposalOperation({
        action: 'remove',
        target: 'current',
        tag_filter: '',
        scope: captureActiveAgentScope(),
    });
}

export async function openProposalMenu(preferences, settingsOnly) {
    const dialog = document.createElement('dialog');
    dialog.className = 'bulk-proposal-dialog';
    const formHtml = settingsOnly
        ? '<h2>AI Tagging Vocabulary</h2><form><p>Which tags the AI chat may propose when it tags your notes.</p><label>Vocabulary <select name="policy"><option value="">Not chosen yet</option><option value="existing">Existing tags only</option><option value="new">Existing and new tags</option></select></label><button type="submit">Save</button><button type="button" data-close>Cancel</button><p role="alert"></p></form>'
        : '<h2>AI-Proposed Tags</h2><form><p>Tags the AI chat proposed for your notes. They are not your tags until you accept them; the robot count on a note shows how many it has.</p><label>Action <select name="action"><option value="accept">Accept the proposed tags</option><option value="remove">Reject the proposed tags</option></select></label><label>Scope <select name="target"><option value="current">Current context</option><option value="namespace">Entire namespace</option></select></label><label>Only this tag (leave blank for all proposed tags)<input name="tag" maxlength="256"></label><p>This bulk operation clears undo/redo after successful changes.</p><button type="submit">Apply</button><button type="button" data-close>Close</button><p role="alert"></p></form>';
    dialog.innerHTML = `<div class="modal-content">${formHtml}</div>`;
    dialog.setAttribute('aria-label', settingsOnly ? 'AI tagging vocabulary' : 'AI-proposed tags');
    const form = dialog.querySelector('form');
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    for (const button of form.querySelectorAll('button')) actions.append(button);
    form.append(actions);
    const scope = captureActiveAgentScope();
    if (!settingsOnly) {
        // Dictated text pasted into the tag filter becomes one tag.
        form.elements.tag.addEventListener('paste', (event) => handleDictationPasteEvent(event, 'tag'));
    }
    if (settingsOnly) {
        const response = await fetch(CONFIG.API.AI.CHAT.replace(/\/chat$/u, '/proposals/settings'), { headers: buildSessionHeaders(false) });
        if (!response.ok) throw new HttpRequestError('Could not load tagging settings');
        const settings = await response.json();
        form.elements.policy.options[0].disabled = true;
        form.elements.policy.value = settings.policy;
    }
    const close = () => {
        dialog.close();
        dialog.remove();
        ModeContext.removeModal('proposalMenu');
    };
    dialog.querySelector('[data-close]').addEventListener('click', close);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) {
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
        }
    });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        form.querySelector('[type="submit"]').disabled = true;
        // lint: allow-JS001 rationale="report external settings or proposal request failures; rethrow internal errors"
        try {
            if (settingsOnly) {
                // Nothing to save until a vocabulary is chosen.
                if (form.elements.policy.value !== '') {
                    await preferences.setMany({ 'pref.ai.tagging.vocabulary': form.elements.policy.value });
                }
                close();
            } else {
                const payload = { action: form.elements.action.value, target: form.elements.target.value,
                    tag_filter: form.elements.tag.value.trim(), scope };
                const result = await runMenuProposalOperation(payload);
                form.querySelector('[role="alert"]').textContent = `${result.proposals} proposals updated across ${result.notes} notes.`;
            }
        // lint: allow-JS001 rationale="expected HTTP errors stay visible in the menu; internal exceptions propagate"
        } catch (error) {
            rethrowUnexpectedError(error);
            if (!(error instanceof AiApiError)) throw error;
            form.querySelector('[role="alert"]').textContent = error.message;
        } finally {
            form.querySelector('[type="submit"]').disabled = false;
        }
    });
    document.body.append(dialog);
    ModeContext.pushModal('proposalMenu');
    dialog.showModal();
}
