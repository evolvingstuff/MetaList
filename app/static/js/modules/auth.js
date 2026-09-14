import { ApplicationState } from './application-state.js';
import { HttpRequestError, rethrowUnexpectedError } from './expected-errors.js';
import { closeAllFloatingNotes } from './mode-manager/services/floating-note-service.js';
/**
 * Authentication module for handling login/logout and password management
 */
import { CONFIG } from './config.js';
import { createUuid } from './uuid.js';
import { CommandPalette } from './command-palette/command-palette-controller.js';
import { ReminderSurface } from './reminder-surface-service.js';
import { AiChatPanel } from './ai-chat/ai-chat-panel-controller.js';
import { clearLegacyAuthStorage, resolveStoredThemePreference } from './client-state-migration.js';
import { consumeBooleanQueryFlag } from './location-flags.js';
import {
    buildLoginNamespaceOpeningCopy,
    buildLoginTitle,
    navigateNamespaceInNewTab,
    openPendingNamespaceTab,
    parseLoginNamespaceCatalog,
} from './login-namespace-picker.js';
import { renderNamespaceLoadingTab } from './modals/namespace-loading-page.js';
import { formatElapsedDuration } from './elapsed-time.js';

export const Auth = {
    hasPassword: null,
    _forcingLogout: false,
    _currentNamespace: null,
    _loginNamespaceRequestId: 0,
    _tabId: null,
    _startupIntroPromise: null,
    _startupIntroResolved: false,
    _loadingStartedAt: null,
    _loadingElapsedTimerId: null,

    _isStartupIntroEnabled() {
        return CONFIG.STARTUP.ENABLE_LOGIN_INTRO === true;
    },
    
    /**
     * Initialize authentication on page load
     * Returns true if OK to proceed with app initialization
     */
    async init() {
        this._ensureTabId();
        clearLegacyAuthStorage();
        this.setupEventListeners();
        if (this._isStartupIntroEnabled()) {
            this._startStartupIntro();
        } else {
            this._startupIntroResolved = true;
            this._startupIntroPromise = Promise.resolve();
        }
        return await this.checkAuthStatus();
    },
    
    /**
     * Check authentication status and show login if needed
     * Returns true if authenticated/no password, false if login required
     */
    async checkAuthStatus() {
        const forceReauth = consumeBooleanQueryFlag({
            location: window.location,
            history: window.history,
            flagName: 'force_reauth',
        });
        if (forceReauth) {
            console.log('[Auth] force_reauth requested, clearing session state');
            this.clearSessionState();
        }

        const headers = {};
        headers['X-Metalist-Tab-Id'] = this._tabId;

        const response = await fetch(CONFIG.API.AUTH.STATUS, { headers });
        if (!response.ok) {
            throw new HttpRequestError(`Status request failed with ${response.status}`);
        }

        const status = await response.json();
        if (this.hasPassword !== Boolean(status.has_password)) this.hasPassword = Boolean(status.has_password);
        if (this._currentNamespace !== status.namespace) this._setCurrentNamespace(status.namespace);
        this._applyThemePreference(status.client_preferences);
        console.log('[Auth] Status response received');

        if (this.hasPassword) {
            if (!status.authenticated) {
                this.showLoginModal();
                return false;
            }
            if (this._isStartupIntroEnabled()) {
                this.showStartupSplash('Opening encrypted workspace…', 'Preparing your encrypted workspace…');
            }
            return true;
        }

        if (this._isStartupIntroEnabled()) {
            this.showStartupSplash('Opening workspace…', 'Preparing workspace…');
        }

        if (!status.authenticated) {
            await this.claimPasswordlessSession();
        }

        return true;
    },

    async claimPasswordlessSession() {
        console.log('[Auth] Claiming passwordless session');
        const response = await fetch(CONFIG.API.AUTH.SESSION, {
            method: 'POST',
            headers: {
                'X-Metalist-Tab-Id': this._tabId
            }
        });

        if (!response.ok) {
            const detail = await response.text();
            throw new HttpRequestError(`Failed to claim session: ${response.status} ${detail}`);
        }

        const data = await response.json();
        console.log('[Auth] Passwordless session established');
        return data;
    },

    _requireElement(id) {
        const element = document.getElementById(id);
        if (element === null) {
            throw new Error(`Missing required auth element: ${id}`);
        }
        return element;
    },

    _setLoginSubtitle(text) {
        if (typeof text !== 'string' || text.length === 0) {
            throw new Error('Auth._setLoginSubtitle requires text string');
        }
        const subtitle = this._requireElement('login-subtitle');
        subtitle.textContent = text;
        subtitle.hidden = false;
    },

    _hideLoginSubtitle() {
        const subtitle = this._requireElement('login-subtitle');
        subtitle.hidden = true;
    },

    _setLoginLoadingTitle(text) {
        if (typeof text !== 'string' || text.length === 0) {
            throw new Error('Auth._setLoginLoadingTitle requires text string');
        }
        const loadingTitle = this._requireElement('login-loading-title');
        loadingTitle.textContent = text;
    },

    _updateLoadingElapsedUI() {
        if (this._loadingStartedAt === null) {
            throw new Error('Loading elapsed timer has not started');
        }
        const elapsed = this._requireElement('login-loading-elapsed');
        const elapsedMilliseconds = window.performance.now() - this._loadingStartedAt;
        elapsed.textContent = `Elapsed: ${formatElapsedDuration(elapsedMilliseconds)}`;
    },

    _startLoadingElapsedTimer() {
        if (this._loadingElapsedTimerId !== null) {
            return;
        }
        this._loadingStartedAt = window.performance.now();
        this._updateLoadingElapsedUI();
        this._loadingElapsedTimerId = window.setInterval(() => {
            this._updateLoadingElapsedUI();
        }, 1000);
    },

    _stopLoadingElapsedTimer() {
        if (this._loadingElapsedTimerId === null) return;
        window.clearInterval(this._loadingElapsedTimerId);
        this._loadingElapsedTimerId = null;
        this._loadingStartedAt = null;
        this._requireElement('login-loading-elapsed').textContent = '';
    },

    _setCurrentNamespace(namespace) {
        if (typeof namespace !== 'string') {
            throw new Error('Auth._setCurrentNamespace requires namespace string');
        }
        this._currentNamespace = namespace;
        const title = this._requireElement('login-title');
        title.textContent = buildLoginTitle(namespace);
    },

    _applyThemePreference(clientPreferences) {
        const resolvedTheme = resolveStoredThemePreference(clientPreferences);
        if (resolvedTheme !== null) {
            document.documentElement.setAttribute('data-theme', resolvedTheme);
            return;
        }
        document.documentElement.removeAttribute('data-theme');
    },

    _setStartupMessage(text) {
        if (typeof text !== 'string' || text.length === 0) {
            throw new Error('Auth._setStartupMessage requires text string');
        }
        const startupMessage = this._requireElement('startup-message');
        startupMessage.textContent = text;
    },

    _setLoginNamespaceStatus(text, state = 'info') {
        if (typeof text !== 'string') {
            throw new Error('Auth._setLoginNamespaceStatus requires text string');
        }
        if (typeof state !== 'string' || state.length === 0) {
            throw new Error('Auth._setLoginNamespaceStatus requires state string');
        }
        const status = this._requireElement('login-namespace-status');
        if (text.length === 0) {
            status.hidden = true;
            status.textContent = '';
            status.dataset.state = 'info';
            this._syncLoginNamespaceVisibility();
            return;
        }
        status.hidden = false;
        status.textContent = text;
        status.dataset.state = state;
        this._syncLoginNamespaceVisibility();
    },

    _syncLoginNamespaceVisibility() {
        const switcher = this._requireElement('login-namespace-switcher');
        const loginForm = this._requireElement('login-form');
        const loginPage = this._requireElement('login-page');
        const status = this._requireElement('login-namespace-status');
        const hasChoices = switcher.dataset.hasChoices === 'true';
        const shouldShow = (hasChoices || status.hidden === false)
            && loginPage.style.display !== 'none'
            && loginForm.style.display !== 'none';
        switcher.hidden = !shouldShow;
    },

    _renderLoginNamespacePicker(catalog, disabled = false) {
        const select = this._requireElement('login-namespace-select');
        const switcher = this._requireElement('login-namespace-switcher');
        if (!catalog || typeof catalog !== 'object') {
            throw new Error('Auth._renderLoginNamespacePicker requires catalog object');
        }
        if (!Array.isArray(catalog.namespaces)) {
            throw new Error('Auth._renderLoginNamespacePicker requires namespaces array');
        }
        if (typeof catalog.currentNamespace !== 'string' || catalog.currentNamespace.length === 0) {
            throw new Error('Auth._renderLoginNamespacePicker requires currentNamespace');
        }

        const optionsHtml = catalog.namespaces.map((namespace) => {
            if (typeof namespace !== 'string' || namespace.length === 0) {
                throw new Error('Auth._renderLoginNamespacePicker requires non-empty namespace strings');
            }
            return `<option value="${namespace}">${namespace}</option>`;
        }).join('');

        if (!catalog.namespaces.includes(catalog.currentNamespace)) {
            throw new Error(`Current namespace ${catalog.currentNamespace} missing from catalog`);
        }

        select.innerHTML = optionsHtml;
        select.value = catalog.currentNamespace;
        select.disabled = disabled;
        switcher.dataset.hasChoices = catalog.namespaces.length >= 2 ? 'true' : 'false';
        this._syncLoginNamespaceVisibility();
    },

    async _readResponseDetail(response, fallbackPrefix) {
        if (!(response instanceof Response)) {
            throw new Error('Auth._readResponseDetail requires Response');
        }
        if (typeof fallbackPrefix !== 'string' || fallbackPrefix.length === 0) {
            throw new Error('Auth._readResponseDetail requires fallbackPrefix string');
        }

        const responseText = await response.text();
        if (responseText.length > 0) {
            const contentType = response.headers.get('content-type');
            if (typeof contentType === 'string' && contentType.toLowerCase().includes('application/json')) {
                const payload = JSON.parse(responseText);
                if (payload && typeof payload === 'object' && typeof payload.detail === 'string' && payload.detail.length > 0) {
                    return `${fallbackPrefix}: ${payload.detail}`;
                }
                if (payload && typeof payload === 'object' && typeof payload.message === 'string' && payload.message.length > 0) {
                    return `${fallbackPrefix}: ${payload.message}`;
                }
            }
            return `${fallbackPrefix} (${response.status})`;
        }
        return `${fallbackPrefix} (${response.status})`;
    },

    async _loadLoginNamespaceCatalog() {
        const requestId = this._loginNamespaceRequestId + 1;
        this._loginNamespaceRequestId = requestId;

        const select = this._requireElement('login-namespace-select');
        select.disabled = true;
        this._setLoginNamespaceStatus('Loading namespaces...');

        const response = await fetch(CONFIG.API.AUTH.LOGIN_NAMESPACES.LIST);
        if (!response.ok) {
            throw new HttpRequestError(await this._readResponseDetail(response, 'Failed to load namespaces'));
        }

        const payload = parseLoginNamespaceCatalog(await response.json());
        if (requestId !== this._loginNamespaceRequestId) {
            return;
        }
        if (this._currentNamespace !== payload.currentNamespace) {
            this._setCurrentNamespace(payload.currentNamespace);
        }
        this._renderLoginNamespacePicker(payload, false);
        this._setLoginNamespaceStatus('');
    },

    _clearLoginError() {
        const errorDiv = this._requireElement('login-error');
        errorDiv.style.display = 'none';
        errorDiv.textContent = '';
    },

    _resetHydrationUI() {
        const message = this._requireElement('login-loading-message');
        const bar = this._requireElement('login-progress-bar');
        const firstLoad = this._requireElement('login-loading-first');
        this._setLoginLoadingTitle('Loading encrypted data…');
        message.textContent = '';
        bar.style.width = '0%';
        firstLoad.style.display = 'none';
    },

    _showLoginLoadingPanel(subtitle, loadingTitle, loadingMessage, progressPercent) {
        if (typeof subtitle !== 'string' || subtitle.length === 0) {
            throw new Error('Auth._showLoginLoadingPanel requires subtitle string');
        }
        if (typeof loadingTitle !== 'string' || loadingTitle.length === 0) {
            throw new Error('Auth._showLoginLoadingPanel requires loadingTitle string');
        }
        if (typeof loadingMessage !== 'string') {
            throw new Error('Auth._showLoginLoadingPanel requires loadingMessage string');
        }
        if (!Number.isInteger(progressPercent) || progressPercent < 0 || progressPercent > 100) {
            throw new Error('Auth._showLoginLoadingPanel requires progressPercent integer 0-100');
        }

        const startupSplash = this._requireElement('startup-splash');
        const loginForm = this._requireElement('login-form');
        const loadingPanel = this._requireElement('login-loading');
        const message = this._requireElement('login-loading-message');
        const bar = this._requireElement('login-progress-bar');

        this._resetHydrationUI();
        startupSplash.style.display = 'none';
        loginForm.style.display = 'none';
        loadingPanel.style.display = 'block';
        this._setLoginSubtitle(subtitle);
        this._setLoginLoadingTitle(loadingTitle);
        message.textContent = loadingMessage;
        bar.style.width = `${progressPercent}%`;
        this._startLoadingElapsedTimer();
        this._clearLoginError();
        this._syncLoginNamespaceVisibility();
    },

    async _waitForBrowserPaint() {
        await new Promise((resolveFirstFrame) => {
            window.requestAnimationFrame(resolveFirstFrame);
        });
        await new Promise((resolveSecondFrame) => {
            window.requestAnimationFrame(resolveSecondFrame);
        });
    },

    _startStartupIntro() {
        if (this._startupIntroPromise !== null) {
            return;
        }
        if (!this._isStartupIntroEnabled()) {
            throw new Error('Startup intro is disabled');
        }

        const loginPage = this._requireElement('login-page');
        const mainApp = this._requireElement('main-app');
        const video = this._requireElement('login-startup-video');

        loginPage.style.display = 'flex';
        mainApp.style.display = 'none';
        this.showStartupSplash('Opening workspace…', 'Preparing workspace…');

        this._startupIntroPromise = new Promise((resolve) => {
            const finishIntro = () => {
                if (this._startupIntroResolved) {
                    return;
                }
                this._startupIntroResolved = true;
                video.pause();
                resolve();
            };

            video.addEventListener('ended', finishIntro, { once: true });
            video.addEventListener('error', finishIntro, { once: true });

            const playPromise = video.play();
            if (playPromise !== undefined && playPromise !== null && typeof playPromise.then === 'function') {
                playPromise.catch((error) => {
            rethrowUnexpectedError(error);
                    console.warn('[Auth] Startup intro playback failed');
                    finishIntro();
                });
            }
        });
    },

    async waitForStartupIntro() {
        if (this._startupIntroPromise === null) {
            throw new Error('Startup intro not initialized');
        }
        await this._startupIntroPromise;
    },

    showStartupSplash(subtitle, message) {
        if (typeof subtitle !== 'string' || subtitle.length === 0) {
            throw new Error('Auth.showStartupSplash requires subtitle string');
        }
        if (typeof message !== 'string' || message.length === 0) {
            throw new Error('Auth.showStartupSplash requires message string');
        }
        if (!this._isStartupIntroEnabled()) {
            throw new Error('Startup splash requested while startup intro is disabled');
        }

        const loginPage = this._requireElement('login-page');
        const mainApp = this._requireElement('main-app');
        const startupSplash = this._requireElement('startup-splash');
        const loginForm = this._requireElement('login-form');
        const loadingPanel = this._requireElement('login-loading');

        this._stopLoadingElapsedTimer();
        mainApp.style.display = 'none';
        loginPage.style.display = 'flex';
        startupSplash.style.display = 'flex';
        loginForm.style.display = 'none';
        loadingPanel.style.display = 'none';
        this._setLoginSubtitle(subtitle);
        this._setStartupMessage(message);
        this._resetHydrationUI();
        this._clearLoginError();
        this._syncLoginNamespaceVisibility();
    },
    
    /**
     * Show the login page and hide main app
     */
    showLoginModal() {
        closeAllFloatingNotes();
        const loginPage = this._requireElement('login-page');
        const mainApp = this._requireElement('main-app');
        const passwordInput = this._requireElement('login-password');
        const startupSplash = this._requireElement('startup-splash');
        const loginForm = this._requireElement('login-form');
        const loadingPanel = this._requireElement('login-loading');

        this._stopLoadingElapsedTimer();
        mainApp.style.display = 'none';
        loginPage.style.display = 'flex';
        startupSplash.style.display = 'none';
        loginForm.style.display = 'block';
        loadingPanel.style.display = 'none';
        this._setLoginSubtitle('Authentication Required');
        this._resetHydrationUI();
        this._clearLoginError();
        this._syncLoginNamespaceVisibility();
        void this._loadLoginNamespaceCatalog().catch((error) => {
            rethrowUnexpectedError(error);
            const message = error instanceof Error ? error.message : 'Failed to load namespaces';
            this._setLoginNamespaceStatus(message, 'error');
        });

        setTimeout(() => {
            passwordInput.focus();
        }, 100);
    },
    
    /**
     * Hide the login page and show main app
     */
    revealMainApp() {
        const loginPage = this._requireElement('login-page');
        const mainApp = this._requireElement('main-app');
        const passwordInput = this._requireElement('login-password');

        this._stopLoadingElapsedTimer();
        loginPage.style.display = 'none';
        mainApp.style.display = 'block';
        this._resetHydrationUI();
        this._clearLoginError();
        this._syncLoginNamespaceVisibility();
        passwordInput.value = '';
    },

    _showHydrationUI() {
        this._showLoginLoadingPanel(
            'Loading encrypted data…',
            'Loading encrypted data…',
            '',
            0,
        );
        this._hideLoginSubtitle();
    },

    _updateHydrationUI(status) {
        const message = document.getElementById('login-loading-message');
        const bar = document.getElementById('login-progress-bar');
        const firstLoad = document.getElementById('login-loading-first');

        if (message) {
            if (typeof status.message === 'string') {
                const trimmed = status.message.trim();
                if (trimmed.length > 0) {
                    const needsEllipsis = !(trimmed.endsWith('...') || trimmed.endsWith('…'));
                    message.textContent = needsEllipsis ? `${trimmed}...` : trimmed;
                } else {
                    message.textContent = '';
                }
            } else {
                message.textContent = '';
            }
        }
        if (firstLoad) {
            firstLoad.style.display = status.first_load ? 'block' : 'none';
        }
        if (typeof status.overall_percent === 'number') {
            let percent = Math.floor(status.overall_percent);
            if (percent > 100) {
                percent = 100;
            }
            if (percent < 0) {
                percent = 0;
            }
            if (bar) {
                bar.style.width = `${percent}%`;
            }
        } else if (typeof status.total === 'number' && status.total > 0) {
            const percent = Math.min(100, Math.floor((status.processed / status.total) * 100));
            if (bar) {
                bar.style.width = `${percent}%`;
            }
        } else {
            if (bar) {
                bar.style.width = '0%';
            }
        }
    },

    async _runHydrationFlow() {
        this._showHydrationUI();

        const headers = {
            'X-Metalist-Tab-Id': this._tabId,
        };

        const startResponse = await fetch(CONFIG.API.AUTH.HYDRATE, {
            method: 'POST',
            headers,
        });

        if (!startResponse.ok) {
            const detail = await startResponse.text();
            throw new HttpRequestError(`Failed to start hydration: ${startResponse.status} ${detail}`);
        }

        let status = await startResponse.json();
        this._updateHydrationUI(status);

        while (status.status !== 'ready') {
            if (status.status === 'error') {
                if (typeof status.error === 'string' && status.error.length > 0) {
                    throw new Error(status.error);
                }
                const failedPhase = typeof status.phase === 'string' && status.phase.length > 0
                    ? status.phase
                    : 'unknown phase';
                const failedMessage = typeof status.message === 'string' && status.message.length > 0
                    ? status.message
                    : 'server returned no error detail';
                throw new Error(`Hydration failed during ${failedPhase}: ${failedMessage}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
            const pollResponse = await fetch(CONFIG.API.AUTH.HYDRATION_STATUS, { headers });
            if (!pollResponse.ok) {
                const detail = await pollResponse.text();
                throw new HttpRequestError(`Hydration status failed: ${pollResponse.status} ${detail}`);
            }
            status = await pollResponse.json();
            this._updateHydrationUI(status);
        }
    },

    async handleLoginNamespaceChange(event) {
        if (!(event && event.target instanceof HTMLSelectElement)) {
            throw new Error('Auth.handleLoginNamespaceChange requires select event');
        }

        const select = event.target;
        const namespace = select.value;
        if (typeof namespace !== 'string' || namespace.length === 0) {
            throw new Error('Namespace picker selection is required');
        }
        if (this._currentNamespace === null) {
            throw new Error('Current namespace is unavailable');
        }
        if (namespace === this._currentNamespace) {
            return;
        }

        const openingCopy = buildLoginNamespaceOpeningCopy(namespace);
        let pendingTab = null;

        try {
            pendingTab = openPendingNamespaceTab(window);
            renderNamespaceLoadingTab(pendingTab, namespace);
            select.disabled = true;
            document.body.classList.add('loading');
            this._showLoginLoadingPanel(
                openingCopy.subtitle,
                openingCopy.loadingTitle,
                openingCopy.loadingMessage,
                35,
            );
            this._setLoginNamespaceStatus(openingCopy.statusText);

            const response = await fetch(CONFIG.API.AUTH.LOGIN_NAMESPACES.OPEN, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ namespace }),
            });

            if (!response.ok) {
                throw new HttpRequestError(await this._readResponseDetail(response, 'Failed to open namespace'));
            }

            const payload = await response.json();
            if (!payload || typeof payload !== 'object') {
                throw new Error('Namespace open response missing body');
            }
            if (typeof payload.url !== 'string' || payload.url.length === 0) {
                throw new Error('Namespace open response missing url');
            }

            navigateNamespaceInNewTab(payload.url, window, pendingTab);
            document.body.classList.remove('loading');
            this.showLoginModal();
        } catch (error) {
            rethrowUnexpectedError(error);
            if (pendingTab !== null && !pendingTab.closed) {
                pendingTab.close();
            }
            document.body.classList.remove('loading');
            this.showLoginModal();
            const restoredSelect = this._requireElement('login-namespace-select');
            restoredSelect.value = this._currentNamespace;
            restoredSelect.disabled = false;
            if (error instanceof Error) {
                this._setLoginNamespaceStatus(error.message, 'error');
                throw error;
            }
            this._setLoginNamespaceStatus('Failed to open namespace', 'error');
            throw new Error('Failed to open namespace');
        }
    },
    
    /**
     * Show error message in login modal
     */
    showLoginError(message) {
        const errorDiv = document.getElementById('login-error');
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
    },
    
    /**
     * Handle login form submission
     */
    async handleLogin(event) {
        event.preventDefault();
        
        const passwordInput = document.getElementById('login-password');
        const password = passwordInput.value;
        
        if (!password) {
            this.showLoginError('Please enter a password');
            return;
        }
        
        document.body.classList.add('loading');
        this._showLoginLoadingPanel(
            'Opening encrypted workspace…',
            'Checking database version…',
            'Verifying your password, backing up, and upgrading this namespace if needed…',
            5,
        );
        await this._waitForBrowserPaint();

        let response;
        try {
            response = await fetch(CONFIG.API.AUTH.LOGIN, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Metalist-Tab-Id': this._tabId,
                },
                body: JSON.stringify({ password })
            });
        } catch (error) {
            rethrowUnexpectedError(error);
            document.body.classList.remove('loading');
            this.showLoginModal();
            if (error instanceof Error) {
                this.showLoginError(`Login request failed: ${error.message}`);
                throw error;
            }
            this.showLoginError('Login request failed');
            throw new Error('Login request failed');
        }

        if (!response.ok) {
            const fallbackPrefix = response.status >= 500
                ? 'Database check or login failed on the server'
                : 'Login failed';
            const errorDetail = await this._readResponseDetail(response, fallbackPrefix);
            document.body.classList.remove('loading');
            this.showLoginModal();
            this.showLoginError(errorDetail);
            return;
        }

        const responseText = await response.text();
        let startupPhase = 'reading the login response';
        try {
            const data = JSON.parse(responseText);

            if (!data || typeof data !== 'object') {
                throw new Error('Login response missing body');
            }
            console.log('[Auth] Login successful');

            if (data.hydration_required !== true) {
                throw new Error('Login response must require the progress flow');
            }
            startupPhase = 'hydrating the workspace';
            await this._runHydrationFlow();

            console.log('[Auth] Login successful, initializing ModeManager');
            if (window.ModeManager) {
                startupPhase = 'initializing the workspace UI';
                await window.ModeManager.init({});
                startupPhase = 'initializing the command palette';
                await CommandPalette.init();
                startupPhase = 'initializing AI chat';
                await AiChatPanel.init({
                    getSettings: () => CommandPalette.getAiSettings(),
                    saveSettings: (settings) => CommandPalette.saveAiSettings(settings),
                    getPanelWidth: () => CommandPalette.getAiChatPanelWidth(),
                    savePanelWidth: (width) => CommandPalette.saveAiChatPanelWidth(width),
                    getDiagnosticsVisible: () => CommandPalette.getAiChatDiagnosticsVisible(),
                    saveDiagnosticsVisible: (isVisible) => CommandPalette.saveAiChatDiagnosticsVisible(isVisible),
                    getComposerHeight: () => CommandPalette.getAiChatComposerHeight(),
                    saveComposerHeight: (height) => CommandPalette.saveAiChatComposerHeight(height),
                    setVisible: (isVisible) => CommandPalette.applyPreference('pref.show_ai_chat', isVisible),
                    openSettings: () => CommandPalette.openAiAgentSettings(),
                });
                startupPhase = 'finishing the startup introduction';
                await this.waitForStartupIntro();
                startupPhase = 'revealing the workspace';
                this.revealMainApp();
                startupPhase = 'starting reminders';
                await ReminderSurface.start();
                document.body.dataset.appReady = 'true';
                CommandPalette.notifyAppUpdate();
            } else {
                startupPhase = 'reloading the workspace';
                window.location.reload();
            }
        } catch (error) {
            rethrowUnexpectedError(error);
            document.body.classList.remove('loading');
            this._setLoginLoadingTitle('Workspace startup failed');
            const loadingMessage = this._requireElement('login-loading-message');
            const errorMessage = error instanceof Error
                ? `${error.name}: ${error.message}`
                : `Non-Error thrown: ${String(error)}`;
            const diagnosticMessage = `${startupPhase}: ${errorMessage}`;
            loadingMessage.textContent =
                `Your password was accepted, but the workspace could not finish opening. ${diagnosticMessage}`;
            if (error instanceof Error) {
                throw error;
            }
            throw new Error(errorMessage);
        }
        document.body.classList.remove('loading');
    },
    
    /**
     * Handle logout
     */
    async logout() {
        await fetch(CONFIG.API.AUTH.LOGOUT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Metalist-Tab-Id': this._tabId,
            }
        }).finally(() => {
            this.clearSessionState();
            window.location.reload();
        });
    },

    clearSessionState() {
        closeAllFloatingNotes();
        clearLegacyAuthStorage();
        sessionStorage.removeItem('metalist_client_id');
    },

    forceLogout(message) {
        if (typeof message !== 'string' || message.length === 0) {
            throw new Error('Auth.forceLogout requires message string');
        }
        if (this._forcingLogout) {
            return;
        }
        this._forcingLogout = true;
        console.warn('[Auth] Forcing logout:', message);
        this.clearSessionState();

        if (document.body) {
            document.body.replaceChildren();
        }

        window.location.replace('/locked');
    },

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Login form submission
        const loginForm = document.getElementById('login-form');
        if (loginForm) {
            loginForm.addEventListener('submit', (e) => this.handleLogin(e));
        }

        const namespaceSelect = document.getElementById('login-namespace-select');
        if (namespaceSelect) {
            namespaceSelect.addEventListener('change', (event) => {
                void this.handleLoginNamespaceChange(event);
            });
        }
        
        // Close modal when clicking outside
        window.addEventListener('click', (event) => {
            const loginModal = document.getElementById('login-modal');
            if (event.target === loginModal) {
                // Don't allow closing login modal by clicking outside if auth is required
                // this.hideLoginModal();
            }
        });
        
        // ESC key to close modal (but only if auth is not required)
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                // Don't close login modal with ESC if auth is required
                // this.hideLoginModal();
            }
        });

    },

    _ensureTabId() {
        if (this._tabId) {
            return;
        }
        let tabId = sessionStorage.getItem('metalist_tab_id');
        if (!tabId) {
            tabId = createUuid();
            sessionStorage.setItem('metalist_tab_id', tabId);
        }
        this._tabId = tabId;
    }
};

// Make showLoginModal available globally for API client
window.showLoginModal = () => Auth.showLoginModal();
ApplicationState.own(Auth, 'Auth', true);
window.Auth = Auth;
