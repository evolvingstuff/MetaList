import { BaseModal } from './base-modal.js';
import {
    AiApiError,
    clearOpenAiCredential,
    listAiModels,
    loadOpenAiCredentialStatus,
    pullOllamaModel,
    saveOpenAiCredential,
} from '../ai-chat/ai-chat-api.js';
import {
    getAgentRetrievalSettingsValidationMessage,
    validateAgentRetrievalSettings,
} from '../ai-chat/agent-retrieval-settings.js';
import {
    cloudPrivacyPolicyToTextFields,
    getCloudPrivacyTextFieldsValidationMessage,
    parseCloudPrivacyTextFields,
} from '../ai-chat/cloud-privacy-policy.js';


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


function renderInstalledModelOptions(state) {
    if (!Array.isArray(state.installedModels)) {
        throw new Error('AI settings installed models must be an array');
    }
    if (state.isLoadingModels) {
        return '<option value="">Loading models…</option>';
    }
    if (state.installedModels.length === 0) {
        return '<option value="">No downloaded models</option>';
    }
    const hasSelectedModel = state.installedModels.includes(state.model);
    const placeholderSelected = hasSelectedModel ? '' : 'selected';
    let options = `<option value="" disabled ${placeholderSelected}>Select model</option>`;
    for (const model of state.installedModels) {
        if (typeof model !== 'string' || model === '') {
            throw new Error('AI settings installed model name is invalid');
        }
        const selected = model === state.model ? 'selected' : '';
        options += `<option value="${escapeHtml(model)}" ${selected}>${escapeHtml(model)}</option>`;
    }
    return options;
}


function retrievalStateFields(settings, provider) {
    const validated = validateAgentRetrievalSettings(settings, provider);
    return {
        maxPageApproximateTokens: validated.maxPageApproximateTokens,
        taggingBatchTokens: validated.taggingBatchTokens,
    };
}


function retrievalSettingsKey(provider) {
    if (provider === 'ollama') {
        return 'ollamaRetrievalSettings';
    }
    if (provider === 'openai') {
        return 'openAiRetrievalSettings';
    }
    throw new Error(`Unsupported AI provider: ${provider}`);
}


export class AiAgentSettingsModal extends BaseModal {
    constructor(readSettings, saveSettings) {
        super('aiAgentSettingsModal', 'ai-agent-settings-modal');
        if (typeof readSettings !== 'function') {
            throw new Error('AiAgentSettingsModal requires readSettings');
        }
        if (typeof saveSettings !== 'function') {
            throw new Error('AiAgentSettingsModal requires saveSettings');
        }
        this._readSettings = readSettings;
        this._saveSettings = saveSettings;
    }

    getInitialModalState() {
        const settings = this._readSettings();
        const retrievalSettings = settings.provider === 'openai'
            ? settings.openAiRetrievalSettings
            : settings.ollamaRetrievalSettings;
        return {
            provider: settings.provider,
            model: settings.model,
            ollamaRetrievalSettings: retrievalStateFields(
                settings.ollamaRetrievalSettings,
                'ollama',
            ),
            openAiRetrievalSettings: retrievalStateFields(
                settings.openAiRetrievalSettings,
                'openai',
            ),
            ...cloudPrivacyPolicyToTextFields(settings.cloudPrivacyPolicy),
            ...retrievalStateFields(retrievalSettings, settings.provider),
            installedModels: [],
            isLoadingModels: false,
            isLoadingCredential: false,
            openAiCredentialConfigured: false,
            openAiCredentialPersistent: false,
            downloadModel: '',
            isDownloading: false,
            downloadStatus: '',
            downloadCompleted: 0,
            downloadTotal: 0,
            error: '',
        };
    }

    focusCloudPrivacySettings() {
        if (!this.isOpen) {
            throw new Error('Cloud privacy settings cannot be focused while the modal is closed');
        }
        const fieldset = document.querySelector(
            '#ai-agent-settings-modal .ai-agent-cloud-privacy-settings',
        );
        const firstInput = document.getElementById('ai-agent-cloud-whitelist-tags');
        if (!(fieldset instanceof HTMLElement)) {
            throw new Error('AI settings cloud privacy fieldset missing');
        }
        if (!(firstInput instanceof HTMLTextAreaElement)) {
            throw new Error('AI settings cloud privacy first input missing');
        }
        fieldset.scrollIntoView({ block: 'start' });
        firstInput.focus({ preventScroll: true });
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

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }
        const state = this.getModalState();
        const isOpenAi = state.provider === 'openai';
        if (!isOpenAi && state.provider !== 'ollama') {
            throw new Error(`Unsupported AI provider: ${state.provider}`);
        }
        const disabledAttribute = state.isDownloading ? 'disabled' : '';
        const maximumPageApproximateTokens = isOpenAi ? 500000 : 24000;
        const progressHiddenAttribute = state.downloadTotal > 0 ? '' : 'hidden';
        const progressMaximum = state.downloadTotal > 0 ? state.downloadTotal : 1;
        const installedModelOptions = renderInstalledModelOptions(state);
        const modelSelectDisabled = (
            state.isDownloading
            || state.isLoadingModels
            || state.installedModels.length === 0
        ) ? 'disabled' : '';
        const saveDisabled = (
            state.isDownloading
            || state.isLoadingModels
        ) ? 'disabled' : '';
        const ollamaSelected = isOpenAi ? '' : 'selected';
        const openAiSelected = isOpenAi ? 'selected' : '';
        const runtimeMarkup = isOpenAi ? `
            <div class="ai-agent-managed-runtime" role="status">
                <span>Connection</span>
                <strong>OpenAI API</strong>
                <small>Official API · requests are sent with store disabled</small>
            </div>
        ` : `
            <div class="ai-agent-managed-runtime" role="status">
                <span>Runtime</span>
                <strong>MetaList-managed Ollama</strong>
                <small>Loopback only · 32,768-token context</small>
            </div>
        `;
        const credentialStatus = state.openAiCredentialPersistent
            ? 'Configured · encrypted in this namespace'
            : (state.openAiCredentialConfigured
                ? 'Configured · session only'
                : 'Not configured');
        const credentialControlsDisabled = (
            state.isDownloading || state.isLoadingCredential
        ) ? 'disabled' : '';
        const saveCredentialDisabled = (
            state.isDownloading
            || state.isLoadingCredential
        ) ? 'disabled' : '';
        const providerSpecificMarkup = isOpenAi ? `
            <section class="ai-agent-model-download" aria-labelledby="ai-agent-openai-title">
                <h3 id="ai-agent-openai-title">OpenAI API key</h3>
                <p>
                    The key is sent only to the MetaList server. Encrypted namespaces
                    persist it encrypted; unencrypted namespaces keep it for this
                    server session only.
                </p>
                <div class="ai-agent-model-download-row">
                    <label for="ai-agent-openai-api-key">
                        <span>API key</span>
                        <input id="ai-agent-openai-api-key" type="password" value="" placeholder="${escapeHtml(credentialStatus)}" maxlength="512" autocomplete="new-password" ${credentialControlsDisabled}>
                    </label>
                    <button type="button" id="ai-agent-openai-save" ${saveCredentialDisabled}>Save key</button>
                </div>
                <p class="ai-agent-download-status" role="status">${escapeHtml(credentialStatus)}</p>
                <button type="button" class="secondary-btn" id="ai-agent-openai-remove" ${state.openAiCredentialConfigured && !state.isLoadingCredential ? '' : 'disabled'}>Remove key</button>
            </section>
        ` : `
            <section class="ai-agent-model-download" aria-labelledby="ai-agent-model-download-title">
                <h3 id="ai-agent-model-download-title">Download an Ollama model</h3>
                <p>
                    Find the exact model and size in the
                    <a href="https://ollama.com/library" target="_blank" rel="noopener noreferrer">Ollama model library</a>,
                    then download it to this Ollama installation.
                </p>
                <div class="ai-agent-model-download-row">
                    <label for="ai-agent-download-model">
                        <span>Model name</span>
                        <input id="ai-agent-download-model" type="text" value="${escapeHtml(state.downloadModel)}" placeholder="gemma3:4b" maxlength="200" autocomplete="off" ${disabledAttribute}>
                    </label>
                    <button type="button" class="secondary-btn" id="ai-agent-download" ${disabledAttribute}>${state.isDownloading ? 'Downloading…' : 'Download'}</button>
                </div>
                <progress
                    id="ai-agent-download-progress"
                    max="${progressMaximum}"
                    value="${state.downloadCompleted}"
                    ${progressHiddenAttribute}
                ></progress>
                <p id="ai-agent-download-status" class="ai-agent-download-status" role="status">${escapeHtml(state.downloadStatus)}</p>
            </section>
        `;
        modalElement.innerHTML = `
            <div class="modal-content ai-agent-settings-modal-content">
                <h2>AI Agent Settings</h2>
                <div class="ai-agent-settings-controls">
                    <label for="ai-agent-provider">
                        <span>Provider</span>
                        <select id="ai-agent-provider" ${disabledAttribute}>
                            <option value="ollama" ${ollamaSelected}>Ollama</option>
                            <option value="openai" ${openAiSelected}>OpenAI API</option>
                        </select>
                    </label>
                    ${runtimeMarkup}
                    <label for="ai-agent-installed-model">
                        <span>${isOpenAi ? 'OpenAI model' : 'Downloaded model'}</span>
                        <select id="ai-agent-installed-model" ${modelSelectDisabled}>
                            ${installedModelOptions}
                        </select>
                    </label>
                    <fieldset class="ai-agent-retrieval-settings">
                        <legend>${isOpenAi ? 'OpenAI' : 'Ollama'} evidence limit</legend>
                        <p>
                            One evidence payload contains complete result trees in
                            user-visible order up to this approximate token limit.
                            A result tree is never divided; trailing trees are omitted.
                        </p>
                        <label for="ai-agent-max-page-approximate-tokens">
                            <span>Maximum approximate evidence tokens</span>
                            <input id="ai-agent-max-page-approximate-tokens" name="ai-agent-max-page-approximate-tokens" type="number" autocomplete="off" data-1p-ignore data-lpignore="true" min="500" max="${maximumPageApproximateTokens}" step="100" value="${state.maxPageApproximateTokens}" ${disabledAttribute}>
                        </label>
                        <label for="ai-agent-tagging-batch-tokens">
                            <span>Tagging batch token window</span>
                            <input id="ai-agent-tagging-batch-tokens" name="ai-agent-tagging-batch-tokens" type="number" autocomplete="off" data-1p-ignore data-lpignore="true" min="500" max="${maximumPageApproximateTokens}" step="100" value="${state.taggingBatchTokens}" ${disabledAttribute}>
                        </label>
                    </fieldset>
                    <fieldset class="ai-agent-cloud-privacy-settings">
                        <legend>Cloud privacy</legend>
                        <p>
                            Applies to every cloud AI provider. Each whitelist is OR;
                            each blacklist is OR; blacklists win. Tag rules use MetaList
                            inheritance, implications, and synonyms. A hidden ancestor
                            hides its entire subtree. <code>@password</code> is always hidden.
                        </p>
                        <label for="ai-agent-cloud-whitelist-tags">
                            <span>Whitelisted tags · one per line</span>
                            <textarea id="ai-agent-cloud-whitelist-tags" rows="4" maxlength="51400" placeholder="project-tag&#10;another-tag" ${disabledAttribute}>${escapeHtml(state.whitelistTagsText)}</textarea>
                        </label>
                        <label for="ai-agent-cloud-whitelist-phrases">
                            <span>Whitelisted text phrases · one per line</span>
                            <textarea id="ai-agent-cloud-whitelist-phrases" rows="4" maxlength="100200" placeholder="allowed phrase" ${disabledAttribute}>${escapeHtml(state.whitelistPhrasesText)}</textarea>
                        </label>
                        <label for="ai-agent-cloud-blacklist-tags">
                            <span>Blacklisted tags · one per line</span>
                            <textarea id="ai-agent-cloud-blacklist-tags" rows="4" maxlength="51400" placeholder="private-tag" ${disabledAttribute}>${escapeHtml(state.blacklistTagsText)}</textarea>
                        </label>
                        <label for="ai-agent-cloud-blacklist-phrases">
                            <span>Blacklisted text phrases · one per line</span>
                            <textarea id="ai-agent-cloud-blacklist-phrases" rows="4" maxlength="100200" placeholder="sensitive phrase" ${disabledAttribute}>${escapeHtml(state.blacklistPhrasesText)}</textarea>
                        </label>
                    </fieldset>
                </div>
                ${providerSpecificMarkup}
                <p class="error-message">${escapeHtml(state.error)}</p>
                <div class="form-actions">
                    <button type="button" class="primary-btn" id="ai-agent-save" data-modal-enter-action ${saveDisabled}>Save</button>
                    <button type="button" class="secondary-btn" id="ai-agent-cancel" ${disabledAttribute}>Cancel</button>
                </div>
            </div>
        `;
        this._setupControls();
    }

    _setupControls() {
        const providerSelect = document.getElementById('ai-agent-provider');
        const installedModelSelect = document.getElementById('ai-agent-installed-model');
        const modelInput = document.getElementById('ai-agent-download-model');
        const openAiApiKeyInput = document.getElementById('ai-agent-openai-api-key');
        const openAiSaveButton = document.getElementById('ai-agent-openai-save');
        const openAiRemoveButton = document.getElementById('ai-agent-openai-remove');
        const maxPageApproximateTokensInput = document.getElementById(
            'ai-agent-max-page-approximate-tokens',
        );
        const whitelistTagsInput = document.getElementById(
            'ai-agent-cloud-whitelist-tags',
        );
        const whitelistPhrasesInput = document.getElementById(
            'ai-agent-cloud-whitelist-phrases',
        );
        const blacklistTagsInput = document.getElementById(
            'ai-agent-cloud-blacklist-tags',
        );
        const blacklistPhrasesInput = document.getElementById(
            'ai-agent-cloud-blacklist-phrases',
        );
        const downloadButton = document.getElementById('ai-agent-download');
        const saveButton = document.getElementById('ai-agent-save');
        const cancelButton = document.getElementById('ai-agent-cancel');
        if (!(providerSelect instanceof HTMLSelectElement)) {
            throw new Error('AI settings provider selector missing');
        }
        const state = this.getModalState();
        if (state.provider === 'ollama' && !(modelInput instanceof HTMLInputElement)) {
            throw new Error('AI settings download model input missing');
        }
        if (state.provider === 'openai' && !(openAiApiKeyInput instanceof HTMLInputElement)) {
            throw new Error('AI settings OpenAI API key input missing');
        }
        if (state.provider === 'openai' && !(openAiSaveButton instanceof HTMLButtonElement)) {
            throw new Error('AI settings OpenAI save button missing');
        }
        if (state.provider === 'openai' && !(openAiRemoveButton instanceof HTMLButtonElement)) {
            throw new Error('AI settings OpenAI remove button missing');
        }
        if (!(maxPageApproximateTokensInput instanceof HTMLInputElement)) {
            throw new Error('AI settings approximate evidence tokens input missing');
        }
        for (const [input, label] of [
            [whitelistTagsInput, 'whitelisted tags'],
            [whitelistPhrasesInput, 'whitelisted phrases'],
            [blacklistTagsInput, 'blacklisted tags'],
            [blacklistPhrasesInput, 'blacklisted phrases'],
        ]) {
            if (!(input instanceof HTMLTextAreaElement)) {
                throw new Error(`AI settings cloud privacy ${label} input missing`);
            }
        }
        if (!(installedModelSelect instanceof HTMLSelectElement)) {
            throw new Error('AI settings installed model selector missing');
        }
        if (state.provider === 'ollama' && !(downloadButton instanceof HTMLButtonElement)) {
            throw new Error('AI settings download button missing');
        }
        if (!(saveButton instanceof HTMLButtonElement)) {
            throw new Error('AI settings save button missing');
        }
        if (!(cancelButton instanceof HTMLButtonElement)) {
            throw new Error('AI settings cancel button missing');
        }

        providerSelect.onchange = () => {
            if (!['ollama', 'openai'].includes(providerSelect.value)) {
                throw new Error(`Unsupported AI provider: ${providerSelect.value}`);
            }
            const nextRetrievalSettings = this.getModalState()[
                retrievalSettingsKey(providerSelect.value)
            ];
            this.updateModalState({
                provider: providerSelect.value,
                model: '',
                installedModels: [],
                error: '',
                ...retrievalStateFields(nextRetrievalSettings, providerSelect.value),
            });
            this.renderModalContent();
            void this._loadProviderState();
        };
        installedModelSelect.onchange = () => {
            this.updateModalState({ model: installedModelSelect.value, error: '' });
            this.renderModalContent();
        };
        if (modelInput instanceof HTMLInputElement) {
            modelInput.oninput = () => {
                this.updateModalState({ downloadModel: modelInput.value, error: '' });
            };
        }
        if (openAiApiKeyInput instanceof HTMLInputElement) {
            openAiApiKeyInput.oninput = () => {
                this.updateModalState({ error: '' });
                const error = document.querySelector(
                    '#ai-agent-settings-modal .error-message',
                );
                if (!(error instanceof HTMLElement)) {
                    throw new Error('AI settings error message missing');
                }
                error.textContent = '';
            };
        }
        const taggingBatchInput = document.getElementById('ai-agent-tagging-batch-tokens');
        if (!(taggingBatchInput instanceof HTMLInputElement)) throw new Error('Tagging batch input missing');
        taggingBatchInput.oninput = () => {
            this._updateRetrievalSetting('taggingBatchTokens', Number(taggingBatchInput.value));
        };
        maxPageApproximateTokensInput.oninput = () => {
            this._updateRetrievalSetting(
                'maxPageApproximateTokens',
                Number(maxPageApproximateTokensInput.value),
            );
        };
        whitelistTagsInput.oninput = () => {
            this.updateModalState({ whitelistTagsText: whitelistTagsInput.value, error: '' });
        };
        whitelistPhrasesInput.oninput = () => {
            this.updateModalState({
                whitelistPhrasesText: whitelistPhrasesInput.value,
                error: '',
            });
        };
        blacklistTagsInput.oninput = () => {
            this.updateModalState({ blacklistTagsText: blacklistTagsInput.value, error: '' });
        };
        blacklistPhrasesInput.oninput = () => {
            this.updateModalState({
                blacklistPhrasesText: blacklistPhrasesInput.value,
                error: '',
            });
        };
        if (downloadButton instanceof HTMLButtonElement) {
            downloadButton.onclick = () => void this._handleDownload();
        }
        if (openAiRemoveButton instanceof HTMLButtonElement) {
            openAiRemoveButton.onclick = () => void this._handleRemoveOpenAiKey();
        }
        if (openAiSaveButton instanceof HTMLButtonElement) {
            openAiSaveButton.onclick = () => void this._handleSaveOpenAiKey();
        }
        saveButton.onclick = () => void this._handleSave();
        cancelButton.onclick = () => this.requestClose();
    }

    _updateRetrievalSetting(fieldName, value) {
        const state = this.getModalState();
        const settingsKey = retrievalSettingsKey(state.provider);
        const providerSettings = state[settingsKey];
        if (!providerSettings || typeof providerSettings !== 'object') {
            throw new Error(`AI ${state.provider} retrieval settings missing`);
        }
        this.updateModalState({
            [fieldName]: value,
            [settingsKey]: {
                ...providerSettings,
                [fieldName]: value,
            },
            error: '',
        });
    }

    onOpen() {
        void this._loadProviderState();
    }

    canRequestClose() {
        const state = this.getModalState();
        return state.isDownloading !== true;
    }

    async _loadProviderState() {
        const state = this.getModalState();
        if (state.provider === 'openai') {
            await this._loadOpenAiCredentialStatus();
        }
        await this._loadInstalledModels();
    }

    async _loadInstalledModels() {
        const state = this.getModalState();
        if (state.isLoadingModels) {
            return;
        }
        this.updateModalState({ isLoadingModels: true, error: '' });
        this.renderModalContent();
        try {
            const payload = await listAiModels({
                provider: state.provider,
            });
            if (!payload || !Array.isArray(payload.models)) {
                throw new Error('AI model response missing models');
            }
            let model = state.model;
            if (!payload.models.includes(model)) {
                model = '';
            }
            this.updateModalState({ installedModels: payload.models, model });
        } catch (error) {
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this.updateModalState({ installedModels: [], model: '', error: error.message });
        } finally {
            this.updateModalState({ isLoadingModels: false });
            this.renderModalContent();
        }
    }

    async _loadOpenAiCredentialStatus() {
        const state = this.getModalState();
        if (state.isLoadingCredential) {
            return;
        }
        this.updateModalState({ isLoadingCredential: true, error: '' });
        this.renderModalContent();
        try {
            const payload = await loadOpenAiCredentialStatus();
            this._applyOpenAiCredentialStatus(payload);
        } catch (error) {
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this.updateModalState({ error: error.message });
        } finally {
            this.updateModalState({ isLoadingCredential: false });
            this.renderModalContent();
        }
    }

    _applyOpenAiCredentialStatus(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('OpenAI credential status must be an object');
        }
        if (typeof payload.configured !== 'boolean') {
            throw new Error('OpenAI credential status configured flag missing');
        }
        if (typeof payload.persistent !== 'boolean') {
            throw new Error('OpenAI credential status persistent flag missing');
        }
        if (payload.persistent && !payload.configured) {
            throw new Error('Persistent OpenAI credential must be configured');
        }
        this.updateModalState({
            openAiCredentialConfigured: payload.configured,
            openAiCredentialPersistent: payload.persistent,
        });
    }

    async _handleSaveOpenAiKey() {
        const input = document.getElementById('ai-agent-openai-api-key');
        if (!(input instanceof HTMLInputElement)) {
            throw new Error('AI settings OpenAI API key input missing');
        }
        const apiKey = input.value;
        if (apiKey.trim() === '') {
            this.updateModalState({ error: 'Enter an OpenAI API key to save.' });
            this.renderModalContent();
            return;
        }
        this.updateModalState({ isLoadingCredential: true, error: '' });
        this.renderModalContent();
        try {
            const payload = await saveOpenAiCredential(apiKey);
            this._applyOpenAiCredentialStatus(payload);
        } catch (error) {
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this.updateModalState({ error: error.message });
        } finally {
            this.updateModalState({ isLoadingCredential: false });
            this.renderModalContent();
        }
    }

    async _handleRemoveOpenAiKey() {
        try {
            const payload = await clearOpenAiCredential();
            this._applyOpenAiCredentialStatus(payload);
            this.renderModalContent();
        } catch (error) {
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this.updateModalState({ error: error.message });
            this.renderModalContent();
        }
    }

    _updateDownloadProgress(event) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
            throw new Error('Download progress event must be an object');
        }
        if (event.type === 'error') {
            this.updateModalState({
                error: event.message,
                downloadStatus: '',
                downloadCompleted: 0,
                downloadTotal: 0,
            });
        } else if (event.type === 'progress' || event.type === 'done') {
            this.updateModalState({
                error: '',
                downloadStatus: event.status,
                downloadCompleted: event.completed,
                downloadTotal: event.total,
            });
        } else {
            throw new Error(`Unknown download progress event: ${event.type}`);
        }
        const state = this.getModalState();
        const progress = document.getElementById('ai-agent-download-progress');
        const status = document.getElementById('ai-agent-download-status');
        const error = document.querySelector('#ai-agent-settings-modal .error-message');
        if (!(progress instanceof HTMLProgressElement)) {
            throw new Error('AI settings download progress missing');
        }
        if (!(status instanceof HTMLElement)) {
            throw new Error('AI settings download status missing');
        }
        if (!(error instanceof HTMLElement)) {
            throw new Error('AI settings error message missing');
        }
        progress.hidden = state.downloadTotal === 0;
        if (state.downloadTotal > 0) {
            progress.max = state.downloadTotal;
            progress.value = state.downloadCompleted;
        }
        status.textContent = state.downloadStatus;
        error.textContent = state.error;
    }

    async _handleDownload() {
        const state = this.getModalState();
        const model = state.downloadModel.trim();
        if (model === '') {
            this.updateModalState({ error: 'Enter an Ollama model name to download.' });
            this.renderModalContent();
            return;
        }
        this.updateModalState({
            isDownloading: true,
            downloadStatus: 'Starting download…',
            downloadCompleted: 0,
            downloadTotal: 0,
            error: '',
        });
        this.renderModalContent();
        let didComplete = false;
        try {
            await pullOllamaModel({
                settings: {
                    provider: 'ollama',
                },
                model,
                onEvent: (event) => {
                    this._updateDownloadProgress(event);
                    if (event.type === 'done') {
                        didComplete = true;
                    }
                },
            });
        } catch (error) {
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this.updateModalState({
                error: error.message,
                downloadStatus: '',
                downloadCompleted: 0,
                downloadTotal: 0,
            });
        } finally {
            this.updateModalState({ isDownloading: false });
            this.renderModalContent();
        }
        if (didComplete) {
            await this._loadInstalledModels();
            this.updateModalState({
                downloadStatus: `Downloaded ${model}. Select it above when ready.`,
                downloadCompleted: 0,
                downloadTotal: 0,
            });
            this.renderModalContent();
        }
    }

    async _handleSave() {
        const state = this.getModalState();
        if (!state.installedModels.includes(state.model)) {
            this.updateModalState({ error: 'Select an available model before saving.' });
            this.renderModalContent();
            return;
        }
        for (const provider of ['ollama', 'openai']) {
            const providerSettings = state[retrievalSettingsKey(provider)];
            const validationMessage = getAgentRetrievalSettingsValidationMessage(
                providerSettings,
                provider,
            );
            if (validationMessage !== '') {
                this.updateModalState({
                    error: `${provider === 'openai' ? 'OpenAI' : 'Ollama'}: ${validationMessage}`,
                });
                this.renderModalContent();
                return;
            }
        }
        const privacyValidationMessage = getCloudPrivacyTextFieldsValidationMessage(state);
        if (privacyValidationMessage !== '') {
            this.updateModalState({ error: privacyValidationMessage });
            this.renderModalContent();
            return;
        }
        const cloudPrivacyPolicy = parseCloudPrivacyTextFields(state);
        await this._saveSettings({
            provider: state.provider,
            model: state.model,
            ollamaRetrievalSettings: validateAgentRetrievalSettings(
                state.ollamaRetrievalSettings,
                'ollama',
            ),
            openAiRetrievalSettings: validateAgentRetrievalSettings(
                state.openAiRetrievalSettings,
                'openai',
            ),
            cloudPrivacyPolicy,
        });
        this.close();
    }
}
