import {
    openProposalMenu,
    removeAllTagSuggestionsFromCurrentContext,
} from '../ai-chat/proposal-menu.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { actionRefreshAndMaybeSelect, showPerfOverlayFromCache } from '../mode-manager/actions/ui-actions.js';
import {
    actionDeselectNote,
    actionSaveAndExitEditingWithoutRefreshing,
} from '../mode-manager/actions/selection-actions.js';
import { FilesAPI, NotesAPI } from '../api-client.js';
import { CONFIG } from '../config.js';
import {
    loadClientState,
    persistClientPreferences,
    persistCommandPaletteUsage,
} from '../client-state-api.js';
import { migrateLegacyClientState } from '../client-state-migration.js';
import { ErrorHandler } from '../error-handler.js';
import {
    AddPasswordModal,
    ChangePasswordModal,
    RemovePasswordModal,
} from '../modals/password-modal.js';
import { SessionTimeoutModal } from '../modals/session-timeout-modal.js';
import { BackupRetentionModal } from '../modals/backup-retention-modal.js';
import { BackupResultModal } from '../modals/backup-result-modal.js';
import { BackupRestoreModal } from '../modals/backup-restore-modal.js';
import { BackupSettingsModal } from '../modals/backup-settings-modal.js';
import { OntologyModal } from '../modals/ontology-modal.js';
import { RandomPasswordModal } from '../modals/random-password-modal.js';
import { HelpModal } from '../modals/help-modal.js';
import {
    CreateNamespaceModal,
    ManageNamespacePortsModal,
    RenameNamespaceModal,
    SwitchNamespaceModal,
} from '../modals/namespace-modals.js';
import { DeleteNamespaceModal } from '../modals/delete-namespace-modal.js';
import { PrioritizeModal } from '../modals/prioritize-modal.js';
import { AlphabetizeRootNotesModal } from '../modals/alphabetize-root-notes-modal.js';
import { ResetUpdatedAtModal } from '../modals/reset-updated-at-modal.js';
import { ReminderModal } from '../modals/reminder-modal.js';
import { SoundManagerModal } from '../modals/sound-manager-modal.js';
import { VersionInfoModal } from '../modals/version-info-modal.js';
import { NoteLayoutAppearanceModal } from '../modals/note-layout-appearance-modal.js';
import { SearchSuggestionStatisticsModal } from '../modals/search-suggestion-statistics-modal.js';
import { ConfirmationModal } from '../modals/confirmation-modal.js';
import { AiAgentSettingsModal } from '../modals/ai-agent-settings-modal.js';
import { AgentPromptEditorModal } from '../modals/agent-prompt-editor-modal.js';
import {
    AGENT_PROMPT_PREFERENCE_KEYS,
    validateAgentInstructionSet,
} from '../ai-chat/agent-prompt-service.js';
import {
    AI_THINKING_LEVEL_OPTIONS,
    DEFAULT_AI_THINKING_LEVEL,
    validateAiThinkingLevel,
} from '../ai-chat/ai-thinking-level-service.js';
import {
    AGENT_RETRIEVAL_PREFERENCE_KEYS,
    OPENAI_AGENT_RETRIEVAL_PREFERENCE_KEYS,
    readAgentRetrievalSettings,
    validateAgentRetrievalSettings,
} from '../ai-chat/agent-retrieval-settings.js';
import {
    CLOUD_PRIVACY_POLICY_PREFERENCE_KEY,
    readCloudPrivacyPolicy,
    serializeCloudPrivacyPolicy,
    validateCloudPrivacyPolicy,
} from '../ai-chat/cloud-privacy-policy.js';
import {
    resolveSearchInputDisplayQuery,
    syncSearchInputValue,
} from '../mode-manager/services/search-input-service.js';
import { isViewingReferenceSource } from '../mode-manager/services/reference-source-navigation-service.js';
import { CommandGate } from '../mode-manager/services/command-gate-service.js';
import { cancelDebouncedSearchExecution } from '../mode-manager/services/search-debounce-service.js';
import { refreshBacklinksPanel, invalidateBacklinksPanelCache, syncBacklinksPanelPlacement } from '../mode-manager/services/backlinks-panel-service.js';
import { attachPickedFileToCurrentNote, pickFileForAttachment } from '../mode-manager/services/file-reference-service.js';
import { isRootReorderLocked, normalizeRootSortMode } from '../mode-manager/services/root-sort-service.js';
import { setTabSortModeOnServer } from '../mode-manager/services/tab-state-service.js';
import { settleResult } from '../async-result.js';
import { buildSessionHeaders } from '../session-auth.js';
import { isValidTagToken } from '../tag-token.js';
import { updateSearchContextsOverlayPlacement } from '../mode-manager/services/search-contexts-overlay-service.js';
import {
    DEFAULT_SEARCH_SUGGESTION_WINDOWS_VALUE,
    parseSearchSuggestionWindowsValue,
    serializeSearchSuggestionWindows,
    setLimitNoteCreditsPerSearchContextValue,
    setShowSearchSuggestionWindowLabelsValue,
    setSearchSuggestionWindowsValue,
} from '../mode-manager/services/search-suggestion-windows-service.js';

import { shouldActivateCommandPaletteRowClick } from './click-activation-service.js';
import { persistUsageBeforeActivation } from './activation-auth-policy.js';
import { waitForCommandAvailability } from './backup-command-availability.js';
import { buildCommandPaletteEndpoints } from './endpoint-registry.js';
import { PreferencesStore } from './preferences-store.js';
import { loadCommandPaletteTagMap } from './tag-config-loader.js';
import { UsageStore } from './usage-store.js';
import {
    DEFAULT_NOTE_LAYOUT_SETTINGS,
    NOTE_LAYOUT_OPTIONS,
    NOTE_LAYOUT_PREFERENCE_KEYS,
    applyNoteLayoutSettings,
    validateNoteLayoutSettings,
} from './note-layout-preferences.js';

function trimToken(token) {
    if (typeof token !== 'string') {
        throw new Error('trimToken requires string');
    }
    return token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

const BACKUP_COMMAND_AVAILABILITY_TIMEOUT_MS = 30000;
const BACKUP_COMMAND_AVAILABILITY_POLL_INTERVAL_MS = 50;

function resolveEffectiveTheme() {
    const explicitTheme = document.documentElement.getAttribute('data-theme');
    if (explicitTheme === 'dark' || explicitTheme === 'light') {
        return explicitTheme;
    }
    if (
        typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
        return 'dark';
    }
    return 'light';
}

function tokenizeQuery(rawQuery) {
    if (typeof rawQuery !== 'string') {
        throw new Error('tokenizeQuery requires rawQuery string');
    }

    const lower = rawQuery.toLowerCase();
    const endsWithSpace = lower.length > 0 && /\s$/.test(lower);
    const rawTokens = lower.split(/\s+/).filter((t) => t.length > 0);
    const cleanedTokens = rawTokens.map(trimToken).filter((t) => t.length > 0);

    if (cleanedTokens.length === 0) {
        return { committed: [], prefix: null };
    }

    if (endsWithSpace) {
        return { committed: cleanedTokens, prefix: null };
    }

    if (cleanedTokens.length === 1) {
        return { committed: [], prefix: cleanedTokens[0] };
    }

    return {
        committed: cleanedTokens.slice(0, cleanedTokens.length - 1),
        prefix: cleanedTokens[cleanedTokens.length - 1],
    };
}

function endpointMatchesTags(endpoint, committedTokens) {
    if (!endpoint || typeof endpoint !== 'object') {
        throw new Error('endpointMatchesTags requires endpoint');
    }
    if (!Array.isArray(committedTokens)) {
        throw new Error('endpointMatchesTags requires committedTokens array');
    }
    if (!(endpoint.tags instanceof Set)) {
        throw new Error('Endpoint missing tags Set');
    }

    for (const token of committedTokens) {
        if (typeof token !== 'string') {
            throw new Error('Committed tokens must be strings');
        }
        if (!endpoint.tags.has(token)) {
            return false;
        }
    }
    return true;
}

function endpointMatchesPrefix(endpoint, prefix) {
    if (!endpoint || typeof endpoint !== 'object') {
        throw new Error('endpointMatchesPrefix requires endpoint');
    }
    if (typeof prefix !== 'string' || prefix.length === 0) {
        throw new Error('endpointMatchesPrefix requires prefix string');
    }
    if (!(endpoint.tags instanceof Set)) {
        throw new Error('Endpoint missing tags Set');
    }

    for (const tag of endpoint.tags) {
        if (tag.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

function sortMatchesByUsage(matches, usageSnapshot) {
    if (!Array.isArray(matches)) {
        throw new Error('sortMatchesByUsage requires matches array');
    }
    if (!usageSnapshot || typeof usageSnapshot !== 'object') {
        throw new Error('sortMatchesByUsage requires usageSnapshot');
    }

    return matches.slice().sort((a, b) => {
        const au = Object.prototype.hasOwnProperty.call(usageSnapshot, a.id) ? usageSnapshot[a.id] : null;
        const bu = Object.prototype.hasOwnProperty.call(usageSnapshot, b.id) ? usageSnapshot[b.id] : null;

        const aCount = au && typeof au.count === 'number' ? au.count : 0;
        const bCount = bu && typeof bu.count === 'number' ? bu.count : 0;
        if (aCount !== bCount) {
            return bCount - aCount;
        }

        const aLast = au && typeof au.lastUsedAt === 'number' ? au.lastUsedAt : 0;
        const bLast = bu && typeof bu.lastUsedAt === 'number' ? bu.lastUsedAt : 0;
        if (aLast !== bLast) {
            return bLast - aLast;
        }

        return a.label.localeCompare(b.label);
    });
}

function computeSuggestedTags(matches, committedTokens, prefix, usageSnapshot) {
    if (!Array.isArray(matches)) {
        throw new Error('computeSuggestedTags requires matches array');
    }
    if (!Array.isArray(committedTokens)) {
        throw new Error('computeSuggestedTags requires committedTokens array');
    }
    if (prefix !== null && typeof prefix !== 'string') {
        throw new Error('computeSuggestedTags prefix must be string or null');
    }
    if (!usageSnapshot || typeof usageSnapshot !== 'object') {
        throw new Error('computeSuggestedTags requires usageSnapshot');
    }

    const committedSet = new Set(committedTokens);
    const total = matches.length;
    const tagStats = new Map();

    for (const endpoint of matches) {
        for (const tag of endpoint.tags) {
            if (committedSet.has(tag)) {
                continue;
            }
            if (prefix && !tag.startsWith(prefix)) {
                continue;
            }
            if (!tagStats.has(tag)) {
                tagStats.set(tag, { endpointIds: new Set(), usage: 0 });
            }
            const stat = tagStats.get(tag);
            stat.endpointIds.add(endpoint.id);
        }
    }

    for (const [tag, stat] of tagStats.entries()) {
        let usage = 0;
        for (const endpointId of stat.endpointIds) {
            const record = Object.prototype.hasOwnProperty.call(usageSnapshot, endpointId)
                ? usageSnapshot[endpointId]
                : null;
            if (record && typeof record.count === 'number') {
                usage += record.count;
            }
        }
        stat.usage = usage;
    }

    const suggestions = [];
    for (const [tag, stat] of tagStats.entries()) {
        const matchCount = stat.endpointIds.size;
        const narrowingPower = total > 0 ? (total - matchCount) / total : 0;
        suggestions.push({ tag, matchCount, narrowingPower, usage: stat.usage });
    }

    suggestions.sort((a, b) => {
        if (a.narrowingPower !== b.narrowingPower) {
            return b.narrowingPower - a.narrowingPower;
        }
        if (a.usage !== b.usage) {
            return b.usage - a.usage;
        }
        return a.tag.localeCompare(b.tag);
    });

    return suggestions.slice(0, 10).map((s) => s.tag);
}

class CommandPaletteController {
    constructor() {
        this._initialized = false;
        this._tagMap = null;
        this._allTags = new Set();
        this._endpoints = [];

        this._isOpen = false;
        this._previousActiveElement = null;
        this._previousScrollY = null;
        this._previousSelection = { query: '', selectedIndex: 0 };

        this._preferences = new PreferencesStore();
        this._usage = new UsageStore();

        this._ontologyModal = null;
        this._backupSettingsModal = null;
        this._backupRetentionModal = null;
        this._backupResultModal = null;
        this._backupRestoreModal = null;
        this._addPasswordModal = null;
        this._changePasswordModal = null;
        this._removePasswordModal = null;
        this._randomPasswordModal = null;
        this._helpModal = null;
        this._sessionTimeoutModal = null;
        this._switchNamespaceModal = null;
        this._createNamespaceModal = null;
        this._manageNamespacePortsModal = null;
        this._renameNamespaceModal = null;
        this._deleteNamespaceModal = null;
        this._prioritizeModal = null;
        this._alphabetizeRootNotesModal = null;
        this._resetUpdatedAtModal = null;
        this._reminderModal = null;
        this._soundManagerModal = null;
        this._versionInfoModal = null;
        this._noteLayoutAppearanceModal = null;
        this._searchSuggestionStatisticsModal = null;
        this._confirmationModal = null;
        this._aiAgentSettingsModal = null;
        this._agentPromptEditorModal = null;

        this._elements = null;

        this._handleKeyDown = this._handleKeyDown.bind(this);
        this._handleInput = this._handleInput.bind(this);
        this._handleClick = this._handleClick.bind(this);
        this._handleOpenRemindersRequest = this._handleOpenRemindersRequest.bind(this);
        this._handleOpenSoundManagerRequest = this._handleOpenSoundManagerRequest.bind(this);
    }

    async init() {
        if (this._initialized) {
            return;
        }
        const clientState = await migrateLegacyClientState({
            clientState: await loadClientState(),
            persistClientPreferencesFn: persistClientPreferences,
            persistCommandPaletteUsageFn: persistCommandPaletteUsage,
        });
        this._tagMap = await loadCommandPaletteTagMap();
        this._preferences.replaceAll(clientState.preferences);
        document.addEventListener('metalist:bulk-preferences', (event) => {
            this._preferences.replaceAll(event.detail);
        });

        this._usage.replaceAll(clientState.command_palette_usage);

        this._allTags.clear();
        for (const tags of this._tagMap.values()) {
            for (const tag of tags) {
                this._allTags.add(tag);
            }
        }

        this._endpoints = buildCommandPaletteEndpoints({
            preferencesStore: this._preferences,
            actions: {
                applyPreference: this.applyPreference.bind(this),
                openAddPassword: this.openAddPassword.bind(this),
                openChangePassword: this.openChangePassword.bind(this),
                openRemovePassword: this.openRemovePassword.bind(this),
                openSessionTimeoutSettings: this.openSessionTimeoutSettings.bind(this),
                openOntologyEditor: this.openOntologyEditor.bind(this),
                createBackup: this.createBackup.bind(this),
                openBackupRestore: this.openBackupRestore.bind(this),
                logout: this.logout.bind(this),
                openRandomPasswordGenerator: this.openRandomPasswordGenerator.bind(this),
                collapseAll: this.collapseAll.bind(this),
                expandAll: this.expandAll.bind(this),
                fullyCollapseAll: this.fullyCollapseAll.bind(this),
                fullyExpandAll: this.fullyExpandAll.bind(this),
                resetViewFilters: this.resetViewFilters.bind(this),
                resetAllPreferences: this.resetAllPreferences.bind(this),
                openSearchSuggestionStatistics: this.openSearchSuggestionStatistics.bind(this),
                openKeyboardShortcutsHelp: this.openKeyboardShortcutsHelp.bind(this),
                exportCurrentViewAsHtml: this.exportCurrentViewAsHtml.bind(this),
                attachFileToCurrentNote: this.attachFileToCurrentNote.bind(this),
                trimUnusedFiles: this.trimUnusedFiles.bind(this),
                openSwitchNamespace: this.openSwitchNamespace.bind(this),
                openCreateNamespace: this.openCreateNamespace.bind(this),
                openManageNamespacePorts: this.openManageNamespacePorts.bind(this),
                openRenameCurrentNamespace: this.openRenameCurrentNamespace.bind(this),
                openDeleteCurrentNamespace: this.openDeleteCurrentNamespace.bind(this),
                prioritizeTagToFront: this.prioritizeTagToFront.bind(this),
                prioritizeTagToBack: this.prioritizeTagToBack.bind(this),
                alphabetizeRootNotesAsc: this.alphabetizeRootNotesAsc.bind(this),
                alphabetizeRootNotesDesc: this.alphabetizeRootNotesDesc.bind(this),
                resetUpdatedAtToCreatedAt: this.resetUpdatedAtToCreatedAt.bind(this),
                openReminders: this.openReminders.bind(this),
                openSoundManager: this.openSoundManager.bind(this),
                openVersionInfo: this.openVersionInfo.bind(this),
                openNoteLayoutAppearance: this.openNoteLayoutAppearance.bind(this),
                getSortMode: this.getSortMode.bind(this),
                setSortMode: this.setSortMode.bind(this),
                getIsUntaggedView: this.getIsUntaggedView.bind(this),
                setIsUntaggedView: this.setIsUntaggedView.bind(this),
                openAiAgentSettings: this.openAiAgentSettings.bind(this),
                openCloudPrivacySettings: this.openCloudPrivacySettings.bind(this),
                openAgentPromptEditor: this.openAgentPromptEditor.bind(this),
                openProposalManager: async () => {
                    if (await this._prepareForModalOpen('proposalManager')) await openProposalMenu(this._preferences, false);
                },
                removeAllTagSuggestionsFromCurrentContext: async () => {
                    const confirmed = await this._confirmAction(
                        'commandPalette.removeAllTagSuggestionsFromCurrentContext.confirm',
                        {
                            eyebrow: 'Tag Proposals',
                            title: 'Remove all suggestions?',
                            description: 'Remove every pending tag suggestion in the current context? This cannot be undone and will clear undo/redo.',
                            confirmLabel: 'Remove all',
                            isDangerous: true,
                        },
                    );
                    if (confirmed) {
                        await removeAllTagSuggestionsFromCurrentContext();
                    }
                },
                openTaggingPrompt: async () => {
                    if (await this._prepareForModalOpen('taggingPrompt')) await openProposalMenu(this._preferences, true);
                },
            },
        });

        this._mergeAndValidateTags();
        this._ensureDom();

        this._applyPreferenceEffectsFromStorage();

        this._initialized = true;
        document.addEventListener('metalist:open-reminders', this._handleOpenRemindersRequest);
        document.addEventListener('metalist:open-sound-manager', this._handleOpenSoundManagerRequest);
    }

    _mergeAndValidateTags() {
        if (!(this._tagMap instanceof Map)) {
            throw new Error('Command palette tag map not loaded');
        }

        const endpointsById = new Map();
        for (const endpoint of this._endpoints) {
            if (!endpoint || typeof endpoint !== 'object') {
                throw new Error('Command palette endpoint registry contains invalid endpoint');
            }
            if (typeof endpoint.id !== 'string' || endpoint.id.length === 0) {
                throw new Error('Command palette endpoints must have id');
            }
            if (endpointsById.has(endpoint.id)) {
                throw new Error(`Duplicate command palette endpoint id: ${endpoint.id}`);
            }
            endpointsById.set(endpoint.id, endpoint);
        }

        for (const id of this._tagMap.keys()) {
            if (!endpointsById.has(id)) {
                throw new Error(`Tag config references unknown endpoint id: ${id}`);
            }
        }

        for (const endpoint of this._endpoints) {
            if (!this._tagMap.has(endpoint.id)) {
                throw new Error(`Endpoint ${endpoint.id} has no tag mapping in config`);
            }
            endpoint.tags = this._tagMap.get(endpoint.id);
        }
    }

    _ensureDom() {
        const existing = document.getElementById('command-palette-modal');
        if (existing) {
            this._elements = this._resolveElements(existing);
            return;
        }

        const modal = document.createElement('div');
        modal.id = 'command-palette-modal';
        modal.className = 'modal command-palette-modal';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="command-palette-panel" role="dialog" aria-modal="true">
                <div class="command-palette-input-row">
                    <input
                        id="command-palette-input"
                        class="command-palette-input"
                        type="text"
                        autocomplete="off"
                        autocorrect="off"
                        autocapitalize="off"
                        spellcheck="false"
                        placeholder="Type tags…"
                    />
                </div>
                <div id="command-palette-suggestions" class="command-palette-suggestions"></div>
                <div id="command-palette-results" class="command-palette-results"></div>
            </div>
        `;
        document.body.appendChild(modal);
        this._elements = this._resolveElements(modal);
    }

    _resolveElements(modal) {
        const panel = modal.querySelector('.command-palette-panel');
        const input = modal.querySelector('#command-palette-input');
        const suggestions = modal.querySelector('#command-palette-suggestions');
        const results = modal.querySelector('#command-palette-results');

        if (!(panel instanceof HTMLElement)) {
            throw new Error('Command palette panel missing');
        }
        if (!(input instanceof HTMLInputElement)) {
            throw new Error('Command palette input missing');
        }
        if (!(suggestions instanceof HTMLElement)) {
            throw new Error('Command palette suggestions missing');
        }
        if (!(results instanceof HTMLElement)) {
            throw new Error('Command palette results missing');
        }

        return { modal, panel, input, suggestions, results };
    }

    _applyPreferenceEffectsFromStorage() {
        const showBacklinks = this._getBoolean('pref.show_backlinks', true);
        document.body.classList.toggle('pref-show-backlinks', showBacklinks);

        const showTags = this._getBoolean('pref.show_note_tags', false);
        document.body.classList.toggle('pref-show-note-tags', showTags);

        const showTabUi = this._getBoolean('pref.show_tab_ui', false);
        document.body.classList.toggle('pref-show-tab-ui', showTabUi);

        const showSearchResultsCount = this._getBoolean(
            'pref.show_search_results_count',
            true,
        );
        document.body.classList.toggle(
            'pref-show-search-results-count',
            showSearchResultsCount,
        );

        const showAiChat = this._getBoolean('pref.show_ai_chat', false);
        const wasAiChatVisible = document.body.classList.contains('pref-show-ai-chat');
        document.body.classList.toggle('pref-show-ai-chat', showAiChat);

        if (wasAiChatVisible !== showAiChat) {
            document.dispatchEvent(new CustomEvent('metalist:ai-chat-visibility-changed', {
                detail: { isVisible: showAiChat },
            }));
        }

        const showPerfOverlay = this._getBoolean('pref.show_perf_overlay', false);
        document.body.classList.toggle('pref-show-perf-overlay', showPerfOverlay);
        if (!showPerfOverlay) {
            const perfOverlay = document.getElementById('perf-overlay');
            if (perfOverlay) {
                perfOverlay.remove();
            }
        }

        const animatedTransitions = this._getBoolean('pref.animated_transitions', true);
        document.body.classList.toggle('pref-animated-transitions', animatedTransitions);

        const storedSearchWindows = this._preferences.getRaw('pref.search_suggestion_windows');
        if (storedSearchWindows === null) {
            setSearchSuggestionWindowsValue(DEFAULT_SEARCH_SUGGESTION_WINDOWS_VALUE);
        } else {
            setSearchSuggestionWindowsValue(storedSearchWindows);
        }
        const showSearchWindowLabels = this._getBoolean(
            'pref.show_search_suggestion_window_labels',
            true,
        );
        setShowSearchSuggestionWindowLabelsValue(
            showSearchWindowLabels ? 'true' : 'false',
        );
        const limitNoteCreditsPerSearchContext = this._getBoolean(
            'pref.limit_note_credits_per_search_context',
            true,
        );
        setLimitNoteCreditsPerSearchContextValue(
            limitNoteCreditsPerSearchContext ? 'true' : 'false',
        );

        applyNoteLayoutSettings(document.body, this._readNoteLayoutSettings());

        const theme = this._getSelect('pref.theme', ['system', 'light', 'dark'], 'system');
        if (theme === 'system') {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.setAttribute('data-theme', theme);
        }

        const tabIndicator = document.getElementById('tab-indicator');
        if (tabIndicator) {
            tabIndicator.style.display = 'none';
        }

        const searchContextsList = document.getElementById('search-contexts-list');
        if (searchContextsList) {
            if (!showTabUi) {
                searchContextsList.style.display = 'none';
            }
            updateSearchContextsOverlayPlacement();
        }

        syncBacklinksPanelPlacement();
        invalidateBacklinksPanelCache();
        void refreshBacklinksPanel({ force: true });
    }

    _getBoolean(key, defaultValue) {
        if (typeof key !== 'string' || key.length === 0) {
            throw new Error('_getBoolean requires key string');
        }
        if (typeof defaultValue !== 'boolean') {
            throw new Error('_getBoolean requires defaultValue boolean');
        }

        const raw = this._preferences.getRaw(key);
        if (raw === null) {
            return defaultValue;
        }
        if (raw === 'true') {
            return true;
        }
        if (raw === 'false') {
            return false;
        }
        throw new Error(`Invalid stored boolean for ${key}`);
    }

    _getSelect(key, allowed, defaultValue) {
        if (typeof key !== 'string' || key.length === 0) {
            throw new Error('_getSelect requires key string');
        }
        if (!Array.isArray(allowed) || allowed.length === 0) {
            throw new Error('_getSelect requires allowed values array');
        }
        if (typeof defaultValue !== 'string' || defaultValue.length === 0) {
            throw new Error('_getSelect requires defaultValue string');
        }

        const raw = this._preferences.getRaw(key);
        if (raw === null) {
            return defaultValue;
        }
        if (!allowed.includes(raw)) {
            throw new Error(`Invalid stored select value for ${key}`);
        }
        return raw;
    }

    _readNoteLayoutSettings() {
        const allowedValues = (key) => NOTE_LAYOUT_OPTIONS[key].map((option) => option.value);
        return validateNoteLayoutSettings({
            topLevelNoteSize: this._getSelect(
                NOTE_LAYOUT_PREFERENCE_KEYS.topLevelNoteSize,
                allowedValues('topLevelNoteSize'),
                DEFAULT_NOTE_LAYOUT_SETTINGS.topLevelNoteSize,
            ),
            childIndentation: this._getSelect(
                NOTE_LAYOUT_PREFERENCE_KEYS.childIndentation,
                allowedValues('childIndentation'),
                DEFAULT_NOTE_LAYOUT_SETTINGS.childIndentation,
            ),
            verticalSpacing: this._getSelect(
                NOTE_LAYOUT_PREFERENCE_KEYS.verticalSpacing,
                allowedValues('verticalSpacing'),
                DEFAULT_NOTE_LAYOUT_SETTINGS.verticalSpacing,
            ),
        });
    }

    async _saveNoteLayoutSettings(settings) {
        const validated = validateNoteLayoutSettings(settings);
        await this._preferences.setMany({
            [NOTE_LAYOUT_PREFERENCE_KEYS.topLevelNoteSize]: validated.topLevelNoteSize,
            [NOTE_LAYOUT_PREFERENCE_KEYS.childIndentation]: validated.childIndentation,
            [NOTE_LAYOUT_PREFERENCE_KEYS.verticalSpacing]: validated.verticalSpacing,
        });
        this._applyPreferenceEffectsFromStorage();
    }

    getAiSettings() {
        const provider = this._getSelect(
            'pref.ai.provider',
            ['ollama', 'openai'],
            'ollama',
        );
        const ollamaRetrievalSettings = readAgentRetrievalSettings(
            (key) => this._preferences.getRaw(key),
            'ollama',
        );
        const openAiRetrievalSettings = readAgentRetrievalSettings(
            (key) => this._preferences.getRaw(key),
            'openai',
        );
        const retrievalSettings = provider === 'openai'
            ? openAiRetrievalSettings
            : ollamaRetrievalSettings;
        const modelPreferenceKey = provider === 'openai'
            ? 'pref.ai.openai_model'
            : 'pref.ai.ollama_model';
        return {
            provider,
            model: this._preferences.getRaw(modelPreferenceKey) ?? '',
            thinkingLevel: this._getSelect(
                'pref.ai.thinking_level',
                AI_THINKING_LEVEL_OPTIONS.map((option) => option.value),
                DEFAULT_AI_THINKING_LEVEL,
            ),
            ollamaRetrievalSettings,
            openAiRetrievalSettings,
            cloudPrivacyPolicy: readCloudPrivacyPolicy(
                (key) => this._preferences.getRaw(key),
            ),
            ...retrievalSettings,
        };
    }

    getAiChatPanelWidth() {
        const rawWidth = this._preferences.getRaw('pref.ai.chat_width');
        if (rawWidth === null) {
            return null;
        }
        const width = Number(rawWidth);
        if (
            !Number.isInteger(width)
            || width < 280
            || width > 5000
            || String(width) !== rawWidth
        ) {
            throw new Error('Stored AI chat width is invalid');
        }
        return width;
    }

    async saveAiChatPanelWidth(width) {
        if (!Number.isInteger(width) || width < 280 || width > 5000) {
            throw new Error('AI chat width must be an integer from 280 to 5000');
        }
        await this._preferences.setRaw('pref.ai.chat_width', String(width));
    }

    getAiChatDiagnosticsVisible() {
        return this._getBoolean('pref.ai.show_diagnostics', false);
    }

    async saveAiChatDiagnosticsVisible(isVisible) {
        if (typeof isVisible !== 'boolean') {
            throw new Error('AI chat diagnostic visibility must be boolean');
        }
        await this._preferences.setRaw(
            'pref.ai.show_diagnostics',
            isVisible ? 'true' : 'false',
        );
    }

    getAiChatComposerHeight() {
        const rawHeight = this._preferences.getRaw('pref.ai.composer_height');
        if (rawHeight === null) {
            return null;
        }
        const height = Number(rawHeight);
        if (
            !Number.isInteger(height)
            || height < 74
            || height > 220
            || String(height) !== rawHeight
        ) {
            throw new Error('Stored AI chat composer height is invalid');
        }
        return height;
    }

    async saveAiChatComposerHeight(height) {
        if (!Number.isInteger(height) || height < 74 || height > 220) {
            throw new Error('AI chat composer height must be an integer from 74 to 220');
        }
        await this._preferences.setRaw('pref.ai.composer_height', String(height));
    }

    async _saveAiSettings(settings) {
        if (!settings || typeof settings !== 'object') {
            throw new Error('_saveAiSettings requires settings object');
        }
        if (!['ollama', 'openai'].includes(settings.provider)) {
            throw new Error('Unsupported AI provider');
        }
        if (typeof settings.model !== 'string' || settings.model.trim() === '') {
            throw new Error('AI settings require model');
        }
        const thinkingLevel = validateAiThinkingLevel(settings.thinkingLevel);
        const modelPreferenceKey = settings.provider === 'openai'
            ? 'pref.ai.openai_model'
            : 'pref.ai.ollama_model';
        await this._preferences.setMany({
            'pref.ai.provider': settings.provider,
            [modelPreferenceKey]: settings.model.trim(),
            'pref.ai.thinking_level': thinkingLevel,
        });
        document.dispatchEvent(new CustomEvent(
            'metalist:ai-settings-changed',
            { detail: { reloadModels: false } },
        ));
    }

    async saveAiSettings(settings) {
        await this._saveAiSettings(settings);
    }

    async _saveAiAgentSettings(settings) {
        if (!settings || typeof settings !== 'object') {
            throw new Error('_saveAiAgentSettings requires settings object');
        }
        if (!['ollama', 'openai'].includes(settings.provider)) {
            throw new Error('Unsupported AI provider');
        }
        if (typeof settings.model !== 'string' || settings.model.trim() === '') {
            throw new Error('AI connection settings require model');
        }
        const ollamaRetrievalSettings = validateAgentRetrievalSettings(
            settings.ollamaRetrievalSettings,
            'ollama',
        );
        const openAiRetrievalSettings = validateAgentRetrievalSettings(
            settings.openAiRetrievalSettings,
            'openai',
        );
        const cloudPrivacyPolicy = validateCloudPrivacyPolicy(
            settings.cloudPrivacyPolicy,
        );
        const modelPreferenceKey = settings.provider === 'openai'
            ? 'pref.ai.openai_model'
            : 'pref.ai.ollama_model';
        await this._preferences.setMany({
            'pref.ai.provider': settings.provider,
            [modelPreferenceKey]: settings.model.trim(),
            [AGENT_RETRIEVAL_PREFERENCE_KEYS.maxPageApproximateTokens]: String(
                ollamaRetrievalSettings.maxPageApproximateTokens,
            ),
            [OPENAI_AGENT_RETRIEVAL_PREFERENCE_KEYS.maxPageApproximateTokens]: String(
                openAiRetrievalSettings.maxPageApproximateTokens,
            ),
            [AGENT_RETRIEVAL_PREFERENCE_KEYS.taggingBatchTokens]: String(ollamaRetrievalSettings.taggingBatchTokens),
            [OPENAI_AGENT_RETRIEVAL_PREFERENCE_KEYS.taggingBatchTokens]: String(openAiRetrievalSettings.taggingBatchTokens),
            [CLOUD_PRIVACY_POLICY_PREFERENCE_KEY]: serializeCloudPrivacyPolicy(
                cloudPrivacyPolicy,
            ),
        });
        document.dispatchEvent(new CustomEvent(
            'metalist:ai-settings-changed',
            { detail: { reloadModels: true } },
        ));
    }

    _readAgentPromptOverrides(skills) {
        if (!Array.isArray(skills) || skills.length === 0) {
            throw new Error('Agent prompt editor requires packaged skills');
        }
        return {
            systemPrompt: this._preferences.getRaw(
                AGENT_PROMPT_PREFERENCE_KEYS.systemPrompt,
            ),
            finalResponsePrompt: this._preferences.getRaw(
                AGENT_PROMPT_PREFERENCE_KEYS.finalResponsePrompt,
            ),
            toolResultPrompt: this._preferences.getRaw(
                AGENT_PROMPT_PREFERENCE_KEYS.toolResultPrompt,
            ),
            skills: skills.map((skill) => ({
                skillId: skill.skillId,
                content: this._preferences.getRaw(skill.preferenceKey),
                incompatiblePreferenceKeys: skill.supersededPreferenceKeys.filter(
                    (key) => this._preferences.getRaw(key) !== null,
                ),
            })),
        };
    }

    async _saveAgentPromptOverrides(settings) {
        const instructions = validateAgentInstructionSet(settings);
        const preferences = {
            [AGENT_PROMPT_PREFERENCE_KEYS.systemPrompt]: instructions.systemPrompt,
            [AGENT_PROMPT_PREFERENCE_KEYS.finalResponsePrompt]: instructions.finalResponsePrompt,
            [AGENT_PROMPT_PREFERENCE_KEYS.toolResultPrompt]: instructions.toolResultPrompt,
        };
        for (const skill of instructions.skills) {
            preferences[skill.preferenceKey] = skill.content;
        }
        const supersededKeys = instructions.skills.flatMap(
            (skill) => skill.supersededPreferenceKeys,
        );
        await this._preferences.setManyAndRemove(preferences, supersededKeys);
    }

    async _resetAgentPromptOverrides(skills) {
        if (!Array.isArray(skills) || skills.length === 0) {
            throw new Error('Agent prompt reset requires packaged skills');
        }
        await this._preferences.removeMany(
            [
                ...Object.values(AGENT_PROMPT_PREFERENCE_KEYS),
                ...skills.map((skill) => skill.preferenceKey),
                ...skills.flatMap((skill) => skill.supersededPreferenceKeys),
            ],
        );
    }

    isOpen() {
        return this._isOpen;
    }

    async toggle() {
        if (!this._initialized) {
            await this.init();
        }

        if (this._isOpen) {
            this.close();
            return;
        }

        await this.open();
    }

    async open() {
        if (!this._initialized) {
            await this.init();
        }
        if (this._isOpen) {
            throw new Error('Command palette already open');
        }
        if (ModeContext.isLoading) {
            return;
        }
        if (ModeContext.modalStack && ModeContext.modalStack.length > 0) {
            return;
        }

        // Opening a menu is not a mutation; successful bulk actions set their own boundary.
        cancelDebouncedSearchExecution();

        this._previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this._previousScrollY = Math.max(0, Math.round(window.scrollY));

        ModeContext.pushModal('commandPalette');

        const { modal, input } = this._elements;
        modal.style.display = 'block';
        this._isOpen = true;

        this._previousSelection.query = input.value;
        this._previousSelection.selectedIndex = 0;
        input.value = '';

        this._render();
        input.focus();

        document.addEventListener('keydown', this._handleKeyDown, { capture: true });
        input.addEventListener('input', this._handleInput);
        modal.addEventListener('click', this._handleClick);
    }

    close() {
        if (!this._isOpen) {
            throw new Error('Command palette is not open');
        }

        const { modal, input } = this._elements;
        modal.style.display = 'none';
        this._isOpen = false;

        document.removeEventListener('keydown', this._handleKeyDown, { capture: true });
        input.removeEventListener('input', this._handleInput);
        modal.removeEventListener('click', this._handleClick);

        ModeContext.removeModal('commandPalette');

        if (typeof this._previousScrollY === 'number') {
            window.scrollTo(0, this._previousScrollY);
        }

        if (this._previousActiveElement) {
            this._previousActiveElement.focus();
        }

        this._previousActiveElement = null;
        this._previousScrollY = null;
    }

    _handleClick(event) {
        if (!event) {
            throw new Error('Command palette click handler missing event');
        }
        const { modal } = this._elements;
        if (event.target === modal) {
            this.close();
        }
    }

    _handleInput() {
        this._render();
    }

    async _handleKeyDown(event) {
        if (!event) {
            throw new Error('Command palette key handler missing event');
        }
        if (!this._isOpen) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.close();
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            this._previousSelection.selectedIndex += 1;
            this._render();
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            this._previousSelection.selectedIndex -= 1;
            this._render();
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            await this._activateSelected();
            return;
        }

        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            const direction = event.key === 'ArrowLeft' ? -1 : 1;
            await this._adjustSelected(direction);
        }
    }

    _render() {
        const { input, suggestions, results } = this._elements;
        const usageSnapshot = this._usage.getUsageSnapshot();

        const tokenization = tokenizeQuery(input.value);
        const committedTokens = tokenization.committed;
        const prefix = tokenization.prefix;

        const baseMatches = this._endpoints.filter((e) => endpointMatchesTags(e, committedTokens));

        let matches = baseMatches;
        if (typeof prefix === 'string' && prefix.length > 0) {
            matches = baseMatches.filter((e) => endpointMatchesPrefix(e, prefix));
        }

        if (committedTokens.length === 0) {
            matches = sortMatchesByUsage(matches, usageSnapshot);
        } else {
            matches = matches.slice().sort((a, b) => a.label.localeCompare(b.label));
        }

        const suggested = computeSuggestedTags(baseMatches, committedTokens, prefix, usageSnapshot);
        suggestions.innerHTML = '';
        for (const tag of suggested) {
            const el = document.createElement('span');
            el.className = 'command-palette-suggestion';
            el.textContent = tag;
            el.addEventListener('click', () => {
                const nextQuery = committedTokens.concat([tag]).join(' ') + ' ';
                input.value = nextQuery;
                this._previousSelection.selectedIndex = 0;
                this._render();
                input.focus();
            });
            suggestions.appendChild(el);
        }

        results.innerHTML = '';
        if (matches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'command-palette-empty';

            const offender = this._findOffendingToken(committedTokens);
            if (offender) {
                empty.textContent = `No matches (try removing: ${offender})`;
            } else {
                empty.textContent = 'No matches';
            }
            results.appendChild(empty);

            let nearMissToken = null;
            if (typeof prefix === 'string' && prefix.length > 0) {
                nearMissToken = prefix;
            } else if (typeof offender === 'string' && offender.length > 0) {
                nearMissToken = offender;
            }

            const nearMisses = this._nearMissTags(nearMissToken);
            if (nearMisses.length > 0) {
                const hint = document.createElement('div');
                hint.className = 'command-palette-empty';
                hint.textContent = `Similar tags: ${nearMisses.join(', ')}`;
                results.appendChild(hint);
            }
            return;
        }

        const normalizedIndex = ((this._previousSelection.selectedIndex % matches.length) + matches.length) % matches.length;
        this._previousSelection.selectedIndex = normalizedIndex;

        for (let idx = 0; idx < matches.length; idx += 1) {
            const endpoint = matches[idx];
            const row = document.createElement('div');
            row.className = 'command-palette-row' + (idx === normalizedIndex ? ' selected' : '');
            row.dataset.endpointId = endpoint.id;

            const label = document.createElement('div');
            label.className = 'command-palette-row-label';
            label.textContent = endpoint.label;
            row.appendChild(label);

            const value = document.createElement('div');
            value.className = 'command-palette-row-value';
            value.textContent = this._formatEndpointValue(endpoint);
            row.appendChild(value);

            row.addEventListener('click', async () => {
                if (!shouldActivateCommandPaletteRowClick({
                    row,
                    selection: window.getSelection(),
                })) {
                    return;
                }
                this._previousSelection.selectedIndex = idx;
                await this._activateSelected();
            });

            results.appendChild(row);
        }
    }

    _findOffendingToken(committedTokens) {
        if (!Array.isArray(committedTokens) || committedTokens.length === 0) {
            return null;
        }

        for (let idx = 0; idx < committedTokens.length; idx += 1) {
            const candidate = committedTokens[idx];
            const reduced = committedTokens.slice(0, idx).concat(committedTokens.slice(idx + 1));
            const matches = this._endpoints.filter((e) => endpointMatchesTags(e, reduced));
            if (matches.length > 0) {
                return candidate;
            }
        }
        return null;
    }

    _nearMissTags(token) {
        if (token === null || typeof token === 'undefined') {
            return [];
        }
        if (typeof token !== 'string' || token.length === 0) {
            return [];
        }

        const maxResults = 8;
        const lower = token.toLowerCase();
        const prefixMatches = [];
        for (const tag of this._allTags) {
            if (tag.startsWith(lower)) {
                prefixMatches.push(tag);
            }
        }
        prefixMatches.sort();
        if (prefixMatches.length > 0) {
            return prefixMatches.slice(0, maxResults);
        }

        const editMatches = [];
        for (const tag of this._allTags) {
            if (this._editDistanceAtMostOne(lower, tag)) {
                editMatches.push(tag);
            }
        }
        editMatches.sort();
        return editMatches.slice(0, maxResults);
    }

    _editDistanceAtMostOne(a, b) {
        if (typeof a !== 'string' || typeof b !== 'string') {
            throw new Error('_editDistanceAtMostOne requires strings');
        }
        if (a === b) {
            return true;
        }
        const lenDiff = Math.abs(a.length - b.length);
        if (lenDiff > 1) {
            return false;
        }

        const shorter = a.length <= b.length ? a : b;
        const longer = a.length <= b.length ? b : a;

        let i = 0;
        let j = 0;
        let edits = 0;
        while (i < shorter.length && j < longer.length) {
            if (shorter[i] === longer[j]) {
                i += 1;
                j += 1;
                continue;
            }
            edits += 1;
            if (edits > 1) {
                return false;
            }
            if (shorter.length === longer.length) {
                i += 1;
                j += 1;
            } else {
                j += 1;
            }
        }
        if (i < shorter.length || j < longer.length) {
            edits += 1;
        }
        return edits <= 1;
    }

    _formatEndpointValue(endpoint) {
        if (endpoint.kind === 'boolean') {
            const value = this._getBoolean(endpoint.persistenceKey, endpoint.defaultValue);
            return value ? '[x]' : '[ ]';
        }
        if (endpoint.kind === 'select') {
            const raw = this._getSelectValue(endpoint);
            const option = endpoint.options.find((o) => o.value === raw);
            return option ? option.label : raw;
        }
        if (endpoint.kind === 'action') {
            if (typeof endpoint.getValue === 'function') {
                const value = endpoint.getValue();
                if (typeof value !== 'string') {
                    throw new Error(`Endpoint ${endpoint.id} returned invalid action value`);
                }
                return value;
            }
            return '↵';
        }
        if (endpoint.kind === 'form') {
            return '…';
        }
        return '';
    }

    _getVisibleMatches() {
        const { input } = this._elements;
        const tokenization = tokenizeQuery(input.value);
        const committed = tokenization.committed;
        const prefix = tokenization.prefix;
        const usageSnapshot = this._usage.getUsageSnapshot();

        const baseMatches = this._endpoints.filter((e) => endpointMatchesTags(e, committed));
        let matches = baseMatches;
        if (typeof prefix === 'string' && prefix.length > 0) {
            matches = baseMatches.filter((e) => endpointMatchesPrefix(e, prefix));
        }

        if (committed.length === 0) {
            matches = sortMatchesByUsage(matches, usageSnapshot);
        } else {
            matches = matches.slice().sort((a, b) => a.label.localeCompare(b.label));
        }
        return matches;
    }

    async _activateSelected() {
        const matches = this._getVisibleMatches();
        if (matches.length === 0) {
            return;
        }
        const idx = this._previousSelection.selectedIndex;
        const normalized = ((idx % matches.length) + matches.length) % matches.length;
        const endpoint = matches[normalized];

        const tokenization = tokenizeQuery(this._elements.input.value);

        const usageTokens = [];
        for (const token of tokenization.committed) {
            usageTokens.push(token);
        }
        if (typeof tokenization.prefix === 'string' && tokenization.prefix.length > 0) {
            usageTokens.push(tokenization.prefix);
        }
        const canActivate = await persistUsageBeforeActivation({
            persistUsage: () => this._usage.recordUse(endpoint.id, usageTokens),
            handleAuthenticationRequired: (message) => ErrorHandler.handleAuthError(message),
        });
        if (!canActivate) {
            return;
        }

        if (endpoint.kind === 'boolean') {
            const current = this._getBoolean(endpoint.persistenceKey, endpoint.defaultValue);
            await endpoint.apply(!current);
            this._render();
            return;
        }
        if (endpoint.kind === 'select') {
            const current = this._getSelectValue(endpoint);
            const next = endpoint.options.findIndex((o) => o.value === current);
            const index = next >= 0 ? (next + 1) % endpoint.options.length : 0;
            await endpoint.apply(endpoint.options[index].value);
            this._render();
            return;
        }
        if (typeof endpoint.execute === 'function') {
            if (endpoint.closeOnExecute === true && this._isOpen) {
                this.close();
            }
            await endpoint.execute();
            if (this._isOpen) {
                this._render();
            }
        }
    }

    async _adjustSelected(direction) {
        if (direction !== -1 && direction !== 1) {
            throw new Error('_adjustSelected requires direction -1 or 1');
        }
        const matches = this._getVisibleMatches();
        if (matches.length === 0) {
            return;
        }
        const idx = this._previousSelection.selectedIndex;
        const normalized = ((idx % matches.length) + matches.length) % matches.length;
        const endpoint = matches[normalized];
        if (endpoint.kind !== 'select') {
            return;
        }

        const current = this._getSelectValue(endpoint);
        const currentIndex = endpoint.options.findIndex((o) => o.value === current);
        const baseIndex = currentIndex >= 0 ? currentIndex : 0;
        const nextIndex = ((baseIndex + direction) % endpoint.options.length + endpoint.options.length) % endpoint.options.length;
        await endpoint.apply(endpoint.options[nextIndex].value);
        this._render();
    }

    _getSelectValue(endpoint) {
        if (!endpoint || typeof endpoint !== 'object') {
            throw new Error('_getSelectValue requires endpoint object');
        }
        const allowed = endpoint.options.map((o) => o.value);
        if (typeof endpoint.getValue === 'function') {
            const raw = endpoint.getValue();
            if (!allowed.includes(raw)) {
                throw new Error(`Endpoint ${endpoint.id} returned invalid select value`);
            }
            return raw;
        }
        return this._getSelect(endpoint.persistenceKey, allowed, endpoint.defaultValue);
    }

    async applyPreference(prefKey, value) {
        if (typeof prefKey !== 'string' || prefKey.length === 0) {
            throw new Error('applyPreference requires prefKey string');
        }
        if (typeof value === 'boolean') {
            await this._preferences.setRaw(prefKey, value ? 'true' : 'false');
            this._applyPreferenceEffectsFromStorage();
            if (prefKey === 'pref.show_perf_overlay' && value) {
                const hadCache = showPerfOverlayFromCache();
                if (!hadCache) {
                    await actionRefreshAndMaybeSelect({
                        startedAt: performance.now(),
                        context: 'pref.show_perf_overlay',
                    });
                }
            }
            return;
        }
        if (typeof value === 'string') {
            await this._preferences.setRaw(prefKey, value);
            this._applyPreferenceEffectsFromStorage();
            return;
        }
        throw new Error('applyPreference requires boolean or string value');
    }

    async resetAllPreferences() {
        await this._preferences.clearAll();
        this._applyPreferenceEffectsFromStorage();
    }

    async _performSearchSuggestionHistoryReset() {
        const result = await CommandGate.run('search.reset_suggestion_history', async () => {
            const payload = await NotesAPI.resetSearchSuggestionHistory();
            if (!payload || typeof payload !== 'object') {
                throw new Error('Reset search suggestion history response missing body');
            }
            if (!Number.isInteger(payload.deletedCount) || payload.deletedCount < 0) {
                throw new Error('Reset search suggestion history response requires deletedCount');
            }
            return payload;
        });
        if (result === null) {
            throw new Error('Reset search suggestion history was blocked by another command');
        }
        return true;
    }

    async _confirmAction(commandName, context) {
        const isReady = await this._prepareForModalOpen(commandName);
        if (!isReady) {
            return false;
        }
        if (this._confirmationModal === null) {
            this._confirmationModal = new ConfirmationModal();
        }
        return await this._confirmationModal.openForConfirmation(context);
    }

    _readSearchSuggestionWindows() {
        const storedValue = this._preferences.getRaw('pref.search_suggestion_windows');
        if (storedValue === null) {
            return parseSearchSuggestionWindowsValue(DEFAULT_SEARCH_SUGGESTION_WINDOWS_VALUE);
        }
        return parseSearchSuggestionWindowsValue(storedValue);
    }

    _readShowSearchSuggestionWindowLabels() {
        return this._getBoolean('pref.show_search_suggestion_window_labels', true);
    }

    _readLimitNoteCreditsPerSearchContext() {
        return this._getBoolean('pref.limit_note_credits_per_search_context', true);
    }

    async _saveSearchSuggestionWindows(
        windowDays,
        showWindowLabels,
        limitNoteCreditsPerSearchContext,
    ) {
        if (typeof showWindowLabels !== 'boolean') {
            throw new Error('showWindowLabels must be boolean');
        }
        if (typeof limitNoteCreditsPerSearchContext !== 'boolean') {
            throw new Error('limitNoteCreditsPerSearchContext must be boolean');
        }
        const serialized = serializeSearchSuggestionWindows(windowDays);
        await this._preferences.setMany({
            'pref.search_suggestion_windows': serialized,
            'pref.show_search_suggestion_window_labels': showWindowLabels ? 'true' : 'false',
            'pref.limit_note_credits_per_search_context': (
                limitNoteCreditsPerSearchContext ? 'true' : 'false'
            ),
        });
        this._applyPreferenceEffectsFromStorage();
    }

    getSortMode() {
        return ModeContext.activeTabSortMode;
    }

    async setSortMode(sortMode) {
        const normalizedSortMode = normalizeRootSortMode(sortMode);
        const activeTabId = ModeContext.activeTabId;
        if (typeof activeTabId !== 'string' || activeTabId.length === 0) {
            throw new Error('ModeContext.activeTabId must be a non-empty string');
        }

        const currentSortMode = ModeContext.activeTabSortMode;
        if (currentSortMode === normalizedSortMode) {
            return;
        }

        if (ModeContext.isEditing) {
            await actionSaveAndExitEditingWithoutRefreshing();
        }

        ModeContext.bumpUndoContextEpoch(`sortMode.${normalizedSortMode}`);
        const response = await setTabSortModeOnServer(activeTabId, normalizedSortMode);
        ModeContext.hydrateTabState(response, { emitUpdate: false });
        ModeContext.clearTabRevealedRedactions(activeTabId);
        ModeContext.resetTabDiffCache(activeTabId, { preserveRootAnchor: false });
        // Sort-mode changes often run while the view is already positioned at top.
        if (ModeContext.getTabScrollPosition(activeTabId) !== 0) {
            ModeContext.updateTabScroll(activeTabId, 0, false);
        }
        // updateTabScroll and resetTabDiffCache both clear anchors for the sorted view.
        if (ModeContext.getTabScrollAnchor(activeTabId) !== null) {
            ModeContext.updateTabScrollAnchor(activeTabId, null, false);
        }
        // resetTabDiffCache clears the root anchor unless preserveRootAnchor is set.
        if (ModeContext.getRootAnchorId() !== null) {
            ModeContext.setRootAnchorId(null);
        }

        ModeContext.beginIgnoreScrollEvents();
        window.scrollTo(0, 0);
        ModeContext.endIgnoreScrollEvents();

        await actionRefreshAndMaybeSelect({
            startedAt: performance.now(),
            context: `sortMode.${normalizedSortMode}`,
            animateNoteChanges: false,
        });
    }

    getIsUntaggedView() {
        return ModeContext.isUntaggedView;
    }

    async setIsUntaggedView(isUntaggedView) {
        if (typeof isUntaggedView !== 'boolean') {
            throw new Error('isUntaggedView must be a boolean');
        }
        const activeTabId = ModeContext.activeTabId;
        if (typeof activeTabId !== 'string' || activeTabId.length === 0) {
            throw new Error('ModeContext.activeTabId must be a non-empty string');
        }
        if (ModeContext.isUntaggedView === isUntaggedView) {
            return;
        }

        if (ModeContext.isEditing) {
            await actionSaveAndExitEditingWithoutRefreshing();
        }

        ModeContext.bumpUndoContextEpoch(`untaggedView.${isUntaggedView ? 'on' : 'off'}`);
        ModeContext.setUntaggedView(isUntaggedView);
        const searchInput = document.getElementById('search-input');
        if (!(searchInput instanceof HTMLInputElement)) {
            throw new Error('search-input missing from DOM');
        }
        syncSearchInputValue(
            searchInput,
            resolveSearchInputDisplayQuery(
                ModeContext.searchQuery,
                isUntaggedView,
                isViewingReferenceSource(),
            ),
        );
        ModeContext.clearTabRevealedRedactions(activeTabId);
        ModeContext.resetTabDiffCache(activeTabId, { preserveRootAnchor: false });
        if (ModeContext.getTabScrollPosition(activeTabId) !== 0) {
            ModeContext.updateTabScroll(activeTabId, 0, false);
        }
        if (ModeContext.getTabScrollAnchor(activeTabId) !== null) {
            ModeContext.updateTabScrollAnchor(activeTabId, null, false);
        }
        if (ModeContext.getRootAnchorId() !== null) {
            ModeContext.setRootAnchorId(null);
        }

        ModeContext.beginIgnoreScrollEvents();
        window.scrollTo(0, 0);
        ModeContext.endIgnoreScrollEvents();

        await actionRefreshAndMaybeSelect({
            startedAt: performance.now(),
            context: `untaggedView.${isUntaggedView ? 'on' : 'off'}`,
            animateNoteChanges: false,
        });
    }

    async exportCurrentViewAsHtml() {
        if (this.isOpen()) {
            this.close();
        }

        const exportResult = await settleResult(async () => {
            const result = await CommandGate.run('commandPalette.exportCurrentViewAsHtml', async () => {
                if (ModeContext.isEditing) {
                    await actionSaveAndExitEditingWithoutRefreshing();
                }

                const payload = await NotesAPI.exportCurrentViewAsHtml(resolveEffectiveTheme());
                if (!payload || typeof payload !== 'object') {
                    throw new Error('HTML export response missing body');
                }
                if (!(payload.blob instanceof Blob)) {
                    throw new Error('HTML export response missing blob');
                }
                if (typeof payload.filename !== 'string' || payload.filename.length === 0) {
                    throw new Error('HTML export response missing filename');
                }
                return payload;
            }, {
                timeoutMs: 120000,
            });
            return result;
        });

        if (!exportResult.ok) {
            const error = exportResult.error;
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('HTML export failed');
            ErrorHandler.showErrorBanner(
                `Export as HTML failed: ${message}`,
                'error',
                10000,
                true,
            );
            return;
        }

        const payload = exportResult.value;
        if (payload === null) {
            return;
        }

        const objectUrl = URL.createObjectURL(payload.blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = payload.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => {
            URL.revokeObjectURL(objectUrl);
        }, 0);
    }

    async attachFileToCurrentNote() {
        if (this.isOpen()) {
            this.close();
        }

        const attachResult = await settleResult(async () => {
            const preferredNoteId = ModeContext.isEditing ? ModeContext.currentNoteId : null;
            const file = await pickFileForAttachment();
            if (file === null) {
                ErrorHandler.showInfoBanner('Attach file canceled or no file was selected.', 5000);
                return null;
            }

            const result = await CommandGate.run('commandPalette.attachFileToCurrentNote', async () => {
                return await attachPickedFileToCurrentNote(file, preferredNoteId);
            }, {
                timeoutMs: 120000,
            });
            if (result === null) {
                ErrorHandler.showErrorBanner(
                    'Attach file did not start because another command is still running.',
                    'error',
                    10000,
                    true,
                );
            }
            return result;
        });
        if (!attachResult.ok) {
            const error = attachResult.error;
            if (
                error instanceof Error
                && (error.message.includes('File upload failed:') || error.message.includes('API call failed:'))
            ) {
                throw error;
            }
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('Attach file failed');
            ErrorHandler.showErrorBanner(
                `Attach file failed: ${message}`,
                'error',
                10000,
                true,
            );
        }
    }

    async trimUnusedFiles() {
        const confirmed = await this._confirmAction(
            'commandPalette.trimUnusedFiles.confirm',
            {
                eyebrow: 'File Storage',
                title: 'Trim Unused Files?',
                description: 'Delete every file that is not referenced by a saved note? This cannot be undone.',
                confirmLabel: 'Trim files',
                isDangerous: true,
            },
        );
        if (!confirmed) {
            return;
        }

        const result = await CommandGate.run('commandPalette.trimUnusedFiles', async () => {
            if (ModeContext.isEditing) {
                await actionSaveAndExitEditingWithoutRefreshing();
            }

            const payload = await FilesAPI.trimUnusedFiles();
            if (!payload || typeof payload !== 'object') {
                throw new Error('Trim unused files response missing body');
            }
            if (!Number.isInteger(payload.deleted_count) || payload.deleted_count < 0) {
                throw new Error('Trim unused files response missing deleted_count');
            }
            if (!Array.isArray(payload.deleted_file_ids)) {
                throw new Error('Trim unused files response missing deleted_file_ids');
            }

            await actionRefreshAndMaybeSelect({});
            return payload;
        });
        if (result === null) {
            return;
        }

        ErrorHandler.showInfoBanner(
            `Trimmed ${result.deleted_count} unused file(s).`,
            6000,
        );
    }

    async _prioritizeTag(direction) {
        if (direction !== 'front' && direction !== 'back') {
            throw new Error("direction must be 'front' or 'back'");
        }
        if (isRootReorderLocked(ModeContext.activeTabSortMode)) {
            ErrorHandler.showInfoBanner(
                'Root-note reordering is disabled while a sort order is active.',
                5000,
            );
            return;
        }
        const isReady = await this._prepareForModalOpen(`commandPalette.prioritize.${direction}`);
        if (!isReady) {
            return;
        }

        const searchQuery = ModeContext.searchQuery;
        if (typeof searchQuery !== 'string') {
            throw new Error('ModeContext.searchQuery must be a string');
        }

        if (this._prioritizeModal === null) {
            this._prioritizeModal = new PrioritizeModal();
        }

        const tag = await this._prioritizeModal.openForDirection({
            direction,
            searchQuery,
        });
        if (tag === null) {
            return;
        }
        if (!isValidTagToken(tag)) {
            ErrorHandler.showErrorBanner(
                'That input is not a valid tag token. This action only supports a single tag (no spaces, quotes, regex, or parentheses).',
                'error',
                10000,
                true,
            );
            return;
        }

        const result = await CommandGate.run(`commandPalette.prioritize.${direction}`, async () => {
            if (ModeContext.isEditing) {
                await actionSaveAndExitEditingWithoutRefreshing();
            }

            const payload = await NotesAPI.prioritize(tag, direction, searchQuery);
            if (!payload || typeof payload !== 'object') {
                throw new Error('Prioritize response missing body');
            }

            if (payload.status === 'moved') {
                ModeContext.bumpUndoContextEpoch(`prioritize.${direction}`);
                await actionRefreshAndMaybeSelect({
                    resetViewCacheBeforeFetch: true,
                    scrollToTopAfterRender: direction === 'front',
                    context: `prioritize.${direction}`,
                });
            }
            return payload;
        }, {
            showLoadingImmediately: true,
            timeoutMs: 120000,
        });
        if (result === null) {
            return;
        }
        if (result.status === 'noop') {
            if (result.reason === 'no_matches') {
                ErrorHandler.showInfoBanner(`No root notes matched tag "${tag}".`, 6000);
                return;
            }
            if (result.reason === 'already_prioritized') {
                ErrorHandler.showInfoBanner(`Tag "${tag}" is already prioritized to the ${direction}.`, 6000);
                return;
            }
        }
    }

    async prioritizeTagToFront() {
        await this._prioritizeTag('front');
    }

    async prioritizeTagToBack() {
        await this._prioritizeTag('back');
    }

    async _alphabetizeRootNotes(direction) {
        if (direction !== 'asc' && direction !== 'desc') {
            throw new Error("direction must be 'asc' or 'desc'");
        }
        if (isRootReorderLocked(ModeContext.activeTabSortMode)) {
            ErrorHandler.showInfoBanner(
                'Root-note reordering is disabled while a sort order is active.',
                5000,
            );
            return;
        }
        const isReady = await this._prepareForModalOpen(`commandPalette.alphabetizeRootNotes.${direction}`);
        if (!isReady) {
            return;
        }

        const searchQuery = ModeContext.searchQuery;
        if (typeof searchQuery !== 'string') {
            throw new Error('ModeContext.searchQuery must be a string');
        }

        if (this._alphabetizeRootNotesModal === null) {
            this._alphabetizeRootNotesModal = new AlphabetizeRootNotesModal();
        }

        const confirmed = await this._alphabetizeRootNotesModal.openForDirection({
            direction,
            searchQuery,
        });
        if (!confirmed) {
            return;
        }

        const result = await CommandGate.run(`commandPalette.alphabetizeRootNotes.${direction}`, async () => {
            if (ModeContext.isEditing) {
                await actionSaveAndExitEditingWithoutRefreshing();
            }

            const payload = await NotesAPI.alphabetizeRootNotes(direction, searchQuery);
            if (!payload || typeof payload !== 'object') {
                throw new Error('Alphabetize root notes response missing body');
            }

            if (payload.status === 'moved') {
                ModeContext.bumpUndoContextEpoch(`alphabetizeRootNotes.${direction}`);
                await actionRefreshAndMaybeSelect({});
            }
            return payload;
        });
        if (result === null) {
            return;
        }
        if (result.status === 'noop') {
            if (result.reason === 'not_enough_roots') {
                ErrorHandler.showInfoBanner('There are not enough visible root notes to alphabetize.', 6000);
                return;
            }
            if (result.reason === 'already_alphabetized') {
                const directionLabel = direction === 'asc' ? 'A-Z' : 'Z-A';
                ErrorHandler.showInfoBanner(`Visible root notes are already alphabetized ${directionLabel}.`, 6000);
                return;
            }
        }
    }

    async alphabetizeRootNotesAsc() {
        await this._alphabetizeRootNotes('asc');
    }

    async alphabetizeRootNotesDesc() {
        await this._alphabetizeRootNotes('desc');
    }

    async resetUpdatedAtToCreatedAt() {
        const isReady = await this._prepareForModalOpen('commandPalette.resetUpdatedAtToCreatedAt');
        if (!isReady) {
            return;
        }

        const searchQuery = ModeContext.searchQuery;
        if (typeof searchQuery !== 'string') {
            throw new Error('ModeContext.searchQuery must be a string');
        }

        if (this._resetUpdatedAtModal === null) {
            this._resetUpdatedAtModal = new ResetUpdatedAtModal();
        }

        const confirmed = await this._resetUpdatedAtModal.openForSearchContext({
            searchQuery,
        });
        if (!confirmed) {
            return;
        }

        const result = await CommandGate.run('commandPalette.resetUpdatedAtToCreatedAt', async () => {
            if (ModeContext.isEditing) {
                await actionSaveAndExitEditingWithoutRefreshing();
            }

            const payload = await NotesAPI.resetUpdatedAtToCreatedAt(searchQuery);
            if (!payload || typeof payload !== 'object') {
                throw new Error('Reset updated-at response missing body');
            }

            if (payload.status === 'updated') {
                ModeContext.bumpUndoContextEpoch('resetUpdatedAtToCreatedAt');
                await actionRefreshAndMaybeSelect({
                    resetViewCacheBeforeFetch: true,
                    context: 'resetUpdatedAtToCreatedAt',
                });
            }
            return payload;
        });
        if (result === null) {
            return;
        }
        if (result.status === 'noop') {
            if (result.reason === 'no_roots') {
                ErrorHandler.showInfoBanner('There are no root notes in the current view.', 6000);
                return;
            }
            if (result.reason === 'already_reset') {
                ErrorHandler.showInfoBanner('Root updated times already match created times in the current view.', 6000);
                return;
            }
        }
        if (result.status === 'updated') {
            ErrorHandler.showInfoBanner(`Reset updated time on ${result.changedNoteCount} note(s).`, 6000);
        }
    }

    async resetViewFilters() {
        const result = await CommandGate.run('commandPalette.resetViewFilters', async () => {
            ModeContext.bumpUndoContextEpoch('commandPalette.resetViewFilters');

            if (ModeContext.isEditing) {
                await actionSaveAndExitEditingWithoutRefreshing();
            }

            if (ModeContext.isUntaggedView) {
                ModeContext.setUntaggedView(false);
            }

            const searchInput = document.getElementById('search-input');
            if (!(searchInput instanceof HTMLInputElement)) {
                throw new Error('search-input missing from DOM');
            }
            const analysis = syncSearchInputValue(searchInput, '');
            // Reset can be invoked when filters are already clear.
            if (ModeContext.searchQuery !== analysis.normalizedText) {
                ModeContext.setSearchQuery(analysis.normalizedText);
            }
            ModeContext.clearActiveTabDiffCacheForSearchExecution(analysis.normalizedText);
            ModeContext.resetRootTracking({ clear: true });
            window.scrollTo(0, 0);
            // Reset can be invoked from an already-top unfiltered view.
            if (ModeContext.getTabScrollPosition(ModeContext.activeTabId) !== 0) {
                ModeContext.updateActiveTabScroll(0);
            }
            // updateActiveTabScroll and resetRootTracking leave anchors null.
            if (ModeContext.getTabScrollAnchor(ModeContext.activeTabId) !== null) {
                ModeContext.updateActiveTabScrollAnchor(null, true);
            }
            // resetRootTracking clears the root anchor before refresh.
            if (ModeContext.getRootAnchorId() !== null) {
                ModeContext.setRootAnchorId(null);
            }

            await actionRefreshAndMaybeSelect({});
        });
        if (result === null) {
            return;
        }
    }

    async collapseAll() {
        await this._setAllNotesCollapsed('collapseAll', true, false);
    }

    async expandAll() {
        await this._setAllNotesCollapsed('expandAll', false, false);
    }

    async fullyCollapseAll() {
        await this._setAllNotesCollapsed('fullyCollapseAll', true, true);
    }

    async fullyExpandAll() {
        await this._setAllNotesCollapsed('fullyExpandAll', false, true);
    }

    async _setAllNotesCollapsed(commandName, collapsed, recursive) {
        if (typeof commandName !== 'string' || commandName.length === 0) {
            throw new Error('_setAllNotesCollapsed requires commandName');
        }
        if (typeof collapsed !== 'boolean' || typeof recursive !== 'boolean') {
            throw new Error('_setAllNotesCollapsed requires boolean state');
        }
        const result = await CommandGate.run(`commandPalette.${commandName}`, async () => {
            ModeContext.bumpUndoContextEpoch(`commandPalette.${commandName}`);
            if (ModeContext.isEditing) {
                await actionSaveAndExitEditingWithoutRefreshing();
            }

            const searchQuery = ModeContext.searchQuery;
            if (typeof searchQuery !== 'string') {
                throw new Error('ModeContext.searchQuery must be a string');
            }

            await NotesAPI.setCollapsedInContext(searchQuery, collapsed, recursive);
            await actionRefreshAndMaybeSelect({ animateNoteChanges: false });
        });
        if (result === null) {
            return;
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
            if (payload && typeof payload === 'object' && typeof payload.detail === 'string') {
                throw new Error(`Request failed (${response.status}): ${payload.detail}`);
            }
            throw new Error(`Request failed (${response.status})`);
        }

        if (payload === null) {
            throw new Error('Response payload missing');
        }
        return payload;
    }

    _clearSessionState() {
        sessionStorage.removeItem('metalist_client_id');
    }

    _getBackupRetentionPromptThreshold() {
        const threshold = CONFIG.BACKUP.RETENTION_PROMPT_THRESHOLD;
        if (!Number.isInteger(threshold) || threshold <= 0) {
            throw new Error('CONFIG.BACKUP.RETENTION_PROMPT_THRESHOLD must be a positive integer');
        }
        return threshold;
    }

    _getBackupRetentionSuggestedKeepCount() {
        const suggestedKeepCount = CONFIG.BACKUP.RETENTION_SUGGESTED_KEEP_COUNT;
        if (!Number.isInteger(suggestedKeepCount) || suggestedKeepCount <= 0) {
            throw new Error('CONFIG.BACKUP.RETENTION_SUGGESTED_KEEP_COUNT must be a positive integer');
        }
        return suggestedKeepCount;
    }

    async _prepareForModalOpen(commandName) {
        if (typeof commandName !== 'string' || commandName.length === 0) {
            throw new Error('_prepareForModalOpen requires commandName');
        }
        if (ModeContext.isEditing) {
            const result = await CommandGate.run(`${commandName}.exitEditing`, async () => {
                await actionDeselectNote();
            });
            if (result === null) {
                return false;
            }
        }
        if (ModeContext.isSearching) {
            ModeContext.setSearching(false);
        }
        if (this.isOpen()) {
            this.close();
        }
        return true;
    }

    async _handleOpenRemindersRequest(event) {
        if (!event || typeof event !== 'object') {
            throw new Error('Open reminders event missing');
        }
        const detail = event.detail;
        if (!detail || typeof detail !== 'object') {
            throw new Error('Open reminders event detail missing');
        }
        if (typeof detail.search !== 'string') {
            throw new Error('Open reminders search must be string');
        }
        await this.openReminders({ search: detail.search });
    }

    async _handleOpenSoundManagerRequest(event) {
        if (!event || typeof event !== 'object') {
            throw new Error('Open sound manager event missing');
        }
        await this.openSoundManager();
    }

    async _listBackupsForRetentionPrompt() {
        const payload = await this._authRequest(CONFIG.API.AUTH.BACKUP.LIST, 'GET', null);
        if (!payload || typeof payload !== 'object') {
            throw new Error('Backup list response missing body');
        }
        if (!Array.isArray(payload.backups)) {
            throw new Error('Backup list response missing backups array');
        }
        return payload.backups;
    }

    async _openBackupRetentionModal(retentionContext) {
        if (!retentionContext || typeof retentionContext !== 'object') {
            throw new Error('_openBackupRetentionModal requires retentionContext object');
        }
        if (this._backupRetentionModal === null) {
            this._backupRetentionModal = new BackupRetentionModal();
        }
        const isReady = await this._prepareForModalOpen('commandPalette.backupRetention');
        if (!isReady) {
            return null;
        }

        return await this._backupRetentionModal.openForBackup(retentionContext);
    }

    async _openBackupResultModal(resultContext) {
        if (!resultContext || typeof resultContext !== 'object') {
            throw new Error('_openBackupResultModal requires resultContext object');
        }
        if (this._backupResultModal === null) {
            this._backupResultModal = new BackupResultModal();
        }
        const isReady = await this._prepareForModalOpen('commandPalette.backupResult');
        if (!isReady) {
            return;
        }

        await this._backupResultModal.openWithResult(resultContext);
    }

    async _openBackupSettingsModal() {
        if (this._backupSettingsModal === null) {
            this._backupSettingsModal = new BackupSettingsModal();
        }
        const isReady = await this._prepareForModalOpen('commandPalette.backupSettings');
        if (!isReady) {
            return null;
        }
        return await this._backupSettingsModal.openForBackup();
    }

    async _maybeDeleteOldestBackupsAfterCreate(createdFilename) {
        if (typeof createdFilename !== 'string' || createdFilename.length === 0) {
            throw new Error('_maybeDeleteOldestBackupsAfterCreate requires createdFilename');
        }

        const backups = await this._listBackupsForRetentionPrompt();
        const backupCount = backups.length;
        const threshold = this._getBackupRetentionPromptThreshold();
        if (backupCount < threshold) {
            return {
                deletedCount: 0,
                remainingCount: backupCount,
            };
        }
        const suggestedKeepCount = this._getBackupRetentionSuggestedKeepCount();

        const modalResult = await this._openBackupRetentionModal({
            createdFilename,
            backupCount,
            suggestedKeepCount,
        });
        if (modalResult === null) {
            return {
                deletedCount: 0,
                remainingCount: backupCount,
            };
        }
        if (!modalResult || typeof modalResult !== 'object') {
            throw new Error('Retention modal result missing');
        }

        if (modalResult.action !== 'apply') {
            return {
                deletedCount: 0,
                remainingCount: backupCount,
            };
        }
        if (!Number.isInteger(modalResult.keepCount)) {
            throw new Error('Retention modal result missing keepCount');
        }

        const keepCount = modalResult.keepCount;
        if (keepCount < 1 || keepCount > backupCount) {
            throw new Error(`keepCount out of range: ${keepCount}`);
        }

        const deleteCount = backupCount - keepCount;
        if (deleteCount <= 0) {
            return {
                deletedCount: 0,
                remainingCount: backupCount,
            };
        }

        const payload = await this._authRequest(CONFIG.API.AUTH.BACKUP.DELETE_OLDEST, 'POST', {
            count: deleteCount,
        });
        if (!payload || typeof payload !== 'object') {
            throw new Error('Backup delete response missing body');
        }
        if (!Array.isArray(payload.deleted_backups)) {
            throw new Error('Backup delete response missing deleted_backups array');
        }
        const deletedCount = payload.deleted_backups.length;
        const remainingCount = backupCount - deletedCount;
        if (remainingCount < 0) {
            throw new Error(`remainingCount must be non-negative, got ${remainingCount}`);
        }
        return {
            deletedCount,
            remainingCount,
        };
    }

    async createBackup() {
        const modalResult = await this._openBackupSettingsModal();
        if (modalResult === null) {
            return;
        }
        if (!modalResult || typeof modalResult !== 'object') {
            throw new Error('Backup settings modal result missing');
        }
        if (modalResult.action !== 'run_backup') {
            return;
        }
        const backupSettings = modalResult.settings;
        if (!backupSettings || typeof backupSettings !== 'object') {
            throw new Error('Backup settings modal result missing settings');
        }

        await waitForCommandAvailability({
            isBusy: () => CommandGate.isBusy(),
            isLoading: () => ModeContext.isLoading,
            timeoutMs: BACKUP_COMMAND_AVAILABILITY_TIMEOUT_MS,
            pollIntervalMs: BACKUP_COMMAND_AVAILABILITY_POLL_INTERVAL_MS,
        });
        const backupResult = await CommandGate.run('commandPalette.createBackup', async () => {
            const payload = await this._authRequest(CONFIG.API.BACKUP.RUN, 'POST', backupSettings);
            if (!payload || typeof payload !== 'object') {
                throw new Error('Backup run response missing body');
            }
            if (!Array.isArray(payload.results) || payload.results.length === 0) {
                throw new Error('Backup run response missing results');
            }
            return payload.results;
        }, {
            timeoutMs: 120000,
        });
        if (backupResult === null) {
            throw new Error('Backup command was dropped after waiting for browser availability');
        }
        if (!Array.isArray(backupResult) || backupResult.length === 0) {
            throw new Error('Backup run expected results array from CommandGate');
        }

        await this._openBackupResultModal({
            results: backupResult,
        });
    }

    async logout() {
        const result = await CommandGate.run('commandPalette.logout', async () => {
            if (ModeContext.isEditing) {
                await actionSaveAndExitEditingWithoutRefreshing();
            }

            await fetch(CONFIG.API.AUTH.LOGOUT, {
                method: 'POST',
                headers: buildSessionHeaders(true),
            }).finally(() => {
                this._clearSessionState();
                window.location.reload();
            });
        });
        if (result === null) {
            return;
        }
    }

    async openBackupRestore() {
        const isReady = await this._prepareForModalOpen('commandPalette.openBackupRestore');
        if (!isReady) {
            return;
        }

        if (this._backupRestoreModal === null) {
            this._backupRestoreModal = new BackupRestoreModal();
        }
        this._backupRestoreModal.open();
    }

    async openRandomPasswordGenerator() {
        const isReady = await this._prepareForModalOpen('commandPalette.openRandomPasswordGenerator');
        if (!isReady) {
            return;
        }

        if (this._randomPasswordModal === null) {
            this._randomPasswordModal = new RandomPasswordModal();
        }
        this._randomPasswordModal.open();
    }

    async openOntologyEditor() {
        const isReady = await this._prepareForModalOpen('commandPalette.openOntologyEditor');
        if (!isReady) {
            return;
        }

        if (this._ontologyModal === null) {
            this._ontologyModal = new OntologyModal();
        }
        this._ontologyModal.open();
    }

    async openKeyboardShortcutsHelp() {
        const isReady = await this._prepareForModalOpen('commandPalette.openKeyboardShortcutsHelp');
        if (!isReady) {
            return;
        }

        if (this._helpModal === null) {
            this._helpModal = new HelpModal();
        }
        this._helpModal.open();
    }

    async openSwitchNamespace() {
        const isReady = await this._prepareForModalOpen('commandPalette.openSwitchNamespace');
        if (!isReady) {
            return;
        }

        if (this._switchNamespaceModal === null) {
            this._switchNamespaceModal = new SwitchNamespaceModal();
        }
        this._switchNamespaceModal.open();
    }

    async openCreateNamespace() {
        const isReady = await this._prepareForModalOpen('commandPalette.openCreateNamespace');
        if (!isReady) {
            return;
        }

        if (this._createNamespaceModal === null) {
            this._createNamespaceModal = new CreateNamespaceModal();
        }
        this._createNamespaceModal.open();
    }

    async openManageNamespacePorts() {
        const isReady = await this._prepareForModalOpen('commandPalette.openManageNamespacePorts');
        if (!isReady) {
            return;
        }

        if (this._manageNamespacePortsModal === null) {
            this._manageNamespacePortsModal = new ManageNamespacePortsModal();
        }
        this._manageNamespacePortsModal.open();
    }

    async openRenameCurrentNamespace() {
        const isReady = await this._prepareForModalOpen('commandPalette.openRenameCurrentNamespace');
        if (!isReady) {
            return;
        }

        if (this._renameNamespaceModal === null) {
            this._renameNamespaceModal = new RenameNamespaceModal();
        }
        this._renameNamespaceModal.open();
    }

    async openDeleteCurrentNamespace() {
        const isReady = await this._prepareForModalOpen('commandPalette.openDeleteCurrentNamespace');
        if (!isReady) {
            return;
        }

        if (this._deleteNamespaceModal === null) {
            this._deleteNamespaceModal = new DeleteNamespaceModal();
        }
        this._deleteNamespaceModal.open();
    }

    async openAddPassword() {
        const isReady = await this._prepareForModalOpen('commandPalette.openAddPassword');
        if (!isReady) {
            return;
        }

        if (this._addPasswordModal === null) {
            this._addPasswordModal = new AddPasswordModal();
        }
        this._addPasswordModal.open();
    }

    async openChangePassword() {
        const isReady = await this._prepareForModalOpen('commandPalette.openChangePassword');
        if (!isReady) {
            return;
        }

        if (this._changePasswordModal === null) {
            this._changePasswordModal = new ChangePasswordModal();
        }
        this._changePasswordModal.open();
    }

    async openRemovePassword() {
        const isReady = await this._prepareForModalOpen('commandPalette.openRemovePassword');
        if (!isReady) {
            return;
        }

        if (this._removePasswordModal === null) {
            this._removePasswordModal = new RemovePasswordModal();
        }
        this._removePasswordModal.open();
    }

    async openSessionTimeoutSettings() {
        const isReady = await this._prepareForModalOpen('commandPalette.openSessionTimeoutSettings');
        if (!isReady) {
            return;
        }

        if (this._sessionTimeoutModal === null) {
            this._sessionTimeoutModal = new SessionTimeoutModal();
        }
        this._sessionTimeoutModal.open();
    }

    async openReminders(options = {}) {
        if (!options || typeof options !== 'object') {
            throw new Error('openReminders options must be object');
        }
        const search = Object.prototype.hasOwnProperty.call(options, 'search') ? options.search : '';
        if (typeof search !== 'string') {
            throw new Error('openReminders search must be string');
        }
        if (this._reminderModal !== null && this._reminderModal.isOpen) {
            this._reminderModal.setSearchQuery(search);
            return;
        }
        const isReady = await this._prepareForModalOpen('commandPalette.openReminders');
        if (!isReady) {
            return;
        }

        if (this._reminderModal === null) {
            this._reminderModal = new ReminderModal();
        }
        this._reminderModal.open({ search });
    }

    async openSoundManager() {
        const isReady = await this._prepareForModalOpen('commandPalette.openSoundManager');
        if (!isReady) {
            return;
        }
        if (this._soundManagerModal === null) {
            this._soundManagerModal = new SoundManagerModal();
        }
        this._soundManagerModal.open();
    }

    async openVersionInfo() {
        const isReady = await this._prepareForModalOpen('commandPalette.openVersionInfo');
        if (!isReady) {
            return;
        }
        if (this._versionInfoModal === null) {
            this._versionInfoModal = new VersionInfoModal();
        }
        this._versionInfoModal.open();
    }

    async openNoteLayoutAppearance() {
        const isReady = await this._prepareForModalOpen('commandPalette.openNoteLayoutAppearance');
        if (!isReady) {
            return;
        }
        if (this._noteLayoutAppearanceModal === null) {
            this._noteLayoutAppearanceModal = new NoteLayoutAppearanceModal(
                this._readNoteLayoutSettings.bind(this),
                this._saveNoteLayoutSettings.bind(this),
            );
        }
        this._noteLayoutAppearanceModal.open();
    }

    async openAiAgentSettings(focusCloudPrivacy = false) {
        if (typeof focusCloudPrivacy !== 'boolean') {
            throw new Error('openAiAgentSettings requires boolean focusCloudPrivacy');
        }
        const isReady = await this._prepareForModalOpen('commandPalette.openAiAgentSettings');
        if (!isReady) {
            return;
        }
        if (this._aiAgentSettingsModal === null) {
            this._aiAgentSettingsModal = new AiAgentSettingsModal(
                this.getAiSettings.bind(this),
                this._saveAiAgentSettings.bind(this),
            );
        }
        this._aiAgentSettingsModal.open();
        if (focusCloudPrivacy) {
            this._aiAgentSettingsModal.focusCloudPrivacySettings();
        }
    }

    async openCloudPrivacySettings() {
        await this.openAiAgentSettings(true);
    }

    async openAgentPromptEditor() {
        const isReady = await this._prepareForModalOpen(
            'commandPalette.openAgentPromptEditor',
        );
        if (!isReady) {
            return;
        }
        if (this._agentPromptEditorModal === null) {
            this._agentPromptEditorModal = new AgentPromptEditorModal(
                this._readAgentPromptOverrides.bind(this),
                this._saveAgentPromptOverrides.bind(this),
                this._resetAgentPromptOverrides.bind(this),
            );
        }
        this._agentPromptEditorModal.open();
    }

    async openSearchSuggestionStatistics() {
        const isReady = await this._prepareForModalOpen(
            'commandPalette.openSearchSuggestionStatistics',
        );
        if (!isReady) {
            return;
        }
        if (this._searchSuggestionStatisticsModal === null) {
            this._searchSuggestionStatisticsModal = new SearchSuggestionStatisticsModal(
                NotesAPI.getSearchSuggestionStatistics.bind(NotesAPI),
                this._readSearchSuggestionWindows.bind(this),
                this._readShowSearchSuggestionWindowLabels.bind(this),
                this._readLimitNoteCreditsPerSearchContext.bind(this),
                this._saveSearchSuggestionWindows.bind(this),
                this._performSearchSuggestionHistoryReset.bind(this),
            );
        }
        this._searchSuggestionStatisticsModal.open();
    }
}

export const CommandPalette = new CommandPaletteController();
