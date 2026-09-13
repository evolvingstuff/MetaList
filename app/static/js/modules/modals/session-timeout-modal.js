import { ApplicationState } from '../application-state.js';
import { HttpRequestError, rethrowUnexpectedError } from '../expected-errors.js';
import { BaseModal } from './base-modal.js';
import { CONFIG } from '../config.js';
import { buildSessionHeaders } from '../session-auth.js';


const MIN_IDLE_TIMEOUT_MINUTES = 1;
const MAX_IDLE_TIMEOUT_MINUTES = 1440;


function escapeHtml(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}


function parseResponseError(responseBody, statusCode) {
    if (responseBody && typeof responseBody === 'object') {
        if (typeof responseBody.detail === 'string' && responseBody.detail.length > 0) {
            return `Request failed (${statusCode}): ${responseBody.detail}`;
        }
        if (typeof responseBody.message === 'string' && responseBody.message.length > 0) {
            return `Request failed (${statusCode}): ${responseBody.message}`;
        }
    }
    return `Request failed (${statusCode})`;
}


export class SessionTimeoutModal extends BaseModal {
    constructor() {
        super('sessionTimeoutModal', 'session-timeout-modal');

        ApplicationState.own(this, 'SessionTimeoutModal', new.target === SessionTimeoutModal);
    }

    getInitialModalState() {
        return {
            loading: false,
            saving: false,
            timeoutDisabled: false,
            idleTimeoutMinutesText: '',
            error: '',
            statusMessage: '',
        };
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
        await this.loadSettings();
    }

    onKeyDown(event) {
        if (!(event instanceof KeyboardEvent)) {
            throw new Error('SessionTimeoutModal.onKeyDown requires KeyboardEvent');
        }
        const state = this.getModalState();
        if (state.loading || state.saving) {
            return;
        }
        if (event.key !== 'Enter') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        void this.handleSave();
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }

        const state = this.getModalState();
        const loading = Boolean(state.loading);
        const saving = Boolean(state.saving);
        const timeoutDisabled = state.timeoutDisabled === true;
        const idleTimeoutMinutesText = typeof state.idleTimeoutMinutesText === 'string'
            ? state.idleTimeoutMinutesText
            : '';
        const error = typeof state.error === 'string' ? state.error : '';
        let statusMessage = typeof state.statusMessage === 'string' ? state.statusMessage : '';
        if (statusMessage.length === 0 && loading) {
            statusMessage = 'Loading idle timeout...';
        }
        const timeoutControlsHtml = timeoutDisabled
            ? ''
            : `
                <div class="form-group">
                    <label for="session-timeout-minutes">Idle timeout (minutes)</label>
                    <input
                        type="number"
                        id="session-timeout-minutes"
                        min="${MIN_IDLE_TIMEOUT_MINUTES}"
                        max="${MAX_IDLE_TIMEOUT_MINUTES}"
                        step="1"
                        value="${escapeHtml(idleTimeoutMinutesText)}"
                        ${loading || saving ? 'disabled' : ''}
                    >
                    <p>Allowed range when enabled: ${MIN_IDLE_TIMEOUT_MINUTES} to ${MAX_IDLE_TIMEOUT_MINUTES} minutes. Background status polling does not keep the session alive.</p>
                </div>
            `;

        modalElement.innerHTML = `
            <div class="modal-content">
                <h3>Session Idle Timeout</h3>
                <p>Choose how many minutes of inactivity MetaList allows before this namespace requires login again. The hydrated server cache stays warm.</p>

                <div class="form-group">
                    <label>
                        <input
                            type="checkbox"
                            id="session-timeout-disabled"
                            ${timeoutDisabled ? 'checked' : ''}
                            ${loading || saving ? 'disabled' : ''}
                        >
                        Disable idle timeout
                    </label>
                    <p>When disabled, the session stays active until logout or server restart.</p>
                </div>

                ${timeoutControlsHtml}

                <div class="form-actions">
                    <button type="button" class="primary-btn" id="session-timeout-save-btn" ${loading || saving ? 'disabled' : ''}>${saving ? 'Saving...' : 'Save'}</button>
                    <button type="button" class="secondary-btn" id="session-timeout-cancel-btn" ${saving ? 'disabled' : ''}>Cancel</button>
                </div>

                <p id="session-timeout-status">${escapeHtml(statusMessage)}</p>
                <p id="session-timeout-error" class="error-message">${escapeHtml(error)}</p>
            </div>
        `;

        this.setupFormEventListeners();
    }

    setupFormEventListeners() {
        const cancelButton = document.getElementById('session-timeout-cancel-btn');
        if (cancelButton instanceof HTMLButtonElement) {
            cancelButton.onclick = () => {
                this.close();
            };
        }

        const timeoutInput = document.getElementById('session-timeout-minutes');
        if (timeoutInput instanceof HTMLInputElement) {
            timeoutInput.oninput = () => {
                this.updateModalState({
                    idleTimeoutMinutesText: timeoutInput.value,
                    error: '',
                    statusMessage: '',
                });
            };
        }

        const disabledCheckbox = document.getElementById('session-timeout-disabled');
        if (disabledCheckbox instanceof HTMLInputElement) {
            disabledCheckbox.onchange = () => {
                this.updateModalState({
                    timeoutDisabled: disabledCheckbox.checked,
                    error: '',
                    statusMessage: '',
                });
                this.renderModalContent();
            };
        }

        const saveButton = document.getElementById('session-timeout-save-btn');
        if (saveButton instanceof HTMLButtonElement) {
            saveButton.onclick = async () => {
                await this.handleSave();
            };
        }
    }

    async _authRequest(url, method, payload) {
        if (typeof url !== 'string' || url.length === 0) {
            throw new Error('_authRequest requires url');
        }
        if (typeof method !== 'string' || method.length === 0) {
            throw new Error('_authRequest requires method');
        }

        const requestInit = {
            method,
            headers: buildSessionHeaders(payload !== null),
        };
        if (payload !== null) {
            requestInit.body = JSON.stringify(payload);
        }

        const response = await fetch(url, requestInit);
        if (response.status === 204) {
            return null;
        }

        let responseBody = null;
        const contentType = response.headers.get('content-type');
        if (typeof contentType === 'string' && contentType.includes('application/json')) {
            responseBody = await response.json();
        }
        if (!response.ok) {
            throw new HttpRequestError(parseResponseError(responseBody, response.status));
        }
        if (responseBody === null) {
            throw new Error('Response payload missing');
        }
        return responseBody;
    }

    async loadSettings() {
        this.updateModalState({
            loading: true,
            saving: false,
            error: '',
            statusMessage: '',
        });
        this.renderModalContent();

        await (async () => {
            const payload = await this._authRequest(
                CONFIG.API.AUTH.SETTINGS.SESSION_TIMEOUT,
                'GET',
                null,
            );
            if (!payload || typeof payload !== 'object') {
                throw new Error('Session timeout response missing body');
            }
            if (!Number.isInteger(payload.idle_timeout_minutes)) {
                throw new Error('Session timeout response missing idle_timeout_minutes');
            }
            const timeoutDisabled = payload.idle_timeout_minutes === 0;
            this.updateModalState({
                loading: false,
                timeoutDisabled,
                idleTimeoutMinutesText: timeoutDisabled ? '30' : String(payload.idle_timeout_minutes),
                error: '',
                statusMessage: '',
            });
            this.renderModalContent();
        })().catch((error) => {
            rethrowUnexpectedError(error);
            const message = error instanceof Error ? error.message : String(error);
            this.updateModalState({
                loading: false,
                error: message,
                statusMessage: '',
            });
            this.renderModalContent();
        });
    }

    _validateTimeoutMinutes() {
        const state = this.getModalState();
        if (state.timeoutDisabled === true) {
            return 0;
        }
        const rawText = typeof state.idleTimeoutMinutesText === 'string'
            ? state.idleTimeoutMinutesText.trim()
            : '';
        if (rawText.length === 0) {
            throw new Error('Idle timeout is required');
        }
        if (!/^[0-9]+$/.test(rawText)) {
            throw new Error('Idle timeout must be a whole number of minutes');
        }

        const timeoutMinutes = Number.parseInt(rawText, 10);
        if (!Number.isInteger(timeoutMinutes)) {
            throw new Error('Idle timeout must be a whole number of minutes');
        }
        if (timeoutMinutes < MIN_IDLE_TIMEOUT_MINUTES || timeoutMinutes > MAX_IDLE_TIMEOUT_MINUTES) {
            throw new Error(
                `Idle timeout must be between ${MIN_IDLE_TIMEOUT_MINUTES} and ${MAX_IDLE_TIMEOUT_MINUTES} minutes`
            );
        }
        return timeoutMinutes;
    }

    async handleSave() {
        const state = this.getModalState();
        if (state.loading || state.saving) {
            return;
        }

        await (async () => {
            const timeoutMinutes = this._validateTimeoutMinutes();
            this.updateModalState({
                saving: true,
                error: '',
                statusMessage: 'Saving idle timeout...',
            });
            this.renderModalContent();

            const payload = await this._authRequest(
                CONFIG.API.AUTH.SETTINGS.SESSION_TIMEOUT,
                'PUT',
                { idle_timeout_minutes: timeoutMinutes },
            );
            if (!payload || typeof payload !== 'object') {
                throw new Error('Session timeout save response missing body');
            }
            if (!Number.isInteger(payload.idle_timeout_minutes)) {
                throw new Error('Session timeout save response missing idle_timeout_minutes');
            }

            this.close();
        })().catch((error) => {
            rethrowUnexpectedError(error);
            const message = error instanceof Error ? error.message : String(error);
            this.updateModalState({
                saving: false,
                error: message,
                statusMessage: '',
            });
            this.renderModalContent();
        });
    }
}
