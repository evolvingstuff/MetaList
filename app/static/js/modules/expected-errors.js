import { isNetworkTransportError } from './api-failure-classification-service.js';

export class UserInputRejected extends Error {}

export class HttpRequestError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HttpRequestError';
    }
}

export function isRequestCancellation(error, signal) {
    return signal instanceof AbortSignal && signal.aborted
        && (error === signal.reason || (error instanceof DOMException && error.name === 'AbortError'));
}

// This whitelist covers expected platform failures, not arbitrary Error,
// TypeError, or errors whose message merely happens to mention fetch.
export function rethrowUnexpectedError(error) {
    if (error instanceof UserInputRejected || error instanceof HttpRequestError || isNetworkTransportError(error)) return;
    if (error instanceof DOMException && ['NotAllowedError', 'AbortError', 'NotSupportedError'].includes(error.name)) return;
    throw error;
}
