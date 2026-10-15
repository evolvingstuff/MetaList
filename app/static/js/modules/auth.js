import { ApplicationState } from './application-state.js';
import { HttpRequestError, rethrowUnexpectedError } from './expected-errors.js';
import { closeAllFloatingNotes } from './mode-manager/services/floating-note-service.js';
/**
 * Authentication module for handling login/logout and password management
 */
import { CONFIG } from './config.js';
import { initializeSessionIdentity, getRequiredTabId } from './session-auth.js';
import { CommandPalette } from './command-palette/command-palette-controller.js';
import { ReminderSurface } from './reminder-surface-service.js';
import { AiChatPanel } from './ai-chat/ai-chat-panel-controller.js';
import { clearLegacyAuthStorage, resolveStoredThemePreference } from './client-state-migration.js';
import { consumeBooleanQueryFlag } from './location-flags.js';
import {
    buildLoginNamespaceStartingNote,
    buildNamespaceLoginUrl,
    buildLoginTitle,
    parseLoginNamespaceCatalog,
} from './login-namespace-picker.js';
import { formatElapsedDuration } from './elapsed-time.js';

// Matches the 350 ms slide in main.css (.login-view-leaving).
const LOGIN_SLIDE_MS = 350;

export const Auth = {
    hasPassword: null,
    _forcingLogout: false,
    // A password change is running: it ends every session itself (see runPasswordChange).
    _isPasswordChanging: false,
    _currentNamespace: null,
    _loginNamespaceRequestId: 0,
    // Hydration progress shown so far: the bar never moves backwards.
    _shownProgressPercent: 0,
    // Seconds shown beside the loading step, counted from when the loading view appears.
    _loadingStartedAt: null,
    _loadingTimerId: null,
    // The next login backs up and upgrades the database (from /auth/status).
    _isUpgradePending: false,
    
    /**
     * Initialize authentication on page load
     * Returns true if OK to proceed with app initialization
     */
    async init() {
        initializeSessionIdentity();
        clearLegacyAuthStorage();
        this.setupEventListeners();
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
        headers['X-Metalist-Tab-Id'] = getRequiredTabId();

        const response = await fetch(CONFIG.API.AUTH.STATUS, { headers });
        if (!response.ok) {
            throw new HttpRequestError(`Status request failed with ${response.status}`);
        }

        const status = await response.json();
        if (this.hasPassword !== Boolean(status.has_password)) this.hasPassword = Boolean(status.has_password);
        if (typeof status.database_upgrade_pending !== 'boolean') {
            throw new Error('Auth status requires database_upgrade_pending');
        }
        if (this._isUpgradePending !== status.database_upgrade_pending) this._isUpgradePending = status.database_upgrade_pending;
        if (this._currentNamespace !== status.namespace) this._setCurrentNamespace(status.namespace);
        this._applyThemePreference(status.client_preferences);
        console.log('[Auth] Status response received');

        if (this.hasPassword) {
            if (!status.authenticated) {
                this.showLoginModal();
                return false;
            }
            return true;
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
                'X-Metalist-Tab-Id': getRequiredTabId()
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
        const loginPage = this._requireElement('login-page');
        const status = this._requireElement('login-namespace-status');
        const hasChoices = switcher.dataset.hasChoices === 'true';
        const shouldShow = (hasChoices || status.hidden === false)
            && loginPage.style.display !== 'none'
            && !this._requireElement('login-form-view').hidden;
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
        message.textContent = '';
        message.dataset.state = 'info';
        bar.style.width = '0%';
        if (this._shownProgressPercent !== 0) this._shownProgressPercent = 0;
    },

    _setLoginProgress(percent) {
        if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
            throw new Error('Auth._setLoginProgress requires an integer percent 0-100');
        }
        // A later phase can report less than an earlier one; the bar holds its place.
        const shown = Math.max(this._shownProgressPercent, percent);
        if (shown !== this._shownProgressPercent) this._shownProgressPercent = shown;
        this._requireElement('login-progress-bar').style.width = `${shown}%`;
    },

    _showLoadingElapsed() {
        if (this._loadingStartedAt === null) {
            throw new Error('The loading time has not started');
        }
        const elapsed = window.performance.now() - this._loadingStartedAt;
        this._requireElement('login-loading-elapsed').textContent = ` · ${formatElapsedDuration(elapsed)}`;
    },

    _startLoadingElapsed() {
        this._stopLoadingElapsed();
        this._loadingStartedAt = window.performance.now();
        this._showLoadingElapsed();
        this._loadingTimerId = window.setInterval(() => this._showLoadingElapsed(), 1000);
    },

    // Stops counting; the last time stays shown (it stays visible after a failure).
    _stopLoadingElapsed() {
        if (this._loadingTimerId === null) {
            return;
        }
        window.clearInterval(this._loadingTimerId);
        this._loadingTimerId = null;
    },

    // The panel under the logo shows the form or the loading progress.
    _showLoginLoadingPanel(message, progressPercent) {
        if (typeof message !== 'string') {
            throw new Error('Auth._showLoginLoadingPanel requires message string');
        }
        this._resetHydrationUI();
        this._slideToLoadingView();
        this._requireElement('login-loading-message').textContent = message;
        this._setLoginProgress(progressPercent);
        this._startLoadingElapsed();
        this._clearLoginError();
        this._syncLoginNamespaceVisibility();
    },

    _showLoginForm() {
        this._stopLoadingElapsed();
        this._requireElement('login-loading-elapsed').textContent = '';
        const formView = this._requireElement('login-form-view');
        const loadingView = this._requireElement('login-loading');
        formView.classList.remove('login-view-leaving');
        loadingView.classList.remove('login-view-entering');
        formView.hidden = false;
        loadingView.hidden = true;
        this._setLoginSubmitBusy(false);
    },

    // The form slides out to the left while the loading view slides in from the
    // right (PLAN.md case 5); with reduced motion, or no form showing, it swaps.
    _slideToLoadingView() {
        const formView = this._requireElement('login-form-view');
        const loadingView = this._requireElement('login-loading');
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        loadingView.hidden = false;
        if (formView.hidden || reducedMotion) {
            formView.hidden = true;
            return;
        }
        formView.classList.add('login-view-leaving');
        loadingView.classList.add('login-view-entering');
        let isFinished = false;
        const finish = () => {
            if (isFinished) {
                return;
            }
            isFinished = true;
            formView.hidden = true;
            formView.classList.remove('login-view-leaving');
            loadingView.classList.remove('login-view-entering');
            this._syncLoginNamespaceVisibility();
        };
        formView.addEventListener('animationend', finish, { once: true });
        // Background tabs may not run the animation; the swap still completes.
        window.setTimeout(finish, LOGIN_SLIDE_MS + 100);
    },

    _setLoginSubmitBusy(isBusy) {
        const button = this._requireElement('login-submit');
        button.disabled = isBusy;
        // A login that upgrades the database takes longer; say why (PLAN.md case 7).
        this._requireElement('login-note').hidden = !(isBusy && this._isUpgradePending);
        if (isBusy) {
            button.textContent = 'Checking…';
            return;
        }
        button.textContent = 'OK';
    },

    async _waitForBrowserPaint() {
        await new Promise((resolveFirstFrame) => {
            window.requestAnimationFrame(resolveFirstFrame);
        });
        await new Promise((resolveSecondFrame) => {
            window.requestAnimationFrame(resolveSecondFrame);
        });
    },

    /**
     * Show the login page and hide main app
     */
    showLoginModal() {
        closeAllFloatingNotes();
        const loginPage = this._requireElement('login-page');
        const mainApp = this._requireElement('main-app');
        const passwordInput = this._requireElement('login-password');

        mainApp.style.display = 'none';
        loginPage.style.display = 'flex';
        this._showLoginForm();
        this._resetHydrationUI();
        this._clearLoginError();
        this._syncLoginNamespaceVisibility();
        void this._loadLoginNamespaceCatalog().then(
            () => this._revealLoginPanel(passwordInput),
            (error) => {
                rethrowUnexpectedError(error);
                const message = error instanceof Error ? error.message : 'Failed to load namespaces';
                this._setLoginNamespaceStatus(message, 'error');
                // Shown anyway, with the error, so the login is never stuck hidden.
                this._revealLoginPanel(passwordInput);
            },
        );
    },

    // Everything under the logo appears together, fading in, once the namespace
    // list is known; later login screens on this page keep it shown.
    _revealLoginPanel(passwordInput) {
        const panel = this._requireElement('login-panel');
        if (panel.dataset.revealed !== 'true') {
            panel.dataset.revealed = 'true';
        }
        passwordInput.focus();
    },

    /**
     * Hide the login page and show main app
     */
    revealMainApp() {
        const loginPage = this._requireElement('login-page');
        const mainApp = this._requireElement('main-app');
        const passwordInput = this._requireElement('login-password');

        this._stopLoadingElapsed();
        loginPage.style.display = 'none';
        mainApp.style.display = 'block';
        this._resetHydrationUI();
        this._clearLoginError();
        this._syncLoginNamespaceVisibility();
        passwordInput.value = '';
    },

    _showHydrationUI() {
        this._showLoginLoadingPanel('', 0);
    },

    _updateHydrationUI(status) {
        const message = this._requireElement('login-loading-message');
        if (typeof status.message !== 'string') {
            throw new Error('Hydration status requires a message string');
        }
        const trimmed = status.message.trim();
        const needsEllipsis = trimmed.length > 0 && !(trimmed.endsWith('...') || trimmed.endsWith('…'));
        message.textContent = needsEllipsis ? `${trimmed}…` : trimmed;
        if (typeof status.overall_percent !== 'number') {
            throw new Error('Hydration status requires overall_percent');
        }
        this._setLoginProgress(Math.min(100, Math.max(0, Math.floor(status.overall_percent))));
    },

    async _runHydrationFlow() {
        this._showHydrationUI();

        const headers = {
            'X-Metalist-Tab-Id': getRequiredTabId(),
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

        // Opened in this tab: the login screen has nothing to keep, and switching back
        // and forth must not pile up tabs (docs/ui/login-screen.md, Switching
        // namespace). Everything under the logo goes at once, so the old name is
        // never seen coming back before that namespace's panel fades in; a line
        // under the logo fades in after a second if it is starting (main.css).
        select.disabled = true;
        this._hideLoginPanelForSwitch(buildLoginNamespaceStartingNote(namespace));

        try {
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

            // A normal history entry: Back returns to this namespace's login screen.
            window.location.assign(buildNamespaceLoginUrl(payload.url, window.location));
        } catch (error) {
            rethrowUnexpectedError(error);
            select.value = this._currentNamespace;
            select.disabled = false;
            this._showLoginPanelAfterSwitch();
            if (error instanceof Error) {
                this._setLoginNamespaceStatus(error.message, 'error');
                throw error;
            }
            this._setLoginNamespaceStatus('Failed to open namespace', 'error');
            throw new Error('Failed to open namespace');
        }
    },
    
    _hideLoginPanelForSwitch(startingNote) {
        if (typeof startingNote !== 'string' || startingNote.length === 0) {
            throw new Error('Auth._hideLoginPanelForSwitch requires the starting note');
        }
        const panel = this._requireElement('login-panel');
        // Not revealed is fully transparent with no transition: gone in this frame.
        if (panel.dataset.revealed !== 'false') panel.dataset.revealed = 'false';
        const note = this._requireElement('login-opening-note');
        note.textContent = startingNote;
        note.hidden = false;
    },

    // The panel fades back in (a refused switch, or Back to this page).
    _showLoginPanelAfterSwitch() {
        const note = this._requireElement('login-opening-note');
        note.hidden = true;
        note.textContent = '';
        const panel = this._requireElement('login-panel');
        if (panel.dataset.revealed !== 'true') panel.dataset.revealed = 'true';
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

        const passwordInput = this._requireElement('login-password');
        const password = passwordInput.value;

        if (!password) {
            this.showLoginError('Please enter a password');
            return;
        }

        // Nothing moves until the password is accepted (PLAN.md, cases 2-4).
        this._clearLoginError();
        this._setLoginSubmitBusy(true);

        let response;
        try {
            response = await fetch(CONFIG.API.AUTH.LOGIN, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Metalist-Tab-Id': getRequiredTabId(),
                },
                body: JSON.stringify({ password })
            });
        } catch (error) {
            rethrowUnexpectedError(error);
            this._rejectLoginAttempt(error instanceof Error ? `Login request failed: ${error.message}` : 'Login request failed');
            if (error instanceof Error) {
                throw error;
            }
            throw new Error('Login request failed');
        }

        if (!response.ok) {
            const fallbackPrefix = response.status >= 500
                ? 'Database check or login failed on the server'
                : 'Login failed';
            this._rejectLoginAttempt(await this._readResponseDetail(response, fallbackPrefix));
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
                    getSpendVisible: () => CommandPalette.getAiChatSpendVisible(),
                    saveSpendVisible: (isVisible) => CommandPalette.saveAiChatSpendVisible(isVisible),
                    getComposerHeight: () => CommandPalette.getAiChatComposerHeight(),
                    saveComposerHeight: (height) => CommandPalette.saveAiChatComposerHeight(height),
                    setVisible: (isVisible) => CommandPalette.applyPreference('pref.show_ai_chat', isVisible),
                    openSettings: () => CommandPalette.openAiAgentSettings(),
                    openMenu: (menuId, scope, signal) => CommandPalette.openAgentMenu(menuId, scope, signal),
                });
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
            this._stopLoadingElapsed();
            const loadingMessage = this._requireElement('login-loading-message');
            const errorMessage = error instanceof Error
                ? `${error.name}: ${error.message}`
                : `Non-Error thrown: ${String(error)}`;
            loadingMessage.dataset.state = 'error';
            loadingMessage.textContent =
                `Your password was accepted, but the workspace could not finish opening. ${startupPhase}: ${errorMessage}`;
            if (error instanceof Error) {
                throw error;
            }
            throw new Error(errorMessage);
        }
    },

    // A refused or failed login: the form stays where it is, with the reason.
    _rejectLoginAttempt(message) {
        const passwordInput = this._requireElement('login-password');
        this._setLoginSubmitBusy(false);
        this.showLoginError(message);
        passwordInput.value = '';
        passwordInput.focus();
    },
    
    /**
     * Handle logout
     */
    async logout() {
        await fetch(CONFIG.API.AUTH.LOGOUT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Metalist-Tab-Id': getRequiredTabId(),
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

    /**
     * Run a password change (add, change, remove). It ends every session on the
     * server, so background requests answered "not logged in" meanwhile are
     * expected: they do not send the page to Session locked, and the dialog then
     * reloads the page into the new state. After a failed change, a lost session
     * locks the page as usual.
     */
    async runPasswordChange(operation) {
        if (typeof operation !== 'function') {
            throw new Error('Auth.runPasswordChange requires an operation');
        }
        if (this._isPasswordChanging) {
            throw new Error('A password change is already running');
        }
        this._isPasswordChanging = true;
        return operation().catch((error) => { // shockharness: ignore[EXC001] reason="the handler only resets state, then rethrows the error unchanged"
            this._isPasswordChanging = false;
            throw error;
        });
    },

    forceLogout(message) {
        if (typeof message !== 'string' || message.length === 0) {
            throw new Error('Auth.forceLogout requires message string');
        }
        if (this._isPasswordChanging) {
            console.log('[Auth] Session ended by the password change; the page reloads into the new state');
            return;
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
            // Back after switching namespace may restore this page as it was left
            // (the dropdown waiting on the switch); it returns ready to use.
            window.addEventListener('pageshow', (event) => {
                if (!event.persisted || this._currentNamespace === null) return;
                namespaceSelect.value = this._currentNamespace;
                namespaceSelect.disabled = false;
                this._setLoginNamespaceStatus('');
                this._showLoginPanelAfterSwitch();
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
};

// Make showLoginModal available globally for API client
window.showLoginModal = () => Auth.showLoginModal();
ApplicationState.own(Auth, 'Auth', true);
window.Auth = Auth;
