import { HttpRequestError, rethrowUnexpectedError } from './modules/expected-errors.js';
const DELETE_JOB_POLL_INTERVAL_MS = 500;


function requireElement(id) {
    const element = document.getElementById(id);
    if (element === null) {
        throw new Error(`Missing required element: ${id}`);
    }
    return element;
}


function sleep(delayMs) {
    if (!Number.isInteger(delayMs) || delayMs < 0) {
        throw new Error('sleep requires non-negative integer delayMs');
    }
    return new Promise((resolve) => {
        setTimeout(resolve, delayMs);
    });
}


async function fetchDeleteJob(jobId) {
    if (typeof jobId !== 'string' || jobId.length === 0) {
        throw new Error('fetchDeleteJob requires jobId');
    }
    const response = await fetch(`/api2/auth/namespaces/delete-jobs/${jobId}`, {
        cache: 'no-store',
    });
    if (!response.ok) {
        throw new HttpRequestError(`Namespace delete job request failed with ${response.status}`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') {
        throw new Error('Namespace delete job response missing body');
    }
    if (typeof payload.status !== 'string' || payload.status.length === 0) {
        throw new Error('Namespace delete job response missing status');
    }
    return payload;
}


function updateLinksState(state, copyText) {
    if (typeof state !== 'string' || state.length === 0) {
        throw new Error('updateLinksState requires non-empty state');
    }
    if (typeof copyText !== 'string' || copyText.length === 0) {
        throw new Error('updateLinksState requires non-empty copyText');
    }
    const linksElement = requireElement('namespace-deleted-links');
    linksElement.dataset.state = state;
    requireElement('namespace-deleted-links-copy').textContent = copyText;
}


function updatePageForPending(deletedNamespace) {
    requireElement('namespace-deleted-title').textContent = `Deleting namespace ${deletedNamespace}`;
    requireElement('namespace-deleted-copy').textContent = (
        'Please wait while MetaList removes the namespace from disk and finalizes cleanup.'
    );
    const statusElement = requireElement('namespace-deleted-status');
    statusElement.dataset.state = 'pending';
    requireElement('namespace-deleted-status-label').textContent = 'In Progress';
    requireElement('namespace-deleted-status-body').textContent = (
        'The namespace is being removed. This page will update automatically.'
    );
    requireElement('namespace-deleted-error').classList.add('namespace-deleted-hidden');
    updateLinksState('disabled', 'These links unlock when namespace cleanup finishes.');
}


function updatePageForSuccess(deletedNamespace) {
    requireElement('namespace-deleted-title').textContent = `Namespace ${deletedNamespace} deleted`;
    requireElement('namespace-deleted-copy').textContent = (
        'The namespace directory, database files, backups, and launch profile were removed.'
    );
    const statusElement = requireElement('namespace-deleted-status');
    statusElement.dataset.state = 'succeeded';
    requireElement('namespace-deleted-status-label').textContent = 'Completed';
    requireElement('namespace-deleted-status-body').textContent = (
        'Redirecting to the namespace you selected.'
    );
    requireElement('namespace-deleted-error').classList.add('namespace-deleted-hidden');
    updateLinksState('ready', 'Continue manually if the automatic redirect does not begin.');
}


function updatePageForFailure(deletedNamespace, errorText) {
    requireElement('namespace-deleted-title').textContent = `Namespace ${deletedNamespace} failed to delete`;
    requireElement('namespace-deleted-copy').textContent = (
        'Deletion did not complete. The error details are shown below.'
    );
    const statusElement = requireElement('namespace-deleted-status');
    statusElement.dataset.state = 'failed';
    requireElement('namespace-deleted-status-label').textContent = 'Failed';
    requireElement('namespace-deleted-status-body').textContent = (
        'This is a destructive operation failure. Do not assume the namespace is gone.'
    );
    const errorElement = requireElement('namespace-deleted-error');
    errorElement.textContent = errorText;
    errorElement.classList.remove('namespace-deleted-hidden');
    updateLinksState(
        'ready',
        'Open another namespace below, but do not assume the failed namespace is gone.',
    );
}


function requirePageState() {
    const pageState = window.__METALIST_NAMESPACE_DELETED__;
    if (!pageState || typeof pageState !== 'object') {
        throw new Error('Namespace deleted page state is missing');
    }
    if (typeof pageState.deletedNamespace !== 'string' || pageState.deletedNamespace.length === 0) {
        throw new Error('Namespace deleted page missing deletedNamespace');
    }
    if (typeof pageState.jobId !== 'string' || pageState.jobId.length === 0) {
        throw new Error('Namespace deleted page missing jobId');
    }
    if (typeof pageState.redirectNamespace !== 'string' || pageState.redirectNamespace.length === 0) {
        throw new Error('Namespace deleted page missing redirectNamespace');
    }
    return pageState;
}


function redirectToSelectedNamespace(pageState) {
    const query = new URLSearchParams({
        job: pageState.jobId,
        namespace: pageState.redirectNamespace,
    });
    window.location.replace(`/namespace-deleted/open?${query.toString()}`);
}


async function run(pageState) {
    if (pageState.initialStatus === 'succeeded') {
        updatePageForSuccess(pageState.deletedNamespace);
        redirectToSelectedNamespace(pageState);
        return;
    }
    if (pageState.initialStatus === 'failed') {
        const errorText = typeof pageState.initialError === 'string' && pageState.initialError !== ''
            ? pageState.initialError
            : 'Namespace deletion failed without an error message.';
        updatePageForFailure(pageState.deletedNamespace, errorText);
        return;
    }

    updatePageForPending(pageState.deletedNamespace);
    for (;;) {
        const fetchResult = await fetchDeleteJob(pageState.jobId).then(
            (value) => ({ ok: true, value }),
            (error) => { rethrowUnexpectedError(error); return ({ ok: false, error }); },
        );
        if (!fetchResult.ok) {
            const error = fetchResult.error;
            if (!(error instanceof TypeError)) {
                throw error;
            }
            await sleep(DELETE_JOB_POLL_INTERVAL_MS);
            continue;
        }
        const payload = fetchResult.value;
        if (payload.status === 'pending') {
            await sleep(DELETE_JOB_POLL_INTERVAL_MS);
            continue;
        }
        if (payload.status === 'succeeded') {
            updatePageForSuccess(pageState.deletedNamespace);
            redirectToSelectedNamespace(pageState);
            return;
        }
        const errorText = typeof payload.error === 'string' && payload.error !== ''
            ? payload.error
            : 'Namespace deletion failed without an error message.';
        updatePageForFailure(pageState.deletedNamespace, errorText);
        return;
    }
}


async function main() {
    let deletedNamespace = 'this namespace';
    const pageStateResult = await settleResult(() => requirePageState());
    if (!pageStateResult.ok) {
        const error = pageStateResult.error;
        const errorText = error instanceof Error
            ? error.message
            : 'Unknown namespace deletion status error';
        updatePageForFailure(
            deletedNamespace,
            `Namespace deletion status page failed: ${errorText}`,
        );
        return;
    }
    const pageState = pageStateResult.value;
    deletedNamespace = pageState.deletedNamespace;
    const runResult = await settleResult(() => run(pageState));
    if (!runResult.ok) {
        const error = runResult.error;
        const errorText = error instanceof Error
            ? error.message
            : 'Unknown namespace deletion status error';
        updatePageForFailure(
            deletedNamespace,
            `Namespace deletion status page failed: ${errorText}`,
        );
        return;
    }
}


void main();
import { settleResult } from './modules/async-result.js';
