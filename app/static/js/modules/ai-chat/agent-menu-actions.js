import { HttpRequestError, rethrowUnexpectedError } from '../expected-errors.js';

// Dialog destinations open their forms; operation destinations only highlight a menu entry.
export async function openAgentMenu({ menuId, endpoints, isCurrent, hasOpenModal, queryElement, showMenuEntry, signal }) {
    const response = await fetch('/static/config/agent-menu-actions.json', { signal });
    if (!response.ok) throw new HttpRequestError('Could not load menu catalog');
    const catalog = await response.json();
    const target = catalog.find((entry) => entry.id === menuId);
    if (!target) throw new Error(`Unsupported agent menu: ${menuId}`);
    if (signal.aborted) return { status: 'cancelled', detail: 'Request was cancelled.' };
    if (!isCurrent()) return { status: 'unavailable', detail: 'The active context changed.' };
    if (hasOpenModal()) return { status: 'unavailable', detail: 'Another dialog is already open.' };
    if (target.presentation === 'palette') {
        await showMenuEntry(target.id);
    } else {
        if (target.presentation !== 'dialog') throw new Error('Invalid menu presentation');
        const endpoint = endpoints.find((entry) => entry.id === target.id);
        if (!endpoint || typeof endpoint.execute !== 'function') throw new Error(`Missing menu command: ${target.id}`);
        await endpoint.execute();
    }
    const isShown = (selector) => {
        const element = queryElement(selector);
        return Boolean(element) && element.getClientRects().length > 0;
    };
    if (isShown(target.selector)) {
        return { status: 'opened', detail: target.label };
    }
    // Some destinations open another dialog when theirs cannot act (Open/Switch
    // namespace with no other namespace opens Create namespace): say which.
    if ('alternate_dialog' in target && isShown(target.alternate_dialog.selector)) {
        return { status: 'opened', detail: target.alternate_dialog.label };
    }
    return { status: 'unavailable', detail: 'The dialog did not open.' };
}

export async function executeAgentMenuRequest({ event, signal, openMenu, acknowledge }) {
    if (signal.aborted) return;
    let result;
    // lint: allow-JS001 rationale="acknowledge external UI/network failures; internal errors propagate"
    try {
        result = await openMenu(event.menu_id, event.scope, signal);
    // lint: allow-JS001 rationale="cancelled or failed external requests are acknowledged without masking programming errors"
    } catch (error) {
        rethrowUnexpectedError(error);
        if (signal.aborted) return;
        if (!(error instanceof HttpRequestError)) throw error;
        result = { status: 'unavailable', detail: error.message };
    }
    if (signal.aborted) return;
    await acknowledge({ request_id: event.request_id, ...result });
}
