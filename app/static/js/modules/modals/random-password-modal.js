import { ApplicationState } from '../application-state.js';
import { rethrowUnexpectedError } from '../expected-errors.js';
import { BaseModal } from './base-modal.js';
import {
    DEFAULT_PASSWORD_CHARSET,
    DEFAULT_PASSWORD_LENGTH,
    generateRandomPassword,
    normalizePasswordCharset,
} from '../password-generator.js';
import {
    evaluatePasswordStrength,
    loadPasswordStrengthEstimator,
} from '../password-strength.js';
import { rememberGeneratedPasswordCopy } from '../mode-manager/services/password-clipboard-service.js';

const COPY_HINT_DEFAULT = 'Copy to clipboard. Pasting into an empty note will add @password automatically.';
const MAX_PASSWORD_LENGTH = 72;

export class RandomPasswordModal extends BaseModal {
    constructor() {
        super('randomPasswordModal', 'random-password-modal');

        ApplicationState.own(this, 'RandomPasswordModal', new.target === RandomPasswordModal);
    }

    getInitialModalState() {
        return {
            length: DEFAULT_PASSWORD_LENGTH,
            charsetInput: DEFAULT_PASSWORD_CHARSET,
            result: '',
            error: '',
            copyStatus: '',
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

    onOpen() {
        this.renderModalContent();
        this.regeneratePassword();
        loadPasswordStrengthEstimator()
            .then(() => {
                if (!this.isOpen) {
                    return;
                }
                const resultOutput = document.getElementById('password-result-output');
                if (!(resultOutput instanceof HTMLInputElement)) {
                    throw new Error('password-result-output missing');
                }
                this.renderPasswordStrength(resultOutput.value);
            })
            .catch((error) => {
            rethrowUnexpectedError(error);
                console.error('Password strength estimator failed');
                if (!this.isOpen) {
                    return;
                }
                this.renderPasswordStrengthUnavailable();
            });
    }

    onClose() {
        // BaseModal disposes the state scope; clear retained form DOM as well.
        document.getElementById(this.modalElementId).replaceChildren();
    }

    onKeyDown(event) {
        if (!(event instanceof KeyboardEvent)) {
            throw new Error('RandomPasswordModal.onKeyDown requires KeyboardEvent');
        }
        if (event.key !== 'Enter') {
            return;
        }

        const target = event.target;
        if (target instanceof HTMLTextAreaElement) {
            return;
        }
        if (target instanceof HTMLButtonElement) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        this.regeneratePassword();
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }

        const state = this.getModalState();
        const lengthValue = Number.isInteger(state.length) ? state.length : DEFAULT_PASSWORD_LENGTH;
        const charsetInput = typeof state.charsetInput === 'string' ? state.charsetInput : DEFAULT_PASSWORD_CHARSET;
        const result = typeof state.result === 'string' ? state.result : '';
        const error = typeof state.error === 'string' ? state.error : '';
        const copyStatus = typeof state.copyStatus === 'string' && state.copyStatus.length > 0
            ? state.copyStatus
            : COPY_HINT_DEFAULT;

        modalElement.innerHTML = `
            <div class="modal-content random-password-modal-content">
                <div class="random-password-modal-header">
                    <p class="random-password-modal-eyebrow">Utility</p>
                    <h3>Generate Random Password</h3>
                    <p class="random-password-modal-description">
                        Generate a password, or type or paste your own candidate to test its strength locally.
                    </p>
                </div>

                <div class="random-password-modal-top-row">
                    <div class="form-group random-password-length-group">
                        <label for="password-length-input">Password length</label>
                        <div class="random-password-length-control">
                            <input
                                type="number"
                                id="password-length-input"
                                min="1"
                                max="${MAX_PASSWORD_LENGTH}"
                                step="1"
                                inputmode="numeric"
                            >
                            <span class="random-password-length-unit">characters</span>
                        </div>
                    </div>
                </div>

                <div class="form-group">
                    <label for="password-charset-input">Character set</label>
                    <textarea id="password-charset-input" rows="5" spellcheck="false"></textarea>
                    <small class="form-help">Line breaks are ignored; every other character can be used.</small>
                </div>

                <div class="form-group">
                    <label for="password-result-output">Password candidate</label>
                    <div class="random-password-result-row">
                        <input
                            type="text"
                            id="password-result-output"
                            spellcheck="false"
                            autocomplete="off"
                            autocapitalize="none"
                        >
                        <button
                            type="button"
                            class="secondary-btn random-password-copy-btn"
                            id="password-copy-btn"
                            ${result.length === 0 ? 'disabled' : ''}
                        >
                            Copy
                        </button>
                    </div>
                    <small id="password-result-copy-hint" class="form-help">${copyStatus}</small>
                </div>

                <div class="password-strength" id="password-strength" data-score="pending">
                    <div class="password-strength-header">
                        <span>Strength</span>
                        <strong id="password-strength-label">Calculating...</strong>
                    </div>
                    <div
                        class="password-strength-meter"
                        id="password-strength-meter"
                        role="meter"
                        aria-label="Password candidate strength"
                        aria-valuemin="0"
                        aria-valuemax="4"
                    >
                        <span></span>
                        <span></span>
                        <span></span>
                        <span></span>
                    </div>
                    <small class="form-help" id="password-strength-policy">Loading the local strength estimator.</small>
                </div>

                <div class="form-actions random-password-modal-actions">
                    <button type="button" class="primary-btn" id="password-regenerate-btn">Regenerate</button>
                </div>

                <p id="password-generator-error" class="error-message">${error}</p>
            </div>
        `;

        const lengthInput = document.getElementById('password-length-input');
        if (!(lengthInput instanceof HTMLInputElement)) {
            throw new Error('password-length-input missing');
        }
        lengthInput.value = String(lengthValue);

        const charsetTextArea = document.getElementById('password-charset-input');
        if (!(charsetTextArea instanceof HTMLTextAreaElement)) {
            throw new Error('password-charset-input missing');
        }
        charsetTextArea.value = charsetInput;

        const resultOutput = document.getElementById('password-result-output');
        if (!(resultOutput instanceof HTMLInputElement)) {
            throw new Error('password-result-output missing');
        }
        resultOutput.value = result;

        this.renderPasswordStrength(result);
        this.setupFormEventListeners();
    }

    renderPasswordStrength(password) {
        const strengthContainer = document.getElementById('password-strength');
        const strengthLabel = document.getElementById('password-strength-label');
        const strengthMeter = document.getElementById('password-strength-meter');
        const strengthPolicy = document.getElementById('password-strength-policy');
        if (!(strengthContainer instanceof HTMLElement)) {
            throw new Error('password-strength missing');
        }
        if (!(strengthLabel instanceof HTMLElement)) {
            throw new Error('password-strength-label missing');
        }
        if (!(strengthMeter instanceof HTMLElement)) {
            throw new Error('password-strength-meter missing');
        }
        if (!(strengthPolicy instanceof HTMLElement)) {
            throw new Error('password-strength-policy missing');
        }

        if (password.length === 0) {
            strengthContainer.dataset.score = 'pending';
            strengthLabel.textContent = 'Enter a password';
            strengthMeter.removeAttribute('aria-valuenow');
            strengthPolicy.textContent = 'Type or paste a candidate to test it locally.';
            return;
        }
        if (typeof globalThis.zxcvbn !== 'function') {
            strengthContainer.dataset.score = 'pending';
            strengthLabel.textContent = 'Calculating...';
            strengthMeter.removeAttribute('aria-valuenow');
            strengthPolicy.textContent = 'Loading the local strength estimator.';
            return;
        }

        const strength = evaluatePasswordStrength(password, globalThis.zxcvbn);
        strengthContainer.dataset.score = String(strength.score);
        strengthLabel.textContent = `${strength.label} · ${strength.score}/4`;
        strengthMeter.setAttribute('aria-valuenow', String(strength.score));
        strengthPolicy.textContent = strength.meetsScoreThreshold
            ? 'Meets the MetaList zxcvbn score threshold.'
            : 'Below the MetaList zxcvbn score threshold.';
    }

    renderPasswordStrengthUnavailable() {
        const strengthContainer = document.getElementById('password-strength');
        const strengthLabel = document.getElementById('password-strength-label');
        const strengthMeter = document.getElementById('password-strength-meter');
        const strengthPolicy = document.getElementById('password-strength-policy');
        if (!(strengthContainer instanceof HTMLElement)) {
            throw new Error('password-strength missing');
        }
        if (!(strengthLabel instanceof HTMLElement)) {
            throw new Error('password-strength-label missing');
        }
        if (!(strengthMeter instanceof HTMLElement)) {
            throw new Error('password-strength-meter missing');
        }
        if (!(strengthPolicy instanceof HTMLElement)) {
            throw new Error('password-strength-policy missing');
        }

        strengthContainer.dataset.score = 'unavailable';
        strengthLabel.textContent = 'Unavailable';
        strengthMeter.removeAttribute('aria-valuenow');
        strengthPolicy.textContent = 'The local strength estimator could not be loaded.';
    }

    setupFormEventListeners() {
        const regenerateButton = document.getElementById('password-regenerate-btn');
        if (regenerateButton instanceof HTMLButtonElement) {
            regenerateButton.onclick = () => this.regeneratePassword();
        }

        const copyButton = document.getElementById('password-copy-btn');
        if (copyButton instanceof HTMLButtonElement) {
            copyButton.onclick = async () => {
                await this.copyResultToClipboard();
            };
        }

        const resultOutput = document.getElementById('password-result-output');
        if (resultOutput instanceof HTMLInputElement) {
            resultOutput.oninput = () => {
                const password = resultOutput.value;
                const copyHintOutput = document.getElementById('password-result-copy-hint');
                const errorOutput = document.getElementById('password-generator-error');
                if (!(copyButton instanceof HTMLButtonElement)) {
                    throw new Error('password-copy-btn missing');
                }
                if (!(copyHintOutput instanceof HTMLElement)) {
                    throw new Error('password-result-copy-hint missing');
                }
                if (!(errorOutput instanceof HTMLElement)) {
                    throw new Error('password-generator-error missing');
                }

                copyButton.disabled = password.length === 0;
                copyHintOutput.textContent = COPY_HINT_DEFAULT;
                errorOutput.textContent = '';
                this.updateModalState({
                    result: password,
                    error: '',
                    copyStatus: COPY_HINT_DEFAULT,
                });
                this.renderPasswordStrength(resultOutput.value);
            };
        }
    }

    async copyResultToClipboard() {
        const resultOutput = document.getElementById('password-result-output');
        if (!(resultOutput instanceof HTMLInputElement)) {
            throw new Error('password-result-output missing');
        }
        const value = resultOutput.value;
        if (value.length === 0) {
            return;
        }

        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value);
        } else {
            resultOutput.focus();
            resultOutput.select();
            const copied = document.execCommand('copy');
            if (!copied) {
                throw new Error('Clipboard copy failed');
            }
        }

        rememberGeneratedPasswordCopy(value);
        resultOutput.focus();
        resultOutput.select();
        this.updateModalState({ copyStatus: 'Copied. Pasting into an empty note will add @password.' });

        const hint = document.getElementById('password-result-copy-hint');
        if (hint instanceof HTMLElement) {
            hint.textContent = 'Copied. Pasting into an empty note will add @password.';
        }
    }

    regeneratePassword() {
        const lengthInput = document.getElementById('password-length-input');
        const charsetInput = document.getElementById('password-charset-input');
        const resultOutput = document.getElementById('password-result-output');
        const errorOutput = document.getElementById('password-generator-error');

        if (!(lengthInput instanceof HTMLInputElement)) {
            throw new Error('password-length-input missing');
        }
        if (!(charsetInput instanceof HTMLTextAreaElement)) {
            throw new Error('password-charset-input missing');
        }
        if (!(resultOutput instanceof HTMLInputElement)) {
            throw new Error('password-result-output missing');
        }
        if (!(errorOutput instanceof HTMLElement)) {
            throw new Error('password-generator-error missing');
        }

        const copyHintOutput = document.getElementById('password-result-copy-hint');
        if (!(copyHintOutput instanceof HTMLElement)) {
            throw new Error('password-result-copy-hint missing');
        }

        const copyButton = document.getElementById('password-copy-btn');
        if (!(copyButton instanceof HTMLButtonElement)) {
            throw new Error('password-copy-btn missing');
        }

        const lengthValue = Number.parseInt(lengthInput.value, 10);
        const charsetValue = charsetInput.value;
        if (!Number.isInteger(lengthValue) || lengthValue <= 0) {
            errorOutput.textContent = 'Password length must be a positive integer.';
            resultOutput.value = '';
            copyButton.disabled = true;
            this.updateModalState({
                length: lengthValue,
                charsetInput: charsetValue,
                result: '',
                error: 'Password length must be a positive integer.',
                copyStatus: COPY_HINT_DEFAULT,
            });
            copyHintOutput.textContent = COPY_HINT_DEFAULT;
            return;
        }
        if (lengthValue > MAX_PASSWORD_LENGTH) {
            errorOutput.textContent = `Password length must be ${MAX_PASSWORD_LENGTH} or less.`;
            resultOutput.value = '';
            copyButton.disabled = true;
            this.updateModalState({
                length: lengthValue,
                charsetInput: charsetValue,
                result: '',
                error: `Password length must be ${MAX_PASSWORD_LENGTH} or less.`,
                copyStatus: COPY_HINT_DEFAULT,
            });
            copyHintOutput.textContent = COPY_HINT_DEFAULT;
            return;
        }

        const charsetWithoutLineBreaks = charsetValue.replace(/\r/g, '').replace(/\n/g, '');
        if (charsetWithoutLineBreaks.length === 0) {
            errorOutput.textContent = 'Character set must not be empty.';
            resultOutput.value = '';
            copyButton.disabled = true;
            this.updateModalState({
                length: lengthValue,
                charsetInput: charsetValue,
                result: '',
                error: 'Character set must not be empty.',
                copyStatus: COPY_HINT_DEFAULT,
            });
            copyHintOutput.textContent = COPY_HINT_DEFAULT;
            return;
        }

        const normalizedCharset = normalizePasswordCharset(charsetValue);
        const generated = generateRandomPassword(lengthValue, normalizedCharset, null);
        resultOutput.value = generated;
        this.renderPasswordStrength(generated);
        copyButton.disabled = false;
        copyHintOutput.textContent = COPY_HINT_DEFAULT;
        errorOutput.textContent = '';
        this.updateModalState({
            length: lengthValue,
            charsetInput: charsetValue,
            result: generated,
            error: '',
            copyStatus: COPY_HINT_DEFAULT,
        });
    }
}
