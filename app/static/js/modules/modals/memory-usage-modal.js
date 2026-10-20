import { ApplicationState } from '../application-state.js';
import { BaseModal } from './base-modal.js';
import { escapeHtml } from '../html-escape.js';
import { copyTextToClipboard } from '../mode-manager/events/mouse-events.js';
import { lastStartupTiming } from '../startup-timing.js';

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
    const unlock = usage.lastUnlock;
    const isTiming = (entry, key) => typeof entry[key] === 'string' && typeof entry.seconds === 'number' && entry.seconds >= 0;
    if (unlock === null || typeof unlock !== 'object' || !Array.isArray(unlock.phases) || !Array.isArray(unlock.steps)
        || !unlock.phases.every(entry => isTiming(entry, 'phase')) || !unlock.steps.every(entry => isTiming(entry, 'step'))
        || typeof unlock.totalSeconds !== 'number') {
        throw new Error('Memory usage response missing lastUnlock');
    }
    return usage;
}

// The server's answer to Measure: each part's size in bytes, in the order it measured them.
function validateMemoryBreakdown(breakdown) {
    if (breakdown === null || typeof breakdown !== 'object' || !Array.isArray(breakdown.parts)) {
        throw new Error('Memory breakdown response must have parts');
    }
    const isSize = entry => typeof entry.label === 'string' && entry.label !== ''
        && Number.isInteger(entry.bytes) && entry.bytes >= 0;
    for (const part of breakdown.parts) {
        if (!isSize(part) || !Array.isArray(part.fields) || !part.fields.every(isSize)) {
            throw new Error('Memory breakdown part is invalid');
        }
    }
    if (typeof breakdown.seconds !== 'number' || breakdown.seconds < 0) {
        throw new Error('Memory breakdown response missing seconds');
    }
    return breakdown;
}

function seconds(value) {
    return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`;
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
        const rowsHtml = this._breakdownRows(state).map(row => {
            const rowClass = row.isField ? ' class="memory-usage-field"' : '';
            return `<tr${rowClass}><th scope="row">${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`;
        }).join('');
        const seconds = state.breakdown.seconds.toLocaleString(undefined, { maximumFractionDigits: 1 });
        return `<table class="memory-usage-table memory-usage-breakdown"><tbody>${rowsHtml}</tbody></table>
                <p class="note-layout-description">Measured in ${escapeHtml(seconds)} s.</p>`;
    }

    // The measured parts, each with its fields under it (the note store's and the search
    // index's, as the code names them, largest first), then what is left over.
    _breakdownRows(state) {
        const measured = state.breakdown.parts.reduce((sum, part) => sum + part.bytes, 0);
        const unmeasured = state.usage.residentBytes - measured;
        // The system can compress memory a part still holds: then the parts add up to
        // more than is resident, and nothing is left over to name.
        let everythingElse = 'none: the system has compressed some of the parts above';
        if (unmeasured >= 0) {
            everythingElse = megabytes(unmeasured);
        }
        return [
            ...state.breakdown.parts.flatMap(part => [
                { label: part.label, value: megabytes(part.bytes), isField: false },
                ...part.fields.map(field => ({ label: field.label, value: megabytes(field.bytes), isField: true })),
            ]),
            { label: 'Everything else (Python, libraries, free space)', value: everythingElse, isField: false },
        ];
    }

    // The last unlock: the server's phases (and, within decrypting, its steps), then the
    // browser's stages from sending the password to the workspace being ready.
    _unlockRows(usage) {
        const browser = lastStartupTiming();
        const rows = [];
        if (usage.lastUnlock.phases.length > 0) {
            rows.push({ label: 'Server, in all', value: seconds(usage.lastUnlock.totalSeconds), isField: false });
            for (const phase of usage.lastUnlock.phases) {
                rows.push({ label: phase.phase, value: seconds(phase.seconds), isField: true });
            }
            for (const step of usage.lastUnlock.steps) {
                rows.push({ label: `  ${step.step}`, value: seconds(step.seconds), isField: true });
            }
        }
        if (browser.stages.length > 0) {
            rows.push({ label: 'This browser, in all', value: seconds(browser.totalSeconds), isField: false });
            for (const stage of browser.stages) {
                rows.push({ label: stage.stage, value: seconds(stage.seconds), isField: true });
            }
        }
        return rows;
    }

    _unlockHtml(usage) {
        const rows = this._unlockRows(usage);
        if (rows.length === 0) {
            return '<p class="note-layout-description">No unlock since this server or page started.</p>';
        }
        const rowsHtml = rows.map(row => {
            const rowClass = row.isField ? ' class="memory-usage-field"' : '';
            return `<tr${rowClass}><th scope="row">${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`;
        }).join('');
        return `<table class="memory-usage-table memory-usage-unlock"><tbody>${rowsHtml}</tbody></table>`;
    }

    _usageRows(usage) {
        const notesHeld = usage.notesLoaded
            ? `${usage.noteCount.toLocaleString()} notes, ${megabytes(usage.noteTextBytes)} of text`
            : 'Not loaded yet (the namespace is still unlocking)';
        return [
            ['Server process memory now', megabytes(usage.residentBytes)],
            ['Server process memory at its peak', megabytes(usage.peakResidentBytes)],
            ['Notes held decrypted in memory', notesHeld],
            ['Server running for', duration(usage.uptimeSeconds)],
        ];
    }

    _rowsHtml(usage) {
        return this._usageRows(usage).map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
    }

    // What the dialog shows, as plain lines to paste: the numbers, then the breakdown
    // when it has been measured, its fields indented.
    copyText(state) {
        const lines = ['MetaList memory usage', ...this._usageRows(state.usage).map(([label, value]) => `${label}: ${value}`)];
        const unlockRows = this._unlockRows(state.usage);
        if (unlockRows.length > 0) {
            lines.push('', 'Last unlock');
            for (const row of unlockRows) {
                const indent = row.isField ? '    ' : '';
                lines.push(`${indent}${row.label}: ${row.value}`);
            }
        }
        if (state.breakdown !== null) {
            const measuredSeconds = state.breakdown.seconds.toLocaleString(undefined, { maximumFractionDigits: 1 });
            lines.push('', `What holds it (measured in ${measuredSeconds} s)`);
            for (const row of this._breakdownRows(state)) {
                const indent = row.isField ? '    ' : '';
                lines.push(`${indent}${row.label}: ${row.value}`);
            }
        }
        return lines.join('\n');
    }

    // The Copy button: the text above on the clipboard, and the button glows as copyable
    // values in notes do.
    async _copy(copyButton) {
        await copyTextToClipboard(this.copyText(this.getModalState()), copyButton, 'memory-usage-copied');
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
        const copyDisabled = state.usage === null || state.loading || state.measuring ? ' disabled' : '';
        modalElement.innerHTML = `
            <div class="modal-content memory-usage-modal-content">
                <h2>Memory Usage</h2>
                <p class="note-layout-description">For this namespace's server process, which holds the decrypted notes. The browser's own memory is not included.</p>
                ${body}
                <h3 class="memory-usage-subheading">Last unlock</h3>
                ${state.usage === null ? '' : this._unlockHtml(state.usage)}
                <h3 class="memory-usage-subheading">What holds it</h3>
                ${this._breakdownHtml(state)}
                <div class="form-actions">
                    <button type="button" class="secondary-btn" id="memory-usage-copy-btn"${copyDisabled}>Copy</button>
                    <button type="button" class="secondary-btn" id="memory-usage-refresh-btn"${refreshDisabled}>Refresh</button>
                </div>
            </div>
        `;
        const refreshButton = document.getElementById('memory-usage-refresh-btn');
        if (!(refreshButton instanceof HTMLButtonElement)) {
            throw new Error('Memory usage refresh button missing');
        }
        refreshButton.onclick = async () => this._refresh();
        const copyButton = document.getElementById('memory-usage-copy-btn');
        if (!(copyButton instanceof HTMLButtonElement)) {
            throw new Error('Memory usage copy button missing');
        }
        copyButton.onclick = async () => this._copy(copyButton);
        const measureButton = document.getElementById('memory-usage-measure-btn');
        if (measureButton instanceof HTMLButtonElement) {
            measureButton.onclick = async () => this._measure();
        }
    }
}
