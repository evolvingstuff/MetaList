import { HttpRequestError, rethrowUnexpectedError } from './modules/expected-errors.js';
const RENAME_JOB_POLL_INTERVAL_MS = 500;


function requireElement(id) {
    const element = document.getElementById(id);
    if (element === null) {
        throw new Error(`Missing required element: ${id}`);
    }
    return element;
}


function sleep(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}


function requirePageState() {
    const state = window.__METALIST_NAMESPACE_RENAMED__;
    if (!state || typeof state !== 'object') {
        throw new Error('Namespace rename page state is missing');
    }
    for (const key of ['jobId', 'sourceNamespace', 'targetNamespace', 'initialStatus', 'initialError']) {
        if (typeof state[key] !== 'string') {
            throw new Error(`Namespace rename page state missing ${key}`);
        }
    }
    return state;
}


async function fetchRenameJob(jobId) {
    const response = await fetch(`/api2/auth/namespaces/rename-jobs/${jobId}`, { cache: 'no-store' });
    if (!response.ok) {
        throw new HttpRequestError(`Namespace rename job request failed with ${response.status}`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || typeof payload.status !== 'string') {
        throw new Error('Namespace rename job response is invalid');
    }
    return payload;
}


function showSuccess(state) {
    requireElement('namespace-rename-title').textContent = `Namespace renamed to ${state.targetNamespace}`;
    requireElement('namespace-rename-copy').textContent = 'The namespace data, files, backups, and saved ports moved together.';
    const status = requireElement('namespace-rename-status');
    status.dataset.state = 'succeeded';
    requireElement('namespace-rename-status-text').textContent = 'Restart complete. Redirecting to the renamed namespace.';
}


function showFailure(state, errorText) {
    requireElement('namespace-rename-title').textContent = `Could not rename ${state.sourceNamespace}`;
    requireElement('namespace-rename-copy').textContent = 'The rename did not complete. Review the error before retrying.';
    const status = requireElement('namespace-rename-status');
    status.dataset.state = 'failed';
    requireElement('namespace-rename-status-text').textContent = 'Namespace rename failed.';
    const error = requireElement('namespace-rename-error');
    error.textContent = errorText;
    error.classList.remove('hidden');
}


function requireFailureText(rawError) {
    if (typeof rawError !== 'string' || rawError.length === 0) {
        throw new Error('Namespace rename failed without an error message.');
    }
    return rawError;
}


function redirectToRenamedNamespace(jobId) {
    const query = new URLSearchParams({ job: jobId });
    window.location.replace(`/namespace-renamed/open?${query.toString()}`);
}


async function run(state) {
    if (state.initialStatus === 'succeeded') {
        showSuccess(state);
        redirectToRenamedNamespace(state.jobId);
        return;
    }
    if (state.initialStatus === 'failed') {
        showFailure(state, requireFailureText(state.initialError));
        return;
    }
    for (;;) {
        const fetchResult = await fetchRenameJob(state.jobId).then(
            (value) => ({ ok: true, value }),
            (error) => { rethrowUnexpectedError(error); return ({ ok: false, error }); },
        );
        if (!fetchResult.ok) {
            if (!(fetchResult.error instanceof TypeError)) {
                throw fetchResult.error;
            }
            await sleep(RENAME_JOB_POLL_INTERVAL_MS);
            continue;
        }
        if (fetchResult.value.status === 'succeeded') {
            showSuccess(state);
            redirectToRenamedNamespace(state.jobId);
            return;
        }
        if (fetchResult.value.status === 'failed') {
            showFailure(state, requireFailureText(fetchResult.value.error));
            return;
        }
        await sleep(RENAME_JOB_POLL_INTERVAL_MS);
    }
}


void run(requirePageState());
