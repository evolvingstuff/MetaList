/**
 * Error Handler - Centralized error handling for authentication and network errors
 */

import { parseDecimalInteger } from './decimal-integer.js';
import { ModeContextInstance as ModeContext } from './mode-manager/mode-context.js';
import { Auth } from './auth.js';
import { classifyApiFailure } from './api-failure-classification-service.js';
import { clearEditingStateForDisconnect } from './disconnect-editing-state-service.js';
import { MS_PER_SECOND } from './time-units.js';

const RESTORE_TRANSITION_UNTIL_KEY = 'metalist_restore_transition_until_ms';
// Lets the banner's hidden state render first so the slide-in transition runs.
const BANNER_SHOW_DELAY_MS = 10;
// Matches the .error-banner transform transition in main.css.
const BANNER_SLIDE_OUT_MS = 300;
const HTTP_ERROR_BANNER_SECONDS = 5;
const RECONNECTED_BANNER_SECONDS = 3;


function _isRestoreTransitionActive() {
    const rawValue = sessionStorage.getItem(RESTORE_TRANSITION_UNTIL_KEY);
    if (rawValue === null) {
        return false;
    }
    if (!/^[0-9]+$/.test(rawValue)) {
        sessionStorage.removeItem(RESTORE_TRANSITION_UNTIL_KEY);
        return false;
    }
    const untilMs = parseDecimalInteger(rawValue);
    if (!Number.isInteger(untilMs)) {
        sessionStorage.removeItem(RESTORE_TRANSITION_UNTIL_KEY);
        return false;
    }
    if (Date.now() >= untilMs) {
        sessionStorage.removeItem(RESTORE_TRANSITION_UNTIL_KEY);
        return false;
    }
    return true;
}

export const ErrorHandler = {
    
    /**
     * Handle different types of API errors with appropriate UX
     */
    handleApiError(error, response) {
        console.error('[ErrorHandler] Handling API failure');

        const failure = classifyApiFailure(error, response);
        if (failure.kind === 'auth') {
            this.handleAuthError(failure.message);
            return;
        }
        if (failure.kind === 'http') {
            this.handleHttpError(failure.message);
            return;
        }
        if (failure.kind === 'network') {
            this.handleNetworkError(failure.message);
            return;
        }
        if (failure.kind === 'internal') {
            throw failure.error;
        }
        throw new Error(`Unsupported API failure kind: ${failure.kind}`);
    },
    
    /**
     * Handle authentication errors (401) - show login screen
     */
    handleAuthError(message) {
        if (typeof message !== 'string' || message.length === 0) {
            throw new Error('ErrorHandler.handleAuthError requires message string');
        }
        console.log('[ErrorHandler] Authentication error');
        Auth.forceLogout(message);
    },

    /**
     * Report an HTTP application failure without claiming the connection was lost.
     */
    handleHttpError(message) {
        if (typeof message !== 'string' || message.length === 0) {
            throw new Error('ErrorHandler.handleHttpError requires message string');
        }
        console.log('[ErrorHandler] HTTP error');
        this.showErrorBanner(message, 'error', HTTP_ERROR_BANNER_SECONDS * MS_PER_SECOND, true);
    },
    
    /**
     * Handle network errors - show a calm status banner but keep the interface visible
     */
    handleNetworkError(message) {
        if (typeof message !== 'string' || message.length === 0) {
            throw new Error('ErrorHandler.handleNetworkError requires message string');
        }
        if (_isRestoreTransitionActive()) {
            console.log('[ErrorHandler] Suppressed network error during restore transition');
            return;
        }
        console.log('[ErrorHandler] Network error');
        
        // Check if we're already showing a connection error banner
        if (!ModeContext.connectionErrorBannerVisible) {
            // First network error - show banner and set disconnected state
            if (ModeContext.isConnected) {
                ModeContext.setConnected(false);
            }
            ModeContext.setConnectionErrorBannerVisible(true);
            this.showPersistentErrorBanner(message, 'connection');
            this.disableEditingUI();
        }
        // If banner is already visible, don't create a new one
    },
    
    /**
     * Handle successful connection - hide error banner if showing
     */
    handleConnectionRestored() {
        // Only process if we were actually disconnected
        if (!ModeContext.isConnected || ModeContext.connectionErrorBannerVisible) {
            console.log('[ErrorHandler] Connection restored');
            
            if (!ModeContext.isConnected) {
                ModeContext.setConnected(true);
            }
            
            if (ModeContext.connectionErrorBannerVisible) {
                ModeContext.setConnectionErrorBannerVisible(false);
                this.hideErrorBanner();
                this.showSuccessBanner('Reconnected to MetaList. Editing is available again.', RECONNECTED_BANNER_SECONDS * MS_PER_SECOND);
                this.enableEditingUI();
            }
        }
        // If already connected, do nothing silently
    },
    
    /**
     * Disable all contenteditable elements when disconnected
     */
    disableEditingUI() {
        // Find all potentially editable elements (both active and inactive)
        const editableElements = document.querySelectorAll('.note-content');
        
        editableElements.forEach(element => {
            // Save original state
            if (element.getAttribute('contenteditable') === 'true') {
                element.setAttribute('data-was-contenteditable', 'true');
            }
            
            // Disable editing and apply disconnected styling
            element.setAttribute('contenteditable', 'false');
            element.classList.add('disconnected-state');
            element.style.cursor = 'not-allowed';
            element.style.opacity = '0.7';
            element.style.pointerEvents = 'none'; // Prevent any interaction
        });
        
        // Exit edit mode immediately without server calls if currently editing.
        // currentContent can still be null while note selection awaits its first refresh.
        if (clearEditingStateForDisconnect(ModeContext)) {
            console.log('[ErrorHandler] Force-exited edit mode due to disconnection');
        }
    },
    
    /**
     * Re-enable contenteditable elements when connection restored
     */
    enableEditingUI() {
        // Re-enable all note content elements
        document.querySelectorAll('.note-content.disconnected-state').forEach(element => {
            // Remove disconnected styling
            element.classList.remove('disconnected-state');
            element.style.cursor = '';
            element.style.opacity = '';
            element.style.pointerEvents = '';
            
            // Restore contenteditable state if it was previously editable
            if (element.getAttribute('data-was-contenteditable') === 'true') {
                element.removeAttribute('data-was-contenteditable');
                // Don't set contenteditable back to true - let the app manage that
            } else {
                // Make sure it's set to false for non-editing elements
                element.setAttribute('contenteditable', 'false');
            }
        });
    },
    
    /**
     * Show persistent error banner (no auto-hide, no close button)
     */
    showPersistentErrorBanner(message, type) {
        if (typeof type !== 'string' || type.length === 0) {
            throw new Error('ErrorHandler.showPersistentErrorBanner requires type string');
        }
        this.showErrorBanner(message, type, 0, false); // duration = 0 means no auto-hide, showClose = false
    },
    
    /**
     * Show error banner at top of screen
     */
    showErrorBanner(message, type, duration, showClose) {
        if (typeof message !== 'string' || message.length === 0) {
            throw new Error('ErrorHandler.showErrorBanner requires message string');
        }
        if (typeof type !== 'string' || type.length === 0) {
            throw new Error('ErrorHandler.showErrorBanner requires type string');
        }
        if (typeof duration !== 'number') {
            throw new Error('ErrorHandler.showErrorBanner requires duration number');
        }
        if (typeof showClose !== 'boolean') {
            throw new Error('ErrorHandler.showErrorBanner requires showClose boolean');
        }
        // Remove any existing banner
        this.hideErrorBanner();
        
        // Create banner element
        const banner = document.createElement('div');
        banner.id = 'error-banner';
        banner.className = `error-banner error-banner-${type}`;
        
        const closeButton = showClose ? 
            `<button class="error-banner-close" onclick="ErrorHandler.hideErrorBanner()" aria-label="Close">×</button>` : '';
            
        banner.innerHTML = `
            <div class="error-banner-content">
                <span class="error-banner-icon">${type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️'}</span>
                <span class="error-banner-message"></span>
                ${closeButton}
            </div>
        `;
        // Plain text: messages can quote what the user typed or what an AI answered.
        banner.querySelector('.error-banner-message').textContent = message;
        
        // Add to page
        document.body.insertBefore(banner, document.body.firstChild);
        
        // Auto-hide after duration
        if (duration > 0) {
            setTimeout(() => this.hideErrorBanner(), duration);
        }
        
        // Animate in
        setTimeout(() => banner.classList.add('error-banner-visible'), BANNER_SHOW_DELAY_MS);
    },
    
    /**
     * Hide error banner
     */
    hideErrorBanner() {
        const banner = document.getElementById('error-banner');
        if (banner) {
            banner.classList.remove('error-banner-visible');
            setTimeout(() => {
                if (banner.parentNode) {
                    banner.parentNode.removeChild(banner);
                }
            }, BANNER_SLIDE_OUT_MS);
        }
    },
    
    /**
     * Show success message banner
     */
    showSuccessBanner(message, duration) {
        if (typeof duration !== 'number') {
            throw new Error('ErrorHandler.showSuccessBanner requires duration number');
        }
        this.showErrorBanner(message, 'success', duration, false);
    },
    
    /**
     * Show info message banner  
     */
    showInfoBanner(message, duration) {
        if (typeof duration !== 'number') {
            throw new Error('ErrorHandler.showInfoBanner requires duration number');
        }
        this.showErrorBanner(message, 'info', duration, false);
    }
};

// Make available globally
window.ErrorHandler = ErrorHandler;
