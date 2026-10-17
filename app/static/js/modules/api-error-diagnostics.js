import { isServerErrorStatus } from './http-status.js';

const ERROR_TYPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CODE_LOCATION = /^(?:app(?:\/[A-Za-z_][A-Za-z0-9_]*)+\.py:\d+|external)$/;
const REQUEST_ID = /^[a-f0-9]{8}$/;

export async function describeApiFailure(response) {
    const base = `API call failed: ${response.status} ${response.statusText}`;
    if (!isServerErrorStatus(response.status) || !response.headers.get('content-type')?.includes('application/json')) {
        return base;
    }

    const body = await response.json();
    const diagnostic = body?.diagnostic;
    if (!ERROR_TYPE.test(diagnostic?.errorType) || !CODE_LOCATION.test(diagnostic?.codeLocation)) {
        return base;
    }
    const requestId = REQUEST_ID.test(diagnostic.requestId)
        ? `, request ${diagnostic.requestId}`
        : '';
    return `${base} (${diagnostic.errorType} at ${diagnostic.codeLocation}${requestId})`;
}
