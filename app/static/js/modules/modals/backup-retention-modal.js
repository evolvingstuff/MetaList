import { ApplicationState } from '../application-state.js';
import { BaseModal } from './base-modal.js';


function _assertPositiveInteger(value, fieldName) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${fieldName} must be a positive integer`);
    }
}


export class BackupRetentionModal extends BaseModal {
    constructor() {
        super('backupRetentionModal', 'backup-retention-modal');
        this._pendingResolve = null;
        this._context = null;
        this._decision = null;

        ApplicationState.own(this, 'BackupRetentionModal', new.target === BackupRetentionModal);
    }

    getInitialModalState() {
        if (this._context === null) {
            throw new Error('BackupRetentionModal requires context before initialization');
        }

        const defaultKeepCount = this._computeDefaultKeepCount(
            this._context.backupCount,
            this._context.suggestedKeepCount,
        );
        return {
            createdFilename: this._context.createdFilename,
            backupCount: this._context.backupCount,
            suggestedKeepCount: this._context.suggestedKeepCount,
            keepCountText: String(defaultKeepCount),
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

    openForBackup(context) {
        this._validateContext(context);
        if (this.isOpen) {
            throw new Error('BackupRetentionModal is already open');
        }
        if (this._pendingResolve !== null) {
            throw new Error('BackupRetentionModal already has a pending promise');
        }

        this._context = {
            createdFilename: context.createdFilename,
            backupCount: context.backupCount,
            suggestedKeepCount: context.suggestedKeepCount,
        };
        this._decision = { result: { action: 'keep_all' } };

        this.open();

        return new Promise((resolve) => {
            this._pendingResolve = resolve;
        });
    }

    onOpen() {
        if (this._context === null) {
            throw new Error('BackupRetentionModal missing open context');
        }
    }

    onClose() {
        const resolve = this._pendingResolve;
        const result = this._decision.result;

        this._pendingResolve = null;
        this._context = null;
        this._decision = null;

        if (resolve !== null) {
            resolve(result);
        }
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }

        const state = this.getModalState();
        if (typeof state.createdFilename !== 'string' || state.createdFilename.length === 0) {
            throw new Error('BackupRetentionModal state missing createdFilename');
        }
        if (!Number.isInteger(state.backupCount) || state.backupCount <= 0) {
            throw new Error('BackupRetentionModal state has invalid backupCount');
        }
        if (!Number.isInteger(state.suggestedKeepCount) || state.suggestedKeepCount <= 0) {
            throw new Error('BackupRetentionModal state has invalid suggestedKeepCount');
        }
        if (typeof state.keepCountText !== 'string') {
            throw new Error('BackupRetentionModal state has invalid keepCountText');
        }

        const createdFilename = state.createdFilename;
        const backupCount = state.backupCount;
        const suggestedKeepCount = state.suggestedKeepCount;
        const keepCountText = state.keepCountText;
        const error = typeof state.error === 'string' ? state.error : '';

        modalElement.innerHTML = `
            <div class="modal-content backup-retention-modal-content">
                <h3>Backup Retention</h3>
                <p>Backup created: <span class="backup-filename">${createdFilename}</span></p>
                <p>You now have <strong>${backupCount}</strong> backups.</p>
                <p>Choose how many backups to keep. Oldest backups beyond that count will be deleted.</p>

                <div class="form-group">
                    <label for="backup-retention-keep-count">Backups to keep (1-${backupCount}):</label>
                    <input
                        type="number"
                        id="backup-retention-keep-count"
                        min="1"
                        max="${backupCount}"
                        step="1"
                        value="${keepCountText}"
                    >
                </div>

                <p id="backup-retention-target">Suggested: keep ${suggestedKeepCount} backups.</p>
                <p id="backup-retention-preview"></p>

                <div class="form-actions">
                    <button type="button" class="primary-btn" id="backup-retention-apply-btn" data-modal-enter-action>Remove Older Backups</button>
                    <button type="button" class="secondary-btn" id="backup-retention-keep-all-btn">Keep All Backups</button>
                </div>

                <p id="backup-retention-error" class="error-message">${error}</p>
            </div>
        `;

        this.setupFormEventListeners();
        this._updatePreviewAndValidation();

        const keepCountInput = document.getElementById('backup-retention-keep-count');
        if (keepCountInput instanceof HTMLInputElement) {
            setTimeout(() => keepCountInput.focus(), 50);
        }
    }

    setupFormEventListeners() {
        const keepCountInput = document.getElementById('backup-retention-keep-count');
        if (keepCountInput instanceof HTMLInputElement) {
            keepCountInput.oninput = () => {
                this.updateModalState({
                    keepCountText: keepCountInput.value,
                    error: '',
                });
                this._updatePreviewAndValidation();
            };
        }

        const keepAllButton = document.getElementById('backup-retention-keep-all-btn');
        if (keepAllButton instanceof HTMLButtonElement) {
            keepAllButton.onclick = () => {
                this.close();
            };
        }

        const applyButton = document.getElementById('backup-retention-apply-btn');
        if (applyButton instanceof HTMLButtonElement) {
            applyButton.onclick = () => this._handleApply();
        }
    }

    _handleApply() {
        const parsedKeepCount = this._parseKeepCount();
        if (parsedKeepCount === null) {
            this._updatePreviewAndValidation();
            return;
        }

        this._decision.result = {
            action: 'apply',
            keepCount: parsedKeepCount,
        };
        this.close();
    }

    _parseKeepCount() {
        const state = this.getModalState();
        const backupCount = Number.isInteger(state.backupCount) ? state.backupCount : 0;
        if (backupCount <= 0) {
            throw new Error('backupCount must be positive');
        }

        const raw = typeof state.keepCountText === 'string' ? state.keepCountText.trim() : '';
        if (!/^[0-9]+$/.test(raw)) {
            this.updateModalState({ error: 'Enter a whole number.' });
            return null;
        }

        const keepCount = Number.parseInt(raw, 10);
        if (keepCount < 1 || keepCount > backupCount) {
            this.updateModalState({
                error: `Backups to keep must be between 1 and ${backupCount}.`,
            });
            return null;
        }

        return keepCount;
    }

    _updatePreviewAndValidation() {
        const preview = document.getElementById('backup-retention-preview');
        if (!(preview instanceof HTMLElement)) {
            throw new Error('backup-retention-preview missing');
        }

        const applyButton = document.getElementById('backup-retention-apply-btn');
        if (!(applyButton instanceof HTMLButtonElement)) {
            throw new Error('backup-retention-apply-btn missing');
        }

        const errorOutput = document.getElementById('backup-retention-error');
        if (!(errorOutput instanceof HTMLElement)) {
            throw new Error('backup-retention-error missing');
        }

        const state = this.getModalState();
        const backupCount = Number.isInteger(state.backupCount) ? state.backupCount : 0;
        const error = typeof state.error === 'string' ? state.error : '';
        if (backupCount <= 0) {
            throw new Error('backupCount must be positive');
        }

        const parsedKeepCount = this._parseKeepCountWithoutError();
        if (parsedKeepCount === null) {
            preview.textContent = 'Enter a valid number of backups to keep.';
            applyButton.disabled = true;
        } else {
            const deleteCount = backupCount - parsedKeepCount;
            if (deleteCount <= 0) {
                preview.textContent = 'No backups will be deleted.';
            } else {
                preview.textContent = `${deleteCount} oldest backup(s) will be deleted.`;
            }
            applyButton.disabled = false;
        }

        errorOutput.textContent = error;
    }

    _parseKeepCountWithoutError() {
        const state = this.getModalState();
        const backupCount = Number.isInteger(state.backupCount) ? state.backupCount : 0;
        if (backupCount <= 0) {
            throw new Error('backupCount must be positive');
        }

        const raw = typeof state.keepCountText === 'string' ? state.keepCountText.trim() : '';
        if (!/^[0-9]+$/.test(raw)) {
            return null;
        }

        const keepCount = Number.parseInt(raw, 10);
        if (keepCount < 1 || keepCount > backupCount) {
            return null;
        }
        return keepCount;
    }

    _computeDefaultKeepCount(backupCount, suggestedKeepCount) {
        _assertPositiveInteger(backupCount, 'backupCount');
        _assertPositiveInteger(suggestedKeepCount, 'suggestedKeepCount');
        return suggestedKeepCount > backupCount ? backupCount : suggestedKeepCount;
    }

    _validateContext(context) {
        if (!context || typeof context !== 'object') {
            throw new Error('BackupRetentionModal context must be an object');
        }
        if (typeof context.createdFilename !== 'string' || context.createdFilename.length === 0) {
            throw new Error('BackupRetentionModal context missing createdFilename');
        }
        _assertPositiveInteger(context.backupCount, 'backupCount');
        _assertPositiveInteger(context.suggestedKeepCount, 'suggestedKeepCount');
    }
}
