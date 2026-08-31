import {
    AiApiError,
    clearAiChatSession,
    copyAiChatResponse,
    listAiModels,
    loadAiChatSession,
    loadOpenAiCostSnapshot,
    previewCloudPrivacy,
    resetOpenAiCostSnapshot,
    streamAiChat,
} from './ai-chat-api.js';
import { AgentDebugView } from './ai-agent-debug-view.js';
import {
    calculateAiChatMaximumWidth,
    calculateAiChatPanelWidth,
    collapseCompletedActivityPairs,
    formatOpenAiCostUsd,
    selectPersistentNonDiagnosticActivities,
    splitSearchActivityLabel,
    validateOpenAiCostSnapshot,
} from './ai-chat-panel-service.js';
import {
    queueMermaidDiagramRendering,
} from '../mode-manager/services/mermaid-render-service.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import {
    getActiveReferenceOriginScope,
    isViewingReferenceSource,
} from '../mode-manager/services/reference-source-navigation-service.js';
import * as Logger from '../mode-manager/mode-logger.js';
import { showContextMenu } from '../context-menu/context-menu-service.js';
import {
    writeRenderedNoteToSystemClipboard,
} from '../mode-manager/services/note-clipboard-write-service.js';
import {
    AI_THINKING_LEVEL_OPTIONS,
    isThinkingLevelAvailableForModel,
    normalizeThinkingLevelForModel,
} from './ai-thinking-level-service.js';


function requireElement(id, constructor) {
    const element = document.getElementById(id);
    if (!(element instanceof constructor)) {
        throw new Error(`AI chat element missing: ${id}`);
    }
    return element;
}


function validateMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error('AI chat message must be an object');
    }
    for (const key of [
        'id',
        'role',
        'content',
        'rendered_content',
        'thinking',
        'rendered_thinking',
        'status',
        'error',
        'provider',
        'model',
    ]) {
        if (typeof message[key] !== 'string') {
            throw new Error(`AI chat message ${key} must be a string`);
        }
    }
    if (!['user', 'assistant'].includes(message.role)) {
        throw new Error('AI chat message role is invalid');
    }
    if (!['complete', 'streaming', 'error'].includes(message.status)) {
        throw new Error('AI chat message status is invalid');
    }
    if (!Array.isArray(message.activities)) {
        throw new Error('AI chat message activities must be an array');
    }
    for (const activity of message.activities) {
        validateActivity(activity);
    }
    return message;
}


export function captureActiveAgentScope() {
    const activeTabId = ModeContext.activeTabId;
    if (typeof activeTabId !== 'string' || activeTabId.length === 0) {
        throw new Error('Active agent scope requires active tab id');
    }
    let scopeTabId = activeTabId;
    let searchQuery = ModeContext.getExecutedSearchQuery(activeTabId);
    if (typeof searchQuery !== 'string') {
        throw new Error('Active agent scope requires executed search query');
    }
    let sortMode = ModeContext.activeTabSortMode;
    let dateFilter = ModeContext.activeTabDateFilter;
    let isUntaggedView = ModeContext.isUntaggedView;
    if (isViewingReferenceSource()) {
        const originScope = getActiveReferenceOriginScope();
        scopeTabId = originScope.scopeTabId;
        searchQuery = originScope.searchQuery;
        sortMode = originScope.sortMode;
        dateFilter = originScope.dateFilter;
        isUntaggedView = originScope.isUntaggedView;
    }
    let scopeKind = 'all_notes';
    let label = 'All notes';
    if (isUntaggedView) {
        if (searchQuery !== '') {
            throw new Error('Untagged scope requires empty executed search');
        }
        scopeKind = 'untagged';
        label = 'Untagged notes';
    } else if (searchQuery.trim() !== '') {
        scopeKind = 'search';
        label = searchQuery;
    }
    let dateFilterActive = false;
    let dateFilterMetric = '';
    let dateFilterStart = '';
    let dateFilterEnd = '';
    if (dateFilter !== null) {
        dateFilterActive = true;
        dateFilterMetric = dateFilter.metric;
        dateFilterStart = dateFilter.startDate;
        dateFilterEnd = dateFilter.endDate;
    }
    return {
        scope_kind: scopeKind,
        active_tab_id: activeTabId,
        scope_tab_id: scopeTabId,
        search_query: searchQuery,
        sort_mode: sortMode,
        date_filter_active: dateFilterActive,
        date_filter_metric: dateFilterMetric,
        date_filter_start: dateFilterStart,
        date_filter_end: dateFilterEnd,
        reference_root_ids: [],
        label,
    };
}


const AI_ACTIVITY_ACTIONS = new Set([
    'planning',
    'model_request',
    'validation',
    'retry',
    'skill',
    'search_notes',
    'read_notes_by_id',
    'respond',
    'cancel',
    'ollama_runtime',
    'provider_runtime',
    'model_context',
    'scope',
    'investigate_current_scope',
    'evidence_selection',
    'investigation_step',
    'investigation_evidence',
    'investigation_facets',
    'investigation_refinement',
    'investigation_sources',
    'evidence_root_prefix',
    'context_narrowing',
    'context_narrowing_plan',
    'context_narrowing_test',
]);


function validateActivity(activity) {
    if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
        throw new Error('AI chat activity must be an object');
    }
    if (!Number.isInteger(activity.sequence) || activity.sequence < 1) {
        throw new Error('AI chat activity sequence must be a positive integer');
    }
    if (typeof activity.action !== 'string' || !AI_ACTIVITY_ACTIONS.has(activity.action)) {
        throw new Error(`Unknown AI chat activity action: ${activity.action}`);
    }
    if (!['started', 'completed'].includes(activity.status)) {
        throw new Error('AI chat activity status is invalid');
    }
    if (typeof activity.label !== 'string' || activity.label === '') {
        throw new Error('AI chat activity label must be non-empty');
    }
    if (!Number.isInteger(activity.approx_input_tokens) || activity.approx_input_tokens < 1) {
        throw new Error('AI chat activity approximate input tokens must be positive');
    }
    if (
        !Number.isInteger(activity.output_tokens_received)
        || activity.output_tokens_received < 0
    ) {
        throw new Error('AI chat activity output tokens must be non-negative');
    }
    if (!Number.isFinite(activity.duration_ms) || activity.duration_ms < 0) {
        throw new Error('AI chat activity duration must be non-negative and finite');
    }
    return activity;
}


class AiChatPanelController {
    constructor() {
        this._initialized = false;
        this._messages = [];
        this._expandedThinkingMessageIds = new Set();
        this._expandedReferenceMessageIds = new Set();
        this._showDiagnosticActivities = false;
        this._isBusy = false;
        this._thinkingStartedAtMs = 0;
        this._thinkingTimerId = 0;
        this._models = [];
        this._isLoadingModels = false;
        this._activeChatAbortController = null;
        this._activeChatCompletion = null;
        this._privacyPreviewAbortController = null;
        this._isPrivacyPreviewHovered = false;
        this._privacyPreviewMutationObserver = null;
        this._isClearingSession = false;
        this._isResettingOpenAiCost = false;
        this._activeOpenAiCostRefresh = null;
        this._localMessageSequence = 0;
        this._getSettings = null;
        this._saveSettings = null;
        this._getPanelWidth = null;
        this._savePanelWidth = null;
        this._getDiagnosticsVisible = null;
        this._saveDiagnosticsVisible = null;
        this._getComposerHeight = null;
        this._saveComposerHeight = null;
        this._composerHeightBeforePointerInteraction = 0;
        this._setVisible = null;
        this._openSettings = null;
        this._elements = null;

        this._handleVisibilityChanged = this._handleVisibilityChanged.bind(this);
        this._handleSettingsChanged = this._handleSettingsChanged.bind(this);
        this._handlePrivacyPointerEnter = this._handlePrivacyPointerEnter.bind(this);
        this._handlePrivacyPointerLeave = this._handlePrivacyPointerLeave.bind(this);
        this._handlePrivacyNotesMutation = this._handlePrivacyNotesMutation.bind(this);
        this._handleMessageContextMenu = this._handleMessageContextMenu.bind(this);
        this._handlePointerMove = this._handlePointerMove.bind(this);
        this._handlePointerUp = this._handlePointerUp.bind(this);
        this._handleResizerKeydown = this._handleResizerKeydown.bind(this);
        this._handleComposerPointerDown = this._handleComposerPointerDown.bind(this);
        this._handleComposerPointerUp = this._handleComposerPointerUp.bind(this);
        this._handleWindowResize = this._handleWindowResize.bind(this);
    }

    async init({
        getSettings,
        saveSettings,
        getPanelWidth,
        savePanelWidth,
        getDiagnosticsVisible,
        saveDiagnosticsVisible,
        getComposerHeight,
        saveComposerHeight,
        setVisible,
        openSettings,
    }) {
        if (this._initialized) {
            return;
        }
        if (typeof getSettings !== 'function') {
            throw new Error('AiChatPanel.init requires getSettings');
        }
        if (typeof saveSettings !== 'function') {
            throw new Error('AiChatPanel.init requires saveSettings');
        }
        if (typeof getPanelWidth !== 'function') {
            throw new Error('AiChatPanel.init requires getPanelWidth');
        }
        if (typeof savePanelWidth !== 'function') {
            throw new Error('AiChatPanel.init requires savePanelWidth');
        }
        if (typeof getDiagnosticsVisible !== 'function') {
            throw new Error('AiChatPanel.init requires getDiagnosticsVisible');
        }
        if (typeof saveDiagnosticsVisible !== 'function') {
            throw new Error('AiChatPanel.init requires saveDiagnosticsVisible');
        }
        if (typeof getComposerHeight !== 'function') {
            throw new Error('AiChatPanel.init requires getComposerHeight');
        }
        if (typeof saveComposerHeight !== 'function') {
            throw new Error('AiChatPanel.init requires saveComposerHeight');
        }
        if (typeof setVisible !== 'function') {
            throw new Error('AiChatPanel.init requires setVisible');
        }
        if (typeof openSettings !== 'function') {
            throw new Error('AiChatPanel.init requires openSettings');
        }
        this._getSettings = getSettings;
        this._saveSettings = saveSettings;
        this._getPanelWidth = getPanelWidth;
        this._savePanelWidth = savePanelWidth;
        this._getDiagnosticsVisible = getDiagnosticsVisible;
        this._saveDiagnosticsVisible = saveDiagnosticsVisible;
        this._getComposerHeight = getComposerHeight;
        this._saveComposerHeight = saveComposerHeight;
        this._setVisible = setVisible;
        this._openSettings = openSettings;
        this._elements = {
            panel: requireElement('ai-chat-panel', HTMLElement),
            resizer: requireElement('ai-chat-resizer', HTMLElement),
            messages: requireElement('ai-chat-messages', HTMLElement),
            openAiCost: requireElement('ai-chat-openai-cost', HTMLElement),
            openAiCostAmount: requireElement(
                'ai-chat-openai-cost-amount',
                HTMLElement,
            ),
            openAiCostReset: requireElement(
                'ai-chat-openai-cost-reset',
                HTMLButtonElement,
            ),
            openAiUncachedInputTokens: requireElement(
                'ai-chat-openai-uncached-input-tokens',
                HTMLElement,
            ),
            openAiCachedInputTokens: requireElement(
                'ai-chat-openai-cached-input-tokens',
                HTMLElement,
            ),
            openAiCacheWriteTokens: requireElement(
                'ai-chat-openai-cache-write-tokens',
                HTMLElement,
            ),
            openAiOutputTokens: requireElement(
                'ai-chat-openai-output-tokens',
                HTMLElement,
            ),
            form: requireElement('ai-chat-form', HTMLFormElement),
            input: requireElement('ai-chat-input', HTMLTextAreaElement),
            send: requireElement('ai-chat-send', HTMLButtonElement),
            model: requireElement('ai-chat-model', HTMLSelectElement),
            thinkingLevel: requireElement('ai-chat-thinking-level', HTMLSelectElement),
            diagnosticsToggle: requireElement(
                'ai-chat-diagnostics-toggle',
                HTMLButtonElement,
            ),
            clear: requireElement('ai-chat-clear', HTMLButtonElement),
            settings: requireElement('ai-chat-settings', HTMLButtonElement),
            close: requireElement('ai-chat-close', HTMLButtonElement),
            toggle: requireElement('chat-toggle-button', HTMLButtonElement),
        };
        const savedComposerHeight = this._getComposerHeight();
        if (savedComposerHeight !== null) {
            this._elements.input.style.height = `${savedComposerHeight}px`;
        }
        this._showDiagnosticActivities = this._getDiagnosticsVisible();
        if (typeof this._showDiagnosticActivities !== 'boolean') {
            throw new Error('Stored AI chat diagnostic visibility must be boolean');
        }
        this._bindEvents();
        const notesContainer = requireElement('notes-container', HTMLElement);
        this._privacyPreviewMutationObserver = new MutationObserver(
            this._handlePrivacyNotesMutation,
        );
        this._privacyPreviewMutationObserver.observe(notesContainer, {
            attributes: true,
            attributeFilter: ['data-note-id', 'data-note-tags'],
            childList: true,
            characterData: true,
            subtree: true,
        });
        await AgentDebugView.init();
        this._initialized = true;
        this._syncDiagnosticActivityToggle();
        this._syncSettingsControls();
        const savedWidth = this._getPanelWidth();
        if (savedWidth !== null) {
            this._applyPanelWidth(savedWidth);
        }
        this._syncResizerAria();
        this._syncToggleButton(document.body.classList.contains('pref-show-ai-chat'));
        if (document.body.classList.contains('pref-show-ai-chat')) {
            await this._loadModels();
        }
        await this._loadSession({ shouldScrollToBottom: true });
        await this._refreshOpenAiCostSnapshot();
    }

    _bindEvents() {
        const elements = this._elements;
        elements.form.addEventListener('submit', (event) => {
            event.preventDefault();
            void this._submitMessage();
        });
        elements.send.addEventListener('click', () => {
            if (this._isBusy) {
                this._cancelActiveRequest();
                return;
            }
            elements.form.requestSubmit();
        });
        elements.input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
                return;
            }
            event.preventDefault();
            elements.form.requestSubmit();
        });
        elements.input.addEventListener('pointerdown', this._handleComposerPointerDown);
        elements.messages.addEventListener('contextmenu', this._handleMessageContextMenu);
        elements.model.addEventListener('change', () => void this._selectModel());
        elements.thinkingLevel.addEventListener(
            'change',
            () => void this._selectThinkingLevel(),
        );
        elements.close.addEventListener('click', () => void this._setVisible(false));
        elements.toggle.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const isVisible = document.body.classList.contains('pref-show-ai-chat');
            void this._setVisible(!isVisible);
        });
        elements.settings.addEventListener('click', () => void this._openSettings());
        elements.diagnosticsToggle.addEventListener(
            'click',
            () => void this._toggleDiagnosticActivities(),
        );
        elements.clear.addEventListener('click', () => void this._clearSession());
        elements.openAiCostReset.addEventListener(
            'click',
            () => void this._resetOpenAiCostSnapshot(),
        );
        elements.resizer.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            document.body.classList.add('ai-chat-resizing');
            window.addEventListener('pointermove', this._handlePointerMove);
            window.addEventListener('pointerup', this._handlePointerUp, { once: true });
            window.addEventListener('pointercancel', this._handlePointerUp, { once: true });
        });
        elements.resizer.addEventListener('keydown', this._handleResizerKeydown);
        elements.panel.addEventListener('pointerenter', this._handlePrivacyPointerEnter);
        elements.panel.addEventListener('pointerleave', this._handlePrivacyPointerLeave);
        window.addEventListener('resize', this._handleWindowResize);
        document.addEventListener('metalist:ai-chat-visibility-changed', this._handleVisibilityChanged);
        document.addEventListener('metalist:ai-settings-changed', this._handleSettingsChanged);
    }

    _handleVisibilityChanged(event) {
        if (!event || !event.detail || typeof event.detail.isVisible !== 'boolean') {
            throw new Error('AI chat visibility event is malformed');
        }
        this._syncToggleButton(event.detail.isVisible);
        if (event.detail.isVisible) {
            this._syncResizerAria();
            this._elements.input.focus();
            void this._loadModels();
            void this._refreshOpenAiCostSnapshot();
        } else {
            this._clearPrivacyPreview();
        }
    }

    _handleSettingsChanged(event) {
        if (!event || !event.detail || typeof event.detail.reloadModels !== 'boolean') {
            throw new Error('AI settings event is malformed');
        }
        this._syncSettingsControls();
        void this._refreshOpenAiCostSnapshot();
        if (this._isPrivacyPreviewHovered) {
            void this._refreshPrivacyPreview();
        }
        if (
            event.detail.reloadModels
            && document.body.classList.contains('pref-show-ai-chat')
        ) {
            void this._loadModels();
        }
    }

    _handlePrivacyPointerEnter() {
        this._isPrivacyPreviewHovered = true;
        void this._refreshPrivacyPreview();
    }

    _handlePrivacyPointerLeave() {
        this._isPrivacyPreviewHovered = false;
        this._clearPrivacyPreview();
    }

    _handlePrivacyNotesMutation() {
        if (this._isPrivacyPreviewHovered) {
            void this._refreshPrivacyPreview();
        }
    }

    _clearPrivacyPreview() {
        if (this._privacyPreviewAbortController !== null) {
            this._privacyPreviewAbortController.abort();
            this._privacyPreviewAbortController = null;
        }
        const highlightedNotes = document.querySelectorAll(
            '.note.cloud-ai-private-preview',
        );
        for (const noteElement of highlightedNotes) {
            noteElement.classList.remove('cloud-ai-private-preview');
        }
    }

    async _refreshPrivacyPreview() {
        this._clearPrivacyPreview();
        if (!this._isPrivacyPreviewHovered) {
            return;
        }
        const notesContainer = requireElement('notes-container', HTMLElement);
        const noteElements = Array.from(
            notesContainer.querySelectorAll('.note[data-note-id]'),
        );
        if (noteElements.length === 0) {
            return;
        }
        const noteIds = noteElements.map((noteElement) => {
            const noteId = noteElement.dataset.noteId;
            if (typeof noteId !== 'string' || noteId === '') {
                throw new Error('Privacy preview note is missing data-note-id');
            }
            return noteId;
        });
        if (new Set(noteIds).size !== noteIds.length) {
            throw new Error('Privacy preview visible note ids must be unique');
        }
        const settings = this._getSettings();
        const abortController = new AbortController();
        this._privacyPreviewAbortController = abortController;
        try {
            const payload = await previewCloudPrivacy({
                provider: settings.provider,
                noteIds,
                signal: abortController.signal,
            });
            if (
                abortController.signal.aborted
                || !this._isPrivacyPreviewHovered
                || this._privacyPreviewAbortController !== abortController
            ) {
                return;
            }
            const hiddenNoteIds = new Set(payload.hidden_note_ids);
            for (const noteElement of noteElements) {
                if (hiddenNoteIds.has(noteElement.dataset.noteId)) {
                    noteElement.classList.add('cloud-ai-private-preview');
                }
            }
        } catch (error) {
            if (!abortController.signal.aborted) {
                if (!(error instanceof AiApiError)) {
                    throw error;
                }
                Logger.logError('Cloud AI privacy preview failed', error);
            }
        } finally {
            if (this._privacyPreviewAbortController === abortController) {
                this._privacyPreviewAbortController = null;
            }
        }
    }

    _syncToggleButton(isVisible) {
        if (typeof isVisible !== 'boolean') {
            throw new Error('_syncToggleButton requires boolean visibility');
        }
        const actionLabel = isVisible ? 'Hide chat' : 'Show chat';
        this._elements.toggle.setAttribute('aria-pressed', String(isVisible));
        this._elements.toggle.setAttribute('aria-label', actionLabel);
        this._elements.toggle.title = actionLabel;
    }

    _syncDiagnosticActivityToggle() {
        const actionLabel = this._showDiagnosticActivities
            ? 'Hide diagnostic activity'
            : 'Show diagnostic activity';
        this._elements.diagnosticsToggle.setAttribute(
            'aria-pressed',
            String(this._showDiagnosticActivities),
        );
        this._elements.diagnosticsToggle.setAttribute('aria-label', actionLabel);
        this._elements.diagnosticsToggle.title = actionLabel;
    }

    async _toggleDiagnosticActivities() {
        const nextVisibility = !this._showDiagnosticActivities;
        await this._saveDiagnosticsVisible(nextVisibility);
        this._showDiagnosticActivities = nextVisibility;
        this._syncDiagnosticActivityToggle();
        this._render({ shouldScrollToBottom: true });
    }

    _handlePointerMove(event) {
        const width = calculateAiChatPanelWidth({
            pointerClientX: event.clientX,
            viewportWidth: window.innerWidth,
        });
        this._applyPanelWidth(width);
    }

    _handleMessageContextMenu(event) {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        const article = target.closest('.ai-chat-message-assistant');
        if (!(article instanceof HTMLElement) || !this._elements.messages.contains(article)) {
            return;
        }
        const messageId = article.dataset.messageId;
        if (typeof messageId !== 'string' || messageId === '') {
            throw new Error('Assistant chat message is missing its message id');
        }
        const message = this._messages.find((candidate) => candidate.id === messageId);
        if (!message) {
            throw new Error(`Assistant chat message missing from controller state: ${messageId}`);
        }
        if (
            message.status !== 'complete'
            || message.content === ''
            || message.id.startsWith('local-')
        ) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        showContextMenu({
            items: [
                {
                    id: 'copy-ai-response',
                    label: 'Copy Response',
                    icon: 'copy',
                    enabled: true,
                    onSelect: () => void this._copyAssistantMessage(message.id),
                },
            ],
            position: { x: event.clientX, y: event.clientY },
            onClose: null,
        });
    }

    async _copyAssistantMessage(messageId) {
        const clientId = ModeContext.clientId;
        if (typeof clientId !== 'string' || clientId === '') {
            throw new Error('Copying an AI response requires a client id');
        }
        try {
            const payload = await copyAiChatResponse({ messageId, clientId });
            if (
                !payload
                || typeof payload.html !== 'string'
                || typeof payload.plain_text !== 'string'
                || payload.tags !== '@llm'
            ) {
                throw new Error('Copied AI response payload is malformed');
            }
            await writeRenderedNoteToSystemClipboard({
                renderedHtml: payload.html,
                renderedPlainText: payload.plain_text,
                logger: Logger,
            });
            if (ModeContext.clipboardMode !== 'note') {
                ModeContext.setClipboardMode('note');
            }
            if (ModeContext.clipboardNoteId !== null) {
                ModeContext.setClipboardNoteId(null);
            }
        } catch (error) {
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this._appendLocalErrorPanel(error.message);
            throw error;
        }
    }

    _handleComposerPointerDown(event) {
        if (event.button !== 0) {
            return;
        }
        this._composerHeightBeforePointerInteraction = Math.round(
            this._elements.input.getBoundingClientRect().height,
        );
        window.addEventListener('pointerup', this._handleComposerPointerUp, { once: true });
        window.addEventListener('pointercancel', this._handleComposerPointerUp, { once: true });
    }

    _handleComposerPointerUp(event) {
        window.removeEventListener('pointerup', this._handleComposerPointerUp);
        window.removeEventListener('pointercancel', this._handleComposerPointerUp);
        if (event.type === 'pointercancel') {
            return;
        }
        const height = Math.round(this._elements.input.getBoundingClientRect().height);
        if (height === this._composerHeightBeforePointerInteraction) {
            return;
        }
        if (!Number.isInteger(height) || height < 74 || height > 220) {
            throw new Error('Rendered AI chat composer height is outside the persisted range');
        }
        void this._saveComposerHeight(height);
    }

    _handleResizerKeydown(event) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            return;
        }
        event.preventDefault();
        const currentWidth = this._elements.panel.getBoundingClientRect().width;
        let requestedWidth = currentWidth;
        if (event.key === 'ArrowLeft') {
            requestedWidth += 24;
        } else if (event.key === 'ArrowRight') {
            requestedWidth -= 24;
        } else if (event.key === 'Home') {
            requestedWidth = 280;
        } else {
            requestedWidth = calculateAiChatMaximumWidth(window.innerWidth);
        }
        const width = calculateAiChatPanelWidth({
            pointerClientX: window.innerWidth - requestedWidth,
            viewportWidth: window.innerWidth,
        });
        this._applyPanelWidth(width);
        void this._persistPanelWidth();
    }

    _handleWindowResize() {
        this._syncResizerAria();
    }

    _applyPanelWidth(width) {
        if (!Number.isFinite(width) || width <= 0) {
            throw new Error('_applyPanelWidth requires positive finite width');
        }
        document.documentElement.style.setProperty('--ai-chat-width', `${width}px`);
        this._setResizerAria(width);
    }

    _setResizerAria(width) {
        if (!Number.isFinite(width) || width <= 0) {
            throw new Error('_setResizerAria requires positive finite width');
        }
        this._elements.resizer.setAttribute('aria-valuenow', String(width));
        this._elements.resizer.setAttribute('aria-valuemin', '280');
        this._elements.resizer.setAttribute(
            'aria-valuemax',
            String(calculateAiChatMaximumWidth(window.innerWidth)),
        );
    }

    _syncResizerAria() {
        let requestedWidth = this._elements.panel.getBoundingClientRect().width;
        if (requestedWidth <= 0) {
            requestedWidth = window.innerWidth / 3;
        }
        const width = calculateAiChatPanelWidth({
            pointerClientX: window.innerWidth - requestedWidth,
            viewportWidth: window.innerWidth,
        });
        this._setResizerAria(width);
    }

    _handlePointerUp() {
        document.body.classList.remove('ai-chat-resizing');
        window.removeEventListener('pointermove', this._handlePointerMove);
        window.removeEventListener('pointerup', this._handlePointerUp);
        window.removeEventListener('pointercancel', this._handlePointerUp);
        void this._persistPanelWidth();
    }

    async _persistPanelWidth() {
        const width = Math.round(this._elements.panel.getBoundingClientRect().width);
        if (!Number.isInteger(width) || width < 280 || width > 5000) {
            throw new Error('Rendered AI chat width is outside the persisted range');
        }
        await this._savePanelWidth(width);
    }

    _syncSettingsControls() {
        const settings = this._getSettings();
        if (!settings || typeof settings !== 'object') {
            throw new Error('AI settings snapshot missing');
        }
        this._elements.model.replaceChildren();
        const hasSelectedModel = this._models.includes(settings.model);
        if (this._models.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No models';
            this._elements.model.appendChild(option);
        } else {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'Select model';
            option.disabled = true;
            option.selected = !hasSelectedModel;
            this._elements.model.appendChild(option);
            for (const model of this._models) {
                if (typeof model !== 'string' || model === '') {
                    throw new Error('Ollama model list contains invalid model');
                }
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                this._elements.model.appendChild(option);
            }
            this._elements.model.value = hasSelectedModel ? settings.model : '';
        }

        const selectedModel = hasSelectedModel ? settings.model : '';
        const thinkingLevel = normalizeThinkingLevelForModel({
            model: selectedModel,
            thinkingLevel: settings.thinkingLevel,
        });
        this._elements.thinkingLevel.replaceChildren();
        for (const thinkingOption of AI_THINKING_LEVEL_OPTIONS) {
            const option = document.createElement('option');
            option.value = thinkingOption.value;
            option.textContent = thinkingOption.label;
            option.disabled = !isThinkingLevelAvailableForModel({
                model: selectedModel,
                thinkingLevel: thinkingOption.value,
            });
            this._elements.thinkingLevel.appendChild(option);
        }
        this._elements.thinkingLevel.value = thinkingLevel;
        this._elements.input.placeholder = hasSelectedModel
            ? `Message ${settings.model}…`
            : 'Select a model to start chatting…';
        this._syncComposerControlsDisabled();
        this._syncOpenAiCostVisibility();
    }

    _syncOpenAiCostVisibility() {
        const settings = this._getSettings();
        const isOpenAi = settings.provider === 'openai';
        this._elements.openAiCost.hidden = !isOpenAi;
        return isOpenAi;
    }

    _renderOpenAiCostSnapshot(snapshot) {
        validateOpenAiCostSnapshot(snapshot);
        this._elements.openAiCostAmount.textContent = formatOpenAiCostUsd(
            snapshot.estimated_cost_usd,
        );
        this._elements.openAiUncachedInputTokens.textContent = (
            snapshot.uncached_input_tokens.toLocaleString()
        );
        this._elements.openAiCachedInputTokens.textContent = (
            snapshot.cached_input_tokens.toLocaleString()
        );
        this._elements.openAiCacheWriteTokens.textContent = (
            snapshot.cache_write_tokens.toLocaleString()
        );
        this._elements.openAiOutputTokens.textContent = (
            snapshot.output_tokens.toLocaleString()
        );
        this._elements.openAiCostReset.disabled = this._isResettingOpenAiCost;
    }

    async _refreshOpenAiCostSnapshot() {
        if (!this._syncOpenAiCostVisibility()) {
            return;
        }
        if (this._activeOpenAiCostRefresh !== null) {
            await this._activeOpenAiCostRefresh;
            return;
        }
        const refreshRequest = (async () => {
            try {
                const snapshot = await loadOpenAiCostSnapshot();
                this._renderOpenAiCostSnapshot(snapshot);
            } catch (error) {
                if (!(error instanceof AiApiError)) {
                    throw error;
                }
                Logger.logError('OpenAI cost estimate refresh failed', error);
            }
        })();
        const refresh = refreshRequest.finally(() => {
            if (this._activeOpenAiCostRefresh !== refresh) {
                throw new Error('OpenAI cost refresh promise changed during request');
            }
            this._activeOpenAiCostRefresh = null;
        });
        this._activeOpenAiCostRefresh = refresh;
        await refresh;
    }

    async _resetOpenAiCostSnapshot() {
        if (this._isResettingOpenAiCost) {
            return;
        }
        if (!this._syncOpenAiCostVisibility()) {
            throw new Error('OpenAI cost can only be reset for the OpenAI provider');
        }
        if (this._activeOpenAiCostRefresh !== null) {
            await this._activeOpenAiCostRefresh;
        }
        this._isResettingOpenAiCost = true;
        this._elements.openAiCostReset.disabled = true;
        try {
            const snapshot = await resetOpenAiCostSnapshot();
            this._renderOpenAiCostSnapshot(snapshot);
        } catch (error) {
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this._appendLocalErrorPanel(error.message);
            throw error;
        } finally {
            this._isResettingOpenAiCost = false;
            this._elements.openAiCostReset.disabled = false;
        }
    }

    _syncComposerControlsDisabled() {
        const settings = this._getSettings();
        const hasModel = this._models.includes(settings.model);
        let isModelDisabled = this._isBusy;
        if (this._isLoadingModels) {
            isModelDisabled = true;
        }
        if (this._models.length === 0) {
            isModelDisabled = true;
        }
        this._elements.model.disabled = isModelDisabled;

        let isThinkingLevelDisabled = this._isBusy;
        if (this._isLoadingModels) {
            isThinkingLevelDisabled = true;
        }
        if (!hasModel) {
            isThinkingLevelDisabled = true;
        }
        this._elements.thinkingLevel.disabled = isThinkingLevelDisabled;

        this._elements.send.textContent = this._isBusy ? 'Stop' : 'Send';
        this._elements.send.classList.toggle('is-stop', this._isBusy);
        let isSendDisabled = false;
        if (!this._isBusy) {
            if (this._isLoadingModels) {
                isSendDisabled = true;
            }
            if (this._models.length === 0) {
                isSendDisabled = true;
            }
            if (!hasModel) {
                isSendDisabled = true;
            }
        }
        this._elements.send.disabled = isSendDisabled;
    }

    async _loadModels() {
        if (this._isLoadingModels || this._isBusy) {
            return;
        }
        this._isLoadingModels = true;
        this._syncComposerControlsDisabled();
        const settings = this._getSettings();
        try {
            const payload = await listAiModels(settings);
            if (!payload || !Array.isArray(payload.models)) {
                throw new Error('AI model response missing models');
            }
            this._models = payload.models;
            if (this._models.length === 0) {
                this._appendLocalErrorPanel(
                    'The selected AI provider has no available models.',
                );
                return;
            }
            if (this._models.includes(settings.model)) {
                const thinkingLevel = normalizeThinkingLevelForModel({
                    model: settings.model,
                    thinkingLevel: settings.thinkingLevel,
                });
                if (thinkingLevel !== settings.thinkingLevel) {
                    await this._saveSettings({
                        provider: settings.provider,
                        model: settings.model,
                        thinkingLevel,
                    });
                }
            }
        } catch (error) {
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this._models = [];
            this._appendLocalErrorPanel(error.message);
        } finally {
            this._isLoadingModels = false;
            this._syncSettingsControls();
        }
    }

    async _selectModel() {
        const settings = this._getSettings();
        const model = this._elements.model.value;
        if (model === '') {
            throw new Error('AI model selection must not be empty');
        }
        const thinkingLevel = normalizeThinkingLevelForModel({
            model,
            thinkingLevel: settings.thinkingLevel,
        });
        await this._saveSettings({
            provider: settings.provider,
            model,
            thinkingLevel,
        });
        this._elements.input.focus();
    }

    async _selectThinkingLevel() {
        const settings = this._getSettings();
        const thinkingLevel = normalizeThinkingLevelForModel({
            model: settings.model,
            thinkingLevel: this._elements.thinkingLevel.value,
        });
        await this._saveSettings({
            provider: settings.provider,
            model: settings.model,
            thinkingLevel,
        });
        this._elements.input.focus();
    }

    async _loadSession({ shouldScrollToBottom }) {
        if (typeof shouldScrollToBottom !== 'boolean') {
            throw new Error('_loadSession requires boolean scroll behavior');
        }
        try {
            const payload = await loadAiChatSession();
            if (!payload || !Array.isArray(payload.messages)) {
                throw new Error('AI chat session response missing messages');
            }
            this._expandedThinkingMessageIds.clear();
            this._expandedReferenceMessageIds.clear();
            this._messages = payload.messages.map(validateMessage);
            this._render({ shouldScrollToBottom });
            await queueMermaidDiagramRendering(this._elements.messages);
        } catch (error) {
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this._appendLocalErrorPanel(error.message);
            throw error;
        }
    }

    async _clearSession() {
        if (this._isClearingSession) {
            return;
        }
        this._isClearingSession = true;
        this._render({ shouldScrollToBottom: true });
        try {
            if (this._isBusy) {
                const activeRequestCompletion = this._activeChatCompletion;
                if (!(activeRequestCompletion instanceof Promise)) {
                    throw new Error('Busy AI chat is missing its completion promise');
                }
                this._cancelActiveRequest();
                await activeRequestCompletion;
            }
            await clearAiChatSession();
        } catch (error) {
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            this._appendLocalErrorPanel(error.message);
            throw error;
        } finally {
            this._isClearingSession = false;
        }
        this._expandedThinkingMessageIds.clear();
        this._expandedReferenceMessageIds.clear();
        this._messages = [];
        this._render({ shouldScrollToBottom: true });
        await AgentDebugView.refreshIfOpen();
        this._elements.input.focus();
    }

    async _submitMessage() {
        if (this._isBusy) {
            return;
        }
        if (this._isLoadingModels) {
            return;
        }
        if (this._models.length === 0) {
            this._appendLocalErrorPanel('No AI models are available.');
            return;
        }
        const message = this._elements.input.value;
        if (message.trim() === '') {
            return;
        }
        const settings = this._getSettings();
        const scope = captureActiveAgentScope();
        const showDiagnostics = this._showDiagnosticActivities;
        if (!this._models.includes(settings.model)) {
            this._appendLocalErrorPanel('Select an available AI model first.');
            return;
        }

        const localTurnId = `local-${Date.now()}`;
        this._messages.push(
            {
                id: `${localTurnId}-user`,
                role: 'user',
                content: message,
                rendered_content: '',
                thinking: '',
                rendered_thinking: '',
                status: 'complete',
                error: '',
                provider: settings.provider,
                model: settings.model,
                activities: [],
            },
            {
                id: `${localTurnId}-assistant`,
                role: 'assistant',
                content: '',
                rendered_content: '',
                thinking: '',
                rendered_thinking: '',
                status: 'streaming',
                error: '',
                provider: settings.provider,
                model: settings.model,
                activities: [],
            },
        );
        const assistantMessage = this._messages[this._messages.length - 1];
        if (this._activeChatAbortController !== null) {
            throw new Error('AI chat abort controller already exists');
        }
        if (this._activeChatCompletion !== null) {
            throw new Error('AI chat completion promise already exists');
        }
        const abortController = new AbortController();
        this._activeChatAbortController = abortController;
        let resolveActiveChatCompletion;
        const activeChatCompletion = new Promise((resolve) => {
            resolveActiveChatCompletion = resolve;
        });
        if (typeof resolveActiveChatCompletion !== 'function') {
            throw new Error('AI chat completion resolver was not initialized');
        }
        this._activeChatCompletion = activeChatCompletion;
        this._elements.input.value = '';
        this._setBusy(true);
        this._startThinkingFeedback();
        this._render({ shouldScrollToBottom: true });

        let wasCancelled = false;
        try {
            await streamAiChat({
                settings,
                message,
                scope,
                showDiagnostics,
                signal: abortController.signal,
                onEvent: (event) => {
                    if (event.type === 'action_status') {
                        assistantMessage.activities.push({
                            sequence: assistantMessage.activities.length + 1,
                            action: event.action,
                            status: event.status,
                            label: event.label,
                            approx_input_tokens: event.approx_input_tokens,
                            output_tokens_received: event.output_tokens_received,
                            duration_ms: event.duration_ms,
                            received_at_ms: Date.now(),
                        });
                        void AgentDebugView.refreshIfOpen();
                    } else if (event.type === 'thinking_delta') {
                        assistantMessage.thinking += event.text;
                        assistantMessage.rendered_thinking = event.rendered_text;
                    } else if (event.type === 'content_delta') {
                        this._stopThinkingFeedback();
                        if (assistantMessage.content === '') {
                            this._expandedThinkingMessageIds.delete(assistantMessage.id);
                        }
                        assistantMessage.content += event.text;
                        assistantMessage.rendered_content = event.rendered_text;
                    } else if (event.type === 'done') {
                        assistantMessage.content = event.content;
                        assistantMessage.rendered_content = event.rendered_content;
                        assistantMessage.status = 'complete';
                        void AgentDebugView.refreshIfOpen();
                    } else if (event.type === 'error') {
                        assistantMessage.status = 'error';
                        assistantMessage.error = event.message;
                        void AgentDebugView.refreshIfOpen();
                    } else {
                        throw new Error(`Unknown AI chat event: ${event.type}`);
                    }
                    const shouldScrollToBottom = event.type !== 'done';
                    this._render({ shouldScrollToBottom });
                    if (
                        settings.provider === 'openai'
                        && (
                            (event.type === 'action_status' && event.status === 'completed')
                            || event.type === 'done'
                            || event.type === 'error'
                        )
                    ) {
                        void this._refreshOpenAiCostSnapshot();
                    }
                },
            });
        } catch (error) {
            if (abortController.signal.aborted) {
                wasCancelled = true;
                assistantMessage.activities.push({
                    sequence: assistantMessage.activities.length + 1,
                    action: 'cancel',
                    status: 'completed',
                    label: 'Cancelled by user',
                });
                assistantMessage.status = 'error';
                assistantMessage.error = 'Cancelled by user';
                this._render({ shouldScrollToBottom: true });
            } else if (error instanceof AiApiError) {
                assistantMessage.status = 'error';
                assistantMessage.error = error.message;
                this._render({ shouldScrollToBottom: true });
            } else {
                throw error;
            }
        } finally {
            if (settings.provider === 'openai') {
                await this._refreshOpenAiCostSnapshot();
            }
            this._stopThinkingFeedback();
            if (this._activeChatAbortController !== abortController) {
                throw new Error('AI chat abort controller changed during request');
            }
            this._activeChatAbortController = null;
            if (this._activeChatCompletion !== activeChatCompletion) {
                throw new Error('AI chat completion promise changed during request');
            }
            this._activeChatCompletion = null;
            this._setBusy(false);
            resolveActiveChatCompletion();
        }
        if (!wasCancelled) {
            await this._loadSession({ shouldScrollToBottom: false });
        }
        this._elements.input.focus();
    }

    _cancelActiveRequest() {
        if (!this._isBusy || this._activeChatAbortController === null) {
            throw new Error('Cannot cancel when no AI chat request is active');
        }
        if (this._activeChatAbortController.signal.aborted) {
            return;
        }
        const assistantMessage = this._messages[this._messages.length - 1];
        validateMessage(assistantMessage);
        assistantMessage.activities.push({
            sequence: assistantMessage.activities.length + 1,
            action: 'cancel',
            status: 'started',
            label: 'Cancelling request',
        });
        this._activeChatAbortController.abort();
        this._elements.send.textContent = 'Stopping…';
        this._elements.send.disabled = true;
        this._render({ shouldScrollToBottom: true });
    }

    _setBusy(isBusy) {
        if (typeof isBusy !== 'boolean') {
            throw new Error('_setBusy requires boolean');
        }
        this._isBusy = isBusy;
        this._syncComposerControlsDisabled();
    }

    _startThinkingFeedback() {
        if (this._thinkingTimerId !== 0 || this._thinkingStartedAtMs !== 0) {
            throw new Error('Thinking feedback timer is already running');
        }
        this._thinkingStartedAtMs = Date.now();
        this._thinkingTimerId = window.setInterval(() => {
            this._syncThinkingElapsed();
        }, 1000);
    }

    _stopThinkingFeedback() {
        if (this._thinkingTimerId !== 0) {
            window.clearInterval(this._thinkingTimerId);
        }
        this._thinkingTimerId = 0;
        this._thinkingStartedAtMs = 0;
    }

    _formatThinkingElapsed() {
        if (this._thinkingStartedAtMs === 0) {
            return '';
        }
        const elapsedSeconds = Math.floor((Date.now() - this._thinkingStartedAtMs) / 1000);
        return elapsedSeconds < 1 ? '' : `${elapsedSeconds}s`;
    }

    _syncThinkingElapsed() {
        const elapsed = this._formatThinkingElapsed();
        for (const element of this._elements.messages.querySelectorAll(
            '.ai-chat-thinking-elapsed',
        )) {
            element.textContent = elapsed;
        }
        for (const element of this._elements.messages.querySelectorAll(
            '.ai-chat-activity-elapsed.is-live',
        )) {
            const baseDurationMs = Number(element.dataset.baseDurationMs);
            const receivedAtMs = Number(element.dataset.receivedAtMs);
            if (!Number.isFinite(baseDurationMs) || !Number.isFinite(receivedAtMs)) {
                throw new Error('Live AI activity duration metadata is invalid');
            }
            element.textContent = this._formatActivityDuration(
                baseDurationMs + (Date.now() - receivedAtMs),
            );
        }
    }

    _formatActivityDuration(durationMs) {
        if (!Number.isFinite(durationMs) || durationMs < 0) {
            throw new Error('Activity duration must be non-negative and finite');
        }
        if (durationMs < 1_000) {
            return `${Math.round(durationMs)}ms`;
        }
        if (durationMs < 60_000) {
            return `${(durationMs / 1_000).toFixed(1)}s`;
        }
        const totalSeconds = Math.floor(durationMs / 1_000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    }

    _appendLocalErrorPanel(message) {
        if (typeof message !== 'string' || message === '') {
            throw new Error('_appendLocalErrorPanel requires a non-empty message');
        }
        this._localMessageSequence += 1;
        const settings = this._getSettings();
        this._messages.push({
            id: `local-error-${Date.now()}-${this._localMessageSequence}`,
            role: 'assistant',
            content: '',
            rendered_content: '',
            thinking: '',
            rendered_thinking: '',
            status: 'error',
            error: message,
            provider: settings.provider,
            model: settings.model,
            activities: [],
        });
        this._render({ shouldScrollToBottom: true });
    }

    _render({ shouldScrollToBottom }) {
        if (typeof shouldScrollToBottom !== 'boolean') {
            throw new Error('_render requires boolean scroll behavior');
        }
        const previousScrollTop = this._elements.messages.scrollTop;
        this._elements.messages.replaceChildren();
        for (const message of this._messages) {
            validateMessage(message);
            const article = document.createElement('article');
            article.className = `ai-chat-message ai-chat-message-${message.role}`;
            article.dataset.messageId = message.id;

            if (
                this._showDiagnosticActivities
                && message.role === 'assistant'
                && message.activities.length > 0
            ) {
                article.appendChild(this._renderActivities(message, 'diagnostic'));
            }
            if (!this._showDiagnosticActivities && message.role === 'assistant') {
                const persistentActivities = selectPersistentNonDiagnosticActivities(
                    message.activities,
                );
                if (persistentActivities.length > 0) {
                    article.appendChild(this._renderActivities({
                        ...message,
                        status: 'complete',
                        activities: persistentActivities,
                    }, 'persistent'));
                }
            }
            if (
                !this._showDiagnosticActivities
                && message.role === 'assistant'
                && message.status === 'streaming'
                && message.content === ''
            ) {
                article.appendChild(this._renderWorkingIndicator());
            }

            if (message.role === 'assistant' && message.thinking !== '') {
                const hasThinkingText = true;
                const isActivelyThinking = message.status === 'streaming' && message.content === '';
                const thinking = document.createElement(hasThinkingText ? 'details' : 'div');
                thinking.className = 'ai-chat-thinking';
                if (hasThinkingText) {
                    let shouldOpenThinking = isActivelyThinking;
                    if (this._expandedThinkingMessageIds.has(message.id)) {
                        shouldOpenThinking = true;
                    }
                    thinking.open = shouldOpenThinking;
                    thinking.addEventListener('toggle', () => {
                        if (isActivelyThinking) {
                            return;
                        }
                        if (thinking.open) {
                            this._expandedThinkingMessageIds.add(message.id);
                        } else {
                            this._expandedThinkingMessageIds.delete(message.id);
                        }
                    });
                }
                const heading = document.createElement(hasThinkingText ? 'summary' : 'div');
                heading.className = 'ai-chat-thinking-heading';
                heading.textContent = 'Thinking';
                if (isActivelyThinking) {
                    thinking.classList.add('is-streaming');
                    heading.setAttribute('aria-label', 'Thinking…');
                    const dots = document.createElement('span');
                    dots.className = 'ai-chat-thinking-dots';
                    dots.setAttribute('aria-hidden', 'true');
                    for (let index = 0; index < 3; index += 1) {
                        const dot = document.createElement('span');
                        dot.textContent = '.';
                        dots.appendChild(dot);
                    }
                    heading.appendChild(dots);
                    const elapsed = document.createElement('span');
                    elapsed.className = 'ai-chat-thinking-elapsed';
                    elapsed.textContent = this._formatThinkingElapsed();
                    elapsed.setAttribute('aria-hidden', 'true');
                    heading.appendChild(elapsed);
                }
                thinking.appendChild(heading);
                if (hasThinkingText) {
                    const thinkingText = document.createElement('div');
                    thinkingText.className = 'ai-chat-thinking-content meta-markdown';
                    thinkingText.setAttribute('data-markdown-rendered', 'true');
                    if (message.rendered_thinking === '') {
                        thinkingText.textContent = message.thinking;
                    } else {
                        thinkingText.innerHTML = message.rendered_thinking;
                    }
                    thinking.appendChild(thinkingText);
                }
                article.appendChild(thinking);
            }

            if (message.content !== '') {
                const content = document.createElement('div');
                content.className = 'ai-chat-message-content';
                if (message.role === 'assistant' && message.rendered_content !== '') {
                    content.classList.add('meta-markdown');
                    content.setAttribute('data-markdown-rendered', 'true');
                    content.innerHTML = message.rendered_content;
                } else {
                    content.textContent = message.content;
                }
                const referenceDisclosure = content.querySelector(
                    'details.ai-chat-references-disclosure',
                );
                if (referenceDisclosure !== null) {
                    if (!(referenceDisclosure instanceof HTMLDetailsElement)) {
                        throw new Error('AI chat reference disclosure must be details');
                    }
                    referenceDisclosure.open = (
                        this._expandedReferenceMessageIds.has(message.id)
                    );
                    referenceDisclosure.addEventListener('toggle', () => {
                        if (referenceDisclosure.open) {
                            this._expandedReferenceMessageIds.add(message.id);
                        } else {
                            this._expandedReferenceMessageIds.delete(message.id);
                        }
                    });
                }
                article.appendChild(content);
            }
            if (message.status === 'error') {
                const error = document.createElement('div');
                error.className = 'ai-chat-message-error';
                error.textContent = message.error;
                article.appendChild(error);
            }
            this._elements.messages.appendChild(article);
        }
        this._elements.clear.disabled = (
            this._messages.length === 0 || this._isClearingSession
        );
        if (shouldScrollToBottom) {
            this._elements.messages.scrollTop = this._elements.messages.scrollHeight;
            return;
        }
        this._elements.messages.scrollTop = previousScrollTop;
        this._revealReferencesHeaderAtViewportBottom();
    }

    _revealReferencesHeaderAtViewportBottom() {
        const lastMessage = this._elements.messages.lastElementChild;
        if (!(lastMessage instanceof HTMLElement)) {
            return;
        }
        const references = lastMessage.querySelector('.ai-chat-references');
        if (!(references instanceof HTMLElement)) {
            return;
        }
        const messagesBounds = this._elements.messages.getBoundingClientRect();
        const referencesBounds = references.getBoundingClientRect();
        const referenceTop = (
            referencesBounds.top
            - messagesBounds.top
            + this._elements.messages.scrollTop
        );
        const referencePreviewHeight = Math.min(
            48,
            Math.ceil(referencesBounds.height),
        );
        this._elements.messages.scrollTop = Math.max(
            0,
            Math.ceil(
                referenceTop
                - this._elements.messages.clientHeight
                + referencePreviewHeight
            ),
        );
    }

    _renderActivities(message, displayMode) {
        if (!['diagnostic', 'persistent'].includes(displayMode)) {
            throw new Error('Unknown AI chat activity display mode');
        }
        const isPersistentNotice = displayMode === 'persistent';
        const activities = document.createElement('div');
        activities.className = 'ai-chat-activities';
        const displayedActivities = collapseCompletedActivityPairs(message.activities);
        for (const [index, activity] of displayedActivities.entries()) {
            const panel = document.createElement('div');
            panel.className = 'ai-chat-activity-panel';
            panel.classList.toggle('is-persistent-notice', isPersistentNotice);
            panel.dataset.action = activity.action;
            const isCurrent = !isPersistentNotice
                && message.status === 'streaming'
                && message.content === ''
                && index === displayedActivities.length - 1;
            panel.classList.toggle('is-current', isCurrent);

            const marker = document.createElement('span');
            marker.className = 'ai-chat-activity-marker';
            marker.setAttribute('aria-hidden', 'true');
            marker.textContent = isPersistentNotice
                ? '!'
                : (activity.status === 'completed' ? '✓' : '•');
            const label = document.createElement('span');
            label.className = 'ai-chat-activity-label';
            const labelParts = splitSearchActivityLabel(activity);
            label.textContent = labelParts.statusLabel;
            if (labelParts.searchQuery !== '') {
                const query = document.createElement('code');
                query.className = 'ai-chat-activity-query';
                query.textContent = labelParts.searchQuery;
                label.append(document.createTextNode(' · '), query);
            }
            panel.append(marker, label);
            if (!isPersistentNotice) {
                const tokenCount = document.createElement('span');
                tokenCount.className = 'ai-chat-activity-token-count';
                tokenCount.textContent = (
                    `≈ ${activity.approx_input_tokens.toLocaleString()} input tokens`
                );
                tokenCount.title = (
                    'Approximate input size, estimated from the serialized request or current '
                    + 'agent context at four characters per token.'
                );
                panel.appendChild(tokenCount);
            }
            if (!isPersistentNotice && activity.output_tokens_received > 0) {
                const outputTokenCount = document.createElement('span');
                outputTokenCount.className = 'ai-chat-activity-output-token-count';
                outputTokenCount.textContent = (
                    `≈ ${activity.output_tokens_received.toLocaleString()} output tokens`
                );
                outputTokenCount.title = (
                    'Approximate generated size received so far, estimated at four '
                    + 'characters per token.'
                );
                if (activity.status === 'started') {
                    outputTokenCount.classList.add('is-live');
                    outputTokenCount.setAttribute('aria-label', (
                        `${activity.output_tokens_received.toLocaleString()} approximate `
                        + 'output tokens received so far'
                    ));
                }
                panel.appendChild(outputTokenCount);
            }
            if (!isPersistentNotice) {
                const elapsed = document.createElement('span');
                elapsed.className = 'ai-chat-activity-elapsed';
                elapsed.textContent = this._formatActivityDuration(activity.duration_ms);
                elapsed.setAttribute('aria-label', 'Step duration');
                if (
                    isCurrent
                    && activity.status === 'started'
                    && Number.isFinite(activity.received_at_ms)
                ) {
                    elapsed.classList.add('is-live');
                    elapsed.dataset.baseDurationMs = String(activity.duration_ms);
                    elapsed.dataset.receivedAtMs = String(activity.received_at_ms);
                }
                panel.appendChild(elapsed);
            }
            activities.appendChild(panel);
        }
        return activities;
    }

    _renderWorkingIndicator() {
        const indicator = document.createElement('div');
        indicator.className = 'ai-chat-working-indicator';
        indicator.setAttribute('role', 'status');

        const label = document.createElement('span');
        label.className = 'ai-chat-working-label';
        label.textContent = 'Working';

        const dots = document.createElement('span');
        dots.className = 'ai-chat-thinking-dots';
        dots.setAttribute('aria-hidden', 'true');
        for (let index = 0; index < 3; index += 1) {
            const dot = document.createElement('span');
            dot.textContent = '.';
            dots.appendChild(dot);
        }

        indicator.append(label, dots);
        return indicator;
    }
}


export const AiChatPanel = new AiChatPanelController();
