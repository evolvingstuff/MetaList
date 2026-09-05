import { captureUndoContext, captureViewportSnapshot } from '../api-client.js';
import { buildSessionHeaders } from '../session-auth.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { CommandGate } from '../mode-manager/services/command-gate-service.js';

export class DocumentRequestError extends Error {}

export async function documentRequest(path, method, payload) {
    const options = { method, headers: buildSessionHeaders(method !== 'GET') };
    if (method !== 'GET') {
        options.headers['X-Metalist-Claim'] = '1';
        options.body = JSON.stringify({ ...payload, clientId: ModeContext.clientId,
            undoContext: captureUndoContext(), viewport: captureViewportSnapshot() });
    }
    let response;
    // lint: allow-JS001 rationale="fetch transport failures are external and leave the unsaved draft available"
    try {
        response = await fetch(`/api2/documents/${path}`, options);
    // lint: allow-JS001 rationale="only fetch transport failures are converted to a recoverable document error"
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new DocumentRequestError('Could not connect. Your changes are still here; retry Save or Cancel.');
    }
    if (!response.ok) {
        throw new DocumentRequestError(`Could not ${method === 'GET' ? 'load' : 'save'} diagram (HTTP ${response.status}). Your changes have not been saved.`);
    }
    const result = await response.json();
    if (method !== 'GET') CommandGate.markCommandServerCall();
    return result;
}
