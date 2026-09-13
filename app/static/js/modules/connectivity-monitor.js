import { ApplicationState } from './application-state.js';
import { rethrowUnexpectedError } from './expected-errors.js';
/**
 * Connectivity Monitor - Dedicated service for checking server connectivity
 * Runs independently of UI state (editing, searching, etc.)
 */

import { ModeContextInstance as ModeContext } from './mode-manager/mode-context.js';
import { CONFIG } from './config.js';
import { ErrorHandler } from './error-handler.js';
import { buildSessionHeaders } from './session-auth.js';

const moduleState = ApplicationState.createFields('connectivity-monitor', {
    connectivityInterval: null,
});
const CONNECTIVITY_CHECK_INTERVAL = 2000; // Check every 2 seconds

export const ConnectivityMonitor = {
    handleConnectivityFailure(error) {
        console.log('[ConnectivityMonitor] Connectivity check failed');
        ErrorHandler.handleApiError(error, null);
    },

    
    /**
     * Start monitoring server connectivity
     */
    start() {
        if (moduleState.connectivityInterval) {
            console.warn('[ConnectivityMonitor] Already running');
            return;
        }
        
        console.log('[ConnectivityMonitor] Starting connectivity monitoring');
        
        // Check immediately
        void this.checkConnectivity().catch((error) => {
            rethrowUnexpectedError(error);
            this.handleConnectivityFailure(error);
        });
        
        // Then check periodically
        moduleState.connectivityInterval = setInterval(() => {
            void this.checkConnectivity().catch((error) => {
            rethrowUnexpectedError(error);
                this.handleConnectivityFailure(error);
            });
        }, CONNECTIVITY_CHECK_INTERVAL);
    },
    
    /**
     * Stop monitoring server connectivity
     */
    stop() {
        if (moduleState.connectivityInterval) {
            clearInterval(moduleState.connectivityInterval);
            moduleState.connectivityInterval = null;
            console.log('[ConnectivityMonitor] Stopped connectivity monitoring');
        }
    },
    
    /**
     * Check server connectivity with a lightweight ping endpoint
     */
    async checkConnectivity() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

        const response = await fetch(CONFIG.API.AUTH.STATUS, {
            method: 'GET',
            headers: buildSessionHeaders(false),
            signal: controller.signal
        }).finally(() => {
            clearTimeout(timeoutId);
        });

        if (response.ok) {
            ErrorHandler.handleConnectionRestored();
        } else if (response.status === 401) {
            ErrorHandler.handleApiError(null, response);
        } else {
            console.log('[ConnectivityMonitor] Server returned error:', response.status);
        }
    },
    
    /**
     * Force an immediate connectivity check
     */
    checkNow() {
        void this.checkConnectivity().catch((error) => {
            rethrowUnexpectedError(error);
            this.handleConnectivityFailure(error);
        });
    }
};

// Export for global access if needed
window.ConnectivityMonitor = ConnectivityMonitor;
