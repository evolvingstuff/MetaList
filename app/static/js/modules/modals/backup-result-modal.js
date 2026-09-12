import { BaseModal } from './base-modal.js';


function _escapeHtml(value) {
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


function _assertString(value, fieldName) {
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }
}


function _assertNonNegativeInteger(value, fieldName) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${fieldName} must be a non-negative integer`);
    }
}


export function formatBackupSize(sizeBytes) {
    _assertNonNegativeInteger(sizeBytes, 'sizeBytes');

    if (sizeBytes < 1024) {
        return `${sizeBytes} B`;
    }
    if (sizeBytes < 1024 * 1024) {
        return `${(sizeBytes / 1024).toFixed(1)} KB`;
    }
    if (sizeBytes < 1024 * 1024 * 1024) {
        return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}


function _statusMarkup(success) {
    if (typeof success !== 'boolean') {
        throw new Error('_statusMarkup requires boolean success');
    }
    if (success) {
        return `
            <span class="backup-result-status backup-result-status-success">
                <span class="backup-result-status-icon" aria-hidden="true">&#10003;</span>
                Saved
            </span>
        `;
    }
    return `
        <span class="backup-result-status backup-result-status-failed">
            <span class="backup-result-status-icon" aria-hidden="true">&#10005;</span>
            Failed
        </span>
    `;
}


function _detailsText(result) {
    if (!result || typeof result !== 'object') {
        throw new Error('_detailsText requires result object');
    }
    if (typeof result.message !== 'string') {
        throw new Error('result.message must be a string');
    }
    if (!result.success) {
        return result.message;
    }
    if (result.destination === 'folder') {
        const prefix = 'Folder backup completed: ';
        if (result.message.startsWith(prefix)) {
            return result.message.slice(prefix.length);
        }
        return result.message;
    }
    return result.message;
}


export class BackupResultModal extends BaseModal {
    constructor() {
        super('backupResultModal', 'backup-result-modal');
        this._pendingResolve = null;
        this._context = null;
    }

    getInitialModalState() {
        if (this._context === null) {
            throw new Error('BackupResultModal requires context before initialization');
        }
        return {
            results: this._context.results,
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

    openWithResult(context) {
        this._validateContext(context);
        if (this.isOpen) {
            throw new Error('BackupResultModal is already open');
        }
        if (this._pendingResolve !== null) {
            throw new Error('BackupResultModal already has a pending promise');
        }
        this._context = {
            results: context.results,
        };
        this.open();
        return new Promise((resolve) => {
            this._pendingResolve = resolve;
        });
    }

    onClose() {
        const resolve = this._pendingResolve;
        this._pendingResolve = null;
        this._context = null;
        if (resolve !== null) {
            resolve();
        }
    }

    onOpen() {
        // Keep keyboard events inside the dialog so the app's shortcut guard
        // does not intercept Enter while focus is still behind the modal.
        this._installModalCloseButton().focus();
    }

    onKeyDown(event) {
        if (!(event instanceof KeyboardEvent)) {
            throw new Error('BackupResultModal.onKeyDown requires KeyboardEvent');
        }
        if (event.key !== 'Enter') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.close();
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }

        const state = this.getModalState();
        if (!Array.isArray(state.results) || state.results.length === 0) {
            throw new Error('BackupResultModal requires results');
        }

        const resultsRowsHtml = state.results.map((result) => {
            if (!result || typeof result !== 'object') {
                throw new Error('BackupResultModal result entry must be an object');
            }
            _assertString(result.destination, 'destination');
            _assertString(result.namespace, 'namespace');
            if (typeof result.success !== 'boolean') {
                throw new Error('success must be a boolean');
            }
            _assertString(result.created_filename, 'created_filename');
            _assertNonNegativeInteger(result.size_bytes, 'size_bytes');
            _assertNonNegativeInteger(result.deleted_count, 'deleted_count');
            _assertNonNegativeInteger(result.remaining_count, 'remaining_count');
            _assertString(result.message, 'message');

            const detailsText = _detailsText(result);
            const createdFilename = result.created_filename.length > 0 ? result.created_filename : '-';
            const backupSize = result.success ? formatBackupSize(result.size_bytes) : '-';
            const deletedCount = result.success ? String(result.deleted_count) : '-';
            const keptCount = result.success ? String(result.remaining_count) : '-';
            return `
                <tr>
                    <td class="backup-result-destination">${_escapeHtml(result.namespace)}</td>
                    <td>${_statusMarkup(result.success)}</td>
                    <td><span class="backup-filename">${_escapeHtml(createdFilename)}</span></td>
                    <td class="backup-result-table-size">${backupSize}</td>
                    <td class="backup-result-table-count">${deletedCount}</td>
                    <td class="backup-result-table-count">${keptCount}</td>
                    <td class="backup-result-notes">${_escapeHtml(detailsText)}</td>
                </tr>
            `;
        }).join('');

        modalElement.innerHTML = `
            <div class="modal-content backup-result-modal-content">
                <h3>Backup Result</h3>
                <div class="backup-result-table-wrapper">
                    <table class="backup-result-table">
                        <thead>
                            <tr>
                                <th scope="col">Namespace</th>
                                <th scope="col">Status</th>
                                <th scope="col">Archive</th>
                                <th scope="col">Size</th>
                                <th scope="col">Deleted</th>
                                <th scope="col">Kept Here</th>
                                <th scope="col">Destination</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${resultsRowsHtml}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    _validateContext(context) {
        if (!context || typeof context !== 'object') {
            throw new Error('BackupResultModal context must be an object');
        }
        if (!Array.isArray(context.results) || context.results.length === 0) {
            throw new Error('BackupResultModal context missing results');
        }
    }
}
