import { ApplicationState } from '../application-state.js';
import { HttpRequestError, rethrowUnexpectedError } from '../expected-errors.js';
import { BaseModal } from './base-modal.js';
import { CONFIG } from '../config.js';
import { buildSessionHeaders } from '../session-auth.js';
import { isValidTagToken } from '../tag-token.js';

const SUGGESTION_LIMIT = 20;

function escapeHtml(value) {
    if (typeof value !== 'string') {
        throw new Error('escapeHtml requires string');
    }
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export class PrioritizeModal extends BaseModal {
    constructor() {
        super('prioritizeModal', 'prioritize-modal');
        this._pendingResolve = null;
        this._context = null;
        this._decision = null;
        this._suggestionsAbortController = null;
        this._requestVersion = 0;

        ApplicationState.own(this, 'PrioritizeModal', new.target === PrioritizeModal);
    }

    getInitialModalState() {
        if (this._context === null) {
            throw new Error('PrioritizeModal requires context before initialization');
        }
        return {
            direction: this._context.direction,
            searchQuery: this._context.searchQuery,
            tagInput: '',
            suggestions: [],
            selectedIndex: -1,
            loadingSuggestions: true,
            isDropdownOpen: true,
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
    }

    openForDirection(context) {
        if (!context || typeof context !== 'object') {
            throw new Error('PrioritizeModal.openForDirection requires context object');
        }
        if (context.direction !== 'front' && context.direction !== 'back') {
            throw new Error("PrioritizeModal direction must be 'front' or 'back'");
        }
        if (typeof context.searchQuery !== 'string') {
            throw new Error('PrioritizeModal searchQuery must be a string');
        }
        if (this.isOpen) {
            throw new Error('PrioritizeModal is already open');
        }
        if (this._pendingResolve !== null) {
            throw new Error('PrioritizeModal already has a pending promise');
        }

        this._context = {
            direction: context.direction,
            searchQuery: context.searchQuery,
        };
        this._decision = { result: null };
        this.open();
        return new Promise((resolve) => {
            this._pendingResolve = resolve;
        });
    }

    onOpen() {
        this.focusInputToEnd();
        void this.fetchSuggestions('');
    }

    onClose() {
        if (this._suggestionsAbortController !== null) {
            this._suggestionsAbortController.abort();
            this._suggestionsAbortController = null;
        }
        const resolve = this._pendingResolve;
        const result = this._decision.result;
        this._pendingResolve = null;
        this._decision = null;
        this._context = null;
        if (resolve !== null) {
            resolve(result);
        }
    }

    shouldCloseOnClickOutside() {
        return true;
    }

    getElements() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error('Prioritize modal element missing');
        }
        const input = modalElement.querySelector('#prioritize-tag-input');
        if (!(input instanceof HTMLInputElement)) {
            throw new Error('prioritize-tag-input missing');
        }
        const suggestions = modalElement.querySelector('#prioritize-modal-suggestions');
        if (!(suggestions instanceof HTMLElement)) {
            throw new Error('prioritize-modal-suggestions missing');
        }
        const error = modalElement.querySelector('#prioritize-modal-error');
        if (!(error instanceof HTMLElement)) {
            throw new Error('prioritize-modal-error missing');
        }
        return {
            modalElement,
            input,
            suggestions,
            error,
        };
    }

    focusInputToEnd() {
        const { input } = this.getElements();
        input.focus();
        const valueLength = input.value.length;
        input.setSelectionRange(valueLength, valueLength);
    }

    syncSuggestionUi() {
        if (!this.isOpen) {
            return;
        }
        const state = this.getModalState();
        const { input, suggestions, error } = this.getElements();
        const isDropdownOpen = state.isDropdownOpen === true;
        const loadingSuggestions = state.loadingSuggestions === true;
        const selectedIndex = Number.isInteger(state.selectedIndex) ? state.selectedIndex : -1;
        const suggestionList = Array.isArray(state.suggestions) ? state.suggestions : [];
        const errorText = typeof state.error === 'string' ? state.error : '';

        input.setAttribute('aria-expanded', isDropdownOpen ? 'true' : 'false');
        error.textContent = errorText;

        if (!isDropdownOpen) {
            suggestions.hidden = true;
            suggestions.classList.add('is-hidden');
            suggestions.innerHTML = '';
            return;
        }

        suggestions.hidden = false;
        suggestions.classList.remove('is-hidden');
        suggestions.innerHTML = this.renderSuggestionsHtml({
            suggestions: suggestionList,
            selectedIndex,
            loadingSuggestions,
        });

        const suggestionButtons = suggestions.querySelectorAll('.prioritize-modal-suggestion');
        suggestionButtons.forEach((button) => {
            if (!(button instanceof HTMLButtonElement)) {
                return;
            }
            button.onmousedown = (event) => {
                event.preventDefault();
                const tag = button.getAttribute('data-tag');
                if (typeof tag !== 'string' || tag.length === 0) {
                    throw new Error('Prioritize suggestion missing tag');
                }
                this.applySuggestion(tag);
            };
            button.onclick = (event) => {
                event.preventDefault();
            };
        });
    }

    onKeyDown(event) {
        if (!(event instanceof KeyboardEvent)) {
            throw new Error('PrioritizeModal.onKeyDown requires KeyboardEvent');
        }

        const state = this.getModalState();
        const isDropdownOpen = state.isDropdownOpen === true;
        if (event.key === 'ArrowDown') {
            if (!isDropdownOpen) {
                return;
            }
            event.preventDefault();
            this.moveSelection(1);
            return;
        }
        if (event.key === 'ArrowUp') {
            if (!isDropdownOpen) {
                return;
            }
            event.preventDefault();
            this.moveSelection(-1);
            return;
        }
        if (event.key !== 'Enter') {
            return;
        }

        const target = event.target;
        if (target instanceof HTMLButtonElement) {
            return;
        }

        const suggestions = Array.isArray(state.suggestions) ? state.suggestions : [];
        const selectedIndex = Number.isInteger(state.selectedIndex) ? state.selectedIndex : -1;
        event.preventDefault();
        event.stopPropagation();
        if (isDropdownOpen && selectedIndex >= 0 && selectedIndex < suggestions.length) {
            this.applySuggestion(suggestions[selectedIndex]);
            return;
        }
        this.submit();
    }

    moveSelection(delta) {
        if (!Number.isInteger(delta) || (delta !== -1 && delta !== 1)) {
            throw new Error('PrioritizeModal.moveSelection requires delta -1 or 1');
        }
        const state = this.getModalState();
        if (state.isDropdownOpen !== true) {
            return;
        }
        const suggestions = Array.isArray(state.suggestions) ? state.suggestions : [];
        if (suggestions.length === 0) {
            return;
        }
        let nextIndex = typeof state.selectedIndex === 'number' ? state.selectedIndex : -1;
        nextIndex += delta;
        if (nextIndex < 0) {
            nextIndex = suggestions.length - 1;
        }
        if (nextIndex >= suggestions.length) {
            nextIndex = 0;
        }
        this.updateModalState({ selectedIndex: nextIndex });
        this.syncSuggestionUi();
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error('Prioritize modal element missing');
        }

        const state = this.getModalState();
        const direction = state.direction;
        if (direction !== 'front' && direction !== 'back') {
            throw new Error('Prioritize modal state missing direction');
        }
        const tagInput = typeof state.tagInput === 'string' ? state.tagInput : '';
        const suggestions = Array.isArray(state.suggestions) ? state.suggestions : [];
        const selectedIndex = Number.isInteger(state.selectedIndex) ? state.selectedIndex : -1;
        const loadingSuggestions = state.loadingSuggestions === true;
        const isDropdownOpen = state.isDropdownOpen === true;
        const error = typeof state.error === 'string' ? state.error : '';
        const showSuggestions = isDropdownOpen;
        const title = direction === 'front' ? 'Prioritize Tag To Front' : 'Prioritize Tag To Back';
        const description = direction === 'front'
            ? 'Move all root notes matching this tag to the front of the global root order.'
            : 'Move all root notes matching this tag to the back of the global root order.';

        modalElement.innerHTML = `
            <div class="modal-content prioritize-modal-content">
                <div class="prioritize-modal-header">
                    <p class="prioritize-modal-eyebrow">Global Root Order</p>
                    <h3>${title}</h3>
                    <p class="prioritize-modal-description">${description}</p>
                </div>

                <div class="form-group prioritize-modal-input-group">
                    <label for="prioritize-tag-input">Tag</label>
                    <div class="prioritize-modal-tag-bar">
                        <input
                            type="text"
                            id="prioritize-tag-input"
                            class="prioritize-modal-tag-input"
                            autocomplete="off"
                            autocorrect="off"
                            autocapitalize="off"
                            spellcheck="false"
                            aria-autocomplete="list"
                            aria-controls="prioritize-modal-suggestions"
                            aria-expanded="${showSuggestions ? 'true' : 'false'}"
                            placeholder="tags"
                            value="${escapeHtml(tagInput)}"
                        >
                        <div
                            id="prioritize-modal-suggestions"
                            class="prioritize-modal-suggestions${showSuggestions ? '' : ' is-hidden'}"
                            ${showSuggestions ? '' : 'hidden'}
                        >
                            ${this.renderSuggestionsHtml({ suggestions, selectedIndex, loadingSuggestions })}
                        </div>
                    </div>
                </div>

                <div class="alphabetize-root-notes-warning">
                    <p>This permanently rearranges stored root note order across all searches.</p>
                    <p>Cmd+Z cannot undo this action. The undo/redo queue will be cleared.</p>
                    <p>Your current search will stay active after the reorder refreshes.</p>
                </div>

                <div class="form-actions prioritize-modal-actions">
                    <button type="button" class="secondary-btn" id="prioritize-modal-cancel-btn">Cancel</button>
                    <button type="button" class="danger-btn" id="prioritize-modal-submit-btn">Apply Global Reorder</button>
                </div>

                <p id="prioritize-modal-error" class="error-message">${escapeHtml(error)}</p>
            </div>
        `;

        this.setupFormEventListeners();
        this.syncSuggestionUi();
    }

    renderSuggestionsHtml({ suggestions, selectedIndex, loadingSuggestions }) {
        if (loadingSuggestions && suggestions.length === 0) {
            return '<div class="prioritize-modal-suggestion prioritize-modal-suggestion-status">Loading tags from all root notes…</div>';
        }
        if (suggestions.length === 0) {
            return '';
        }
        return suggestions.slice(0, SUGGESTION_LIMIT).map((tag, index) => {
            const activeClass = index === selectedIndex ? ' is-selected' : '';
            return (
                `<button type="button" class="prioritize-modal-suggestion${activeClass}" ` +
                `data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`
            );
        }).join('');
    }

    setupFormEventListeners() {
        const input = document.getElementById('prioritize-tag-input');
        if (!(input instanceof HTMLInputElement)) {
            throw new Error('prioritize-tag-input missing');
        }
        input.onfocus = () => {
            const state = this.getModalState();
            if (state.isDropdownOpen === true) {
                return;
            }
            const suggestions = Array.isArray(state.suggestions) ? state.suggestions : [];
            this.updateModalState({
                isDropdownOpen: true,
                selectedIndex: suggestions.length > 0 ? 0 : -1,
                error: '',
            });
            this.syncSuggestionUi();
            if (suggestions.length === 0) {
                void this.fetchSuggestions(input.value);
            }
        };
        input.oninput = () => {
            this.updateModalState({
                tagInput: input.value,
                isDropdownOpen: true,
                error: '',
            });
            this.syncSuggestionUi();
            void this.fetchSuggestions(input.value);
        };
        input.onblur = () => {
            this.updateModalState({
                isDropdownOpen: false,
                selectedIndex: -1,
            });
            this.syncSuggestionUi();
        };

        const cancelButton = document.getElementById('prioritize-modal-cancel-btn');
        if (cancelButton instanceof HTMLButtonElement) {
            cancelButton.onclick = () => {
                this.close();
            };
        }

        const submitButton = document.getElementById('prioritize-modal-submit-btn');
        if (submitButton instanceof HTMLButtonElement) {
            submitButton.onclick = () => this.submit();
        }
    }

    applySuggestion(tag) {
        if (typeof tag !== 'string' || tag.trim() === '') {
            throw new Error('PrioritizeModal.applySuggestion requires non-empty tag');
        }
        if (!isValidTagToken(tag)) {
            throw new Error('Prioritize suggestion must be valid single tag token');
        }
        this.updateModalState({
            tagInput: tag,
            isDropdownOpen: false,
            selectedIndex: -1,
            loadingSuggestions: false,
            error: '',
        });
        const { input } = this.getElements();
        input.value = tag;
        this.syncSuggestionUi();
        this.focusInputToEnd();
    }

    submit() {
        const state = this.getModalState();
        let tag = typeof state.tagInput === 'string' ? state.tagInput.trim() : '';
        if (tag === '') {
            this.updateModalState({ error: 'Enter a tag.' });
            this.syncSuggestionUi();
            return;
        }
        if (!isValidTagToken(tag)) {
            this.updateModalState({
                error: 'This action only supports a single tag token.',
            });
            this.syncSuggestionUi();
            return;
        }
        this._decision.result = tag;
        this.close();
    }

    async fetchSuggestions(rawQuery) {
        if (typeof rawQuery !== 'string') {
            throw new Error('PrioritizeModal.fetchSuggestions requires query string');
        }
        if (this._context === null) {
            throw new Error('PrioritizeModal context missing');
        }

        const requestVersion = this._requestVersion + 1;
        this._requestVersion = requestVersion;
        if (this._suggestionsAbortController !== null) {
            this._suggestionsAbortController.abort();
        }
        const controller = new AbortController();
        this._suggestionsAbortController = controller;

        this.updateModalState({
            loadingSuggestions: true,
            isDropdownOpen: true,
            selectedIndex: -1,
        });
        this.syncSuggestionUi();

        await (async () => {
            const payload = await fetch(CONFIG.API.NOTES.PRIORITIZE_TAG_SUGGESTIONS, {
                method: 'POST',
                headers: buildSessionHeaders(true),
                body: JSON.stringify({
                    query: rawQuery,
                    search_query: this._context.searchQuery,
                }),
                signal: controller.signal,
            }).catch((error) => {
            rethrowUnexpectedError(error);
                if (error && error.name === 'AbortError') {
                    return null;
                }
                throw error;
            });

            if (payload === null) {
                return;
            }
            if (!payload.ok) {
                throw new HttpRequestError(`Prioritize tag suggestions failed: ${payload.status}`);
            }
            const responseBody = await payload.json();
            if (this._requestVersion !== requestVersion) {
                return;
            }
            if (!responseBody || typeof responseBody !== 'object' || !Array.isArray(responseBody.suggestions)) {
                throw new Error('Prioritize tag suggestions response missing suggestions');
            }
            const suggestions = responseBody.suggestions.filter((tag) => typeof tag === 'string' && tag.length > 0);
            const latestState = this.getModalState();
            const keepDropdownOpen = latestState.isDropdownOpen === true;
            this.updateModalState({
                loadingSuggestions: false,
                suggestions,
                isDropdownOpen: keepDropdownOpen,
                selectedIndex: suggestions.length > 0 ? 0 : -1,
                error: '',
            });
            this.syncSuggestionUi();
        })().catch((error) => {
            rethrowUnexpectedError(error);
            if (this._requestVersion !== requestVersion) {
                return;
            }
            const message = error instanceof Error ? error.message : 'Failed to load suggestions';
            const latestState = this.getModalState();
            const keepDropdownOpen = latestState.isDropdownOpen === true;
            this.updateModalState({
                loadingSuggestions: false,
                suggestions: [],
                isDropdownOpen: keepDropdownOpen,
                selectedIndex: -1,
                error: message,
            });
            this.syncSuggestionUi();
        }).finally(() => {
            if (this._suggestionsAbortController === controller) {
                this._suggestionsAbortController = null;
            }
        });
    }
}
