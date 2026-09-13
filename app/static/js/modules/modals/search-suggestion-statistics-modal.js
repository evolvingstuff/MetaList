import { ApplicationState } from '../application-state.js';
import { BaseModal } from './base-modal.js';
import {
    validateSearchSuggestionStatistics,
} from '../mode-manager/services/search-suggestion-statistics-service.js';
import {
    MAX_SEARCH_SUGGESTION_WINDOW_DAYS,
    MAX_SEARCH_SUGGESTION_WINDOW_SLOTS,
    getSearchSuggestionWindowsValidationError,
    validateSearchSuggestionWindows,
} from '../mode-manager/services/search-suggestion-windows-service.js';


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


function pluralize(count, singular, plural) {
    if (!Number.isInteger(count) || count < 0) {
        throw new Error('pluralize requires a non-negative integer');
    }
    return count === 1 ? singular : plural;
}


export class SearchSuggestionStatisticsModal extends BaseModal {
    constructor(
        loadStatistics,
        readWindows,
        readShowWindowLabels,
        readLimitNoteCredits,
        saveSettings,
        resetStatistics,
    ) {
        super('searchSuggestionStatisticsModal', 'search-suggestion-statistics-modal');
        const callbacks = {
            loadStatistics,
            readWindows,
            readShowWindowLabels,
            readLimitNoteCredits,
            saveSettings,
            resetStatistics,
        };
        for (const [name, callback] of Object.entries(callbacks)) {
            if (typeof callback !== 'function') {
                throw new Error(`SearchSuggestionStatisticsModal requires ${name}`);
            }
        }
        this._loadStatistics = loadStatistics;
        this._readWindows = readWindows;
        this._readShowWindowLabels = readShowWindowLabels;
        this._readLimitNoteCredits = readLimitNoteCredits;
        this._saveSettings = saveSettings;
        this._resetStatistics = resetStatistics;
        this._loadGeneration = 0;

        ApplicationState.own(this, 'SearchSuggestionStatisticsModal', new.target === SearchSuggestionStatisticsModal);
    }

    getInitialModalState() {
        const showWindowLabels = this._readShowWindowLabels();
        const limitNoteCreditsPerSearchContext = this._readLimitNoteCredits();
        if (typeof showWindowLabels !== 'boolean') {
            throw new Error('Search suggestion label preference must be boolean');
        }
        if (typeof limitNoteCreditsPerSearchContext !== 'boolean') {
            throw new Error('Search-context note credit limit preference must be boolean');
        }
        return {
            loading: true,
            saving: false,
            resetting: false,
            confirmingReset: false,
            windowDays: validateSearchSuggestionWindows(this._readWindows()),
            showWindowLabels,
            limitNoteCreditsPerSearchContext,
            error: '',
            statistics: null,
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
        this._loadGeneration += 1;
        const loadGeneration = this._loadGeneration;
        const statistics = validateSearchSuggestionStatistics(await this._loadStatistics());
        if (!this.isOpen || loadGeneration !== this._loadGeneration) {
            return;
        }
        this.updateModalState({ loading: false, statistics });
        this.renderModalContent();
    }

    async _changeWindow(index, rawValue) {
        if (!Number.isInteger(index) || index < 0) {
            throw new Error('Search suggestion window index must be a non-negative integer');
        }
        const dayCount = Number(rawValue);
        const next = this.getModalState().windowDays.slice();
        next[index] = dayCount;
        const validationError = getSearchSuggestionWindowsValidationError(next);
        if (validationError === '') {
            this.updateModalState({ windowDays: next, error: '' });
        } else {
            this.updateModalState({ error: validationError });
            this.renderModalContent();
            return;
        }
        await this._persistSuggestionSettings();
    }

    async _removeWindow(index) {
        if (!Number.isInteger(index) || index < 0) {
            throw new Error('Search suggestion window index must be a non-negative integer');
        }
        const next = this.getModalState().windowDays.slice();
        next.splice(index, 1);
        this.updateModalState({ windowDays: next, error: '' });
        await this._persistSuggestionSettings();
    }

    async _addWindow(windowDays) {
        const validatedWindows = validateSearchSuggestionWindows(windowDays);
        if (validatedWindows.length >= MAX_SEARCH_SUGGESTION_WINDOW_SLOTS) {
            throw new Error(
                `Search suggestion windows cannot contain more than ${MAX_SEARCH_SUGGESTION_WINDOW_SLOTS} slots`,
            );
        }
        const used = new Set(validatedWindows);
        let nextValue = 1;
        while (used.has(nextValue) && nextValue <= MAX_SEARCH_SUGGESTION_WINDOW_DAYS) {
            nextValue += 1;
        }
        if (nextValue > MAX_SEARCH_SUGGESTION_WINDOW_DAYS) {
            throw new Error('All supported search suggestion windows are already in use');
        }
        this.updateModalState({
            windowDays: [...validatedWindows, nextValue],
            error: '',
        });
        await this._persistSuggestionSettings();
    }

    async _changeBooleanSetting(settingName, value) {
        if (
            settingName !== 'showWindowLabels'
            && settingName !== 'limitNoteCreditsPerSearchContext'
        ) {
            throw new Error('Unknown search suggestion boolean setting');
        }
        if (typeof value !== 'boolean') {
            throw new Error('Search suggestion setting value must be boolean');
        }
        this.updateModalState({ [settingName]: value, error: '' });
        await this._persistSuggestionSettings();
    }

    async _persistSuggestionSettings() {
        const state = this.getModalState();
        if (state.saving === true || state.resetting === true || state.confirmingReset === true) {
            throw new Error('Search suggestion settings cannot save while busy');
        }
        const windowDays = validateSearchSuggestionWindows(state.windowDays);
        if (typeof state.showWindowLabels !== 'boolean') {
            throw new Error('Search suggestion label preference must be boolean');
        }
        if (typeof state.limitNoteCreditsPerSearchContext !== 'boolean') {
            throw new Error('Search-context note credit limit preference must be boolean');
        }
        this.updateModalState({ saving: true, error: '' });
        this.renderModalContent();
        await this._saveSettings(
            windowDays,
            state.showWindowLabels,
            state.limitNoteCreditsPerSearchContext,
        );
        if (!this.isOpen) {
            return;
        }
        this.updateModalState({ saving: false });
        this.renderModalContent();
    }

    _requestResetConfirmation() {
        const state = this.getModalState();
        if (
            state.loading === true
            || state.saving === true
            || state.resetting === true
            || state.confirmingReset === true
        ) {
            throw new Error('Search suggestion statistics cannot confirm reset while busy');
        }
        this.updateModalState({ confirmingReset: true });
        this.renderModalContent();
    }

    _cancelResetConfirmation() {
        const state = this.getModalState();
        if (state.confirmingReset !== true || state.resetting === true) {
            throw new Error('Search suggestion statistics reset confirmation is not cancellable');
        }
        this.updateModalState({ confirmingReset: false });
        this.renderModalContent();
    }

    async _resetActivity() {
        const state = this.getModalState();
        if (
            state.loading === true
            || state.saving === true
            || state.resetting === true
            || state.confirmingReset !== true
        ) {
            throw new Error('Search suggestion statistics cannot reset while busy');
        }
        this.updateModalState({ resetting: true });
        this.renderModalContent();
        const didReset = await this._resetStatistics();
        if (typeof didReset !== 'boolean') {
            throw new Error('Search suggestion statistics reset requires boolean result');
        }
        if (!this.isOpen) {
            return;
        }
        if (!didReset) {
            this.updateModalState({ resetting: false, confirmingReset: false });
            this.renderModalContent();
            return;
        }
        this._loadGeneration += 1;
        const loadGeneration = this._loadGeneration;
        const statistics = validateSearchSuggestionStatistics(await this._loadStatistics());
        if (!this.isOpen || loadGeneration !== this._loadGeneration) {
            return;
        }
        this.updateModalState({
            loading: false,
            resetting: false,
            confirmingReset: false,
            statistics,
        });
        this.renderModalContent();
    }

    _renderResetConfirmation(modalElement, state) {
        const disabled = state.resetting ? ' disabled' : '';
        const resetLabel = state.resetting ? 'Resetting…' : 'Reset activity';
        modalElement.innerHTML = `
            <div class="modal-content search-suggestion-statistics-modal-content">
                <div class="prioritize-modal-header">
                    <p class="prioritize-modal-eyebrow">Search Suggestions</p>
                    <h3>Reset Suggestion Activity?</h3>
                </div>
                <div class="alphabetize-root-notes-warning">
                    <p>Delete all learned search-suggestion tag activity for this namespace?</p>
                    <p>Notes, tabs, saved searches, and the settings in this modal will not be changed.</p>
                </div>
                <div class="form-actions alphabetize-root-notes-actions">
                    <button type="button" class="secondary-btn" id="search-suggestion-statistics-reset-cancel-btn"${disabled}>Cancel</button>
                    <button type="button" class="danger-btn" id="search-suggestion-statistics-reset-confirm-btn" data-modal-enter-action${disabled}>${resetLabel}</button>
                </div>
            </div>
        `;
        const cancelButton = document.getElementById(
            'search-suggestion-statistics-reset-cancel-btn',
        );
        if (!(cancelButton instanceof HTMLButtonElement)) {
            throw new Error('Search suggestion statistics reset cancel button missing');
        }
        cancelButton.onclick = () => this._cancelResetConfirmation();
        const confirmButton = document.getElementById(
            'search-suggestion-statistics-reset-confirm-btn',
        );
        if (!(confirmButton instanceof HTMLButtonElement)) {
            throw new Error('Search suggestion statistics reset confirm button missing');
        }
        confirmButton.onclick = async () => {
            await this._resetActivity();
        };
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error('Search suggestion statistics modal element missing');
        }
        const state = this.getModalState();
        if (
            typeof state.loading !== 'boolean'
            || typeof state.saving !== 'boolean'
            || typeof state.resetting !== 'boolean'
            || typeof state.confirmingReset !== 'boolean'
            || typeof state.showWindowLabels !== 'boolean'
            || typeof state.limitNoteCreditsPerSearchContext !== 'boolean'
            || typeof state.error !== 'string'
        ) {
            throw new Error('Search suggestion statistics modal state is invalid');
        }
        if (state.confirmingReset) {
            this._renderResetConfirmation(modalElement, state);
            return;
        }
        const windowDays = validateSearchSuggestionWindows(state.windowDays);
        const disabled = state.saving || state.resetting ? ' disabled' : '';
        const rows = windowDays.map((dayCount, index) => `
            <div class="search-window-row" data-window-index="${index}">
                <span class="search-window-slot">Slot ${index + 1}</span>
                <input class="search-window-days-input" type="number" min="1" max="${MAX_SEARCH_SUGGESTION_WINDOW_DAYS}" value="${dayCount}" aria-label="Slot ${index + 1} window in days"${disabled}>
                <span>days</span>
                <button type="button" class="secondary-btn search-window-remove"${disabled}>Remove</button>
            </div>
        `).join('');
        const emptyMessage = windowDays.length === 0
            ? '<p class="note-layout-description">No personalized slots. Base tag ordering will be used.</p>'
            : '';
        const showWindowLabelsChecked = state.showWindowLabels ? ' checked' : '';
        const limitNoteCreditsChecked = state.limitNoteCreditsPerSearchContext ? ' checked' : '';
        let statisticsBody = '<p class="search-suggestion-statistics-status">Loading statistics…</p>';
        if (state.loading !== true) {
            statisticsBody = this._buildStatisticsHtml(
                validateSearchSuggestionStatistics(state.statistics),
            );
        }
        const resetDisabled = state.loading || state.saving || state.resetting
            ? ' disabled'
            : '';
        const resetLabel = state.resetting ? 'Resetting…' : 'Reset activity';
        const settingsStatus = state.saving ? 'Saving…' : 'Changes save automatically.';

        modalElement.innerHTML = `
            <div class="modal-content search-suggestion-statistics-modal-content">
                <h2>Search Suggestion Stats &amp; Settings</h2>
                <section class="search-suggestion-settings-section">
                    <h3>Personalization settings</h3>
                    <p class="note-layout-description">Each ordered row controls one personalized suggestion slot. Activity is retained for the latest 365 populated days.</p>
                    <div class="search-window-rows">${rows}</div>
                    ${emptyMessage}
                    <button type="button" class="secondary-btn" id="search-window-add-btn"${disabled}>Add slot</button>
                    <label class="search-window-label-toggle">
                        <input type="checkbox" id="search-window-label-toggle"${showWindowLabelsChecked}${disabled}>
                        <span>Show time-window labels in search suggestions</span>
                    </label>
                    <label class="search-window-label-toggle">
                        <input type="checkbox" id="search-context-credit-limit-toggle"${limitNoteCreditsChecked}${disabled}>
                        <span>Limit each note to one activity credit per search context</span>
                    </label>
                    <p class="note-layout-description">When enabled, later edits, expansions, commands, moves, indents, and outdents on the same note are suppressed until you enter a different tab or search context.</p>
                    <p class="search-suggestion-settings-status" aria-live="polite">${settingsStatus}</p>
                    <p class="error-message">${escapeHtml(state.error)}</p>
                </section>
                <section class="search-suggestion-statistics-section">
                    <h3>Collected activity</h3>
                    <p class="note-layout-description">Each qualifying note interaction credits every distinct raw tag on that note once, including inherited and meta tags. Adding explicit tags credits only the newly added tags. Accepting a suggestion credits that tag; clicking a tab credits its positive tag terms. Search text and note contents are not retained.</p>
                    ${statisticsBody}
                </section>
                <div class="form-actions">
                    <button type="button" class="danger-btn" id="search-suggestion-statistics-reset-btn"${resetDisabled}>${resetLabel}</button>
                </div>
            </div>
        `;
        this._bindControls(windowDays);
    }

    _bindControls(windowDays) {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error('Search suggestion statistics modal element missing');
        }
        const rows = Array.from(modalElement.querySelectorAll('.search-window-row'));
        rows.forEach((row, index) => {
            const input = row.querySelector('.search-window-days-input');
            const removeButton = row.querySelector('.search-window-remove');
            if (!(input instanceof HTMLInputElement)) {
                throw new Error('Search window input missing');
            }
            if (!(removeButton instanceof HTMLButtonElement)) {
                throw new Error('Search window remove button missing');
            }
            input.onchange = async () => this._changeWindow(index, input.value);
            removeButton.onclick = async () => this._removeWindow(index);
        });
        const addButton = document.getElementById('search-window-add-btn');
        const labelToggle = document.getElementById('search-window-label-toggle');
        const creditLimitToggle = document.getElementById('search-context-credit-limit-toggle');
        const resetButton = document.getElementById('search-suggestion-statistics-reset-btn');
        if (!(addButton instanceof HTMLButtonElement)) {
            throw new Error('Search window add button missing');
        }
        if (!(labelToggle instanceof HTMLInputElement) || labelToggle.type !== 'checkbox') {
            throw new Error('Search window label checkbox missing');
        }
        if (!(creditLimitToggle instanceof HTMLInputElement) || creditLimitToggle.type !== 'checkbox') {
            throw new Error('Search-context note credit limit checkbox missing');
        }
        if (!(resetButton instanceof HTMLButtonElement)) {
            throw new Error('Search suggestion statistics reset button missing');
        }
        addButton.onclick = async () => this._addWindow(windowDays);
        labelToggle.onchange = async () => this._changeBooleanSetting(
            'showWindowLabels',
            labelToggle.checked,
        );
        creditLimitToggle.onchange = async () => this._changeBooleanSetting(
            'limitNoteCreditsPerSearchContext',
            creditLimitToggle.checked,
        );
        resetButton.onclick = () => this._requestResetConfirmation();
    }

    _buildStatisticsHtml(statistics) {
        if (statistics.days.length === 0) {
            return '<p class="search-suggestion-statistics-empty">No search-suggestion activity has been collected.</p>';
        }
        const populatedDayCount = statistics.days.length;
        const daySections = statistics.days.map((day, index) => `
            <details class="search-suggestion-statistics-day"${index === 0 ? ' open' : ''}>
                <summary>
                    <span>${escapeHtml(day.date)}</span>
                    <span>${day.totalTagCredits} ${pluralize(day.totalTagCredits, 'tag credit', 'tag credits')}</span>
                </summary>
                <table class="search-suggestion-statistics-table">
                    <thead><tr><th scope="col">Tag</th><th scope="col">Credits</th></tr></thead>
                    <tbody>
                        ${day.tags.map((entry) => `
                            <tr><td>${escapeHtml(entry.tag)}</td><td>${entry.count}</td></tr>
                        `).join('')}
                    </tbody>
                </table>
            </details>
        `).join('');
        return `
            <p class="search-suggestion-statistics-retention">${populatedDayCount} populated ${pluralize(populatedDayCount, 'day', 'days')} retained (maximum ${statistics.retentionPopulatedDayLimit}).</p>
            <div class="search-suggestion-statistics-days">${daySections}</div>
        `;
    }
}
