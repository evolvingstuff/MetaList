import { UserInputRejected, HttpRequestError } from '../expected-errors.js';
import { ApplicationState } from '../application-state.js';
import { BaseModal } from './base-modal.js';
import { CONFIG } from '../config.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { ErrorHandler } from '../error-handler.js';
import { settleResult } from '../async-result.js';
import {
    navigateNamespaceInNewTab,
    openPendingNamespaceTab,
    rewriteNamespaceUrlPreservingCurrentHost,
} from '../login-namespace-picker.js';
import { buildSessionHeaders } from '../session-auth.js';
import { renderNamespaceLoadingTab } from './namespace-loading-page.js';
import { selectNamespacePortsEditorProfile } from './namespace-ports-profile.js';
import { buildNamespaceRenamePayload } from './namespace-rename-validation.js';


const NAMESPACE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;


function parseResponseError(responseBody, statusCode) {
    if (responseBody && typeof responseBody === 'object') {
        if (typeof responseBody.detail === 'string' && responseBody.detail.length > 0) {
            return `Request failed (${statusCode}): ${responseBody.detail}`;
        }
        if (typeof responseBody.message === 'string' && responseBody.message.length > 0) {
            return `Request failed (${statusCode}): ${responseBody.message}`;
        }
    }
    return `Request failed (${statusCode})`;
}


function stringifyPort(portValue) {
    if (portValue === null) {
        return '';
    }
    if (!Number.isInteger(portValue)) {
        throw new Error('stringifyPort requires integer or null');
    }
    return String(portValue);
}


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


function assertCatalogShape(catalog) {
    if (!catalog || typeof catalog !== 'object') {
        throw new Error('Namespace catalog response missing body');
    }
    if (!Array.isArray(catalog.namespaces)) {
        throw new Error('Namespace catalog response missing namespaces');
    }
    if (!catalog.new_namespace_profile || typeof catalog.new_namespace_profile !== 'object') {
        throw new Error('Namespace catalog response missing new_namespace_profile');
    }
}


function assertProfileShape(profile) {
    if (!profile || typeof profile !== 'object') {
        throw new Error('Namespace profile missing');
    }
    if (!Number.isInteger(profile.port)) {
        throw new Error('Namespace profile missing port');
    }
    if (profile.https_port !== null && !Number.isInteger(profile.https_port)) {
        throw new Error('Namespace profile missing https_port');
    }
}


function parsePort(rawValue, label) {
    if (typeof rawValue !== 'string') {
        throw new UserInputRejected(`${label} is required`);
    }
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
        throw new UserInputRejected(`${label} is required`);
    }
    if (!/^[0-9]+$/.test(trimmed)) {
        throw new UserInputRejected(`${label} must be numeric`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new UserInputRejected(`${label} must be between 1 and 65535`);
    }
    return parsed;
}


function profilePayloadFromEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        throw new Error('Namespace entry missing');
    }
    const namespace = entry.namespace;
    if (typeof namespace !== 'string' || namespace.length === 0) {
        throw new Error('Namespace entry missing namespace');
    }
    const profile = entry.default_profile;
    assertProfileShape(profile);
    return {
        namespace,
        port: profile.port,
        https_port: profile.https_port,
    };
}


function findNamespaceEntry(catalog, namespace) {
    assertCatalogShape(catalog);
    if (typeof namespace !== 'string' || namespace.length === 0) {
        throw new Error('findNamespaceEntry requires namespace');
    }
    const entry = catalog.namespaces.find((candidate) => candidate.namespace === namespace);
    if (!entry) {
        throw new Error(`Unknown namespace: ${namespace}`);
    }
    return entry;
}


function validatePortsDoNotOverlap(portRows) {
    if (!Array.isArray(portRows)) {
        throw new Error('validatePortsDoNotOverlap requires rows array');
    }
    const seenPorts = new Map();
    for (const row of portRows) {
        const localPorts = [
            { label: 'HTTP', value: row.port },
            { label: 'HTTPS', value: row.https_port },
        ];
        for (const localPort of localPorts) {
            if (localPort.value === null) {
                continue;
            }
            if (seenPorts.has(localPort.value)) {
                const other = seenPorts.get(localPort.value);
                throw new Error(
                    `${localPort.label} port ${localPort.value} for ${row.namespace} conflicts with `
                    + `${other.label} port for ${other.namespace}`
                );
            }
            seenPorts.set(localPort.value, {
                namespace: row.namespace,
                label: localPort.label,
            });
        }
    }
}


function renderLoadingModal({ title, status, error, cancelId }) {
    return `
        <div class="modal-content namespace-modal-content">
            <h3>${escapeHtml(title)}</h3>
            <p class="namespace-modal-status">${escapeHtml(status)}</p>
            <div class="form-actions namespace-modal-actions">
                <button type="button" class="secondary-btn" id="${escapeHtml(cancelId)}">Cancel</button>
            </div>
            <p class="error-message" ${error.length === 0 ? 'style="display:none;"' : ''}>${escapeHtml(error)}</p>
        </div>
    `;
}


class NamespaceModalBase extends BaseModal {
    constructor(modalName, modalElementId) {
        super(modalName, modalElementId);
        this.apiEndpoints = {
            list: CONFIG.API.AUTH.NAMESPACES.LIST,
            open: CONFIG.API.AUTH.NAMESPACES.OPEN,
            savePorts: CONFIG.API.AUTH.NAMESPACES.SAVE_PORTS,
            renameCurrent: CONFIG.API.AUTH.NAMESPACES.RENAME_CURRENT,
        };

        ApplicationState.own(this, 'NamespaceModalBase', new.target === NamespaceModalBase);
    }

    shouldCloseOnClickOutside() {
        return true;
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

    onClose() {
        this.updateModalState(this.getInitialModalState());
    }

    handleKeyDown(event) {
        const topModal = ModeContext.topModal;
        if (topModal !== this.modalName) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.close();
            return;
        }

        if (event.key !== 'Enter') {
            return;
        }
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLButtonElement || activeElement instanceof HTMLTextAreaElement) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        void this.handleSubmit();
    }

    _renderIntoModal(html) {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }
        modalElement.innerHTML = html;
    }

    _wireCancelButton(id) {
        const cancelButton = document.getElementById(id);
        if (cancelButton instanceof HTMLButtonElement) {
            cancelButton.onclick = () => this.close();
        }
    }

    _buildAuthHeaders(includeContentType) {
        return buildSessionHeaders(includeContentType);
    }

    async _authRequest(url, method, bodyObject) {
        if (typeof url !== 'string' || url.length === 0) {
            throw new Error('_authRequest requires url string');
        }
        if (typeof method !== 'string' || method.length === 0) {
            throw new Error('_authRequest requires method string');
        }
        if (bodyObject !== null && typeof bodyObject !== 'object') {
            throw new Error('_authRequest bodyObject must be object or null');
        }

        const hasBody = bodyObject !== null;
        const response = await fetch(url, {
            method,
            headers: this._buildAuthHeaders(hasBody),
            body: hasBody ? JSON.stringify(bodyObject) : undefined,
        });

        let payload = null;
        const contentType = response.headers.get('content-type');
        if (typeof contentType === 'string' && contentType.includes('application/json')) {
            payload = await response.json();
        }

        if (!response.ok) {
            throw new HttpRequestError(parseResponseError(payload, response.status));
        }
        return payload;
    }

    _renderLoading(title, cancelId) {
        const state = this.getModalState();
        const status = typeof state.status === 'string' ? state.status : '';
        const error = typeof state.error === 'string' ? state.error : '';
        this._renderIntoModal(renderLoadingModal({ title, status, error, cancelId }));
        this._wireCancelButton(cancelId);
    }
}


export class SwitchNamespaceModal extends NamespaceModalBase {
    constructor() {
        super('switchNamespaceModal', 'switch-namespace-modal');

        ApplicationState.own(this, 'SwitchNamespaceModal', new.target === SwitchNamespaceModal);
    }

    getInitialModalState() {
        return {
            loading: false,
            submitting: false,
            catalog: null,
            selectedNamespace: '',
            error: '',
            status: 'Loading namespaces...',
        };
    }

    async onOpen() {
        await this.loadCatalog();
    }

    renderModalContent() {
        const state = this.getModalState();
        const loading = Boolean(state.loading);
        const submitting = Boolean(state.submitting);
        const catalog = state.catalog;
        const selectedNamespace = typeof state.selectedNamespace === 'string' ? state.selectedNamespace : '';
        const error = typeof state.error === 'string' ? state.error : '';
        const status = typeof state.status === 'string' ? state.status : '';

        if (loading || !catalog) {
            this._renderLoading('Switch Namespace', 'switch-namespace-cancel-loading-btn');
            return;
        }

        assertCatalogShape(catalog);
        const rowsHtml = catalog.namespaces.map((entry) => {
            const namespace = entry.namespace;
            if (typeof namespace !== 'string' || namespace.length === 0) {
                throw new Error('Namespace catalog entry missing namespace');
            }
            const checked = namespace === selectedNamespace ? 'checked' : '';
            const currentBadge = entry.is_current === true ? '<span class="namespace-modal-badge">Current</span>' : '';
            return `
                <label class="namespace-modal-radio-row">
                    <input type="radio" name="switch-namespace-choice" value="${escapeHtml(namespace)}" ${checked} ${submitting ? 'disabled' : ''}>
                    <span>${escapeHtml(namespace)}</span>
                    ${currentBadge}
                </label>
            `;
        }).join('');

        const selectedEntry = findNamespaceEntry(catalog, selectedNamespace);
        const isCurrentSelection = selectedEntry.is_current === true;
        this._renderIntoModal(`
            <div class="modal-content namespace-modal-content switch-namespace-modal-content">
                <h3>Switch Namespace</h3>
                <div class="namespace-modal-list">${rowsHtml}</div>
                <div class="form-actions namespace-modal-actions">
                    <button type="button" class="primary-btn" id="switch-namespace-submit-btn" ${submitting || isCurrentSelection ? 'disabled' : ''}>Switch to Namespace</button>
                    <button type="button" class="secondary-btn" id="switch-namespace-cancel-btn" ${submitting ? 'disabled' : ''}>Cancel</button>
                </div>
                <p class="namespace-modal-status">${escapeHtml(status)}</p>
                <p class="error-message" ${error.length === 0 ? 'style="display:none;"' : ''}>${escapeHtml(error)}</p>
            </div>
        `);
        this.setupFormEventListeners();
    }

    setupFormEventListeners() {
        const inputs = document.querySelectorAll('input[name="switch-namespace-choice"]');
        inputs.forEach((input) => {
            if (!(input instanceof HTMLInputElement)) {
                return;
            }
            input.onchange = () => {
                this.updateModalState({
                    selectedNamespace: input.value,
                    error: '',
                    status: '',
                });
                this.renderModalContent();
            };
        });

        const submitButton = document.getElementById('switch-namespace-submit-btn');
        if (submitButton instanceof HTMLButtonElement) {
            submitButton.onclick = async () => {
                await this.handleSubmit();
            };
        }
        this._wireCancelButton('switch-namespace-cancel-btn');
    }

    async loadCatalog() {
        this.updateModalState({
            loading: true,
            submitting: false,
            error: '',
            status: 'Loading namespaces...',
        });
        this.renderModalContent();
        const catalogResult = await settleResult(async () => {
            const catalog = await this._authRequest(this.apiEndpoints.list, 'GET', null);
            assertCatalogShape(catalog);
            const selectedNamespace = catalog.current_namespace;
            if (typeof selectedNamespace !== 'string' || selectedNamespace.length === 0) {
                throw new Error('Namespace catalog missing current namespace');
            }
            this.updateModalState({
                loading: false,
                catalog,
                selectedNamespace,
                error: '',
                status: '',
            });
        });
        if (!catalogResult.ok) {
            const error = catalogResult.error;
            const message = error instanceof Error ? error.message : 'Failed to load namespaces';
            this.updateModalState({
                loading: false,
                error: message,
                status: '',
            });
        }
        this.renderModalContent();
    }

    async handleSubmit() {
        const state = this.getModalState();
        const catalog = state.catalog;
        const selectedNamespace = typeof state.selectedNamespace === 'string' ? state.selectedNamespace : '';
        const payloadResult = await settleResult(() => {
            const entry = findNamespaceEntry(catalog, selectedNamespace);
            if (entry.is_current === true) {
                throw new UserInputRejected('Select a different namespace');
            }
            return profilePayloadFromEntry(entry);
        });
        if (!payloadResult.ok) {
            const error = payloadResult.error;
            const message = error instanceof Error ? error.message : 'Invalid namespace selection';
            this.updateModalState({ error: message, status: '' });
            this.renderModalContent();
            return;
        }
        const payload = payloadResult.value;
        const pendingTabResult = await settleResult(() => {
            const tab = openPendingNamespaceTab(window);
            renderNamespaceLoadingTab(tab, payload.namespace);
            return tab;
        });
        if (!pendingTabResult.ok) {
            const error = pendingTabResult.error;
            const message = error instanceof Error ? error.message : 'Failed to open namespace tab';
            this.updateModalState({ error: message, status: '' });
            this.renderModalContent();
            return;
        }
        const pendingTab = pendingTabResult.value;
        this.updateModalState({
            submitting: true,
            error: '',
            status: 'Opening namespace...',
        });
        this.renderModalContent();

        const switchResult = await settleResult(async () => {
            const response = await this._authRequest(this.apiEndpoints.open, 'POST', payload);
            if (!response || typeof response !== 'object') {
                throw new Error('Namespace open response missing body');
            }
            if (typeof response.url !== 'string' || response.url.length === 0) {
                throw new Error('Namespace open response missing url');
            }
            navigateNamespaceInNewTab(response.url, window, pendingTab);
            this.close();
        });
        if (!switchResult.ok) {
            if (!pendingTab.closed) {
                pendingTab.close();
            }
            const error = switchResult.error;
            const message = error instanceof Error ? error.message : 'Failed to switch namespace';
            this.updateModalState({
                submitting: false,
                error: message,
                status: '',
            });
            this.renderModalContent();
        }
    }
}


export class CreateNamespaceModal extends NamespaceModalBase {
    constructor() {
        super('createNamespaceModal', 'create-namespace-modal');

        ApplicationState.own(this, 'CreateNamespaceModal', new.target === CreateNamespaceModal);
    }

    getInitialModalState() {
        return {
            loading: false,
            submitting: false,
            catalog: null,
            namespace: '',
            port: '',
            httpsPort: '',
            error: '',
            status: 'Loading namespace defaults...',
        };
    }

    async onOpen() {
        await this.loadCatalog();
    }

    renderModalContent() {
        const state = this.getModalState();
        const loading = Boolean(state.loading);
        const submitting = Boolean(state.submitting);
        const catalog = state.catalog;
        const namespace = typeof state.namespace === 'string' ? state.namespace : '';
        const port = typeof state.port === 'string' ? state.port : '';
        const httpsPort = typeof state.httpsPort === 'string' ? state.httpsPort : '';
        const error = typeof state.error === 'string' ? state.error : '';
        const status = typeof state.status === 'string' ? state.status : '';

        if (loading || !catalog) {
            this._renderLoading('Create Namespace', 'create-namespace-cancel-loading-btn');
            return;
        }

        const supportsHttps = Boolean(catalog.supports_https);
        this._renderIntoModal(`
            <div class="modal-content namespace-modal-content create-namespace-modal-content">
                <h3>Create Namespace</h3>
                <div class="form-group">
                    <label for="create-namespace-name">Namespace Name</label>
                    <input id="create-namespace-name" type="text" value="${escapeHtml(namespace)}" placeholder="work" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ${submitting ? 'disabled' : ''}>
                </div>
                <div class="namespace-modal-port-grid">
                    <div class="form-group">
                        <label for="create-namespace-http-port">HTTP Port</label>
                        <input id="create-namespace-http-port" type="number" min="1" max="65535" value="${escapeHtml(port)}" ${submitting ? 'disabled' : ''}>
                    </div>
                    ${supportsHttps ? `
                        <div class="form-group">
                            <label for="create-namespace-https-port">HTTPS Port</label>
                            <input id="create-namespace-https-port" type="number" min="1" max="65535" value="${escapeHtml(httpsPort)}" ${submitting ? 'disabled' : ''}>
                        </div>
                    ` : ''}
                </div>
                <div class="form-actions namespace-modal-actions">
                    <button type="button" class="primary-btn" id="create-namespace-submit-btn" ${submitting ? 'disabled' : ''}>Create and Open Namespace</button>
                    <button type="button" class="secondary-btn" id="create-namespace-cancel-btn" ${submitting ? 'disabled' : ''}>Cancel</button>
                </div>
                <p class="namespace-modal-status">${escapeHtml(status)}</p>
                <p class="error-message" ${error.length === 0 ? 'style="display:none;"' : ''}>${escapeHtml(error)}</p>
            </div>
        `);
        this.setupFormEventListeners();
    }

    setupFormEventListeners() {
        this._wireTextInput('create-namespace-name', 'namespace');
        this._wireTextInput('create-namespace-http-port', 'port');
        this._wireTextInput('create-namespace-https-port', 'httpsPort');

        const submitButton = document.getElementById('create-namespace-submit-btn');
        if (submitButton instanceof HTMLButtonElement) {
            submitButton.onclick = async () => {
                await this.handleSubmit();
            };
        }
        this._wireCancelButton('create-namespace-cancel-btn');
    }

    _wireTextInput(elementId, stateKey) {
        const input = document.getElementById(elementId);
        if (input instanceof HTMLInputElement) {
            input.oninput = () => {
                this.updateModalState({
                    [stateKey]: input.value,
                    error: '',
                    status: '',
                });
            };
        }
    }

    async loadCatalog() {
        this.updateModalState({
            loading: true,
            submitting: false,
            error: '',
            status: 'Loading namespace defaults...',
        });
        this.renderModalContent();
        const catalogResult = await settleResult(async () => {
            const catalog = await this._authRequest(this.apiEndpoints.list, 'GET', null);
            assertCatalogShape(catalog);
            const profile = catalog.new_namespace_profile;
            assertProfileShape(profile);
            this.updateModalState({
                loading: false,
                catalog,
                namespace: '',
                port: stringifyPort(profile.port),
                httpsPort: stringifyPort(profile.https_port),
                error: '',
                status: '',
            });
        });
        if (!catalogResult.ok) {
            const error = catalogResult.error;
            const message = error instanceof Error ? error.message : 'Failed to load namespace defaults';
            this.updateModalState({
                loading: false,
                error: message,
                status: '',
            });
        }
        this.renderModalContent();
    }

    _validateSubmission() {
        const state = this.getModalState();
        const catalog = state.catalog;
        assertCatalogShape(catalog);
        const namespace = typeof state.namespace === 'string' ? state.namespace.trim() : '';
        if (namespace.length === 0) {
            throw new UserInputRejected('Enter a namespace name');
        }
        if (!NAMESPACE_PATTERN.test(namespace)) {
            throw new UserInputRejected("Namespace must contain only lowercase letters, digits, and '-'");
        }
        if (catalog.namespaces.find((entry) => entry.namespace === namespace)) {
            throw new UserInputRejected('That namespace already exists');
        }

        const payload = {
            namespace,
            port: parsePort(state.port, 'HTTP port'),
            https_port: Boolean(catalog.supports_https) ? parsePort(state.httpsPort, 'HTTPS port') : null,
        };
        validatePortsDoNotOverlap([payload]);
        return payload;
    }

    async handleSubmit() {
        const payloadResult = await settleResult(() => this._validateSubmission());
        if (!payloadResult.ok) {
            const error = payloadResult.error;
            const message = error instanceof Error ? error.message : 'Invalid namespace settings';
            this.updateModalState({ error: message, status: '' });
            this.renderModalContent();
            return;
        }
        const payload = payloadResult.value;
        const pendingTab = window.open('about:blank', '_blank');
        renderNamespaceLoadingTab(pendingTab, payload.namespace);
        this.updateModalState({
            submitting: true,
            error: '',
            status: 'Creating namespace...',
        });
        this.renderModalContent();

        const createResult = await settleResult(async () => {
            const response = await this._authRequest(this.apiEndpoints.open, 'POST', payload);
            if (!response || typeof response !== 'object') {
                throw new Error('Namespace create response missing body');
            }
            if (typeof response.url !== 'string' || response.url.length === 0) {
                throw new Error('Namespace create response missing url');
            }
            const navigationUrl = rewriteNamespaceUrlPreservingCurrentHost(response.url, window.location);
            if (pendingTab && !pendingTab.closed) {
                pendingTab.location.replace(navigationUrl);
            } else {
                window.open(navigationUrl, '_blank', 'noopener,noreferrer');
            }
            this.close();
        });
        if (!createResult.ok) {
            if (pendingTab && !pendingTab.closed) {
                pendingTab.close();
            }
            const error = createResult.error;
            const message = error instanceof Error ? error.message : 'Failed to create namespace';
            this.updateModalState({
                submitting: false,
                error: message,
                status: '',
            });
            this.renderModalContent();
        }
    }
}


export class RenameNamespaceModal extends NamespaceModalBase {
    constructor() {
        super('renameNamespaceModal', 'rename-namespace-modal');

        ApplicationState.own(this, 'RenameNamespaceModal', new.target === RenameNamespaceModal);
    }

    getInitialModalState() {
        return {
            loading: false,
            submitting: false,
            catalog: null,
            targetNamespace: '',
            error: '',
            status: 'Loading namespace...',
        };
    }

    async onOpen() {
        await this.loadCatalog();
    }

    renderModalContent() {
        const state = this.getModalState();
        const catalog = state.catalog;
        if (Boolean(state.loading) || !catalog) {
            this._renderLoading('Rename Current Namespace', 'rename-namespace-cancel-loading-btn');
            return;
        }
        assertCatalogShape(catalog);
        const currentNamespace = catalog.current_namespace;
        if (typeof currentNamespace !== 'string' || currentNamespace.length === 0) {
            throw new Error('Namespace catalog missing current_namespace');
        }
        const submitting = Boolean(state.submitting);
        const targetNamespace = typeof state.targetNamespace === 'string' ? state.targetNamespace : '';
        const error = typeof state.error === 'string' ? state.error : '';
        const status = typeof state.status === 'string' ? state.status : '';
        this._renderIntoModal(`
            <div class="modal-content namespace-modal-content create-namespace-modal-content">
                <h3>Rename Current Namespace</h3>
                <p>Rename <strong>${escapeHtml(currentNamespace)}</strong>. Its database, files, backups, and saved ports move together.</p>
                <p>MetaList will restart this namespace on the same ports and ask you to log in again.</p>
                <div class="form-group">
                    <label for="rename-namespace-name">New Namespace Name</label>
                    <input id="rename-namespace-name" type="text" value="${escapeHtml(targetNamespace)}" placeholder="personal" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ${submitting ? 'disabled' : ''}>
                </div>
                <div class="form-actions namespace-modal-actions">
                    <button type="button" class="primary-btn" id="rename-namespace-submit-btn" ${submitting ? 'disabled' : ''}>Rename and Restart</button>
                    <button type="button" class="secondary-btn" id="rename-namespace-cancel-btn" ${submitting ? 'disabled' : ''}>Cancel</button>
                </div>
                <p class="namespace-modal-status">${escapeHtml(status)}</p>
                <p class="error-message" ${error.length === 0 ? 'style="display:none;"' : ''}>${escapeHtml(error)}</p>
            </div>
        `);
        this.setupFormEventListeners();
    }

    setupFormEventListeners() {
        const input = document.getElementById('rename-namespace-name');
        if (input instanceof HTMLInputElement) {
            input.oninput = () => this.updateModalState({
                targetNamespace: input.value,
                error: '',
                status: '',
            });
        }
        const submitButton = document.getElementById('rename-namespace-submit-btn');
        if (submitButton instanceof HTMLButtonElement) {
            submitButton.onclick = async () => this.handleSubmit();
        }
        this._wireCancelButton('rename-namespace-cancel-btn');
    }

    async loadCatalog() {
        this.updateModalState({
            loading: true,
            submitting: false,
            error: '',
            status: 'Loading namespace...',
        });
        this.renderModalContent();
        const result = await settleResult(async () => {
            const catalog = await this._authRequest(this.apiEndpoints.list, 'GET', null);
            assertCatalogShape(catalog);
            this.updateModalState({
                loading: false,
                catalog,
                targetNamespace: '',
                error: '',
                status: '',
            });
        });
        if (!result.ok) {
            const error = result.error;
            this.updateModalState({
                loading: false,
                error: error instanceof Error ? error.message : 'Failed to load namespace',
                status: '',
            });
        }
        this.renderModalContent();
    }

    _validateSubmission() {
        const state = this.getModalState();
        const catalog = state.catalog;
        assertCatalogShape(catalog);
        const currentNamespace = catalog.current_namespace;
        if (typeof currentNamespace !== 'string' || currentNamespace.length === 0) {
            throw new Error('Namespace catalog missing current_namespace');
        }
        const existingNamespaces = catalog.namespaces.map((entry) => {
            if (!entry || typeof entry !== 'object' || typeof entry.namespace !== 'string') {
                throw new Error('Namespace catalog entry missing namespace');
            }
            return entry.namespace;
        });
        return buildNamespaceRenamePayload({
            currentNamespace,
            targetNamespace: state.targetNamespace,
            existingNamespaces,
        });
    }

    async handleSubmit() {
        const payloadResult = await settleResult(() => this._validateSubmission());
        if (!payloadResult.ok) {
            const error = payloadResult.error;
            this.updateModalState({
                error: error instanceof Error ? error.message : 'Invalid namespace name',
                status: '',
            });
            this.renderModalContent();
            return;
        }
        this.updateModalState({ submitting: true, error: '', status: 'Preparing namespace rename...' });
        this.renderModalContent();
        const result = await settleResult(async () => {
            const response = await this._authRequest(
                this.apiEndpoints.renameCurrent,
                'POST',
                payloadResult.value,
            );
            if (!response || typeof response !== 'object') {
                throw new Error('Namespace rename response missing body');
            }
            if (typeof response.redirect_url !== 'string' || response.redirect_url.length === 0) {
                throw new Error('Namespace rename response missing redirect_url');
            }
            window.location.assign(response.redirect_url);
        });
        if (!result.ok) {
            const error = result.error;
            this.updateModalState({
                submitting: false,
                error: error instanceof Error ? error.message : 'Failed to rename namespace',
                status: '',
            });
            this.renderModalContent();
        }
    }
}


export class ManageNamespacePortsModal extends NamespaceModalBase {
    constructor() {
        super('manageNamespacePortsModal', 'manage-namespace-ports-modal');

        ApplicationState.own(this, 'ManageNamespacePortsModal', new.target === ManageNamespacePortsModal);
    }

    getInitialModalState() {
        return {
            loading: false,
            saving: false,
            catalog: null,
            rows: [],
            error: '',
            status: 'Loading namespace ports...',
        };
    }

    async onOpen() {
        await this.loadCatalog();
    }

    renderModalContent() {
        const state = this.getModalState();
        const loading = Boolean(state.loading);
        const saving = Boolean(state.saving);
        const catalog = state.catalog;
        const rows = Array.isArray(state.rows) ? state.rows : [];
        const error = typeof state.error === 'string' ? state.error : '';
        const status = typeof state.status === 'string' ? state.status : '';

        if (loading || !catalog) {
            this._renderLoading('Manage Namespace Ports', 'manage-namespace-ports-cancel-loading-btn');
            return;
        }

        assertCatalogShape(catalog);
        const supportsHttps = Boolean(catalog.supports_https);
        const rowsHtml = rows.map((row) => {
            const currentBadge = row.is_current === true ? '<span class="namespace-modal-badge">Current</span>' : '';
            const note = row.is_current === true ? 'Next launch' : '';
            return `
                <tr>
                    <th scope="row">
                        <div class="namespace-ports-name-cell">
                            <span>${escapeHtml(row.namespace)}</span>
                            ${currentBadge}
                        </div>
                    </th>
                    <td><input class="namespace-ports-input" data-namespace="${escapeHtml(row.namespace)}" data-field="port" type="number" min="1" max="65535" value="${escapeHtml(row.port)}" ${saving ? 'disabled' : ''}></td>
                    ${supportsHttps ? `<td><input class="namespace-ports-input" data-namespace="${escapeHtml(row.namespace)}" data-field="httpsPort" type="number" min="1" max="65535" value="${escapeHtml(row.httpsPort)}" ${saving ? 'disabled' : ''}></td>` : ''}
                    <td>${escapeHtml(note)}</td>
                </tr>
            `;
        }).join('');

        this._renderIntoModal(`
            <div class="modal-content namespace-modal-content namespace-ports-modal-content">
                <h3>Manage Namespace Ports</h3>
                <div class="namespace-ports-table-wrap">
                    <table class="namespace-ports-table">
                        <thead>
                            <tr>
                                <th scope="col">Namespace</th>
                                <th scope="col">HTTP</th>
                                ${supportsHttps ? '<th scope="col">HTTPS</th>' : ''}
                                <th scope="col">Applies</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
                <div class="form-actions namespace-modal-actions">
                    <button type="button" class="primary-btn" id="manage-namespace-ports-save-btn" ${saving ? 'disabled' : ''}>Save Ports</button>
                    <button type="button" class="secondary-btn" id="manage-namespace-ports-cancel-btn" ${saving ? 'disabled' : ''}>Cancel</button>
                </div>
                <p class="namespace-modal-status">${escapeHtml(status)}</p>
                <p class="error-message" ${error.length === 0 ? 'style="display:none;"' : ''}>${escapeHtml(error)}</p>
            </div>
        `);
        this.setupFormEventListeners();
    }

    setupFormEventListeners() {
        const inputs = document.querySelectorAll('.namespace-ports-input');
        inputs.forEach((input) => {
            if (!(input instanceof HTMLInputElement)) {
                return;
            }
            input.oninput = () => {
                this._updateRowDraft(input);
            };
        });

        const saveButton = document.getElementById('manage-namespace-ports-save-btn');
        if (saveButton instanceof HTMLButtonElement) {
            saveButton.onclick = async () => {
                await this.handleSubmit();
            };
        }
        this._wireCancelButton('manage-namespace-ports-cancel-btn');
    }

    _updateRowDraft(input) {
        const namespace = input.dataset.namespace;
        const field = input.dataset.field;
        if (typeof namespace !== 'string' || namespace.length === 0) {
            throw new Error('Port input missing namespace');
        }
        if (field !== 'port' && field !== 'httpsPort') {
            throw new Error('Port input missing field');
        }
        const state = this.getModalState();
        const rows = state.rows.map((row) => {
            if (row.namespace !== namespace) {
                return row;
            }
            return {
                ...row,
                [field]: input.value,
            };
        });
        this.updateModalState({
            rows,
            error: '',
            status: '',
        });
    }

    async loadCatalog() {
        this.updateModalState({
            loading: true,
            saving: false,
            error: '',
            status: 'Loading namespace ports...',
        });
        this.renderModalContent();
        const catalogResult = await settleResult(async () => {
            const catalog = await this._authRequest(this.apiEndpoints.list, 'GET', null);
            const rows = this._buildRowsFromCatalog(catalog);
            this.updateModalState({
                loading: false,
                saving: false,
                catalog,
                rows,
                error: '',
                status: '',
            });
        });
        if (!catalogResult.ok) {
            const error = catalogResult.error;
            const message = error instanceof Error ? error.message : 'Failed to load namespace ports';
            this.updateModalState({
                loading: false,
                saving: false,
                error: message,
                status: '',
            });
        }
        this.renderModalContent();
    }

    _buildRowsFromCatalog(catalog) {
        assertCatalogShape(catalog);
        return catalog.namespaces.map((entry) => {
            const namespace = entry.namespace;
            if (typeof namespace !== 'string' || namespace.length === 0) {
                throw new Error('Namespace catalog entry missing namespace');
            }
            const profile = selectNamespacePortsEditorProfile(entry);
            assertProfileShape(profile);
            return {
                namespace,
                is_current: entry.is_current === true,
                port: stringifyPort(profile.port),
                httpsPort: stringifyPort(profile.https_port),
            };
        });
    }

    _validateSubmission() {
        const state = this.getModalState();
        const catalog = state.catalog;
        assertCatalogShape(catalog);
        const supportsHttps = Boolean(catalog.supports_https);
        const rows = Array.isArray(state.rows) ? state.rows : [];
        if (rows.length === 0) {
            throw new Error('No namespace rows to save');
        }
        const profiles = rows.map((row) => {
            if (typeof row.namespace !== 'string' || row.namespace.length === 0) {
                throw new Error('Namespace row missing name');
            }
            return {
                namespace: row.namespace,
                port: parsePort(row.port, `${row.namespace} HTTP port`),
                https_port: supportsHttps ? parsePort(row.httpsPort, `${row.namespace} HTTPS port`) : null,
            };
        });
        validatePortsDoNotOverlap(profiles);
        return { profiles };
    }

    async handleSubmit() {
        const payloadResult = await settleResult(() => this._validateSubmission());
        if (!payloadResult.ok) {
            const error = payloadResult.error;
            const message = error instanceof Error ? error.message : 'Invalid namespace ports';
            this.updateModalState({ error: message, status: '' });
            this.renderModalContent();
            return;
        }

        this.updateModalState({
            saving: true,
            error: '',
            status: 'Saving namespace ports...',
        });
        this.renderModalContent();

        const saveResult = await settleResult(async () => {
            const response = await this._authRequest(this.apiEndpoints.savePorts, 'POST', payloadResult.value);
            if (!response || typeof response !== 'object') {
                throw new Error('Namespace ports response missing body');
            }
            if (!Array.isArray(response.profiles)) {
                throw new Error('Namespace ports response missing profiles');
            }
            return response;
        });
        if (!saveResult.ok) {
            const error = saveResult.error;
            const message = error instanceof Error ? error.message : 'Failed to save namespace ports';
            this.updateModalState({
                saving: false,
                error: message,
                status: '',
            });
            this.renderModalContent();
            return;
        }

        const response = saveResult.value;
        const statusMessage = typeof response.message === 'string' && response.message.length > 0
            ? response.message
            : 'Saved namespace ports.';
        ErrorHandler.showInfoBanner(statusMessage, 5000);
        await this.loadCatalog();
        this.updateModalState({
            status: statusMessage,
        });
        this.renderModalContent();
    }
}
