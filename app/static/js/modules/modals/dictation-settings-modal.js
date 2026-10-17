import { ApplicationState } from '../application-state.js';
import { BaseModal } from './base-modal.js';
import { isValidDictationTagPhrase } from '../mode-manager/services/dictation-note-paste.js';

// The phrases, in the order shown: the one that starts tags in a note, and the
// two around a quoted phrase (docs/ui/dictation-paste.md).
const FIELDS = [
    { key: 'tagPhrase', id: 'dictation-tag-phrase', label: 'Phrase that starts tags' },
    { key: 'quoteOpen', id: 'dictation-quote-open', label: 'Phrase that starts a quote' },
    { key: 'quoteClose', id: 'dictation-quote-close', label: 'Phrase that ends a quote' },
    { key: 'negate', id: 'dictation-negate', label: 'Phrase that excludes the next search term' },
];

// Dictation settings: the spoken phrases MetaList recognizes in pasted dictated
// text ("start tags", "quote", "end quote" and "minus" by default).
export class DictationSettingsModal extends BaseModal {
    constructor(readPhrases, savePhrases) {
        super('dictationSettingsModal', 'dictation-settings-modal');
        if (typeof readPhrases !== 'function') {
            throw new Error('DictationSettingsModal requires readPhrases');
        }
        if (typeof savePhrases !== 'function') {
            throw new Error('DictationSettingsModal requires savePhrases');
        }
        this._readPhrases = readPhrases;
        this._savePhrases = savePhrases;

        ApplicationState.own(this, 'DictationSettingsModal', new.target === DictationSettingsModal);
    }

    getInitialModalState() {
        return { phrases: this._readPhrases(), error: '', saving: false };
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
        const input = document.getElementById(FIELDS[0].id);
        if (input instanceof HTMLInputElement) {
            input.focus();
            input.select();
        }
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }
        const state = this.getModalState();
        let disabled = '';
        if (state.saving === true) disabled = ' disabled';
        let errorHtml = '';
        if (state.error !== '') errorHtml = `<p class="dictation-settings-error" role="alert">${state.error}</p>`;
        const fields = FIELDS.map((field) => `
                <label class="dictation-settings-field" for="${field.id}">${field.label}</label>
                <input type="text" id="${field.id}" spellcheck="false" autocomplete="off"${disabled}>`).join('');
        modalElement.innerHTML = `
            <div class="modal-content dictation-settings-modal-content">
                <h2>Dictation Settings</h2>
                <p class="note-layout-description">Phrases MetaList recognizes in dictated text you paste.
                    In a note, everything after the tags phrase becomes tags: "Here is my content. Start tags.
                    Neural network." adds the content and the tag neural-network. In the search bar (and tag
                    relationship conditions) the quote phrases mark a text search, and the exclusion phrase
                    excludes the next term: "neural network minus python".</p>
                ${fields}
                ${errorHtml}
                <div class="form-actions">
                    <button type="button" class="save-btn" data-dictation-save data-modal-enter-action${disabled}>Save</button>
                </div>
            </div>
        `;
        // Set as properties, never as markup: a rejected entry may hold any character.
        for (const field of FIELDS) {
            document.getElementById(field.id).value = state.phrases[field.key];
        }
        const saveButton = modalElement.querySelector('[data-dictation-save]');
        if (!(saveButton instanceof HTMLButtonElement)) {
            throw new Error('Dictation settings Save button missing');
        }
        saveButton.onclick = async () => this._handleSave();
    }

    _readFields() {
        const phrases = {};
        for (const field of FIELDS) {
            const input = document.getElementById(field.id);
            if (!(input instanceof HTMLInputElement)) {
                throw new Error(`Dictation phrase input missing: ${field.id}`);
            }
            phrases[field.key] = input.value.trim().replace(/\s+/g, ' ');
        }
        return phrases;
    }

    _validationError(phrases) {
        for (const field of FIELDS) {
            if (!isValidDictationTagPhrase(phrases[field.key])) {
                return `${field.label}: use words of letters only (2 to 64 characters), such as "start tags" or "armadillo".`;
            }
        }
        const mustDiffer = [phrases.quoteOpen, phrases.quoteClose, phrases.negate];
        const distinct = new Set(mustDiffer.map((phrase) => phrase.toLowerCase()));
        if (distinct.size !== mustDiffer.length) {
            return 'The quote and exclusion phrases must all differ.';
        }
        return '';
    }

    async _handleSave() {
        const phrases = this._readFields();
        const error = this._validationError(phrases);
        if (error !== '') {
            this.updateModalState({ phrases, error });
            this.renderModalContent();
            return;
        }
        this.updateModalState({ phrases, error: '', saving: true });
        this.renderModalContent();
        await this._savePhrases(phrases);
        this.close();
    }
}
