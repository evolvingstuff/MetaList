import { ApplicationState, stateValuesEqual } from '../application-state.js';
import { rethrowUnexpectedError } from '../expected-errors.js';
import {
    AiApiError,
    loadAiDebugSnapshot,
    setAiDebugExactDetails,
} from './ai-chat-api.js';


function requireElement(id, constructor) {
    const element = document.getElementById(id);
    if (!(element instanceof constructor)) {
        throw new Error(`Agent debug element missing: ${id}`);
    }
    return element;
}


function validateSnapshot(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Agent debug snapshot must be an object');
    }
    if (typeof payload.enabled !== 'boolean' || typeof payload.has_trace !== 'boolean') {
        throw new Error('Agent debug snapshot flags are invalid');
    }
    if (!payload.run || typeof payload.run !== 'object' || Array.isArray(payload.run)) {
        throw new Error('Agent debug snapshot run must be an object');
    }
    if (payload.has_trace) {
        validateRun(payload.run);
    } else if (Object.keys(payload.run).length !== 0) {
        throw new Error('Agent debug snapshot without a trace must have an empty run');
    }
    return payload;
}


function validateRun(run) {
    for (const key of [
        'run_id',
        'model',
        'user_message',
        'status',
        'started_at',
        'finished_at',
        'error',
    ]) {
        if (typeof run[key] !== 'string') {
            throw new Error(`Agent debug run ${key} must be a string`);
        }
    }
    if (!Array.isArray(run.events)) {
        throw new Error('Agent debug run events must be an array');
    }
    for (const event of run.events) {
        validateTraceEvent(event);
    }
}


function validateTraceEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error('Agent debug event must be an object');
    }
    if (!Number.isInteger(event.sequence) || event.sequence < 1) {
        throw new Error('Agent debug event sequence must be a positive integer');
    }
    for (const key of ['type', 'label', 'timestamp']) {
        if (typeof event[key] !== 'string' || event[key] === '') {
            throw new Error(`Agent debug event ${key} must be a non-empty string`);
        }
    }
    if (!Number.isFinite(event.duration_ms) || event.duration_ms < 0) {
        throw new Error('Agent debug event duration must be non-negative');
    }
    if (!event.detail || typeof event.detail !== 'object' || Array.isArray(event.detail)) {
        throw new Error('Agent debug event detail must be an object');
    }
}


class AgentDebugViewController {
    constructor() {
        this._initialized = false;
        this._snapshot = { enabled: true, has_trace: false, run: {} };
        this._elements = null;

        ApplicationState.own(this, 'AgentDebugViewController', new.target === AgentDebugViewController);
    }

    async init() {
        if (this._initialized) {
            return;
        }
        this._elements = {
            button: requireElement('ai-chat-debug', HTMLButtonElement),
            dialog: requireElement('ai-agent-debug-dialog', HTMLDialogElement),
            enabled: requireElement('ai-agent-debug-enabled', HTMLInputElement),
            copyAll: requireElement('ai-agent-debug-copy-all', HTMLButtonElement),
            refresh: requireElement('ai-agent-debug-refresh', HTMLButtonElement),
            close: requireElement('ai-agent-debug-close', HTMLButtonElement),
            status: requireElement('ai-agent-debug-status', HTMLElement),
            events: requireElement('ai-agent-debug-events', HTMLElement),
        };
        this._bindEvents();
        this._initialized = true;
        await this._loadSnapshot();
    }

    async refreshIfOpen() {
        if (!this._initialized || !this._elements.dialog.open) {
            return;
        }
        await this._loadSnapshot();
    }

    _bindEvents() {
        this._elements.button.addEventListener('click', () => void this._open());
        this._elements.close.addEventListener('click', () => this._elements.dialog.close());
        this._elements.copyAll.addEventListener('click', () => void this._copyAll());
        this._elements.refresh.addEventListener('click', () => void this._loadSnapshot());
        this._elements.enabled.addEventListener('change', () => void this._toggleExactDetails());
        this._elements.dialog.addEventListener('click', (event) => {
            this._closeFromBackdropClick(event);
        });
        this._elements.dialog.addEventListener('close', () => {
            this._elements.button.setAttribute('aria-expanded', 'false');
        });
    }

    async _open() {
        if (!this._elements.dialog.open) {
            this._elements.dialog.showModal();
        }
        this._elements.button.setAttribute('aria-expanded', 'true');
        await this._loadSnapshot();
    }

    _closeFromBackdropClick(event) {
        if (event.target !== this._elements.dialog) {
            return;
        }
        const bounds = this._elements.dialog.getBoundingClientRect();
        const isInsideDialog = event.clientX >= bounds.left
            && event.clientX <= bounds.right
            && event.clientY >= bounds.top
            && event.clientY <= bounds.bottom;
        if (!isInsideDialog) {
            this._elements.dialog.close();
        }
    }

    async _loadSnapshot() {
        try {
            const snapshot = validateSnapshot(await loadAiDebugSnapshot());
            if (!stateValuesEqual(this._snapshot, snapshot)) this._snapshot = snapshot;
            this._setStatus('');
            this._render();
        } catch (error) {
            rethrowUnexpectedError(error);
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this._setStatus(error.message);
            throw error;
        }
    }

    async _toggleExactDetails() {
        try {
            this._snapshot = validateSnapshot(
                await setAiDebugExactDetails(this._elements.enabled.checked),
            );
            this._setStatus('');
            this._render();
        } catch (error) {
            rethrowUnexpectedError(error);
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this._elements.enabled.checked = this._snapshot.enabled;
            this._setStatus(error.message);
            throw error;
        }
    }

    async _copyAll() {
        if (!this._snapshot.has_trace) {
            throw new Error('Cannot copy an empty agent trace');
        }
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error('Clipboard text writing is unavailable');
        }
        await navigator.clipboard.writeText(JSON.stringify(this._snapshot.run, null, 2));
        this._setStatus('Copied complete trace to clipboard.');
    }

    _render() {
        const payload = this._snapshot;
        this._elements.enabled.checked = payload.enabled;
        this._elements.copyAll.disabled = !payload.has_trace;
        this._elements.events.replaceChildren();
        if (!payload.has_trace) {
            this._renderEmpty('No agent run has been recorded in this session yet.');
            return;
        }
        if (!payload.enabled) {
            this._setStatus('Latest trace recorded. Enable exact details to inspect payloads.');
        }
        this._renderRun(payload.run, payload.enabled);
    }

    _renderEmpty(message) {
        if (typeof message !== 'string' || message === '') {
            throw new Error('Agent debug empty message must be non-empty');
        }
        const empty = document.createElement('p');
        empty.className = 'ai-agent-debug-empty';
        empty.textContent = message;
        this._elements.events.appendChild(empty);
    }

    _renderRun(run, showExactDetails) {
        if (typeof showExactDetails !== 'boolean') {
            throw new Error('Agent debug exact-detail visibility must be boolean');
        }
        const runHeader = document.createElement('section');
        runHeader.className = 'ai-agent-debug-run-header';
        const title = document.createElement('h3');
        title.textContent = `${run.status.toUpperCase()} · ${run.model}`;
        const metadata = document.createElement('p');
        metadata.textContent = `Run ${run.run_id} · ${run.started_at}`;
        const request = document.createElement('p');
        request.textContent = run.user_message;
        runHeader.append(title, metadata, request);
        if (run.error !== '') {
            const error = document.createElement('p');
            error.className = 'ai-agent-debug-error';
            error.textContent = run.error;
            runHeader.appendChild(error);
        }
        this._elements.events.appendChild(runHeader);
        for (const event of run.events) {
            const details = document.createElement('details');
            details.className = 'ai-agent-debug-event';
            const summary = document.createElement('summary');
            const duration = event.duration_ms > 0 ? ` · ${event.duration_ms.toFixed(1)} ms` : '';
            summary.textContent = `${event.sequence}. ${event.label}${duration}`;
            const type = document.createElement('div');
            type.className = 'ai-agent-debug-event-type';
            type.textContent = `${event.type} · ${event.timestamp}`;
            const payload = document.createElement('pre');
            payload.textContent = JSON.stringify(event.detail, null, 2);
            details.append(summary, type);
            if (showExactDetails) {
                details.appendChild(payload);
            }
            this._elements.events.appendChild(details);
        }
    }

    _setStatus(message) {
        if (typeof message !== 'string') {
            throw new Error('Agent debug status must be a string');
        }
        this._elements.status.textContent = message;
    }
}


export const AgentDebugView = new AgentDebugViewController();
