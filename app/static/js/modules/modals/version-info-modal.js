import { ApplicationState } from '../application-state.js';
import { checkRelease, updateRequest, rememberUpdateJob, currentUpdateJob, clearFailedUpdateJob } from '../app-update-service.js';
import { rethrowUnexpectedError } from '../expected-errors.js';
import { CommandGate } from '../mode-manager/services/command-gate-service.js';
import { HttpRequestError } from '../expected-errors.js';
import { BaseModal } from './base-modal.js';
import { CONFIG } from '../config.js';
import { buildSessionHeaders } from '../session-auth.js';


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


function yesNo(value) {
    if (typeof value !== 'boolean') {
        throw new Error('yesNo requires boolean');
    }
    return value ? 'Yes' : 'No';
}


function requireString(payload, key) {
    const value = payload[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Version info response missing ${key}`);
    }
    return value;
}


function requireBoolean(payload, key) {
    const value = payload[key];
    if (typeof value !== 'boolean') {
        throw new Error(`Version info response missing ${key}`);
    }
    return value;
}


function requireNonNegativeInteger(payload, key) {
    const value = payload[key];
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Version info response missing ${key}`);
    }
    return value;
}


function nullableValue(value) {
    if (value === null || typeof value === 'undefined') {
        return 'None';
    }
    if (typeof value === 'string') {
        return value.length > 0 ? value : 'None';
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    throw new Error('Unsupported version info value');
}


export class VersionInfoModal extends BaseModal {
    constructor() {
        super('versionInfoModal', 'version-info-modal');
        this._loadGeneration = 0;
        this._updateTimer = null;
        this.handleUpdateClick = this.handleUpdateClick.bind(this);

        ApplicationState.own(this, 'VersionInfoModal', new.target === VersionInfoModal);
    }

    getInitialModalState() {
        return {
            loading: true,
            error: '',
            info: null,
            release: null,
            updateMessage: 'Checking PyPI for updates…',
            updateJob: currentUpdateJob(),
            updatePending: false,
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
        this._loadGeneration += 1;
        const generation = this._loadGeneration;
        await Promise.all([this.loadVersionInfo(generation), this.loadUpdateInfo(generation)]);
        if (!this.isOpen || generation !== this._loadGeneration) return;
        const job = this.getModalState().updateJob;
        if (job !== null) await this.pollUpdate(generation, job);
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }

        const state = this.getModalState();
        const loading = state.loading === true;
        const error = typeof state.error === 'string' ? state.error : '';
        const info = state.info;

        let bodyHtml = '<p class="version-info-status">Loading version info...</p>';
        if (!loading && info !== null) {
            bodyHtml = this.buildInfoTableHtml(info);
        }
        if (!loading && info === null && error.length === 0) {
            throw new Error('Version info modal reached empty non-loading state');
        }

        modalElement.innerHTML = `
            <div class="modal-content version-info-modal-content">
                <h3>Version Info</h3>
                ${bodyHtml}
                <section class="version-update-section" aria-live="polite">
                    <p>${escapeHtml(state.updateMessage)}</p>
                    ${this.buildUpdateControls(state)}
                </section>
                <p class="error-message">${escapeHtml(error)}</p>
            </div>
        `;
    }

    buildInfoTableHtml(info) {
        if (!info || typeof info !== 'object') {
            throw new Error('buildInfoTableHtml requires info object');
        }

        const rows = [
            ['App version', requireString(info, 'version')],
            ['Database schema version', String(requireNonNegativeInteger(info, 'database_user_version'))],
            ['Namespace', requireString(info, 'namespace')],
            ['Authenticated', yesNo(requireBoolean(info, 'authenticated'))],
            ['Password set', yesNo(requireBoolean(info, 'has_password'))],
            ['Encryption enabled', yesNo(requireBoolean(info, 'encryption_enabled'))],
            ['Vault version', nullableValue(info.vault_version)],
            ['KDF algorithm', nullableValue(info.kdf_algorithm)],
            ['KDF memory KiB', nullableValue(info.kdf_memory_cost_kib)],
            ['KDF parallelism', nullableValue(info.kdf_parallelism)],
            ['Cache ready', yesNo(requireBoolean(info, 'cache_ready'))],
        ];

        return `
            <table class="version-info-table">
                <tbody>
                    ${rows.map(([label, value]) => `
                        <tr>
                            <th scope="row">${escapeHtml(label)}</th>
                            <td>${escapeHtml(value)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    async loadVersionInfo(loadGeneration) {
        const response = await fetch(CONFIG.API.AUTH.STATUS, {
            headers: buildSessionHeaders(false),
        });
        const payload = await response.json();
        if (!response.ok) {
            const detail = payload && typeof payload.detail === 'string'
                ? payload.detail
                : `HTTP ${response.status}`;
            throw new HttpRequestError(`Version info request failed: ${detail}`);
        }
        if (!payload || typeof payload !== 'object') {
            throw new Error('Version info response missing body');
        }
        if (!this.isOpen || loadGeneration !== this._loadGeneration) {
            return;
        }
        this.updateModalState({
            loading: false,
            error: '',
            info: payload,
        });
        this.renderModalContent();
    }

    setupEventListeners() {
        super.setupEventListeners();
        document.getElementById(this.modalElementId).addEventListener('click', this.handleUpdateClick);
    }

    cleanupEventListeners() {
        document.getElementById(this.modalElementId).removeEventListener('click', this.handleUpdateClick);
        super.cleanupEventListeners();
    }

    onClose() {
        if (this._updateTimer !== null) {
            clearTimeout(this._updateTimer);
            this._updateTimer = null;
        }
    }

    buildUpdateControls(state) {
        if (state.loading) return '';
        if (state.updateJob !== null) {
            const job = state.updateJob;
            const log = `<p class="version-update-log">Update log on the server: ${escapeHtml(job.log_path)}</p>`;
            if (job.status === 'complete') return '<button type="button" data-update-action="reload">Reload MetaList</button>';
            if (job.status === 'failed') return `${log}<button type="button" data-update-action="check">Check again</button>`;
            return log;
        }
        if (state.release === null) return '<button type="button" data-update-action="check">Check again</button>';
        if (!state.release.update_available || !state.release.supported) return '';
        return `<p>Checks the release, creates verified backups, and restarts all namespaces. You may need to sign in again.</p>
            <button type="button" data-update-action="install" ${state.updatePending ? 'disabled' : ''}>Update to ${escapeHtml(state.release.target_version)}</button>`;
    }

    async loadUpdateInfo(generation) {
        const { release, error } = await checkRelease();
        if (!this.isOpen || generation !== this._loadGeneration) return;
        const state = this.getModalState();
        const updateMessage = release === null ? error : release.message;
        if (JSON.stringify(state.release) === JSON.stringify(release) && state.updateMessage === updateMessage) return;
        this.updateModalState({ release, updateMessage });
        this.renderModalContent();
    }

    async handleUpdateClick(event) {
        const button = event.target.closest('[data-update-action]');
        if (!button || CommandGate.isBusy()) return;
        const action = button.dataset.updateAction;
        if (action === 'reload') { window.location.reload(); return; }
        const generation = this._loadGeneration;
        if (action === 'check') {
            if (this.getModalState().updateJob !== null) {
                clearFailedUpdateJob();
                this.updateModalState({ updateJob: null, release: null, updateMessage: 'Checking PyPI for updates…' });
                this.renderModalContent();
            }
            await CommandGate.run('version.checkUpdate', () => this.loadUpdateInfo(generation));
            return;
        }
        if (action !== 'install') throw new Error(`Unknown update action: ${action}`);
        const state = this.getModalState();
        if (state.updatePending || state.updateJob !== null) return;
        this.updateModalState({ updatePending: true });
        this.renderModalContent();
        try {
            const job = await CommandGate.run('version.installUpdate', () => updateRequest('', { target_version: state.release.target_version }));
            rememberUpdateJob(job);
            if (!this.isOpen || generation !== this._loadGeneration) return;
            this.updateModalState({ updateJob: job, updatePending: false, updateMessage: job.message });
            this.renderModalContent();
            this.scheduleUpdatePoll(generation, job);
        } catch (error) {
            rethrowUnexpectedError(error);
            if (this.isOpen && generation === this._loadGeneration) {
                this.updateModalState({ updatePending: false, updateMessage: error.message });
                this.renderModalContent();
            }
        }
    }

    scheduleUpdatePoll(generation, job) {
        if (['complete', 'failed'].includes(job.status)) return;
        this._updateTimer = setTimeout(async () => {
            this._updateTimer = null;
            await this.pollUpdate(generation, job);
        }, 2000);
    }

    async pollUpdate(generation, previousJob) {
        let job = previousJob;
        let message;
        try {
            job = await updateRequest(`/jobs/${encodeURIComponent(previousJob.job_id)}`);
            rememberUpdateJob(job);
            message = job.message;
        } catch (error) {
            rethrowUnexpectedError(error);
            message = 'Waiting for MetaList to restart. If it does not return, check the update log on the server and run metalist to restart it.';
        }
        if (!this.isOpen || generation !== this._loadGeneration) return;
        const state = this.getModalState();
        if (JSON.stringify(state.updateJob) !== JSON.stringify(job) || state.updateMessage !== message) {
            this.updateModalState({ updateJob: job, updateMessage: message });
            this.renderModalContent();
        }
        this.scheduleUpdatePoll(generation, job);
    }

}
