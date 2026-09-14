import { ApplicationState } from './application-state.js';
import { CONFIG } from './config.js';
import { buildSessionHeaders } from './session-auth.js';
import { HttpRequestError, rethrowUnexpectedError } from './expected-errors.js';

const state = ApplicationState.createFields('app-update-service', { pageCheck: null, job: null });
const releasePattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const updateUrl = CONFIG.API.AUTH.APP_UPDATE;

export async function updateRequest(path, body) {
    const options = { cache: 'no-store' };
    if (body !== undefined) {
        options.headers = buildSessionHeaders(true);
        options.method = 'POST';
        options.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    options.signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), 15000);
    return fetch(`${updateUrl}${path}`, options).then(async response => {
        if (!response.ok) {
            const payload = await response.json();
            const detail = typeof payload.detail === 'string' ? payload.detail : `HTTP ${response.status}`;
            throw new HttpRequestError(`Update request failed: ${detail}`);
        }
        return await response.json();
    }).finally(() => clearTimeout(timeout));
}

export function validateRelease(release) {
    if (!release || !releasePattern.test(release.current_version) || !releasePattern.test(release.target_version)
        || typeof release.supported !== 'boolean' || typeof release.update_available !== 'boolean'
        || typeof release.message !== 'string') {
        throw new Error('Invalid update check response');
    }
    return release;
}

export async function checkRelease() {
    let outcome;
    try {
        outcome = { release: validateRelease(await updateRequest('/check')), error: '' };
    } catch (error) {
        rethrowUnexpectedError(error);
        outcome = { release: null, error: 'Could not check PyPI for updates. Try again from Version Info.' };
    }
    return outcome;
}

export function checkReleaseOnPageLoad() {
    if (state.pageCheck !== null) throw new Error('Page update check already started');
    state.pageCheck = checkRelease();
}

export async function showUpdateNotice(preferences, openVersionInfo) {
    if (state.pageCheck === null) throw new Error('Page update check has not started');
    const { release } = await state.pageCheck;
    if (release === null || !release.update_available
        || preferences.getRaw('pref.update_notice_version') === release.target_version
        || document.getElementById('app-update-notice')) return;
    const notice = document.createElement('aside');
    notice.id = 'app-update-notice';
    notice.className = 'app-update-notice reminder-surface-item';
    notice.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.textContent = `MetaList ${release.target_version} is available`;
    const view = document.createElement('button');
    view.type = 'button';
    view.textContent = 'Version Info';
    view.addEventListener('click', async () => { await openVersionInfo(); });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = '×';
    dismiss.setAttribute('aria-label', 'Dismiss update notification');
    dismiss.addEventListener('click', () => notice.remove());
    notice.append(label, view, dismiss);
    document.body.appendChild(notice);
    // Remember a version only after its notice is displayed, using existing encrypted preferences.
    try {
        await persistUpdateNotice(preferences, release.target_version);
    } catch (error) {
        rethrowUnexpectedError(error);
        label.textContent += ' (could not save notification preference)';
    }
}


export function rememberUpdateJob(job) {
    if (!job || !['queued', 'preparing', 'installing', 'complete', 'failed'].includes(job.status)
        || typeof job.job_id !== 'string' || typeof job.log_path !== 'string' || typeof job.message !== 'string') {
        throw new Error('Invalid update job response');
    }
    if (JSON.stringify(state.job) !== JSON.stringify(job)) state.job = job;
}

export function currentUpdateJob() { return state.job; }

async function persistUpdateNotice(preferences, version) {
    await preferences.setRaw('pref.update_notice_version', version);
}


export function clearFailedUpdateJob() {
    if (state.job === null || state.job.status !== 'failed') throw new Error('Only a failed update can be cleared for retry');
    state.job = null;
}
