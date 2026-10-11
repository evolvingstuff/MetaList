import { ApplicationState } from '../application-state.js';
import { BaseModal } from './base-modal.js';

// Settings for the tag bar's suggestions. Each checkbox saves as soon as it
// changes; the server reads the setting from the session's preferences in memory
// (app/services/client_state_service.py), so the next suggestion uses it.
export const TAG_SUGGESTION_OPTIONS = [
    {
        key: 'pref.suggest_already_applying_tags',
        label: 'Allow suggesting tags that already apply',
        description: 'Also suggest tags a parent already has, and tags the rules already imply. '
            + 'Off: they are left out, and listed after the other matches once you type.',
        defaultValue: false,
    },
];

function checkboxId(key) {
    return `tag-suggestion-settings-${key.replace('pref.', '').replaceAll('_', '-')}`;
}

export class TagSuggestionSettingsModal extends BaseModal {
    constructor(readSettings, saveSetting) {
        super('tagSuggestionSettingsModal', 'tag-suggestion-settings-modal');
        if (typeof readSettings !== 'function') {
            throw new Error('TagSuggestionSettingsModal requires readSettings');
        }
        if (typeof saveSetting !== 'function') {
            throw new Error('TagSuggestionSettingsModal requires saveSetting');
        }
        this._readSettings = readSettings;
        this._saveSetting = saveSetting;

        ApplicationState.own(this, 'TagSuggestionSettingsModal', new.target === TagSuggestionSettingsModal);
    }

    getInitialModalState() {
        return { settings: this._validatedSettings(this._readSettings()), saving: false };
    }

    _validatedSettings(settings) {
        if (!settings || typeof settings !== 'object') {
            throw new Error('Tag suggestion settings must be an object');
        }
        const validated = {};
        for (const option of TAG_SUGGESTION_OPTIONS) {
            if (typeof settings[option.key] !== 'boolean') {
                throw new Error(`Tag suggestion setting ${option.key} must be boolean`);
            }
            validated[option.key] = settings[option.key];
        }
        return validated;
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
        const firstCheckbox = document.getElementById(checkboxId(TAG_SUGGESTION_OPTIONS[0].key));
        if (firstCheckbox instanceof HTMLInputElement) {
            firstCheckbox.focus();
        }
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }
        const state = this.getModalState();
        const settings = this._validatedSettings(state.settings);
        const disabled = state.saving === true ? ' disabled' : '';
        const options = TAG_SUGGESTION_OPTIONS.map((option) => `
                    <label class="visual-cues-toggle">
                        <input type="checkbox" id="${checkboxId(option.key)}"${settings[option.key] ? ' checked' : ''}${disabled}>
                        <span class="visual-cues-text">
                            <span class="visual-cues-title">${option.label}</span>
                            <span class="visual-cues-description">${option.description}</span>
                        </span>
                    </label>`).join('');

        modalElement.innerHTML = `
            <div class="modal-content visual-cues-modal-content">
                <h2>Tag Suggestions</h2>
                <p class="note-layout-description">Choose what the tag bar suggests. Changes apply immediately.</p>
                <div class="visual-cues-controls">
                    <section class="visual-cues-section">${options}
                    </section>
                </div>
            </div>
        `;
        this._setupEventListeners();
    }

    _setupEventListeners() {
        for (const option of TAG_SUGGESTION_OPTIONS) {
            const checkbox = document.getElementById(checkboxId(option.key));
            if (!(checkbox instanceof HTMLInputElement)) {
                throw new Error(`Tag suggestion checkbox missing: ${option.key}`);
            }
            checkbox.onchange = async () => this._handleToggle(option.key, checkbox.checked);
        }
    }

    async _handleToggle(key, enabled) {
        this.updateModalState({ saving: true });
        this.renderModalContent();
        await this._saveSetting(key, enabled);
        this.updateModalState({ settings: this._validatedSettings(this._readSettings()), saving: false });
        this.renderModalContent();
        const checkbox = document.getElementById(checkboxId(key));
        if (checkbox instanceof HTMLInputElement) {
            checkbox.focus();
        }
    }
}
