import { ApplicationState } from '../application-state.js';
import { HttpRequestError, rethrowUnexpectedError } from '../expected-errors.js';
import { BaseModal } from './base-modal.js';
import { CONFIG } from '../config.js';
import { buildSessionHeaders } from '../session-auth.js';


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


export class BackupSettingsModal extends BaseModal {
    constructor() {
        super('backupSettingsModal', 'backup-settings-modal');
        this._pendingResolve = null;
        this._decision = null;
        this._pendingRunBackup = null;

        ApplicationState.own(this, 'BackupSettingsModal', new.target === BackupSettingsModal);
    }

    _errorMessage(error) {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    getInitialModalState() {
        return {
            loading: false,
            saving: false,
            pickingFolder: false,
            folderPath: '',
            selectedNamespaces: [],
            availableNamespaces: [],
            retentionCountText: '30',
            statusMessage: '',
            error: '',
        };
    }

    shouldCloseOnClickOutside() {
        return true;
    }

    _hasActiveOperation() {
        const state = this.getModalState();
        return [state.loading, state.saving, state.pickingFolder].includes(true);
    }

    canRequestClose() {
        return !this._hasActiveOperation();
    }

    handleKeyDown(event) {
        if (!(event instanceof KeyboardEvent)) {
            throw new Error('BackupSettingsModal.handleKeyDown requires KeyboardEvent');
        }
        if (this._hasActiveOperation() && (event.key === 'Escape' || event.key === 'Enter')) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        super.handleKeyDown(event);
    }

    handleClickOutside(event) {
        if (!event || typeof event !== 'object') {
            throw new Error('BackupSettingsModal.handleClickOutside requires event object');
        }
        if (this._hasActiveOperation() && event.target === event.currentTarget) {
            return;
        }
        super.handleClickOutside(event);
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

    openForBackup() {
        if (this.isOpen) {
            throw new Error('BackupSettingsModal is already open');
        }
        if (this._pendingResolve !== null) {
            throw new Error('BackupSettingsModal already has a pending promise');
        }
        this._decision = { result: { action: 'cancel' } };
        this.open();
        return new Promise((resolve) => {
            this._pendingResolve = resolve;
        });
    }

    async onOpen() {
        await this.loadSettings();
    }

    onClose() {
        const resolve = this._pendingResolve;
        const closeResult = this._decision.result;
        this._pendingResolve = null;
        this._decision = null;
        if (resolve !== null) {
            resolve(closeResult);
        }
    }

    onKeyDown(event) {
        if (!(event instanceof KeyboardEvent)) {
            throw new Error('BackupSettingsModal.onKeyDown requires KeyboardEvent');
        }
        if (event.key !== 'Enter') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        void this.handleRunBackup();
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }
        const state = this.getModalState();
        const loading = Boolean(state.loading);
        const saving = Boolean(state.saving);
        const pickingFolder = Boolean(state.pickingFolder);
        const folderPath = typeof state.folderPath === 'string' ? state.folderPath : '';
        const selectedNamespaces = Array.isArray(state.selectedNamespaces) ? state.selectedNamespaces : [];
        const availableNamespaces = Array.isArray(state.availableNamespaces) ? state.availableNamespaces : [];
        const retentionCountText = typeof state.retentionCountText === 'string' ? state.retentionCountText : '';
        const statusMessage = typeof state.statusMessage === 'string' ? state.statusMessage : '';
        const error = typeof state.error === 'string' ? state.error : '';
        const showNamespaceSelection = availableNamespaces.length > 1;
        const singleNamespaceLabel = availableNamespaces.length > 0 ? availableNamespaces[0] : '';
        const namespaceSelectionHtml = showNamespaceSelection
            ? availableNamespaces.map((namespace) => {
                const checked = selectedNamespaces.includes(namespace);
                return `
                    <label class="backup-settings-checkbox-row backup-settings-namespace-row">
                        <input type="checkbox" data-backup-namespace="${escapeHtml(namespace)}" ${checked ? 'checked' : ''} ${loading || saving ? 'disabled' : ''}>
                        <span>${escapeHtml(namespace)}</span>
                    </label>
                `;
            }).join('')
            : `<p class="backup-settings-single-namespace"><strong>Namespace:</strong> ${escapeHtml(singleNamespaceLabel)}</p>`;

        let effectiveStatusMessage = statusMessage;
        if (effectiveStatusMessage.length === 0 && loading) {
            effectiveStatusMessage = 'Loading backup settings...';
        }

        modalElement.innerHTML = `
            <div class="modal-content backup-retention-modal-content">
                <h3 class="backup-settings-modal-title">Backup Settings</h3>
                <p>Choose one backup folder and how many snapshots to keep for each selected namespace.</p>

                <div class="form-group">
                    <label for="backup-settings-folder-path">Folder path</label>
                    <input type="text" id="backup-settings-folder-path" value="${escapeHtml(folderPath)}" placeholder="/Users/you/Backups/MetaList" readonly ${loading || saving || pickingFolder ? 'disabled' : ''}>
                    <div class="form-actions">
                        <button type="button" class="secondary-btn" id="backup-settings-folder-pick-btn" ${loading || saving || pickingFolder ? 'disabled' : ''}>${pickingFolder ? 'Choosing...' : 'Choose Folder...'}</button>
                        <button type="button" class="secondary-btn" id="backup-settings-folder-clear-btn" ${loading || saving || pickingFolder || folderPath.length === 0 ? 'disabled' : ''}>Clear</button>
                    </div>
                    <p>Use an absolute path. MetaList will create the folder if needed.</p>
                </div>

                <div class="form-group">
                    <label>Namespaces to include</label>
                    ${namespaceSelectionHtml}
                </div>

                <div class="form-group">
                    <label for="backup-settings-retention-count">Backups to retain per namespace</label>
                    <input type="number" id="backup-settings-retention-count" min="1" step="1" value="${retentionCountText}" ${loading || saving ? 'disabled' : ''}>
                </div>

                <div class="form-actions">
                    <button type="button" class="primary-btn" id="backup-settings-run-btn" ${loading || saving ? 'disabled' : ''}>${saving ? 'Saving...' : 'Back Up Now'}</button>
                    <button type="button" class="secondary-btn" id="backup-settings-cancel-btn" ${loading || saving || pickingFolder ? 'disabled' : ''}>Cancel</button>
                </div>

                <p id="backup-settings-status">${escapeHtml(effectiveStatusMessage)}</p>
                <p id="backup-settings-error" class="error-message">${escapeHtml(error)}</p>
            </div>
        `;

        this.setupFormEventListeners();
        setTimeout(() => this._focusPreferredControl(), 0);
    }

    _focusPreferredControl() {
        const focusCandidateIds = [
            'backup-settings-retention-count',
            'backup-settings-folder-pick-btn',
            'backup-settings-run-btn',
            'backup-settings-cancel-btn',
        ];

        for (const candidateId of focusCandidateIds) {
            const candidate = document.getElementById(candidateId);
            if (!(candidate instanceof HTMLElement)) {
                continue;
            }
            if (candidate.hasAttribute('disabled')) {
                continue;
            }
            candidate.focus();
            return;
        }
    }

    _defaultSelectedNamespaces(availableNamespaces) {
        if (!Array.isArray(availableNamespaces)) {
            throw new Error('availableNamespaces must be an array');
        }
        return availableNamespaces.map((namespace) => {
            if (typeof namespace !== 'string' || namespace.length === 0) {
                throw new Error('availableNamespaces entries must be non-empty strings');
            }
            return namespace;
        });
    }

    setupFormEventListeners() {
        const cancelButton = document.getElementById('backup-settings-cancel-btn');
        if (cancelButton instanceof HTMLButtonElement) {
            cancelButton.onclick = () => {
                this.close();
            };
        }

        const folderPickButton = document.getElementById('backup-settings-folder-pick-btn');
        if (folderPickButton instanceof HTMLButtonElement) {
            folderPickButton.onclick = async () => {
                await this.pickFolderPath();
            };
        }

        const folderClearButton = document.getElementById('backup-settings-folder-clear-btn');
        if (folderClearButton instanceof HTMLButtonElement) {
            folderClearButton.onclick = () => {
                this.updateModalState({
                    folderPath: '',
                    error: '',
                });
                this.renderModalContent();
            };
        }

        const namespaceCheckboxes = document.querySelectorAll('[data-backup-namespace]');
        namespaceCheckboxes.forEach((element) => {
            if (!(element instanceof HTMLInputElement)) {
                throw new Error('Namespace checkbox must be an input');
            }
            element.onchange = () => {
                const state = this.getModalState();
                const availableNamespaces = Array.isArray(state.availableNamespaces) ? state.availableNamespaces : [];
                const checkedNamespaces = availableNamespaces.filter((candidate) => {
                    const candidateElement = document.querySelector(`[data-backup-namespace="${CSS.escape(candidate)}"]`);
                    return candidateElement instanceof HTMLInputElement && candidateElement.checked;
                });
                this.updateModalState({
                    selectedNamespaces: checkedNamespaces,
                    error: '',
                });
            };
        });

        const retentionInput = document.getElementById('backup-settings-retention-count');
        if (retentionInput instanceof HTMLInputElement) {
            retentionInput.oninput = () => {
                this.updateModalState({
                    retentionCountText: retentionInput.value,
                    error: '',
                });
            };
        }

        const runButton = document.getElementById('backup-settings-run-btn');
        if (runButton instanceof HTMLButtonElement) {
            runButton.onclick = async () => {
                await this.handleRunBackup();
            };
        }
    }

    _buildAuthHeaders(includeContentType) {
        return buildSessionHeaders(includeContentType);
    }

    async _authRequest(url, method, payload) {
        if (typeof url !== 'string' || url.length === 0) {
            throw new Error('_authRequest requires url');
        }
        if (typeof method !== 'string' || method.length === 0) {
            throw new Error('_authRequest requires method');
        }
        const includeContentType = payload !== null;
        const response = await fetch(url, {
            method,
            headers: this._buildAuthHeaders(includeContentType),
            body: payload === null ? undefined : JSON.stringify(payload),
        });

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
            pickingFolder: false,
            statusMessage: 'Loading backup settings...',
            error: '',
        });
        this.renderModalContent();
        const settled = await this._authRequest(CONFIG.API.BACKUP.SETTINGS, 'GET', null).then(
            (payload) => ({ ok: true, payload }),
            (error) => { rethrowUnexpectedError(error); return ({ ok: false, error }); },
        );
        if (!settled.ok) {
            this.updateModalState({
                loading: false,
                statusMessage: '',
                error: this._errorMessage(settled.error),
            });
            this.renderModalContent();
            return;
        }
        const payload = settled.payload;
        if (!payload || typeof payload !== 'object') {
            this.updateModalState({
                loading: false,
                statusMessage: '',
                error: 'Backup settings response missing body',
            });
            this.renderModalContent();
            return;
        }
        if (!Array.isArray(payload.selected_namespaces)) {
            this.updateModalState({
                loading: false,
                statusMessage: '',
                error: 'Backup settings response missing selected_namespaces',
            });
            this.renderModalContent();
            return;
        }
        if (!Array.isArray(payload.available_namespaces)) {
            this.updateModalState({
                loading: false,
                statusMessage: '',
                error: 'Backup settings response missing available_namespaces',
            });
            this.renderModalContent();
            return;
        }
        this.updateModalState({
            loading: false,
            pickingFolder: false,
            folderPath: typeof payload.folder_path === 'string' ? payload.folder_path : '',
            selectedNamespaces: this._defaultSelectedNamespaces(payload.available_namespaces),
            availableNamespaces: payload.available_namespaces,
            retentionCountText: String(payload.retention_count),
            statusMessage: '',
            error: '',
        });
        this.renderModalContent();
    }

    _parseRetentionCount() {
        const state = this.getModalState();
        const raw = typeof state.retentionCountText === 'string' ? state.retentionCountText.trim() : '';
        if (!/^[0-9]+$/.test(raw)) {
            throw new Error('Retention count must be a whole number.');
        }
        const retentionCount = Number.parseInt(raw, 10);
        if (!Number.isInteger(retentionCount) || retentionCount <= 0) {
            throw new Error('Retention count must be greater than zero.');
        }
        return retentionCount;
    }

    async pickFolderPath() {
        this.updateModalState({
            pickingFolder: true,
            statusMessage: 'Choose a backup folder...',
            error: '',
        });
        this.renderModalContent();
        const settled = await this._authRequest(CONFIG.API.BACKUP.FOLDER_PICK, 'POST', {}).then(
            (payload) => ({ ok: true, payload }),
            (error) => { rethrowUnexpectedError(error); return ({ ok: false, error }); },
        );
        if (!settled.ok) {
            this.updateModalState({
                pickingFolder: false,
                statusMessage: '',
                error: this._errorMessage(settled.error),
            });
            this.renderModalContent();
            return;
        }
        const payload = settled.payload;
        if (!payload || typeof payload !== 'object') {
            this.updateModalState({
                pickingFolder: false,
                statusMessage: '',
                error: 'Folder picker response missing body',
            });
            this.renderModalContent();
            return;
        }
        if (payload.selected === true) {
            if (typeof payload.folder_path !== 'string' || payload.folder_path.length === 0) {
                this.updateModalState({
                    pickingFolder: false,
                    statusMessage: '',
                    error: 'Folder picker response missing folder path',
                });
                this.renderModalContent();
                return;
            }
            this.updateModalState({
                pickingFolder: false,
                folderPath: payload.folder_path,
                statusMessage: '',
                error: '',
            });
            this.renderModalContent();
            return;
        }
        this.updateModalState({
            pickingFolder: false,
            statusMessage: '',
            error: '',
        });
        this.renderModalContent();
    }

    handleRunBackup() {
        if (this._pendingRunBackup !== null) {
            return this._pendingRunBackup;
        }
        const pendingRunBackup = this._runBackupOnce();
        this._pendingRunBackup = pendingRunBackup;
        return pendingRunBackup.then(
            (result) => {
                if (this._pendingRunBackup !== pendingRunBackup) {
                    throw new Error('Backup settings run promise changed before completion');
                }
                this._pendingRunBackup = null;
                return result;
            },
            (error) => {
            rethrowUnexpectedError(error);
                if (this._pendingRunBackup !== pendingRunBackup) {
                    throw new Error('Backup settings run promise changed before failure');
                }
                this._pendingRunBackup = null;
                throw error;
            },
        );
    }

    async _runBackupOnce() {
        const state = this.getModalState();
        const folderPath = typeof state.folderPath === 'string' ? state.folderPath.trim() : '';
        const selectedNamespaces = Array.isArray(state.selectedNamespaces) ? state.selectedNamespaces : [];
        if (folderPath.length === 0) {
            this.updateModalState({
                error: 'Choose a backup folder before running a backup.',
            });
            this.renderModalContent();
            return;
        }
        if (selectedNamespaces.length === 0) {
            this.updateModalState({
                error: 'Select at least one namespace to back up.',
            });
            this.renderModalContent();
            return;
        }
        this.updateModalState({
            saving: true,
            error: '',
        });
        this.renderModalContent();
        const retentionResult = await Promise.resolve()
            .then(() => this._parseRetentionCount())
            .then(
                (value) => ({ ok: true, value }),
                (error) => { rethrowUnexpectedError(error); return ({ ok: false, error }); },
            );
        if (!retentionResult.ok) {
            this.updateModalState({
                saving: false,
                error: this._errorMessage(retentionResult.error),
            });
            this.renderModalContent();
            return;
        }
        const retentionCount = retentionResult.value;

        this._decision.result = {
            action: 'run_backup',
            settings: {
                folder_path: folderPath,
                selected_namespaces: selectedNamespaces,
                retention_count: retentionCount,
            },
        };
        this.close();
    }
}
