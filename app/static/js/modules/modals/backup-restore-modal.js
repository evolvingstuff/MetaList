import { ApplicationState } from '../application-state.js';
import { HttpRequestError, rethrowUnexpectedError } from '../expected-errors.js';
import { BaseModal } from './base-modal.js';
import { CONFIG } from '../config.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { buildSessionHeaders } from '../session-auth.js';
import { settleResult } from '../async-result.js';


const RESTORE_TRANSITION_SUPPRESS_MS = 30_000;
const RESTORE_TRANSITION_UNTIL_KEY = 'metalist_restore_transition_until_ms';
const SERVER_REACHABILITY_POLL_INTERVAL_MS = 300;
const SERVER_REACHABILITY_REQUEST_TIMEOUT_MS = 1000;
const RESTORE_RECONNECT_CURSOR_CLASS = 'restore-reconnect-loading';


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


function backupSourceLabel(source) {
    if (source === 'folder') {
        return 'Folder';
    }
    return 'Local';
}


function escapeHtml(value) {
    if (typeof value !== 'string') {
        throw new Error('escapeHtml requires string');
    }
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}


function stringifyPort(portValue) {
    if (portValue === null) {
        return '';
    }
    if (!Number.isInteger(portValue)) {
        throw new Error('stringifyPort requires integer or null');
    }
    return String(portValue);
}


function parsePort(rawValue, label) {
    if (typeof rawValue !== 'string') {
        throw new Error(`${label} is required`);
    }
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
        throw new Error(`${label} is required`);
    }
    if (!/^[0-9]+$/.test(trimmed)) {
        throw new Error(`${label} must be numeric`);
    }
    const port = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${label} must be between 1 and 65535`);
    }
    return port;
}


function validatePortsDoNotOverlap(profile) {
    const pairs = [
        ['HTTP', profile.port],
        ['HTTPS', profile.https_port],
    ];
    const seen = new Map();
    for (const [service, port] of pairs) {
        if (port === null) {
            continue;
        }
        if (seen.has(port)) {
            throw new Error(`${service} port ${port} conflicts with ${seen.get(port)} port`);
        }
        seen.set(port, service);
    }
}


export class BackupRestoreModal extends BaseModal {
    constructor() {
        super('backupRestoreModal', 'backup-restore-modal');
        this.apiEndpoints = {
            list: CONFIG.API.BACKUP.LIST,
            restore: CONFIG.API.BACKUP.RESTORE,
            restorePreflight: CONFIG.API.BACKUP.RESTORE_PREFLIGHT,
            restoreImport: CONFIG.API.BACKUP.RESTORE_IMPORT,
        };

        ApplicationState.own(this, 'BackupRestoreModal', new.target === BackupRestoreModal);
    }

    getInitialModalState() {
        return {
            loading: false,
            choosingFolder: false,
            restoring: false,
            confirming: false,
            restored: false,
            waitingForServer: false,
            restoredFilename: '',
            restoredTargetNamespace: '',
            activeNamespaceRestarted: false,
            openNamespaceSuggested: false,
            backups: [],
            selectedBackupId: '',
            targetNamespaceText: '',
            preflight: null,
            importLaunchProfile: null,
            overwriteConfirmText: '',
            targetPassword: '',
            error: '',
        };
    }

    shouldCloseOnClickOutside() {
        return true;
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
        await this.loadBackups();
    }

    onClose() {
        // BaseModal disposes the state scope; clear retained form DOM as well.
        document.getElementById(this.modalElementId).replaceChildren();
        this._setReconnectCursor(false);
    }

    requestClose() {
        const state = this.getModalState();
        if (state.restored === true && state.activeNamespaceRestarted === true) {
            this._beginPostRestoreReconnectAndReload();
            return;
        }
        super.requestClose();
    }

    handleKeyDown(event) {
        const topModal = ModeContext.topModal;
        if (topModal !== this.modalName) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.requestClose();
            return;
        }
        this.onKeyDown(event);
    }

    handleClickOutside(event) {
        const modalContent = event.currentTarget.querySelector('.modal-content');
        if (!modalContent || modalContent.contains(event.target)) {
            return;
        }
        this.requestClose();
    }

    onKeyDown(event) {
        if (!(event instanceof KeyboardEvent)) {
            throw new Error('BackupRestoreModal.onKeyDown requires KeyboardEvent');
        }
        if (event.key !== 'Enter') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const state = this.getModalState();
        if (state && state.restored && Boolean(state.activeNamespaceRestarted)) {
            this._beginPostRestoreReconnectAndReload();
            return;
        }
        void this.handleRestore();
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }

        const state = this.getModalState();
        const backups = Array.isArray(state.backups) ? state.backups : [];
        const selectedBackupId = typeof state.selectedBackupId === 'string' ? state.selectedBackupId : '';
        const targetNamespaceText = typeof state.targetNamespaceText === 'string' ? state.targetNamespaceText : '';
        const overwriteConfirmText = typeof state.overwriteConfirmText === 'string' ? state.overwriteConfirmText : '';
        const targetPassword = typeof state.targetPassword === 'string' ? state.targetPassword : '';
        const preflight = state.preflight && typeof state.preflight === 'object' ? state.preflight : null;
        const error = typeof state.error === 'string' ? state.error : '';
        const loading = Boolean(state.loading);
        const choosingFolder = Boolean(state.choosingFolder);
        const restoring = Boolean(state.restoring);
        const confirming = Boolean(state.confirming);
        const restored = Boolean(state.restored);
        const waitingForServer = Boolean(state.waitingForServer);
        const restoredFilename = typeof state.restoredFilename === 'string' ? state.restoredFilename : '';
        const restoredTargetNamespace = typeof state.restoredTargetNamespace === 'string' ? state.restoredTargetNamespace : '';
        const activeNamespaceRestarted = Boolean(state.activeNamespaceRestarted);
        const openNamespaceSuggested = Boolean(state.openNamespaceSuggested);

        if (restored) {
            if (restoredFilename.length === 0 || restoredTargetNamespace.length === 0) {
                throw new Error('Backup restore success state missing restored values');
            }
            if (activeNamespaceRestarted) {
                if (waitingForServer) {
                    modalElement.innerHTML = `
                        <div class="modal-content backup-restore-modal-content">
                            <h3>Restore Complete</h3>
                            <p>Backup restored successfully: <span class="backup-filename">${restoredFilename}</span></p>
                            <p>Reconnecting to restarted server. You will be redirected automatically.</p>
                        </div>
                    `;
                    return;
                }
                modalElement.innerHTML = `
                    <div class="modal-content backup-restore-modal-content">
                        <h3>Restore Complete</h3>
                        <p>Backup restored successfully: <span class="backup-filename">${restoredFilename}</span></p>
                        <p>Close this modal to reload the app.</p>
                    </div>
                `;
                return;
            }

            modalElement.innerHTML = `
                <div class="modal-content backup-restore-modal-content">
                    <h3>Restore Complete</h3>
                    <p>Backup restored successfully: <span class="backup-filename">${restoredFilename}</span></p>
                    <p>Restored into namespace <strong>${restoredTargetNamespace}</strong>.</p>
                    <p>${openNamespaceSuggested ? 'Use the namespace switcher to open it.' : 'You can continue using it now.'}</p>
                </div>
            `;
            return;
        }

        let selectedBackup = backups.find((backup) => backup.backup_id === selectedBackupId);
        if (typeof selectedBackup === 'undefined') {
            selectedBackup = null;
        }
        const selectSize = backups.length > 1 ? Math.min(backups.length, 8) : 1;
        const optionsHtml = backups.map((backup) => {
            if (!backup || typeof backup !== 'object') {
                throw new Error('Invalid backup list entry');
            }
            if (typeof backup.backup_id !== 'string' || backup.backup_id.length === 0) {
                throw new Error('Backup entry missing backup_id');
            }
            if (typeof backup.filename !== 'string' || backup.filename.length === 0) {
                throw new Error('Backup entry missing filename');
            }
            if (typeof backup.namespace !== 'string' || backup.namespace.length === 0) {
                throw new Error('Backup entry missing namespace');
            }
            if (typeof backup.created_at !== 'string' || backup.created_at.length === 0) {
                throw new Error('Backup entry missing created_at');
            }
            if (typeof backup.size_bytes !== 'number') {
                throw new Error('Backup entry missing size_bytes');
            }
            const sourceLabel = backupSourceLabel(backup.source);
            const isSelected = backup.backup_id === selectedBackupId ? 'selected' : '';
            const label = `${sourceLabel} · ${backup.namespace} · ${backup.filename} (${Math.round(backup.size_bytes / 1024)} KB, ${backup.created_at})`;
            return `<option value="${escapeHtml(backup.backup_id)}" ${isSelected}>${escapeHtml(label)}</option>`;
        }).join('');

        const selectedNamespace = selectedBackup && typeof selectedBackup.namespace === 'string' ? selectedBackup.namespace : '';
        const isImport = Boolean(preflight && preflight.same_namespace === false);
        const targetExists = Boolean(preflight && preflight.target_exists === true);
        const targetRequiresPassword = Boolean(preflight && preflight.target_requires_password === true);
        const overwriteWarningHtml = confirming && isImport && targetExists ? `
            <div class="namespace-delete-warning backup-restore-danger-warning">
                <p><strong>BIG WARNING:</strong> this will overwrite existing namespace <span class="namespace-delete-namespace">${escapeHtml(targetNamespaceText.trim())}</span> with backup data from <span class="namespace-delete-namespace">${escapeHtml(selectedNamespace)}</span>.</p>
                <p>This is not the normal same-name restore path. Type <strong>${escapeHtml(targetNamespaceText.trim())}</strong> to enable the import.</p>
                <input type="text" id="backup-overwrite-confirmation" value="${escapeHtml(overwriteConfirmText)}" placeholder="Type target namespace">
                ${targetRequiresPassword ? `
                    <label class="backup-restore-target-password-label" for="backup-target-password">Target namespace password</label>
                    <input type="password" id="backup-target-password" value="${escapeHtml(targetPassword)}" autocomplete="current-password" placeholder="Password for ${escapeHtml(targetNamespaceText.trim())}">
                ` : ''}
            </div>
        ` : '';
        let restoreButtonLabel = 'Restore Selected Backup';
        if (confirming && isImport && targetExists) {
            restoreButtonLabel = 'Import And Overwrite Namespace';
        } else if (confirming && isImport) {
            restoreButtonLabel = 'Confirm Import';
        } else if (confirming) {
            restoreButtonLabel = 'Confirm Restore';
        }
        const restoreButtonClass = confirming && isImport && targetExists ? 'danger-btn' : 'primary-btn';
        const emptyBackupsHtml = !loading && backups.length === 0 ? `
            <div class="backup-restore-empty-state">
                <p>No backups are available from this namespace's configured backup folder.</p>
                <p>Choose the folder containing your MetaList backup archives.</p>
                <button type="button" class="secondary-btn" id="backup-restore-choose-folder-btn" ${choosingFolder ? 'disabled' : ''}>${choosingFolder ? 'Choosing...' : 'Choose Backup Folder...'}</button>
            </div>
        ` : '';

        if (confirming) {
            if (selectedBackup === null) {
                throw new Error('Confirming restore without selected backup');
            }
            let confirmationSummaryHtml = '';
            if (isImport) {
                const targetStatus = targetExists ? 'existing namespace' : 'new namespace';
                confirmationSummaryHtml = `
                    <p>Import backup <span class="backup-filename">${escapeHtml(selectedBackup.filename)}</span></p>
                    <p>From namespace <strong>${escapeHtml(selectedNamespace)}</strong> into ${targetStatus} <strong>${escapeHtml(targetNamespaceText.trim())}</strong>.</p>
                `;
            } else {
                confirmationSummaryHtml = `
                    <p>Restore backup <span class="backup-filename">${escapeHtml(selectedBackup.filename)}</span></p>
                    <p>This will overwrite namespace <strong>${escapeHtml(targetNamespaceText.trim())}</strong>.</p>
                `;
            }
            const sameNamespaceWarningHtml = !isImport ? `
                <div class="namespace-delete-warning backup-restore-danger-warning">
                    <p><strong>Warning:</strong> this restore overwrites the target namespace.</p>
                </div>
            ` : '';
            modalElement.innerHTML = `
                <div class="modal-content backup-restore-modal-content">
                    <h3>${isImport ? 'Import Backup' : 'Restore From Backup'}</h3>
                    ${confirmationSummaryHtml}
                    ${sameNamespaceWarningHtml}
                    ${overwriteWarningHtml}

                    <div class="form-actions">
                        <button type="button" class="${restoreButtonClass}" id="restore-backup-btn" ${restoring || backups.length === 0 ? 'disabled' : ''}>${restoreButtonLabel}</button>
                        <button type="button" class="secondary-btn" id="close-backup-modal-btn" ${restoring ? 'disabled' : ''}>Back</button>
                    </div>

                    <p id="backup-modal-status">${restoring ? 'Restoring backup...' : ''}</p>
                    <p id="backup-modal-error" class="error-message">${escapeHtml(error)}</p>
                </div>
            `;
            this.setupFormEventListeners();
            return;
        }

        modalElement.innerHTML = `
            <div class="modal-content backup-restore-modal-content">
                <h3>Restore From Backup</h3>
                <p>Select a backup snapshot and restore the workspace data.</p>
                <p>Same-name restores overwrite that namespace. Different-name imports create a namespace unless the target already exists.</p>
                ${emptyBackupsHtml}

                <div class="form-group">
                    <label for="backup-select">Available Backups</label>
                    <select id="backup-select" size="${selectSize}" ${loading || restoring || confirming || backups.length === 0 ? 'disabled' : ''}>
                        ${optionsHtml}
                    </select>
                </div>

                <div class="form-group">
                    <label for="backup-target-namespace">Target namespace</label>
                    <input type="text" id="backup-target-namespace" value="${escapeHtml(targetNamespaceText)}" ${loading || restoring || confirming || backups.length === 0 ? 'disabled' : ''}>
                </div>

                <p>${selectedNamespace ? `Backup namespace: ${escapeHtml(selectedNamespace)}` : ''}</p>

                <div class="form-actions">
                    <button type="button" class="${restoreButtonClass}" id="restore-backup-btn" ${loading || restoring || backups.length === 0 ? 'disabled' : ''}>${restoreButtonLabel}</button>
                    <button type="button" class="secondary-btn" id="close-backup-modal-btn" ${restoring ? 'disabled' : ''}>${confirming ? 'Back' : 'Cancel'}</button>
                </div>

                <p id="backup-modal-status">${loading ? 'Loading backups...' : ''}${choosingFolder ? ' Choosing a backup folder...' : ''}${restoring ? ' Restoring backup...' : ''}</p>
                <p id="backup-modal-error" class="error-message">${escapeHtml(error)}</p>
            </div>
        `;

        this.setupFormEventListeners();
    }

    setupFormEventListeners() {
        const closeButton = document.getElementById('close-backup-modal-btn');
        if (closeButton instanceof HTMLButtonElement) {
            closeButton.onclick = () => {
                const state = this.getModalState();
                if (state.confirming) {
                    this.updateModalState({
                        confirming: false,
                        preflight: null,
                        importLaunchProfile: null,
                        overwriteConfirmText: '',
                        targetPassword: '',
                        error: '',
                    });
                    this.renderModalContent();
                    return;
                }
                this.close();
            };
        }

        const restoreButton = document.getElementById('restore-backup-btn');
        if (restoreButton instanceof HTMLButtonElement) {
            restoreButton.onclick = async () => {
                await this.handleRestore();
            };
        }

        const chooseFolderButton = document.getElementById('backup-restore-choose-folder-btn');
        if (chooseFolderButton instanceof HTMLButtonElement) {
            chooseFolderButton.onclick = async () => {
                await this.chooseBackupFolder();
            };
        }

        const select = document.getElementById('backup-select');
        if (select instanceof HTMLSelectElement) {
            select.onchange = () => {
                const backups = this.getModalState().backups;
                const selectedBackup = Array.isArray(backups)
                    ? backups.find((backup) => backup.backup_id === select.value) || null
                    : null;
                const nextNamespace = selectedBackup && typeof selectedBackup.namespace === 'string'
                    ? selectedBackup.namespace
                    : '';
                this.updateModalState({
                    selectedBackupId: select.value,
                    targetNamespaceText: nextNamespace,
                    confirming: false,
                    preflight: null,
                    importLaunchProfile: null,
                    overwriteConfirmText: '',
                    targetPassword: '',
                    error: '',
                });
                this.renderModalContent();
            };
        }

        const targetNamespaceInput = document.getElementById('backup-target-namespace');
        if (targetNamespaceInput instanceof HTMLInputElement) {
            targetNamespaceInput.oninput = () => {
                this.updateModalState({
                    targetNamespaceText: targetNamespaceInput.value,
                    confirming: false,
                    preflight: null,
                    importLaunchProfile: null,
                    overwriteConfirmText: '',
                    targetPassword: '',
                    error: '',
                });
            };
        }

        const overwriteInput = document.getElementById('backup-overwrite-confirmation');
        if (overwriteInput instanceof HTMLInputElement) {
            overwriteInput.oninput = () => {
                this.updateModalState({
                    overwriteConfirmText: overwriteInput.value,
                    error: '',
                });
            };
        }

        const targetPasswordInput = document.getElementById('backup-target-password');
        if (targetPasswordInput instanceof HTMLInputElement) {
            targetPasswordInput.oninput = () => {
                this.updateModalState({
                    targetPassword: targetPasswordInput.value,
                    error: '',
                });
            };
        }

    }

    _buildAuthHeaders(includeContentType) {
        return buildSessionHeaders(includeContentType);
    }

    async _authRequest(url, method, bodyObject) {
        if (typeof url !== 'string' || url.length === 0) {
            throw new Error('_authRequest requires url');
        }
        if (typeof method !== 'string' || method.length === 0) {
            throw new Error('_authRequest requires method');
        }
        if (bodyObject !== null && typeof bodyObject !== 'object') {
            throw new Error('_authRequest bodyObject must be object or null');
        }

        const hasBody = bodyObject !== null;
        const response = await fetch(url, {
            method,
            headers: this._buildAuthHeaders(hasBody),
            body: hasBody ? JSON.stringify(bodyObject) : undefined,
        });

        let payload = null;
        const contentType = response.headers.get('content-type');
        if (typeof contentType === 'string' && contentType.includes('application/json')) {
            payload = await response.json();
        }
        if (!response.ok) {
            throw new HttpRequestError(parseResponseError(payload, response.status));
        }
        if (payload === null) {
            throw new Error('Response payload missing');
        }
        return payload;
    }

    async loadBackups() {
        this.updateModalState({
            loading: true,
            choosingFolder: false,
            restoring: false,
            confirming: false,
            restored: false,
            waitingForServer: false,
            restoredFilename: '',
            restoredTargetNamespace: '',
            activeNamespaceRestarted: false,
            openNamespaceSuggested: false,
            error: '',
            backups: [],
            selectedBackupId: '',
            targetNamespaceText: '',
            preflight: null,
            importLaunchProfile: null,
            overwriteConfirmText: '',
            targetPassword: '',
        });
        this.renderModalContent();

        const payload = await this._authRequest(this.apiEndpoints.list, 'GET', null);
        if (!payload || typeof payload !== 'object') {
            throw new Error('Backup list response missing body');
        }
        if (!Array.isArray(payload.backups)) {
            throw new Error('Backup list response missing backups array');
        }

        const backups = payload.backups;
        const firstBackup = backups.length > 0 ? backups[0] : null;
        const selectedBackupId = firstBackup && typeof firstBackup.backup_id === 'string' ? firstBackup.backup_id : '';
        const targetNamespaceText = firstBackup && typeof firstBackup.namespace === 'string' ? firstBackup.namespace : '';
        this.updateModalState({
            loading: false,
            backups,
            selectedBackupId,
            targetNamespaceText,
            preflight: null,
            importLaunchProfile: null,
            overwriteConfirmText: '',
            targetPassword: '',
            error: '',
        });
        this.renderModalContent();
    }

    _parseBackupSettingsForFolderChoice(payload) {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Backup settings response missing body');
        }
        if (!Array.isArray(payload.selected_namespaces) || payload.selected_namespaces.length === 0) {
            throw new Error('Backup settings response missing selected_namespaces');
        }
        for (const namespace of payload.selected_namespaces) {
            if (typeof namespace !== 'string' || namespace.length === 0) {
                throw new Error('Backup settings selected_namespaces entries must be non-empty strings');
            }
        }
        if (!Number.isInteger(payload.retention_count) || payload.retention_count <= 0) {
            throw new Error('Backup settings response missing retention_count');
        }
        return {
            selectedNamespaces: payload.selected_namespaces,
            retentionCount: payload.retention_count,
        };
    }

    _parseBackupFolderPick(payload) {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Folder picker response missing body');
        }
        if (payload.selected === false) {
            return null;
        }
        if (payload.selected !== true) {
            throw new Error('Folder picker response missing selected state');
        }
        if (typeof payload.folder_path !== 'string' || payload.folder_path.length === 0) {
            throw new Error('Folder picker response missing folder path');
        }
        return payload.folder_path;
    }

    async _pickAndPersistBackupFolder() {
        const settingsPayload = await this._authRequest(CONFIG.API.BACKUP.SETTINGS, 'GET', null);
        const settings = this._parseBackupSettingsForFolderChoice(settingsPayload);
        const pickPayload = await this._authRequest(CONFIG.API.BACKUP.FOLDER_PICK, 'POST', {});
        const folderPath = this._parseBackupFolderPick(pickPayload);
        if (folderPath === null) {
            return false;
        }
        await this._authRequest(CONFIG.API.BACKUP.SETTINGS, 'PUT', {
            folder_path: folderPath,
            selected_namespaces: settings.selectedNamespaces,
            retention_count: settings.retentionCount,
        });
        return true;
    }

    async chooseBackupFolder() {
        this.updateModalState({
            choosingFolder: true,
            error: '',
        });
        this.renderModalContent();
        const choiceResult = await settleResult(() => this._pickAndPersistBackupFolder());
        if (!choiceResult.ok) {
            const error = choiceResult.error;
            const message = error instanceof Error ? error.message : 'Failed to choose backup folder';
            this.updateModalState({ choosingFolder: false, error: message });
            this.renderModalContent();
            return;
        }
        if (!choiceResult.value) {
            this.updateModalState({ choosingFolder: false, error: '' });
            this.renderModalContent();
            return;
        }
        await this.loadBackups();
    }

    _buildRestoreBasePayload(selectedBackup, targetNamespace) {
        if (!selectedBackup || typeof selectedBackup !== 'object') {
            throw new Error('Selected backup is missing');
        }
        return {
            backup_id: selectedBackup.backup_id,
            source: selectedBackup.source,
            backup_filename: selectedBackup.filename,
            backup_namespace: selectedBackup.namespace,
            target_namespace: targetNamespace,
        };
    }

    _buildImportLaunchProfile() {
        const state = this.getModalState();
        const importLaunchProfile = state.importLaunchProfile && typeof state.importLaunchProfile === 'object'
            ? state.importLaunchProfile
            : null;
        if (importLaunchProfile === null) {
            throw new Error('Restore preflight did not assign launch ports for the imported namespace');
        }
        const profile = {
            port: parsePort(importLaunchProfile.port, 'HTTP port'),
            https_port: importLaunchProfile.httpsPort === null
                ? null
                : parsePort(importLaunchProfile.httpsPort, 'HTTPS port'),
        };
        validatePortsDoNotOverlap(profile);
        return profile;
    }

    _importLaunchProfileFromResponse(profile) {
        if (!profile || typeof profile !== 'object') {
            throw new Error('Restore preflight missing suggested launch profile');
        }
        if (!Number.isInteger(profile.port)) {
            throw new Error('Restore preflight suggested profile missing HTTP port');
        }
        if (profile.https_port !== null && !Number.isInteger(profile.https_port)) {
            throw new Error('Restore preflight suggested profile missing HTTPS port');
        }
        return {
            port: stringifyPort(profile.port),
            httpsPort: profile.https_port === null ? null : stringifyPort(profile.https_port),
        };
    }

    _findSelectedBackup(state) {
        const backups = Array.isArray(state.backups) ? state.backups : [];
        let selectedBackup = backups.find((backup) => backup.backup_id === state.selectedBackupId);
        if (typeof selectedBackup === 'undefined') {
            selectedBackup = null;
        }
        return selectedBackup;
    }

    _validateRestoreSelection(state) {
        if (typeof state.selectedBackupId !== 'string' || state.selectedBackupId.length === 0) {
            throw new Error('Select a backup first.');
        }
        const selectedBackup = this._findSelectedBackup(state);
        if (selectedBackup === null) {
            throw new Error('Selected backup is missing.');
        }
        if (typeof state.targetNamespaceText !== 'string' || state.targetNamespaceText.trim().length === 0) {
            throw new Error('Target namespace is required.');
        }
        return {
            selectedBackup,
            targetNamespace: state.targetNamespaceText.trim(),
        };
    }

    async _prepareRestoreConfirmation() {
        const state = this.getModalState();
        const selection = this._validateRestoreSelection(state);
        this.updateModalState({ error: '' });
        this.renderModalContent();
        const preflight = await this._authRequest(
            this.apiEndpoints.restorePreflight,
            'POST',
            this._buildRestoreBasePayload(selection.selectedBackup, selection.targetNamespace),
        );
        if (!preflight || typeof preflight !== 'object') {
            throw new Error('Restore preflight response missing body');
        }
        const sameNamespace = preflight.same_namespace === true;
        let importLaunchProfile = null;
        if (!sameNamespace) {
            const suggestedProfile = preflight.suggested_profile;
            importLaunchProfile = this._importLaunchProfileFromResponse(suggestedProfile);
        }
        this.updateModalState({
            confirming: true,
            preflight,
            importLaunchProfile,
            overwriteConfirmText: '',
            targetPassword: '',
            error: '',
        });
        this.renderModalContent();
    }

    async _submitConfirmedRestore() {
        const state = this.getModalState();
        const selection = this._validateRestoreSelection(state);
        const preflight = state.preflight && typeof state.preflight === 'object' ? state.preflight : null;
        if (preflight === null) {
            throw new Error('Restore preflight is required before restore');
        }
        const sameNamespace = preflight.same_namespace === true;
        if (typeof preflight.target_is_active !== 'boolean') {
            throw new Error('Restore preflight missing target_is_active');
        }
        const targetIsActive = preflight.target_is_active;
        const targetExists = preflight.target_exists === true;
        if (!sameNamespace && targetExists) {
            const confirmation = typeof state.overwriteConfirmText === 'string'
                ? state.overwriteConfirmText.trim()
                : '';
            if (confirmation !== selection.targetNamespace) {
                throw new Error(`Type ${selection.targetNamespace} to confirm overwriting that namespace`);
            }
            if (preflight.target_requires_password === true) {
                const targetPassword = typeof state.targetPassword === 'string' ? state.targetPassword : '';
                if (targetPassword.length === 0) {
                    throw new Error(`Enter the password for ${selection.targetNamespace}`);
                }
            }
        }
        this.updateModalState({
            restoring: true,
            error: '',
        });
        this.renderModalContent();

        const basePayload = this._buildRestoreBasePayload(selection.selectedBackup, selection.targetNamespace);
        if (targetIsActive) {
            this._markRestoreTransitionActive();
        }
        let restoreRequestResult = null;
        if (sameNamespace) {
            restoreRequestResult = await settleResult(
                () => this._authRequest(this.apiEndpoints.restore, 'POST', basePayload),
            );
        } else {
            restoreRequestResult = await settleResult(
                () => this._authRequest(this.apiEndpoints.restoreImport, 'POST', {
                    ...basePayload,
                    overwrite_existing_target: targetExists,
                    target_password: typeof state.targetPassword === 'string' ? state.targetPassword : '',
                    launch_profile: this._buildImportLaunchProfile(),
                }),
            );
        }
        if (!restoreRequestResult.ok) {
            if (targetIsActive) {
                this._clearRestoreTransitionActive();
            }
            throw restoreRequestResult.error;
        }
        const payload = restoreRequestResult.value;
        if (!payload || typeof payload !== 'object') {
            if (targetIsActive) {
                this._clearRestoreTransitionActive();
            }
            throw new Error('Restore response missing body');
        }

        const activeNamespaceRestarted = payload.active_namespace_restarted === true;
        if (activeNamespaceRestarted) {
            this._markRestoreTransitionActive();
        } else if (targetIsActive) {
            this._clearRestoreTransitionActive();
        }
        this.updateModalState({
            loading: false,
            restoring: false,
            confirming: false,
            preflight: null,
            importLaunchProfile: null,
            overwriteConfirmText: '',
            targetPassword: '',
            restored: true,
            waitingForServer: false,
            restoredFilename: payload.backup_filename,
            restoredTargetNamespace: payload.target_namespace,
            activeNamespaceRestarted,
            openNamespaceSuggested: payload.open_namespace_suggested === true,
            error: '',
        });
        this.renderModalContent();
    }

    async handleRestore() {
        const restoreResult = await settleResult(async () => {
            const state = this.getModalState();
            if (!state.confirming) {
                await this._prepareRestoreConfirmation();
                return;
            }
            await this._submitConfirmedRestore();
        });
        if (!restoreResult.ok) {
            const error = restoreResult.error;
            const message = error instanceof Error ? error.message : 'Restore failed';
            this.updateModalState({
                restoring: false,
                error: message,
            });
            this.renderModalContent();
        }
    }

    _markRestoreTransitionActive() {
        const transitionUntil = Date.now() + RESTORE_TRANSITION_SUPPRESS_MS;
        sessionStorage.setItem(RESTORE_TRANSITION_UNTIL_KEY, String(transitionUntil));
    }

    _clearRestoreTransitionActive() {
        sessionStorage.removeItem(RESTORE_TRANSITION_UNTIL_KEY);
    }

    _beginPostRestoreReconnectAndReload() {
        const state = this.getModalState();
        if (!state || !state.restored || !state.activeNamespaceRestarted) {
            throw new Error('Cannot begin post-restore reconnect before active-namespace restore success');
        }
        if (state.waitingForServer) {
            return;
        }
        this._setReconnectCursor(true);
        this.updateModalState({
            waitingForServer: true,
            error: '',
        });
        this.renderModalContent();
        void this._waitForServerReachabilityThenReload();
    }

    async _waitForServerReachabilityThenReload() {
        while (true) {
            const reachable = await this._checkServerReachability();
            if (reachable) {
                this._setReconnectCursor(false);
                window.location.reload();
                return;
            }
            await this._sleep(SERVER_REACHABILITY_POLL_INTERVAL_MS);
        }
    }

    async _checkServerReachability() {
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), SERVER_REACHABILITY_REQUEST_TIMEOUT_MS);
        const reachablePromise = fetch('/maintenance', {
            method: 'GET',
            cache: 'no-store',
            signal: abortController.signal,
        }).then(
            (response) => response.status >= 200 && response.status < 600,
            (error) => { rethrowUnexpectedError(error); return false; },
        );
        const reachable = await reachablePromise;
        clearTimeout(timeoutId);
        return reachable;
    }

    _sleep(delayMs) {
        if (!Number.isInteger(delayMs) || delayMs < 0) {
            throw new Error(`delayMs must be a non-negative integer, got ${delayMs}`);
        }
        return new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    _setReconnectCursor(active) {
        if (typeof active !== 'boolean') {
            throw new Error(`active must be a boolean, got ${typeof active}`);
        }
        if (!document.body) {
            throw new Error('document.body is required for reconnect cursor toggling');
        }
        if (active) {
            document.body.classList.add(RESTORE_RECONNECT_CURSOR_CLASS);
            return;
        }
        document.body.classList.remove(RESTORE_RECONNECT_CURSOR_CLASS);
    }
}
