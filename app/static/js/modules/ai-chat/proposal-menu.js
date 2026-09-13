import { HttpRequestError, rethrowUnexpectedError } from '../expected-errors.js';
import { AiApiError } from './ai-chat-api.js';
import { CONFIG } from '../config.js';
import { buildSessionHeaders } from '../session-auth.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { captureActiveAgentScope } from './ai-chat-panel-controller.js';
import { runMenuProposalOperation } from './bulk-proposal-ui.js';

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
    dialog.innerHTML = settingsOnly
        ? '<h2>Tagging prompt and vocabulary</h2><form><label>Vocabulary <select name="policy"><option value="">Not chosen yet</option><option value="existing">Existing tags only</option><option value="new">Existing and new tags</option></select></label><label>Tagging instructions<textarea name="prompt" maxlength="32000" required></textarea></label><button type="button" data-reset>Reset prompt</button><button type="submit">Save</button><button type="button" data-close>Cancel</button><p role="alert"></p></form>'
        : '<h2>Manage tag proposals</h2><form><label>Action <select name="action"><option value="accept">Accept proposals</option><option value="remove">Remove proposals</option></select></label><label>Scope <select name="target"><option value="current">Current context</option><option value="namespace">Entire namespace</option></select></label><label>Tag filter (leave blank for all proposals)<input name="tag" maxlength="256"></label><p>This bulk operation clears undo/redo after successful changes.</p><button type="submit">Apply</button><button type="button" data-close>Close</button><p role="alert"></p></form>';
    dialog.innerHTML = `<div class="modal-content">${dialog.innerHTML}</div>`;
    dialog.setAttribute('aria-label', settingsOnly ? 'Tagging prompt and vocabulary' : 'Manage tag proposals');
    const form = dialog.querySelector('form');
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    for (const button of form.querySelectorAll('button')) actions.append(button);
    form.append(actions);
    const scope = captureActiveAgentScope();
    if (settingsOnly) {
        const response = await fetch(CONFIG.API.AI.CHAT.replace(/\/chat$/u, '/proposals/settings'), { headers: buildSessionHeaders(false) });
        if (!response.ok) throw new HttpRequestError('Could not load tagging settings');
        const settings = await response.json();
        form.elements.policy.options[0].disabled = true;
        form.elements.policy.value = settings.policy;
        form.elements.prompt.value = settings.prompt;
        dialog.querySelector('[data-reset]').addEventListener('click', () => { form.elements.prompt.value = settings.default_prompt; });
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
                const values = { 'pref.ai.prompt.tagging': form.elements.prompt.value };
                if (form.elements.policy.value !== '') values['pref.ai.tagging.vocabulary'] = form.elements.policy.value;
                await preferences.setMany(values);
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
