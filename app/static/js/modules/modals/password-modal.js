import { ApplicationState } from '../application-state.js';
import { HttpRequestError, rethrowUnexpectedError } from '../expected-errors.js';
/** Three explicit password-management modals backed by shared behavior. */

import { BaseModal } from './base-modal.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { CONFIG } from '../config.js';
import {
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    calculatePasswordLengthProgress,
    validateNewPasswordLength,
} from '../password-policy.js';
import {
    evaluatePasswordStrength,
    loadPasswordStrengthEstimator,
} from '../password-strength.js';
import { readPasswordOperationResponse } from '../password-operation-response.js';
import { buildSessionHeaders } from '../session-auth.js';

const PASSWORD_MODAL_CONFIG = {
    create: {
        modalName: 'addPasswordModal',
        modalElementId: 'add-password-modal',
    },
    change: {
        modalName: 'changePasswordModal',
        modalElementId: 'change-password-modal',
    },
    remove: {
        modalName: 'removePasswordModal',
        modalElementId: 'remove-password-modal',
    },
};


class PasswordOperationModal extends BaseModal {
    constructor(mode) {
        const modalConfig = PASSWORD_MODAL_CONFIG[mode];
        if (!modalConfig) {
            throw new Error(`Unknown password modal mode: ${mode}`);
        }
        super(modalConfig.modalName, modalConfig.modalElementId);
        this.mode = mode;
        this.apiEndpoints = {
            status: CONFIG.API.AUTH.STATUS,
            create: CONFIG.API.AUTH.SETTINGS.PASSWORD.CREATE,
            change: CONFIG.API.AUTH.SETTINGS.PASSWORD.CHANGE,
            remove: CONFIG.API.AUTH.SETTINGS.PASSWORD.REMOVE
        };

        ApplicationState.own(this, 'PasswordOperationModal', new.target === PasswordOperationModal);
    }
    
    getInitialModalState() {
        return {
            mode: this.mode,
            currentStep: 1,
            isProcessing: false,
            error: null,
            formData: {
                currentPassword: '',
                newPassword: '',
                confirmPassword: ''
            }
        };
    }
    
    async onOpen() {
        await (async () => {
            const response = await fetch(this.apiEndpoints.status, {
                headers: buildSessionHeaders(false),
            });
            if (!response.ok) {
                throw new HttpRequestError(`Password status request failed with ${response.status}`);
            }
            const status = await response.json();
            if (typeof status.has_password !== 'boolean') {
                throw new Error('Password status response is missing has_password');
            }
            if (this.mode === 'create' && status.has_password) {
                throw new Error('A password is already set. Use Change Password or Remove Password.');
            }
            if (this.mode !== 'create' && !status.has_password) {
                throw new Error('No password is set. Use Add Password first.');
            }

            this.renderModalContent();
            if (this.mode !== 'remove') {
                this.loadNewPasswordStrengthEstimator();
            }
        })().catch((error) => {
            rethrowUnexpectedError(error);
            console.error('Failed to open password operation modal');
            const errorMessage = error && typeof error.message === 'string' && error.message !== ''
                ? error.message
                : 'Failed to load password settings. Please try again.';
            this.updateModalState({
                error: errorMessage,
            });
            this.renderModalContent();
        });
    }
    
    /**
     * Called before modal closes - cleanup form data
     */
    onClose() {
        // The state scope is disposed by BaseModal; remove password values from
        // the hidden DOM instead of rewriting state just before disposal.
        document.getElementById(this.modalElementId).replaceChildren();
    }
    
    /**
     * Handle modal-specific keyboard shortcuts
     */
    onKeyDown(event) {
        const state = this.getModalState();
        
        // Enter to submit (if not processing)
        if (event.key === 'Enter' && !state.isProcessing) {
            event.preventDefault();
            const submitButton = document.querySelector('[data-password-submit]');
            if (!(submitButton instanceof HTMLButtonElement)) {
                throw new Error('Password modal submit button missing');
            }
            if (submitButton.disabled) {
                return;
            }
            this.handleSubmit();
        }
        
        // Escape handled by BaseModal (will close modal)
    }
    
    /**
     * Render the modal content based on current mode
     */
    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        const state = this.getModalState();
        
        if (!modalElement) {
            throw new Error(`Modal element not found: ${this.modalElementId}`);
        }
        
        const content = this.generateContentHTML(state);
        modalElement.innerHTML = content;
        
        // Setup form event listeners
        this.setupFormEventListeners();
    }
    
    /**
     * Generate HTML content based on modal state
     */
    generateContentHTML(state) {
        if (state.error) {
            return this.generateErrorHTML(state.error);
        }
        
        switch (state.mode) {
            case 'create':
                return this.generateCreatePasswordHTML();
            case 'change':
                return this.generateChangePasswordHTML();
            case 'remove':
                return this.generateRemovePasswordHTML();
            default:
                return this.generateLoadingHTML();
        }
    }
    
    generateCreatePasswordHTML() {
        return `
            <div class="modal-content">
                <h3>Add Password</h3>
                
                <form id="password-form">
                    <div class="form-group">
                        <label for="new-password">New Password:</label>
                        <input
                            type="password"
                            id="new-password"
                            autocomplete="new-password"
                            minlength="${PASSWORD_MIN_LENGTH}"
                            maxlength="${PASSWORD_MAX_LENGTH}"
                            required
                        >
                    </div>

                    ${this.generateNewPasswordLengthHTML()}
                    ${this.generateNewPasswordStrengthHTML()}
                    
                    <div class="form-group">
                        <label for="confirm-password">Confirm Password:</label>
                        <input type="password" id="confirm-password" autocomplete="new-password" maxlength="${PASSWORD_MAX_LENGTH}" required>
                    </div>

                    <small class="form-help" id="password-form-validation" aria-live="polite"></small>

                    <div class="form-actions">
                        <button type="submit" class="primary-btn" data-password-submit disabled>Add Password</button>
                        <button type="button" class="secondary-btn" id="cancel-btn">Cancel</button>
                    </div>
                </form>
                
                <div id="progress-section" style="display: none;">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: 0%"></div>
                    </div>
                    <p id="progress-text">Encrypting notes...</p>
                </div>
            </div>
        `;
    }
    
    generateChangePasswordHTML() {
        return `
            <div class="modal-content">
                <h3>Change Password</h3>
                
                <form id="password-form" autocomplete="off">
                    <div class="form-group">
                        <label for="current-password">Current Password:</label>
                        <input type="password" id="current-password" autocomplete="current-password" required>
                    </div>
                    
                    <div class="form-group">
                        <label for="new-password">New Password:</label>
                        <input
                            type="password"
                            id="new-password"
                            autocomplete="new-password"
                            minlength="${PASSWORD_MIN_LENGTH}"
                            maxlength="${PASSWORD_MAX_LENGTH}"
                            required
                        >
                    </div>

                    ${this.generateNewPasswordLengthHTML()}
                    ${this.generateNewPasswordStrengthHTML()}
                    
                    <div class="form-group">
                        <label for="confirm-password">Confirm New Password:</label>
                        <input type="password" id="confirm-password" autocomplete="new-password" maxlength="${PASSWORD_MAX_LENGTH}" required>
                    </div>

                    <small class="form-help" id="password-form-validation" aria-live="polite"></small>

                    <div class="form-actions">
                        <button type="submit" class="primary-btn" data-password-submit disabled>Change Password</button>
                        <button type="button" class="secondary-btn" id="cancel-btn">Cancel</button>
                    </div>
                </form>
                
                <div id="progress-section" style="display: none;">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: 0%"></div>
                    </div>
                    <p id="progress-text">Updating password...</p>
                </div>
            </div>
        `;
    }

    generateNewPasswordLengthHTML() {
        return `
            <div class="password-length" id="new-password-length" data-complete="false">
                <div class="password-length-header">
                    <span>Minimum length</span>
                    <strong id="new-password-length-label">
                        <span class="password-length-check" aria-hidden="true">✓</span>
                        <span id="new-password-length-count">0 / ${PASSWORD_MIN_LENGTH}</span>
                    </strong>
                </div>
                <div
                    class="password-length-meter"
                    id="new-password-length-meter"
                    role="progressbar"
                    aria-label="New password minimum length progress"
                    aria-valuemin="0"
                    aria-valuemax="${PASSWORD_MIN_LENGTH}"
                    aria-valuenow="0"
                >
                    <span id="new-password-length-fill" style="width: 0%"></span>
                </div>
                <small class="form-help" id="new-password-length-policy">
                    ${PASSWORD_MIN_LENGTH} characters required.
                </small>
            </div>
        `;
    }

    renderNewPasswordLength(password) {
        const lengthContainer = document.getElementById('new-password-length');
        const lengthCount = document.getElementById('new-password-length-count');
        const lengthMeter = document.getElementById('new-password-length-meter');
        const lengthFill = document.getElementById('new-password-length-fill');
        const lengthPolicy = document.getElementById('new-password-length-policy');
        if (!(lengthContainer instanceof HTMLElement)) {
            throw new Error('new-password-length missing');
        }
        if (!(lengthCount instanceof HTMLElement)) {
            throw new Error('new-password-length-count missing');
        }
        if (!(lengthMeter instanceof HTMLElement)) {
            throw new Error('new-password-length-meter missing');
        }
        if (!(lengthFill instanceof HTMLElement)) {
            throw new Error('new-password-length-fill missing');
        }
        if (!(lengthPolicy instanceof HTMLElement)) {
            throw new Error('new-password-length-policy missing');
        }

        const progress = calculatePasswordLengthProgress(password);
        lengthContainer.dataset.complete = String(progress.meetsMinimumLength);
        lengthCount.textContent = progress.meetsMinimumLength
            ? `${progress.characterCount} characters`
            : `${progress.characterCount} / ${PASSWORD_MIN_LENGTH}`;
        lengthFill.style.width = `${progress.progressPercent}%`;
        lengthMeter.setAttribute(
            'aria-valuenow',
            String(Math.min(progress.characterCount, PASSWORD_MIN_LENGTH)),
        );
        lengthPolicy.textContent = progress.meetsMinimumLength
            ? 'Minimum length reached.'
            : `${progress.remainingCharacterCount} more characters required.`;
    }

    generateNewPasswordStrengthHTML() {
        return `
            <div class="password-strength" id="new-password-strength" data-score="pending">
                <div class="password-strength-header">
                    <span>Strength</span>
                    <strong id="new-password-strength-label">Enter a password</strong>
                </div>
                <div
                    class="password-strength-meter"
                    id="new-password-strength-meter"
                    role="meter"
                    aria-label="New password strength"
                    aria-valuemin="0"
                    aria-valuemax="4"
                >
                    <span></span>
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
                <small class="form-help" id="new-password-strength-policy">
                    Type a password to test it locally.
                </small>
            </div>
        `;
    }

    loadNewPasswordStrengthEstimator() {
        loadPasswordStrengthEstimator()
            .then(() => {
                if (!this.isOpen) {
                    return;
                }
                const newPasswordInput = document.getElementById('new-password');
                if (!(newPasswordInput instanceof HTMLInputElement)) {
                    return;
                }
                this.renderNewPasswordStrength(newPasswordInput.value);
            })
            .catch((error) => {
            rethrowUnexpectedError(error);
                console.error('Password strength estimator failed');
                if (!this.isOpen) {
                    return;
                }
                const strengthContainer = document.getElementById('new-password-strength');
                if (strengthContainer === null) {
                    return;
                }
                this.renderNewPasswordStrengthUnavailable();
            });
    }

    renderNewPasswordStrength(password) {
        const strengthContainer = document.getElementById('new-password-strength');
        const strengthLabel = document.getElementById('new-password-strength-label');
        const strengthMeter = document.getElementById('new-password-strength-meter');
        const strengthPolicy = document.getElementById('new-password-strength-policy');
        if (!(strengthContainer instanceof HTMLElement)) {
            throw new Error('new-password-strength missing');
        }
        if (!(strengthLabel instanceof HTMLElement)) {
            throw new Error('new-password-strength-label missing');
        }
        if (!(strengthMeter instanceof HTMLElement)) {
            throw new Error('new-password-strength-meter missing');
        }
        if (!(strengthPolicy instanceof HTMLElement)) {
            throw new Error('new-password-strength-policy missing');
        }

        if (password.length === 0) {
            strengthContainer.dataset.score = 'pending';
            strengthLabel.textContent = 'Enter a password';
            strengthMeter.removeAttribute('aria-valuenow');
            strengthPolicy.textContent = 'Type a password to test it locally.';
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

    renderNewPasswordStrengthUnavailable() {
        const strengthContainer = document.getElementById('new-password-strength');
        const strengthLabel = document.getElementById('new-password-strength-label');
        const strengthMeter = document.getElementById('new-password-strength-meter');
        const strengthPolicy = document.getElementById('new-password-strength-policy');
        if (!(strengthContainer instanceof HTMLElement)) {
            throw new Error('new-password-strength missing');
        }
        if (!(strengthLabel instanceof HTMLElement)) {
            throw new Error('new-password-strength-label missing');
        }
        if (!(strengthMeter instanceof HTMLElement)) {
            throw new Error('new-password-strength-meter missing');
        }
        if (!(strengthPolicy instanceof HTMLElement)) {
            throw new Error('new-password-strength-policy missing');
        }

        strengthContainer.dataset.score = 'unavailable';
        strengthLabel.textContent = 'Unavailable';
        strengthMeter.removeAttribute('aria-valuenow');
        strengthPolicy.textContent = 'The local strength estimator could not be loaded.';
    }
    
    generateRemovePasswordHTML() {
        return `
            <div class="modal-content">
                <h3>Remove Password</h3>
                <p><strong>Warning:</strong> This will decrypt all your notes and remove password protection. Your notes will be stored in plaintext.</p>
                
                <form id="password-form">
                    <div class="form-group">
                        <label for="current-password">Current Password:</label>
                        <input type="password" id="current-password" required>
                    </div>
                    
                    <div class="form-group">
                        <label>
                            <input type="checkbox" id="confirm-remove" required>
                            I understand that my notes will no longer be encrypted
                        </label>
                    </div>

                    <small class="form-help" id="password-form-validation" aria-live="polite"></small>

                    <div class="form-actions">
                        <button type="submit" class="danger-btn" data-password-submit disabled>Remove Password</button>
                        <button type="button" class="secondary-btn" id="cancel-btn">Cancel</button>
                    </div>
                </form>
                
                <div id="progress-section" style="display: none;">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: 0%"></div>
                    </div>
                    <p id="progress-text">Decrypting notes...</p>
                </div>
            </div>
        `;
    }
    
    generateLoadingHTML() {
        return `
            <div class="modal-content">
                <h3>Loading...</h3>
                <p>Checking password settings...</p>
            </div>
        `;
    }
    
    generateErrorHTML(error) {
        return `
            <div class="modal-content">
                <h3>Error</h3>
                <p class="error-message">${error}</p>
            </div>
        `;
    }
    
    /**
     * Setup form event listeners after content is rendered
     */
    setupFormEventListeners() {
        const form = document.getElementById('password-form');
        const cancelBtn = document.getElementById('cancel-btn');
        const newPasswordInput = document.getElementById('new-password');
        const confirmPasswordInput = document.getElementById('confirm-password');
        const currentPasswordInput = document.getElementById('current-password');
        const confirmRemoveCheckbox = document.getElementById('confirm-remove');
        
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleSubmit();
            });
        }
        
        // Real-time password matching validation
        if (newPasswordInput && confirmPasswordInput) {
            newPasswordInput.addEventListener('input', () => {
                this.renderNewPasswordLength(newPasswordInput.value);
                this.renderNewPasswordStrength(newPasswordInput.value);
            });
            this.renderNewPasswordLength(newPasswordInput.value);
            this.renderNewPasswordStrength(newPasswordInput.value);

            const checkPasswordMatch = () => {
                const newPw = newPasswordInput.value;
                const confirmPw = confirmPasswordInput.value;
                
                // Only check if confirm field has content
                if (confirmPw) {
                    let isMatch = false;
                    
                    if (confirmPw.length < newPw.length) {
                        // Check if newPw starts with confirmPw (still typing)
                        isMatch = newPw.startsWith(confirmPw);
                    } else if (confirmPw.length === newPw.length) {
                        // Same length - must be exact match
                        isMatch = (newPw === confirmPw);
                    } else {
                        // confirmPw is longer than newPw - always wrong
                        isMatch = false;
                    }
                    
                    if (!isMatch) {
                        confirmPasswordInput.style.borderColor = 'var(--error-color)';
                        confirmPasswordInput.style.backgroundColor = 'rgba(190, 48, 67, 0.18)';
                    } else {
                        confirmPasswordInput.style.borderColor = '';
                        confirmPasswordInput.style.backgroundColor = '';
                    }
                } else {
                    // Reset styles if confirm field is empty
                    confirmPasswordInput.style.borderColor = '';
                    confirmPasswordInput.style.backgroundColor = '';
                }
            };
            
            confirmPasswordInput.addEventListener('input', checkPasswordMatch);
            newPasswordInput.addEventListener('input', checkPasswordMatch);
        }
        
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.close());
        }
        
        for (const passwordInput of [currentPasswordInput, newPasswordInput, confirmPasswordInput]) {
            if (passwordInput instanceof HTMLInputElement) {
                passwordInput.addEventListener('input', () => this.syncSubmitAvailability());
            }
        }
        if (confirmRemoveCheckbox instanceof HTMLInputElement) {
            confirmRemoveCheckbox.addEventListener('change', () => this.syncSubmitAvailability());
        }
        if (form) {
            this.syncSubmitAvailability();
        }
    }

    syncSubmitAvailability() {
        const submitButton = document.querySelector('[data-password-submit]');
        const validationOutput = document.getElementById('password-form-validation');
        if (!(submitButton instanceof HTMLButtonElement)) {
            throw new Error('Password modal submit button missing');
        }
        if (!(validationOutput instanceof HTMLElement)) {
            throw new Error('password-form-validation missing');
        }

        const validation = this.validateFormData(this.collectFormData(), this.mode);
        submitButton.disabled = !validation.valid;
        validationOutput.textContent = validation.valid ? '' : validation.error;
    }
    
    /**
     * Handle form submission based on current mode
     */
    async handleSubmit() {
        const state = this.getModalState();
        
        if (state.isProcessing) {
            return; // Prevent double submission
        }

        const formData = this.collectFormData();
        const validation = this.validateFormData(formData, state.mode);
        if (!validation.valid) {
            this.syncSubmitAvailability();
            return;
        }

        await (async () => {
            this.updateModalState({ isProcessing: true, error: null });
            this.showProcessingState();
            
            // Show waiting cursor
            document.body.classList.add('loading');
            
            // Submit to appropriate endpoint
            await this.submitPasswordOperation(state.mode, formData);
            
            // Success - close modal
            this.close();
            
            // Refresh the app to reflect new encryption state
            window.location.reload();
        })().catch((error) => {
            rethrowUnexpectedError(error);
            console.error('Password operation failed');
            
            // Remove waiting cursor on error
            document.body.classList.remove('loading');

            let errorMessage = null;
            if (error && typeof error.message === 'string' && error.message.length > 0) {
                errorMessage = error.message;
            } else {
                errorMessage = 'Password operation failed. Please try again.';
            }
            
            this.updateModalState({ 
                error: errorMessage,
                isProcessing: false 
            });
            this.renderModalContent();
        });
    }
    
    /**
     * Collect form data from current form inputs
     */
    collectFormData() {
        return {
            currentPassword: document.getElementById('current-password')?.value || '',
            newPassword: document.getElementById('new-password')?.value || '',
            confirmPassword: document.getElementById('confirm-password')?.value || ''
        };
    }
    
    /**
     * Validate form data based on mode
     */
    validateFormData(formData, mode) {
        switch (mode) {
            case 'create':
                if (!formData.newPassword) {
                    return { valid: false, error: 'Please enter a new password' };
                }
                if (formData.newPassword !== formData.confirmPassword) {
                    return { valid: false, error: 'Passwords do not match' };
                }
                const createLengthValidation = validateNewPasswordLength(formData.newPassword);
                if (!createLengthValidation.valid) {
                    return createLengthValidation;
                }
                break;
                
            case 'change':
                if (!formData.currentPassword) {
                    return { valid: false, error: 'Please enter your current password' };
                }
                if (!formData.newPassword) {
                    return { valid: false, error: 'Please enter a new password' };
                }
                if (formData.newPassword !== formData.confirmPassword) {
                    return { valid: false, error: 'New passwords do not match' };
                }
                const changeLengthValidation = validateNewPasswordLength(formData.newPassword);
                if (!changeLengthValidation.valid) {
                    return changeLengthValidation;
                }
                break;
                
            case 'remove':
                if (!formData.currentPassword) {
                    return { valid: false, error: 'Please enter your current password' };
                }
                const confirmCheckbox = document.getElementById('confirm-remove');
                if (!confirmCheckbox || !confirmCheckbox.checked) {
                    return { valid: false, error: 'Please confirm that you understand the risks' };
                }
                break;
        }
        
        return { valid: true };
    }
    
    /**
     * Submit password operation to server
     */
    async submitPasswordOperation(mode, formData) {
        let endpoint, body, method;
        
        switch (mode) {
            case 'create':
                endpoint = this.apiEndpoints.create;
                body = { password: formData.newPassword };
                method = 'POST';
                break;
                
            case 'change':
                endpoint = this.apiEndpoints.change;
                body = { 
                    current_password: formData.currentPassword,
                    new_password: formData.newPassword
                };
                method = 'PUT';
                break;
                
            case 'remove':
                endpoint = this.apiEndpoints.remove;
                body = { current_password: formData.currentPassword };
                method = 'DELETE';
                break;
                
            default:
                throw new Error(`Unknown password operation mode: ${mode}`);
        }
        
        const response = await fetch(endpoint, {
            method,
            headers: buildSessionHeaders(true),
            body: JSON.stringify(body)
        });
        
        return readPasswordOperationResponse(response);
    }
    
    /**
     * Show processing state with progress indication
     */
    showProcessingState() {
        const form = document.getElementById('password-form');
        const progressSection = document.getElementById('progress-section');
        
        if (form) {
            form.style.display = 'none';
        }
        
        if (progressSection) {
            progressSection.style.display = 'block';
        }
        
        // TODO: Implement SSE progress updates for real progress tracking
        // For now, just show indeterminate progress
        this.simulateProgress();
    }
    
    /**
     * Simulate progress for bulk operations (temporary until SSE implemented)
     */
    simulateProgress() {
        const progressFill = document.querySelector('.progress-fill');
        if (!progressFill) return;
        
        let progress = 0;
        const interval = setInterval(() => {
            progress += Math.random() * 10;
            if (progress >= 90) {
                progress = 90; // Stop at 90% to show we're waiting for completion
                clearInterval(interval);
            }
            progressFill.style.width = `${progress}%`;
        }, 200);
    }
    
    shouldCloseOnClickOutside() {
        return true;
    }
}


export class AddPasswordModal extends PasswordOperationModal {
    constructor() {
        super('create');

        ApplicationState.own(this, 'AddPasswordModal', new.target === AddPasswordModal);
    }
}


export class ChangePasswordModal extends PasswordOperationModal {
    constructor() {
        super('change');

        ApplicationState.own(this, 'ChangePasswordModal', new.target === ChangePasswordModal);
    }
}


export class RemovePasswordModal extends PasswordOperationModal {
    constructor() {
        super('remove');

        ApplicationState.own(this, 'RemovePasswordModal', new.target === RemovePasswordModal);
    }
}
