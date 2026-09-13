import { ApplicationState } from '../application-state.js';
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

        ApplicationState.own(this, 'VersionInfoModal', new.target === VersionInfoModal);
    }

    getInitialModalState() {
        return {
            loading: true,
            error: '',
            info: null,
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
        await this.loadVersionInfo();
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

    async loadVersionInfo() {
        this._loadGeneration += 1;
        const loadGeneration = this._loadGeneration;
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
}
