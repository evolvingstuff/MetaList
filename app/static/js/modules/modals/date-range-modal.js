import { ApplicationState } from '../application-state.js';
import { BaseModal } from './base-modal.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { DATE_RANGE_FIELDS, OPEN_DATE } from '../mode-manager/services/date-range-kinds.js';

// Date range → Custom range…: From and To dates (either may be left open) and
// whether they are the notes' created or last updated dates. Resolves with the
// chosen { field, fromDate, toDate }, or null when cancelled.

export class DateRangeModal extends BaseModal {
    constructor() {
        super('dateRangeModal', 'date-range-modal');
        this._pendingResolve = null;
        this._context = null;
        this._decision = null;

        ApplicationState.own(this, 'DateRangeModal', new.target === DateRangeModal);
    }

    getInitialModalState() {
        if (this._context === null) {
            throw new Error('DateRangeModal requires context before initialization');
        }
        return { ...this._context };
    }

    validateCleanState() {
        if (ModeContext.isLoading) {
            throw new Error('Cannot open the date range dialog while application is loading');
        }
        if (ModeContext.modalStack && ModeContext.modalStack.length > 0) {
            throw new Error(`Cannot open the date range dialog while ${ModeContext.topModal} is open`);
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

    openForRange(context) {
        if (!context || typeof context !== 'object') {
            throw new Error('DateRangeModal.openForRange requires context object');
        }
        if (!Object.values(DATE_RANGE_FIELDS).includes(context.field)) {
            throw new Error(`DateRangeModal field must be created or updated, not ${context.field}`);
        }
        if (typeof context.fromDate !== 'string' || typeof context.toDate !== 'string') {
            throw new Error('DateRangeModal requires fromDate and toDate strings');
        }
        if (this.isOpen) {
            throw new Error('DateRangeModal is already open');
        }
        if (this._pendingResolve !== null) {
            throw new Error('DateRangeModal already has a pending promise');
        }
        this._context = { field: context.field, fromDate: context.fromDate, toDate: context.toDate };
        this._decision = { result: null };
        this.open();
        return new Promise((resolve) => {
            this._pendingResolve = resolve;
        });
    }

    onClose() {
        const resolve = this._pendingResolve;
        const result = this._decision.result;
        this._pendingResolve = null;
        this._decision = null;
        this._context = null;
        if (resolve !== null) {
            resolve(result);
        }
    }

    onKeyDown(event) {
        if (!(event instanceof KeyboardEvent)) {
            throw new Error('DateRangeModal.onKeyDown requires KeyboardEvent');
        }
        if (event.key !== 'Enter' || document.activeElement instanceof HTMLButtonElement) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.submit();
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error('Date range modal element missing');
        }
        const state = this.getModalState();
        const isCreated = state.field === DATE_RANGE_FIELDS.CREATED;
        modalElement.innerHTML = `
            <div class="modal-content date-range-modal-content">
                <div class="prioritize-modal-header">
                    <h3>Date Range</h3>
                </div>
                <div class="date-range-modal-field" role="radiogroup" aria-label="Date">
                    <label><input type="radio" name="date-range-field" value="updated" ${isCreated ? '' : 'checked'}> Last updated</label>
                    <label><input type="radio" name="date-range-field" value="created" ${isCreated ? 'checked' : ''}> Created</label>
                </div>
                <div class="date-range-modal-dates">
                    <label>From <input type="date" id="date-range-from" title="Leave empty for no start"></label>
                    <label>To <input type="date" id="date-range-to" title="Leave empty for no end"></label>
                </div>
                <div class="form-actions">
                    <button type="button" class="secondary-btn" id="date-range-cancel-btn">Cancel</button>
                    <button type="button" class="primary-btn" id="date-range-apply-btn">Apply</button>
                </div>
            </div>
        `;
        const fromInput = this._requireDateInput('date-range-from');
        const toInput = this._requireDateInput('date-range-to');
        fromInput.value = state.fromDate;
        toInput.value = state.toDate;
        fromInput.oninput = () => this._syncApplyButton();
        toInput.oninput = () => this._syncApplyButton();
        document.getElementById('date-range-cancel-btn').onclick = () => this.close();
        document.getElementById('date-range-apply-btn').onclick = () => this.submit();
        this._syncApplyButton();
        fromInput.focus();
    }

    _requireDateInput(id) {
        const input = document.getElementById(id);
        if (!(input instanceof HTMLInputElement)) {
            throw new Error(`Date range input ${id} missing`);
        }
        return input;
    }

    // The chosen range, or why there is none yet (the Apply button's tooltip).
    _readRange() {
        const fromDate = this._requireDateInput('date-range-from').value;
        const toDate = this._requireDateInput('date-range-to').value;
        if (fromDate === OPEN_DATE && toDate === OPEN_DATE) {
            return { range: null, problem: 'Choose a From or To date' };
        }
        // YYYY-MM-DD compares as text in date order.
        if (fromDate !== OPEN_DATE && toDate !== OPEN_DATE && fromDate > toDate) {
            return { range: null, problem: 'From must not be after To' };
        }
        const checked = document.querySelector('input[name="date-range-field"]:checked');
        if (!(checked instanceof HTMLInputElement)) {
            throw new Error('Date range dialog has no field chosen');
        }
        return { range: { field: checked.value, fromDate, toDate }, problem: '' };
    }

    _syncApplyButton() {
        const button = document.getElementById('date-range-apply-btn');
        if (!(button instanceof HTMLButtonElement)) {
            throw new Error('Date range Apply button missing');
        }
        const { range, problem } = this._readRange();
        button.disabled = range === null;
        button.title = problem;
    }

    submit() {
        const { range } = this._readRange();
        if (range === null) {
            return;
        }
        this._decision.result = range;
        this.close();
    }
}
