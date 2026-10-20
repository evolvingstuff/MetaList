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

// The server's answer to Measure: each part's size in bytes, in the order it measured them.
function validateMemoryBreakdown(breakdown) {
    if (breakdown === null || typeof breakdown !== 'object' || !Array.isArray(breakdown.parts)) {
        throw new Error('Memory breakdown response must have parts');
    }
    for (const part of breakdown.parts) {
        if (typeof part.label !== 'string' || part.label === '' || !Number.isInteger(part.bytes) || part.bytes < 0) {
            throw new Error('Memory breakdown part is invalid');
        }
    }
    if (typeof breakdown.seconds !== 'number' || breakdown.seconds < 0) {
        throw new Error('Memory breakdown response missing seconds');
    }
    return breakdown;
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
// the notes it holds decrypted in memory, and, on request, what holds it part by part.
export class MemoryUsageModal extends BaseModal {
    constructor(loadMemoryUsage, loadMemoryBreakdown) {
        super('memoryUsageModal', 'memory-usage-modal');
        if (typeof loadMemoryUsage !== 'function') {
            throw new Error('MemoryUsageModal requires loadMemoryUsage');
        }
        if (typeof loadMemoryBreakdown !== 'function') {
            throw new Error('MemoryUsageModal requires loadMemoryBreakdown');
        }
        this._loadMemoryUsage = loadMemoryUsage;
        this._loadMemoryBreakdown = loadMemoryBreakdown;
        this._loadGeneration = 0;
        ApplicationState.own(this, 'MemoryUsageModal', new.target === MemoryUsageModal);
    }

    getInitialModalState() {
        return { loading: true, usage: null, measuring: false, breakdown: null };
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

    // The Refresh button: shows Loading… again, then reads the numbers anew. A breakdown
    // measured against the old total goes with it.
    async _refresh() {
        this.updateModalState({ loading: true, breakdown: null });
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

    // The Measure button: the server measures each part (a few seconds), then the rows show.
    async _measure() {
        const loadGeneration = this._loadGeneration;
        this.updateModalState({ measuring: true });
        this.renderModalContent();
        const breakdown = validateMemoryBreakdown(await this._loadMemoryBreakdown());
        if (!this.isOpen || loadGeneration !== this._loadGeneration) {
            return;
        }
        this.updateModalState({ measuring: false, breakdown });
        this.renderModalContent();
    }

    _breakdownHtml(state) {
        if (state.measuring) {
            return '<p class="memory-usage-status">Measuring… this takes a few seconds.</p>';
        }
        if (state.breakdown === null) {
            const measureDisabled = state.usage === null ? ' disabled' : '';
            return `
                <p class="note-layout-description">Measures each part of the server by size (never its content). Takes a few seconds; saving waits meanwhile.</p>
                <button type="button" class="secondary-btn" id="memory-usage-measure-btn"${measureDisabled}>Measure what holds it</button>`;
        }
        const measured = state.breakdown.parts.reduce((sum, part) => sum + part.bytes, 0);
        const unmeasured = state.usage.residentBytes - measured;
        // The system can compress memory a part still holds: then the parts add up to
        // more than is resident, and nothing is left over to name.
        let everythingElse = 'none: the system has compressed some of the parts above';
        if (unmeasured >= 0) {
            everythingElse = megabytes(unmeasured);
        }
        const rows = [
            ...state.breakdown.parts.map(part => [part.label, megabytes(part.bytes)]),
            ['Everything else (Python, libraries, free space)', everythingElse],
        ];
        const rowsHtml = rows.map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
        const seconds = state.breakdown.seconds.toLocaleString(undefined, { maximumFractionDigits: 1 });
        return `<table class="memory-usage-table memory-usage-breakdown"><tbody>${rowsHtml}</tbody></table>
                <p class="note-layout-description">Measured in ${escapeHtml(seconds)} s.</p>`;
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
        const refreshDisabled = state.loading || state.measuring ? ' disabled' : '';
        modalElement.innerHTML = `
            <div class="modal-content memory-usage-modal-content">
                <h2>Memory Usage</h2>
                <p class="note-layout-description">For this namespace's server process, which holds the decrypted notes. The browser's own memory is not included.</p>
                ${body}
                <h3 class="memory-usage-subheading">What holds it</h3>
                ${this._breakdownHtml(state)}
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
        const measureButton = document.getElementById('memory-usage-measure-btn');
        if (measureButton instanceof HTMLButtonElement) {
            measureButton.onclick = async () => this._measure();
        }
    }
}
