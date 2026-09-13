import { HttpRequestError } from './expected-errors.js';
import { CONFIG } from './config.js';
import { buildSessionHeaders } from './session-auth.js';


export class AuthenticationRequiredError extends HttpRequestError {
    constructor(message) {
        if (typeof message !== 'string' || message.length === 0) {
            throw new Error('AuthenticationRequiredError requires message string');
        }
        super(message);
        this.name = 'AuthenticationRequiredError';
    }
}


async function readResponsePayload(response, fallbackMessage) {
    if (!(response instanceof Response)) {
        throw new Error('readResponsePayload requires Response');
    }
    if (typeof fallbackMessage !== 'string' || fallbackMessage.length === 0) {
        throw new Error('readResponsePayload requires fallbackMessage');
    }

    const responseText = await response.text();
    const contentType = response.headers.get('content-type');
    const isJson = typeof contentType === 'string'
        && contentType.toLowerCase().includes('application/json');
    if (!response.ok) {
        let errorMessage = `${fallbackMessage} (${response.status})`;
        if (isJson && responseText.length > 0) {
            const errorPayload = JSON.parse(responseText);
            if (errorPayload && typeof errorPayload === 'object' && typeof errorPayload.detail === 'string') {
                errorMessage = `${fallbackMessage}: ${errorPayload.detail}`;
            }
        }
        if (response.status === 401) {
            throw new AuthenticationRequiredError(errorMessage);
        }
        throw new HttpRequestError(errorMessage);
    }
    if (!isJson || responseText.length === 0) {
        throw new Error(`${fallbackMessage}: response must be JSON`);
    }
    const payload = JSON.parse(responseText);
    if (!payload || typeof payload !== 'object') {
        throw new Error(`${fallbackMessage}: response payload missing`);
    }
    return payload;
}


export async function loadClientState() {
    const response = await fetch(CONFIG.API.AUTH.CLIENT_STATE, {
        method: 'GET',
        headers: buildSessionHeaders(false),
    });
    return await readResponsePayload(response, 'Failed to load client state');
}


export async function persistClientPreferences(preferences) {
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
        throw new Error('persistClientPreferences requires preferences object');
    }
    const response = await fetch(CONFIG.API.AUTH.CLIENT_PREFERENCES, {
        method: 'PUT',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({ preferences }),
    });
    return await readResponsePayload(response, 'Failed to save client preferences');
}


export async function persistCommandPaletteUsage(commandPaletteUsage) {
    if (!commandPaletteUsage || typeof commandPaletteUsage !== 'object' || Array.isArray(commandPaletteUsage)) {
        throw new Error('persistCommandPaletteUsage requires usage object');
    }
    const response = await fetch(CONFIG.API.AUTH.COMMAND_PALETTE_USAGE, {
        method: 'PUT',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({ command_palette_usage: commandPaletteUsage }),
    });
    return await readResponsePayload(response, 'Failed to save command palette usage');
}
