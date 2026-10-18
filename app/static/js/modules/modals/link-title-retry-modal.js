import { ApplicationState } from '../application-state.js';
import { BaseModal } from './base-modal.js';
import { NotesAPI } from '../api-client.js';
import { escapeHtml } from '../html-escape.js';

// Progress of "Retry failed link titles" (docs/ui/command-palette.md). The retry
// runs on the server; closing this dialog leaves it running, and opening the
// action again shows its progress. Stop drops the lookups not yet started.

const POLL_INTERVAL_MS = 1000;
const RUN_STATUSES = new Set(['idle', 'running', 'stopping', 'finished', 'stopped']);

const REASON_LABELS = {
    http_429: 'too many requests',
    http_403: 'refused by the site',
    http_404: 'page not found',
    http_410: 'page gone',
    interstitial_title: 'login, consent or verification page',
    no_title: 'no title on the page',
    timeout: 'timed out',
    dns_error: 'site not found',
    network_error: 'network error',
};

function requireCount(value, name) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Link title retry progress requires a count for ${name}`);
    }
    return value;
}

function requireCounts(value, name) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Link title retry progress requires ${name} counts`);
    }
    return Object.entries(value).map(([key, count]) => [key, requireCount(count, `${name}.${key}`)]);
}

export function describeLinkTitleRetryReason(kind) {
    if (typeof kind !== 'string' || kind.length === 0) {
        throw new Error('describeLinkTitleRetryReason requires a reason');
    }
    if (Object.prototype.hasOwnProperty.call(REASON_LABELS, kind)) {
        return REASON_LABELS[kind];
    }
    const httpStatus = /^http_(\d{3})$/.exec(kind);
    if (httpStatus !== null) {
        return `HTTP ${httpStatus[1]}`;
    }
    return kind.replaceAll('_', ' ');
}

/** What the dialog shows before a run: how many links it would ask, and the start button. */
export function describeLinkTitleRetryStart(retryable) {
    requireCount(retryable, 'retryable');
    if (retryable === 0) {
        return { statusLine: 'No failed link titles to retry.', startLabel: '' };
    }
    let noun = 'titles';
    let linkNoun = 'links';
    if (retryable === 1) {
        noun = 'title';
        linkNoun = 'link';
    }
    return {
        statusLine: `${retryable} failed link ${noun} can be asked again.`,
        startLabel: `Retry ${retryable} ${linkNoun}`,
    };
}

/** What the dialog shows for a progress snapshot from the server. */
export function describeLinkTitleRetry(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object' || !RUN_STATUSES.has(snapshot.status)) {
        throw new Error('Link title retry progress requires a known status');
    }
    const total = requireCount(snapshot.total, 'total');
    const asked = requireCount(snapshot.asked, 'asked');
    const found = requireCount(snapshot.found, 'found');
    const skipped = requireCount(snapshot.skipped, 'skipped');
    const dropped = requireCount(snapshot.dropped, 'dropped');
    const stillFailing = requireCounts(snapshot.stillFailing, 'stillFailing');
    const pausedSites = requireCounts(snapshot.pausedSites, 'pausedSites');
    const paused = pausedSites.reduce((sum, [, count]) => sum + count, 0);
    const failing = stillFailing.reduce((sum, [, count]) => sum + count, 0);
    const accounted = asked + paused + skipped + dropped;

    let noun = 'links';
    if (total === 1) {
        noun = 'link';
    }
    let statusLine = `Asked ${asked} of ${total} ${noun}`;
    if (snapshot.status === 'idle') {
        statusLine = 'No retry has run yet';
    } else if (snapshot.status === 'stopping') {
        statusLine = `Stopping: finishing the lookups in progress (asked ${asked} of ${total})`;
    } else if (snapshot.status === 'finished') {
        statusLine = `Done: asked ${asked} of ${total} ${noun}`;
    } else if (snapshot.status === 'stopped') {
        statusLine = `Stopped: asked ${asked} of ${total} ${noun}`;
    }

    const rows = [
        { label: 'Titles found', value: String(found) },
        { label: 'Still failing', value: String(failing) },
    ];
    for (const [kind, count] of [...stillFailing].sort((a, b) => b[1] - a[1])) {
        rows.push({ label: ` ${describeLinkTitleRetryReason(kind)}`, value: String(count) });
    }
    for (const [site, count] of pausedSites) {
        rows.push({ label: `Skipped, ${site} asked MetaList to wait`, value: String(count) });
    }
    if (skipped > 0) {
        rows.push({ label: 'Skipped, already being looked up', value: String(skipped) });
    }
    if (dropped > 0) {
        rows.push({ label: 'Not asked (stopped)', value: String(dropped) });
    }
    return {
        statusLine,
        rows,
        progressValue: accounted,
        progressMax: total,
        canStop: snapshot.status === 'running',
        isActive: ['running', 'stopping'].includes(snapshot.status),
    };
}

export class LinkTitleRetryModal extends BaseModal {
    constructor() {
        super('linkTitleRetryModal', 'link-title-retry-modal');
        this._pollTimer = null;
        this._snapshot = null;
        ApplicationState.own(this, 'LinkTitleRetryModal', new.target === LinkTitleRetryModal);
    }

    /**
     * Open with the progress just returned by the server: a run in progress is
     * shown as such; otherwise the dialog offers to start one (nothing runs yet).
     */
    openWithProgress(snapshot) {
        describeLinkTitleRetry(snapshot);
        this._snapshot = snapshot;
        return this.open();
    }

    getInitialModalState() {
        if (this._snapshot === null) {
            throw new Error('LinkTitleRetryModal requires progress before opening');
        }
        const isOffer = !describeLinkTitleRetry(this._snapshot).isActive;
        return { snapshot: this._snapshot, isOffer };
    }

    showModalElement() {
        let modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            modalElement = document.createElement('div');
            modalElement.id = this.modalElementId;
            modalElement.className = 'modal';
            modalElement.style.display = 'none';
            document.body.appendChild(modalElement);
        }
        this.renderModalContent();
        modalElement.style.display = 'block';
    }

    onOpen() {
        this._schedulePoll();
    }

    onClose() {
        if (this._pollTimer !== null) {
            window.clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
        this._snapshot = null;
    }

    _schedulePoll() {
        const state = this.getModalState();
        if (state.isOffer || !describeLinkTitleRetry(state.snapshot).isActive) {
            return;
        }
        this._pollTimer = window.setTimeout(() => {
            this._pollTimer = null;
            void this._poll();
        }, POLL_INTERVAL_MS);
    }

    async _poll() {
        const snapshot = await NotesAPI.getLinkTitleRetry();
        if (!this.isOpen) {
            return;
        }
        this._showProgress(snapshot);
        this._schedulePoll();
    }

    _showProgress(snapshot) {
        describeLinkTitleRetry(snapshot);
        const state = this.getModalState();
        // Unchanged progress (a slow lookup) is not a state change.
        if (!state.isOffer && JSON.stringify(snapshot) === JSON.stringify(state.snapshot)) {
            return;
        }
        this.updateModalState({ snapshot, isOffer: false });
        this.renderModalContent();
    }

    async _start() {
        const snapshot = await NotesAPI.startLinkTitleRetry();
        if (!this.isOpen) {
            return;
        }
        this._showProgress(snapshot);
        this._schedulePoll();
    }

    _renderOffer(modalElement, snapshot) {
        const offer = describeLinkTitleRetryStart(snapshot.retryable);
        let actions = '';
        let description = '';
        if (offer.startLabel !== '') {
            description = '<p class="link-title-retry-note">MetaList asks each site again, one request at a time per site. '
                + 'Sites that ask MetaList to wait are skipped. You can keep working while it runs.</p>';
            actions = `<button type="button" class="primary-btn" id="link-title-retry-start-btn" data-modal-enter-action>${escapeHtml(offer.startLabel)}</button>`;
        }
        modalElement.innerHTML = `
            <div class="modal-content link-title-retry-modal-content">
                <div class="prioritize-modal-header">
                    <p class="prioritize-modal-eyebrow">Link titles</p>
                    <h3>Retry failed link titles</h3>
                </div>
                <p class="link-title-retry-status">${escapeHtml(offer.statusLine)}</p>
                ${description}
                <div class="form-actions">${actions}</div>
            </div>
        `;
        const start = document.getElementById('link-title-retry-start-btn');
        if (start instanceof HTMLButtonElement) {
            start.onclick = () => {
                start.disabled = true;
                void this._start();
            };
        }
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error('Link title retry modal element missing');
        }
        const state = this.getModalState();
        if (state.isOffer) {
            this._renderOffer(modalElement, state.snapshot);
            return;
        }
        const view = describeLinkTitleRetry(state.snapshot);
        const rows = view.rows.map((row) => `
            <div class="link-title-retry-row"><span>${escapeHtml(row.label)}</span><span>${escapeHtml(row.value)}</span></div>
        `).join('');
        let note = '';
        if (view.isActive) {
            note = '<p class="link-title-retry-note">You can close this and keep working; the retry continues. Run the action again to see its progress.</p>';
        }
        let stopButton = '';
        if (view.canStop) {
            stopButton = '<button type="button" class="secondary-btn" id="link-title-retry-stop-btn">Stop</button>';
        }
        modalElement.innerHTML = `
            <div class="modal-content link-title-retry-modal-content">
                <div class="prioritize-modal-header">
                    <p class="prioritize-modal-eyebrow">Link titles</p>
                    <h3>Retry failed link titles</h3>
                </div>
                <p class="link-title-retry-status">${escapeHtml(view.statusLine)}</p>
                <progress class="link-title-retry-progress" max="${view.progressMax}" value="${view.progressValue}"></progress>
                <div class="link-title-retry-rows">${rows}</div>
                ${note}
                <div class="form-actions">${stopButton}</div>
            </div>
        `;
        const stop = document.getElementById('link-title-retry-stop-btn');
        if (stop instanceof HTMLButtonElement) {
            stop.onclick = () => {
                void this._stop();
            };
        }
    }

    async _stop() {
        const snapshot = await NotesAPI.stopLinkTitleRetry();
        if (this.isOpen) {
            this._showProgress(snapshot);
        }
    }
}
