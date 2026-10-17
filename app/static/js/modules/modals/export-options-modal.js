import { ApplicationState } from '../application-state.js';
import { BaseModal } from './base-modal.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';

// The most earlier suggestions the server accepts (MAX_PREVIOUS_TITLES in
// app/services/agent/export_title_suggestions.py).
const MAX_PREVIOUS_TITLES = 10;

// Export and Print options (docs/ui/controls.md), one step before the file or
// the browser's print dialog. Both set their title (the heading and page title;
// an export's file name, the name Save as PDF suggests), from a smart default
// selected so typing replaces it. When what goes out includes @password or
// @username notes, the same dialog offers to include them (unchecked: hidden).
// Enter confirms; Escape or Cancel does nothing. Nothing is remembered.
//
// With an AI set up, "Suggest with AI" asks it for a title; only
// pressing it does. While it asks, the button is Stop, and typing in the
// field, Print or Cancel stop it too: the field never changes under the user.
// The answer replaces the field's text, selected, and Cmd/Ctrl+Z brings back
// what was there; asking again gets a different title. A failure floats on the
// dialog until the next action, moving nothing.
const PURPOSES = Object.freeze({
    print: Object.freeze({
        eyebrow: 'Print',
        heading: 'Title',
        action: 'Print',
        includedWarning: 'Anyone who sees this print can read them.',
    }),
    download: Object.freeze({
        eyebrow: 'Export as HTML',
        heading: 'Title',
        action: 'Export',
        includedWarning: 'Anyone who opens this file can read them. It is not encrypted.',
    }),
});

// What the dialog says under the title about the AI, by availability.
const AI_TITLE_NOTES = Object.freeze({
    partial: 'Private notes are not sent to the AI.',
    private: "These notes are private, so the AI can't suggest a title.",
});
const AI_TITLE_AVAILABILITIES = Object.freeze(['unavailable', 'nothing', 'private', 'partial', 'ready']);

// What the checkbox includes: the passwords, the usernames, or both, as shown.
function includeCredentialsLabel({ passwordCount, usernameCount }) {
    if (passwordCount > 0 && usernameCount > 0) {
        return 'Include Unredacted Usernames and Passwords';
    }
    return passwordCount > 0 ? 'Include Unredacted Passwords' : 'Include Unredacted Usernames';
}

const moduleState = ApplicationState.createFields('export-options-modal', {
    modal: null,
});

class ExportOptionsModal extends BaseModal {
    constructor() {
        super('exportOptionsModal', 'export-options-modal');
        this._pendingResolve = null;
        this._request = null;
        // The outcome of one opening: what was chosen, or nothing (cancelled).
        this._decision = null;
        // Asks the AI: (previousTitles, signal) => { title, failure }.
        this._suggestTitle = null;
        // The AI request running, if any; the titles it gave in this opening.
        this._asking = null;
        this._suggestedTitles = null;

        ApplicationState.own(this, 'ExportOptionsModal', new.target === ExportOptionsModal);
    }

    getInitialModalState() {
        if (this._request === null) {
            throw new Error('ExportOptionsModal requires a request before initialization');
        }
        return { ...this._request };
    }

    validateCleanState() {
        if (ModeContext.isLoading) {
            throw new Error('Cannot open export options while the application is loading');
        }
        if (ModeContext.modalStack && ModeContext.modalStack.length > 0) {
            throw new Error(`Cannot open export options while ${ModeContext.topModal} is open`);
        }
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

    ask(request, suggestTitle) {
        if (this.isOpen || this._pendingResolve !== null) {
            throw new Error('ExportOptionsModal is already open');
        }
        this._request = request;
        this._decision = { result: null };
        this._suggestTitle = suggestTitle;
        this._suggestedTitles = [];
        this.open();
        return new Promise((resolve) => {
            this._pendingResolve = resolve;
        });
    }

    onOpen() {
        const titleInput = document.getElementById('export-title-input');
        if (!(titleInput instanceof HTMLInputElement)) {
            throw new Error('Export options title missing');
        }
        titleInput.focus();
        titleInput.select();
    }

    onClose() {
        this._stopAsking();
        const resolve = this._pendingResolve;
        const result = this._decision.result;
        this._pendingResolve = null;
        this._request = null;
        this._decision = null;
        this._suggestTitle = null;
        this._suggestedTitles = null;
        if (resolve !== null) {
            resolve(result);
        }
    }

    _stopAsking() {
        if (this._asking === null) {
            return;
        }
        this._asking.abort();
        this._asking = null;
        this._showAsking(false);
        const button = document.getElementById('export-title-ai-btn');
        if (button instanceof HTMLButtonElement) {
            button.classList.remove('is-asking');
            button.setAttribute('aria-label', 'Suggest a title with AI');
        }
    }

    // A busy pointer over the dialog while the AI is asked.
    _showAsking(isAsking) {
        const content = document.querySelector(`#${this.modalElementId} .modal-content`);
        if (!(content instanceof HTMLElement)) {
            throw new Error('Export options content missing');
        }
        content.classList.toggle('is-asking-ai', isAsking);
    }

    _showFailure(message) {
        const card = document.getElementById('export-title-ai-failure');
        if (!(card instanceof HTMLElement)) {
            throw new Error('Print title failure card missing');
        }
        card.textContent = `The AI couldn't suggest a title: ${message}`;
        card.hidden = false;
    }

    _hideFailure() {
        const card = document.getElementById('export-title-ai-failure');
        if (card instanceof HTMLElement && !card.hidden) {
            card.hidden = true;
        }
    }

    // The AI's title replaces the field's text as an edit the field can undo.
    _applySuggestedTitle(input, title) {
        input.focus();
        input.select();
        if (!document.execCommand('insertText', false, title)) {
            throw new Error('The title field could not take the suggested title');
        }
        input.select();
        this._suggestedTitles.push(title);
    }

    async _askAiForTitle(input, button) {
        const asking = new AbortController();
        this._asking = asking;
        this._showAsking(true);
        button.classList.add('is-asking');
        button.setAttribute('aria-label', 'Stop asking the AI');
        // The titles it gave in this opening (the last ten), so it gives another.
        const { title, failure } = await this._suggestTitle(this._suggestedTitles.slice(-MAX_PREVIOUS_TITLES), asking.signal);
        if (this._asking !== asking) {
            // Stopped, or the dialog closed: the answer is not wanted.
            return;
        }
        this._stopAsking();
        if (failure !== '') {
            this._showFailure(failure);
            return;
        }
        this._applySuggestedTitle(input, title);
    }

    _renderTitleField(state) {
        const hasButton = ['ready', 'partial', 'private'].includes(state.aiTitle);
        const button = !hasButton ? '' : `
                        <button type="button" class="secondary-btn export-title-ai-btn" id="export-title-ai-btn"
                            aria-label="Suggest a title with AI"${state.aiTitle === 'private' ? ' disabled' : ''}>
                            <span class="export-title-ai-label">🤖 Suggest with AI</span>
                            <span class="export-title-ai-stop"><span class="export-title-ai-spinner" aria-hidden="true"></span>Stop</span>
                        </button>`;
        const note = Object.hasOwn(AI_TITLE_NOTES, state.aiTitle)
            ? `<p class="export-title-ai-note">${AI_TITLE_NOTES[state.aiTitle]}</p>` : '';
        return `
                <div class="form-group export-title-group">
                    <div class="export-title-row">
                        <input type="text" id="export-title-input" aria-label="Title" maxlength="200" autocomplete="off" spellcheck="false">${button}
                    </div>${note}
                    <div class="export-title-ai-failure" id="export-title-ai-failure" role="status" hidden></div>
                </div>`;
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error('Export options modal element missing');
        }
        const state = this.getModalState();
        const purpose = PURPOSES[state.purpose];
        const passwordChoice = state.passwordCount === 0 && state.usernameCount === 0 ? '' : `
                <fieldset class="export-password-choice">
                    <label class="export-password-toggle"><input type="checkbox" id="export-passwords-include"><span>${includeCredentialsLabel(state)}</span></label>
                    <p class="export-password-warning">${purpose.includedWarning}</p>
                </fieldset>`;
        modalElement.innerHTML = `
            <div class="modal-content alphabetize-root-notes-modal-content">
                <div class="prioritize-modal-header">
                    <p class="prioritize-modal-eyebrow">${purpose.eyebrow}</p>
                    <h3>${purpose.heading}</h3>
                </div>${this._renderTitleField(state)}${passwordChoice}
                <div class="form-actions alphabetize-root-notes-actions">
                    <button type="button" class="secondary-btn" id="export-options-cancel-btn">Cancel</button>
                    <button type="button" class="primary-btn" id="export-options-submit-btn" data-modal-enter-action>${purpose.action}</button>
                </div>
            </div>
        `;
        // A failure shown floats until the next key or click.
        modalElement.onkeydown = () => this._hideFailure();
        modalElement.onpointerdown = () => this._hideFailure();
        const titleInput = document.getElementById('export-title-input');
        if (!(titleInput instanceof HTMLInputElement)) {
            throw new Error('Export options title missing');
        }
        // Set as a value, never as markup: the title can be any text.
        titleInput.value = state.defaultTitle;
        // Typing wins over a title still being asked for.
        titleInput.oninput = () => this._stopAsking();
        const aiButton = document.getElementById('export-title-ai-btn');
        if (aiButton instanceof HTMLButtonElement) {
            aiButton.onclick = () => {
                if (this._asking !== null) {
                    this._stopAsking();
                    return;
                }
                void this._askAiForTitle(titleInput, aiButton);
            };
        }
        const cancelButton = document.getElementById('export-options-cancel-btn');
        if (!(cancelButton instanceof HTMLButtonElement)) {
            throw new Error('Export options cancel button missing');
        }
        cancelButton.onclick = () => {
            this.close();
        };
        const submitButton = document.getElementById('export-options-submit-btn');
        if (!(submitButton instanceof HTMLButtonElement)) {
            throw new Error('Export options submit button missing');
        }
        submitButton.onclick = () => {
            const includeChoice = document.getElementById('export-passwords-include');
            this._decision.result = {
                title: titleInput.value,
                includeCredentials: includeChoice instanceof HTMLInputElement && includeChoice.checked,
            };
            this.close();
        };
    }
}

// Resolves to {title, includeCredentials}, or null when cancelled. aiTitle is
// { availability, suggest }: whether Suggest with AI can ask (see
// loadExportTitleAvailability), and how (prepareExportDialog).
export function askExportOptions({ purpose, defaultTitle, passwordCount, usernameCount, aiTitle }) {
    if (!Object.hasOwn(PURPOSES, purpose)) {
        throw new Error(`Unknown export purpose: ${purpose}`);
    }
    if (typeof defaultTitle !== 'string') {
        throw new Error('askExportOptions requires a title string');
    }
    if (!Number.isInteger(passwordCount) || passwordCount < 0 || !Number.isInteger(usernameCount) || usernameCount < 0) {
        throw new Error('askExportOptions requires password and username counts');
    }
    if (!aiTitle || !AI_TITLE_AVAILABILITIES.includes(aiTitle.availability) || typeof aiTitle.suggest !== 'function') {
        throw new Error('askExportOptions requires the AI title availability and a way to ask');
    }
    if (moduleState.modal === null) {
        moduleState.modal = new ExportOptionsModal();
    }
    return moduleState.modal.ask(
        { purpose, defaultTitle, passwordCount, usernameCount, aiTitle: aiTitle.availability },
        aiTitle.suggest,
    );
}
