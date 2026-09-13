export function isNetworkTransportError(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }
    if (typeof error.name !== 'string' || typeof error.message !== 'string') {
        return false;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
        return true;
    }
    return error instanceof TypeError && [
        'Failed to fetch',
        'NetworkError when attempting to fetch resource.',
        'Network request failed',
        'Load failed',
        'fetch failed',
    ].includes(error.message);
}


export function classifyApiFailure(error, response) {
    if (typeof response === 'undefined') {
        throw new Error('classifyApiFailure requires response (use null)');
    }

    if (response !== null) {
        if (typeof response !== 'object') {
            throw new Error('classifyApiFailure response must be an object or null');
        }
        if (!Number.isInteger(response.status)) {
            throw new Error('classifyApiFailure response.status must be an integer');
        }
        if (response.status === 401) {
            return {
                kind: 'auth',
                message: 'Your session has expired. Please log in again.',
            };
        }
        if (response.status >= 500) {
            return {
                kind: 'http',
                message: `Server error (${response.status}). Please try again.`,
            };
        }
        if (response.status >= 400) {
            return {
                kind: 'http',
                message: `Request failed (${response.status}). Please check your input and try again.`,
            };
        }
        return {
            kind: 'http',
            message: `Unexpected error (${response.status}). Please try again.`,
        };
    }

    if (!error || typeof error !== 'object') {
        throw new Error('classifyApiFailure requires error object when response is null');
    }
    if (typeof error.name !== 'string') {
        throw new Error('classifyApiFailure requires error.name string');
    }
    if (typeof error.message !== 'string') {
        throw new Error('classifyApiFailure requires error.message string');
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
        return {
            kind: 'network',
            message: 'The MetaList server is taking a little longer to respond. Editing is paused while we reconnect.',
        };
    }
    if (isNetworkTransportError(error)) {
        return {
            kind: 'network',
            message: 'We\u2019ve lost touch with the MetaList server. Editing is paused while we reconnect.',
        };
    }
    return {
        kind: 'internal',
        error,
    };
}
