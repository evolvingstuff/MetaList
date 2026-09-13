import { ApplicationState } from '../application-state.js';
import {
    NOTE_LAYOUT_OPTIONS,
    applyNoteLayoutSettings,
    validateNoteLayoutSettings,
} from '../command-palette/note-layout-preferences.js';
import { BaseModal } from './base-modal.js';


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


function buildOptions(options, selectedValue) {
    return options.map((option) => {
        const selected = option.value === selectedValue ? ' selected' : '';
        return `<option value="${option.value}"${selected}>${option.label}</option>`;
    }).join('');
}


export class NoteLayoutAppearanceModal extends BaseModal {
    constructor(readSettings, saveSettings) {
        super('noteLayoutAppearanceModal', 'note-layout-appearance-modal');
        if (typeof readSettings !== 'function') {
            throw new Error('NoteLayoutAppearanceModal requires readSettings');
        }
        if (typeof saveSettings !== 'function') {
            throw new Error('NoteLayoutAppearanceModal requires saveSettings');
        }
        this._readSettings = readSettings;
        this._saveSettings = saveSettings;

        ApplicationState.own(this, 'NoteLayoutAppearanceModal', new.target === NoteLayoutAppearanceModal);
    }

    getInitialModalState() {
        const settings = validateNoteLayoutSettings(this._readSettings());
        return {
            ...settings,
            saving: false,
            error: '',
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
        const firstSelect = document.getElementById('note-layout-top-level-size');
        if (firstSelect instanceof HTMLSelectElement) {
            firstSelect.focus();
        }
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }
        const state = this.getModalState();
        const settings = validateNoteLayoutSettings(state);
        const saving = state.saving === true;
        const error = typeof state.error === 'string' ? state.error : '';
        const disabled = saving ? ' disabled' : '';

        modalElement.innerHTML = `
            <div class="modal-content note-layout-appearance-modal-content">
                <h2>Note Layout &amp; Appearance</h2>
                <p class="note-layout-description">Adjust how note hierarchy and spacing appear in this namespace.</p>

                <div class="note-layout-controls">
                    <label for="note-layout-top-level-size">
                        <span>Top-level note size</span>
                        <select id="note-layout-top-level-size"${disabled}>
                            ${buildOptions(NOTE_LAYOUT_OPTIONS.topLevelNoteSize, settings.topLevelNoteSize)}
                        </select>
                    </label>
                    <label for="note-layout-child-indentation">
                        <span>Child indentation</span>
                        <select id="note-layout-child-indentation"${disabled}>
                            ${buildOptions(NOTE_LAYOUT_OPTIONS.childIndentation, settings.childIndentation)}
                        </select>
                    </label>
                    <label for="note-layout-vertical-spacing">
                        <span>Vertical spacing</span>
                        <select id="note-layout-vertical-spacing"${disabled}>
                            ${buildOptions(NOTE_LAYOUT_OPTIONS.verticalSpacing, settings.verticalSpacing)}
                        </select>
                    </label>
                </div>

                <div class="note-layout-preview" aria-label="Layout preview">
                    <div class="note-layout-preview-root">Top-level note</div>
                    <div class="note-layout-preview-child">Child note</div>
                    <div class="note-layout-preview-child">Another child note</div>
                </div>

                <div class="form-actions">
                    <button type="button" class="primary-btn" id="note-layout-save-btn" data-modal-enter-action${disabled}>${saving ? 'Saving…' : 'Save'}</button>
                    <button type="button" class="secondary-btn" id="note-layout-cancel-btn"${disabled}>Cancel</button>
                </div>
                <p class="error-message">${escapeHtml(error)}</p>
            </div>
        `;

        const preview = modalElement.querySelector('.note-layout-preview');
        if (!(preview instanceof HTMLElement)) {
            throw new Error('Note layout preview missing');
        }
        applyNoteLayoutSettings(preview, settings);
        this._setupEventListeners();
    }

    _setupEventListeners() {
        const selectBindings = [
            ['note-layout-top-level-size', 'topLevelNoteSize'],
            ['note-layout-child-indentation', 'childIndentation'],
            ['note-layout-vertical-spacing', 'verticalSpacing'],
        ];
        for (const [elementId, stateKey] of selectBindings) {
            const select = document.getElementById(elementId);
            if (!(select instanceof HTMLSelectElement)) {
                throw new Error(`Note layout select missing: ${elementId}`);
            }
            select.onchange = () => {
                this.updateModalState({ [stateKey]: select.value, error: '' });
                this.renderModalContent();
                const refreshedSelect = document.getElementById(elementId);
                if (refreshedSelect instanceof HTMLSelectElement) {
                    refreshedSelect.focus();
                }
            };
        }

        const cancelButton = document.getElementById('note-layout-cancel-btn');
        if (!(cancelButton instanceof HTMLButtonElement)) {
            throw new Error('Note layout cancel button missing');
        }
        cancelButton.onclick = () => this.close();

        const saveButton = document.getElementById('note-layout-save-btn');
        if (!(saveButton instanceof HTMLButtonElement)) {
            throw new Error('Note layout save button missing');
        }
        saveButton.onclick = async () => this._handleSave();
    }

    async _handleSave() {
        const settings = validateNoteLayoutSettings(this.getModalState());
        this.updateModalState({ saving: true, error: '' });
        this.renderModalContent();
        await this._saveSettings(settings);
        this.close();
    }
}
