import { ApplicationState } from '../application-state.js';
import { BaseModal } from './base-modal.js';
import { escapeHtml } from '../html-escape.js';

const BYTES_PER_MEGABYTE = 1024 * 1024;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

// The server's answer, checked: a missing or mistyped field is a bug, not a blank row.
function validateMemoryUsage(usage) {
    if (usage === null || typeof usage !== 'object') {
        throw new Error('Memory usage response must be an object');
    }
    for (const key of ['residentBytes', 'peakResidentBytes', 'noteCount', 'noteTextBytes']) {
        if (!Number.isInteger(usage[key]) || usage[key] < 0) {
            throw new Error(`Memory usage response missing ${key}`);
        }
    }
    if (typeof usage.uptimeSeconds !== 'number' || usage.uptimeSeconds < 0) {
        throw new Error('Memory usage response missing uptimeSeconds');
    }
    if (typeof usage.notesLoaded !== 'boolean') {
        throw new Error('Memory usage response missing notesLoaded');
    }
    return usage;
}

function megabytes(bytes) {
    return `${(bytes / BYTES_PER_MEGABYTE).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
}

function duration(seconds) {
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    const days = Math.floor(hours / HOURS_PER_DAY);
    if (days > 0) return `${days} d ${hours % HOURS_PER_DAY} h`;
    if (hours > 0) return `${hours} h ${minutes % MINUTES_PER_HOUR} min`;
    return `${minutes} min`;
}

// Memory used by this namespace's server process (not the browser): now, at its peak,
// and the notes it holds decrypted in memory.
export class MemoryUsageModal extends BaseModal {
    constructor(loadMemoryUsage) {
        super('memoryUsageModal', 'memory-usage-modal');
        if (typeof loadMemoryUsage !== 'function') {
            throw new Error('MemoryUsageModal requires loadMemoryUsage');
        }
        this._loadMemoryUsage = loadMemoryUsage;
        this._loadGeneration = 0;
        ApplicationState.own(this, 'MemoryUsageModal', new.target === MemoryUsageModal);
    }

    getInitialModalState() {
        return { loading: true, usage: null };
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

    async onOpen() {
        await this._load();
    }

    // The Refresh button: shows Loading… again, then reads the numbers anew.
    async _refresh() {
        this.updateModalState({ loading: true });
        this.renderModalContent();
        await this._load();
    }

    async _load() {
        this._loadGeneration += 1;
        const loadGeneration = this._loadGeneration;
        const usage = validateMemoryUsage(await this._loadMemoryUsage());
        if (!this.isOpen || loadGeneration !== this._loadGeneration) {
            return;
        }
        this.updateModalState({ loading: false, usage });
        this.renderModalContent();
    }

    _rowsHtml(usage) {
        const notesHeld = usage.notesLoaded
            ? `${usage.noteCount.toLocaleString()} notes, ${megabytes(usage.noteTextBytes)} of text`
            : 'Not loaded yet (the namespace is still unlocking)';
        const rows = [
            ['Server process memory now', megabytes(usage.residentBytes)],
            ['Server process memory at its peak', megabytes(usage.peakResidentBytes)],
            ['Notes held decrypted in memory', notesHeld],
            ['Server running for', duration(usage.uptimeSeconds)],
        ];
        return rows.map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error('Memory usage modal element missing');
        }
        const state = this.getModalState();
        let body = '<p class="memory-usage-status">Loading…</p>';
        if (state.usage !== null) {
            body = `<table class="memory-usage-table"><tbody>${this._rowsHtml(state.usage)}</tbody></table>`;
        }
        const refreshDisabled = state.loading ? ' disabled' : '';
        modalElement.innerHTML = `
            <div class="modal-content memory-usage-modal-content">
                <h2>Memory Usage</h2>
                <p class="note-layout-description">For this namespace's server process, which holds the decrypted notes. The browser's own memory is not included.</p>
                ${body}
                <div class="form-actions">
                    <button type="button" class="secondary-btn" id="memory-usage-refresh-btn"${refreshDisabled}>Refresh</button>
                </div>
            </div>
        `;
        const refreshButton = document.getElementById('memory-usage-refresh-btn');
        if (!(refreshButton instanceof HTMLButtonElement)) {
            throw new Error('Memory usage refresh button missing');
        }
        refreshButton.onclick = async () => this._refresh();
    }
}
