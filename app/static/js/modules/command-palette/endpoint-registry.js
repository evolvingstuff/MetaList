function requireAction(actions, key) {
    if (!actions || typeof actions !== 'object') {
        throw new Error('Endpoint registry requires actions object');
    }
    const fn = actions[key];
    if (typeof fn !== 'function') {
        throw new Error(`Endpoint registry missing action: ${key}`);
    }
    return fn;
}

function readBooleanPreference(preferencesStore, key, defaultValue) {
    if (typeof key !== 'string' || key.length === 0) {
        throw new Error('readBooleanPreference requires key');
    }
    if (typeof defaultValue !== 'boolean') {
        throw new Error('readBooleanPreference requires boolean default');
    }
    const raw = preferencesStore.getRaw(key);
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

function visibilityLabel(preferencesStore, key, defaultValue, subject) {
    if (typeof subject !== 'string' || subject.length === 0) {
        throw new Error('visibilityLabel requires subject');
    }
    const isVisible = readBooleanPreference(preferencesStore, key, defaultValue);
    return `${isVisible ? 'Hide' : 'Show'} ${subject}`;
}

export function buildCommandPaletteEndpoints(deps) {
    if (!deps || typeof deps !== 'object') {
        throw new Error('buildCommandPaletteEndpoints requires deps object');
    }

    const preferencesStore = deps.preferencesStore;
    if (!preferencesStore || typeof preferencesStore.getRaw !== 'function') {
        throw new Error('buildCommandPaletteEndpoints requires preferencesStore');
    }

    const actions = deps.actions;
    const applyPreference = requireAction(actions, 'applyPreference');
    const openAddPassword = requireAction(actions, 'openAddPassword');
    const openChangePassword = requireAction(actions, 'openChangePassword');
    const openRemovePassword = requireAction(actions, 'openRemovePassword');
    const openSessionTimeoutSettings = requireAction(actions, 'openSessionTimeoutSettings');
    const createBackup = requireAction(actions, 'createBackup');
    const openBackupRestore = requireAction(actions, 'openBackupRestore');
    const logout = requireAction(actions, 'logout');
    const openRandomPasswordGenerator = requireAction(actions, 'openRandomPasswordGenerator');
    const collapseAll = requireAction(actions, 'collapseAll');
    const expandAll = requireAction(actions, 'expandAll');
    const fullyCollapseAll = requireAction(actions, 'fullyCollapseAll');
    const fullyExpandAll = requireAction(actions, 'fullyExpandAll');
    const resetViewFilters = requireAction(actions, 'resetViewFilters');
    const resetAllPreferences = requireAction(actions, 'resetAllPreferences');
    const openSearchSuggestionStatistics = requireAction(actions, 'openSearchSuggestionStatistics');
    const openOntologyEditor = requireAction(actions, 'openOntologyEditor');
    const openKeyboardShortcutsHelp = requireAction(actions, 'openKeyboardShortcutsHelp');
    const attachFileToCurrentNote = requireAction(actions, 'attachFileToCurrentNote');
    const trimUnusedFiles = requireAction(actions, 'trimUnusedFiles');
    const exportCurrentViewAsHtml = requireAction(actions, 'exportCurrentViewAsHtml');
    const openSwitchNamespace = requireAction(actions, 'openSwitchNamespace');
    const openCreateNamespace = requireAction(actions, 'openCreateNamespace');
    const openManageNamespacePorts = requireAction(actions, 'openManageNamespacePorts');
    const openRenameCurrentNamespace = requireAction(actions, 'openRenameCurrentNamespace');
    const openDeleteCurrentNamespace = requireAction(actions, 'openDeleteCurrentNamespace');
    const prioritizeTagToFront = requireAction(actions, 'prioritizeTagToFront');
    const prioritizeTagToBack = requireAction(actions, 'prioritizeTagToBack');
    const alphabetizeRootNotesAsc = requireAction(actions, 'alphabetizeRootNotesAsc');
    const alphabetizeRootNotesDesc = requireAction(actions, 'alphabetizeRootNotesDesc');
    const resetUpdatedAtToCreatedAt = requireAction(actions, 'resetUpdatedAtToCreatedAt');
    const openReminders = requireAction(actions, 'openReminders');
    const openSoundManager = requireAction(actions, 'openSoundManager');
    const openVersionInfo = requireAction(actions, 'openVersionInfo');
    const openNoteLayoutAppearance = requireAction(actions, 'openNoteLayoutAppearance');
    const getSortMode = requireAction(actions, 'getSortMode');
    const setSortMode = requireAction(actions, 'setSortMode');
    const getIsUntaggedView = requireAction(actions, 'getIsUntaggedView');
    const setIsUntaggedView = requireAction(actions, 'setIsUntaggedView');
    const openAiAgentSettings = requireAction(actions, 'openAiAgentSettings');
    const openCloudPrivacySettings = requireAction(actions, 'openCloudPrivacySettings');
    const openAgentPromptEditor = requireAction(actions, 'openAgentPromptEditor');
    const openProposalManager = requireAction(actions, 'openProposalManager');
    const removeAllTagSuggestionsFromCurrentContext = requireAction(
        actions,
        'removeAllTagSuggestionsFromCurrentContext',
    );
    const openTaggingPrompt = requireAction(actions, 'openTaggingPrompt');

    const defaults = {
        showBacklinks: true,
        showNoteTags: false,
        showTabUi: false,
        showSearchResultsCount: true,
        showAiChat: false,
        showPerfOverlay: false,
        animatedTransitions: true,
        theme: 'system',
    };
    const sortModeActionValue = (sortMode) => (getSortMode() === sortMode ? 'Current' : '↵');

    return [
        {
            id: 'pref.show_backlinks',
            kind: 'boolean',
            get label() {
                return visibilityLabel(preferencesStore, 'pref.show_backlinks', defaults.showBacklinks, 'backlinks');
            },
            persistenceKey: 'pref.show_backlinks',
            defaultValue: defaults.showBacklinks,
            apply: (next) => applyPreference('pref.show_backlinks', next),
        },
        {
            id: 'pref.show_note_tags',
            kind: 'boolean',
            get label() {
                return visibilityLabel(preferencesStore, 'pref.show_note_tags', defaults.showNoteTags, 'tags in list');
            },
            persistenceKey: 'pref.show_note_tags',
            defaultValue: defaults.showNoteTags,
            apply: (next) => applyPreference('pref.show_note_tags', next),
        },
        {
            id: 'pref.show_tab_ui',
            kind: 'boolean',
            get label() {
                return visibilityLabel(preferencesStore, 'pref.show_tab_ui', defaults.showTabUi, 'tabs');
            },
            persistenceKey: 'pref.show_tab_ui',
            defaultValue: defaults.showTabUi,
            apply: (next) => applyPreference('pref.show_tab_ui', next),
        },
        {
            id: 'pref.show_search_results_count',
            kind: 'boolean',
            get label() {
                return visibilityLabel(
                    preferencesStore,
                    'pref.show_search_results_count',
                    defaults.showSearchResultsCount,
                    'search result count',
                );
            },
            persistenceKey: 'pref.show_search_results_count',
            defaultValue: defaults.showSearchResultsCount,
            apply: (next) => applyPreference('pref.show_search_results_count', next),
        },
        {
            id: 'pref.show_ai_chat',
            kind: 'boolean',
            get label() {
                return visibilityLabel(preferencesStore, 'pref.show_ai_chat', defaults.showAiChat, 'AI chat');
            },
            persistenceKey: 'pref.show_ai_chat',
            defaultValue: defaults.showAiChat,
            apply: (next) => applyPreference('pref.show_ai_chat', next),
        },
        {
            id: 'pref.show_perf_overlay',
            kind: 'boolean',
            get label() {
                return visibilityLabel(preferencesStore, 'pref.show_perf_overlay', defaults.showPerfOverlay, 'performance overlay');
            },
            persistenceKey: 'pref.show_perf_overlay',
            defaultValue: defaults.showPerfOverlay,
            apply: (next) => applyPreference('pref.show_perf_overlay', next),
        },
        {
            id: 'pref.animated_transitions',
            kind: 'boolean',
            get label() {
                return visibilityLabel(
                    preferencesStore,
                    'pref.animated_transitions',
                    defaults.animatedTransitions,
                    'animated transitions',
                );
            },
            persistenceKey: 'pref.animated_transitions',
            defaultValue: defaults.animatedTransitions,
            apply: (next) => applyPreference('pref.animated_transitions', next),
        },
        {
            id: 'view.sort_mode.normal',
            kind: 'action',
            label: 'Sort order: Normal',
            getValue: () => sortModeActionValue('normal'),
            closeOnExecute: true,
            execute: async () => setSortMode('normal'),
        },
        {
            id: 'view.sort_mode.created',
            kind: 'action',
            label: 'Sort order: Datetime created',
            getValue: () => sortModeActionValue('created'),
            closeOnExecute: true,
            execute: async () => setSortMode('created'),
        },
        {
            id: 'view.sort_mode.updated',
            kind: 'action',
            label: 'Sort order: Datetime last updated',
            getValue: () => sortModeActionValue('updated'),
            closeOnExecute: true,
            execute: async () => setSortMode('updated'),
        },
        {
            id: 'view.sort_mode.alphabetical',
            kind: 'action',
            label: 'Sort order: Alphabetical',
            getValue: () => sortModeActionValue('alphabetical'),
            closeOnExecute: true,
            execute: async () => setSortMode('alphabetical'),
        },
        {
            id: 'view.sort_mode.content_volume',
            kind: 'action',
            label: 'Sort order: Content volume (largest first)',
            getValue: () => sortModeActionValue('content-volume'),
            closeOnExecute: true,
            execute: async () => setSortMode('content-volume'),
        },
        {
            id: 'view.all_notes',
            kind: 'action',
            label: 'View: All notes',
            getValue: () => (getIsUntaggedView() ? '↵' : 'Current'),
            closeOnExecute: true,
            execute: async () => setIsUntaggedView(false),
        },
        {
            id: 'view.untagged_notes',
            kind: 'action',
            label: 'View: Untagged notes',
            getValue: () => (getIsUntaggedView() ? 'Current' : '↵'),
            closeOnExecute: true,
            execute: async () => setIsUntaggedView(true),
        },
        {
            id: 'pref.theme',
            kind: 'select',
            label: 'Theme',
            persistenceKey: 'pref.theme',
            defaultValue: defaults.theme,
            options: [
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
            ],
            apply: (next) => applyPreference('pref.theme', next),
        },
        {
            id: 'form.search_suggestion_statistics',
            kind: 'form',
            label: 'Search suggestion stats & settings…',
            execute: async () => openSearchSuggestionStatistics(),
        },
        {
            id: 'form.ai_agent_settings',
            kind: 'form',
            label: 'AI agent settings…',
            execute: async () => openAiAgentSettings(),
        },
        {
            id: 'form.cloud_ai_privacy',
            kind: 'form',
            label: 'Cloud AI privacy…',
            execute: async () => openCloudPrivacySettings(),
        },
        {
            id: 'form.proposals', kind: 'form', label: 'Manage tag proposals…',
            execute: async () => openProposalManager(),
        },
        {
            id: 'action.remove_all_tag_suggestions_current_context',
            kind: 'action',
            label: 'Remove all tag suggestions (current context)',
            closeOnExecute: true,
            execute: async () => removeAllTagSuggestionsFromCurrentContext(),
        },
        {
            id: 'form.tagging_prompt', kind: 'form', label: 'Tagging prompt and vocabulary…',
            execute: async () => openTaggingPrompt(),
        },
        {
            id: 'form.agent_prompts',
            kind: 'form',
            label: 'Agent prompts…',
            execute: async () => openAgentPromptEditor(),
        },
        {
            id: 'action.fully_expand_all',
            kind: 'action',
            label: 'Fully expand all notes (current view)',
            closeOnExecute: true,
            execute: async () => fullyExpandAll(),
        },
        {
            id: 'action.fully_collapse_all',
            kind: 'action',
            label: 'Fully collapse all notes (current view)',
            closeOnExecute: true,
            execute: async () => fullyCollapseAll(),
        },
        {
            id: 'action.expand_all',
            kind: 'action',
            label: 'Expand all root notes (current view)',
            closeOnExecute: true,
            execute: async () => expandAll(),
        },
        {
            id: 'action.collapse_all',
            kind: 'action',
            label: 'Collapse all root notes (current view)',
            closeOnExecute: true,
            execute: async () => collapseAll(),
        },
        {
            id: 'action.reset_view_filters',
            kind: 'action',
            label: 'Reset current view filters',
            closeOnExecute: true,
            execute: async () => resetViewFilters(),
        },
        {
            id: 'action.reset_all_preferences',
            kind: 'action',
            label: 'Reset all preferences',
            execute: async () => resetAllPreferences(),
        },
        {
            id: 'form.add_password',
            kind: 'form',
            label: 'Add password…',
            execute: async () => openAddPassword(),
        },
        {
            id: 'form.change_password',
            kind: 'form',
            label: 'Change password…',
            execute: async () => openChangePassword(),
        },
        {
            id: 'form.remove_password',
            kind: 'form',
            label: 'Remove password…',
            execute: async () => openRemovePassword(),
        },
        {
            id: 'form.session_timeout',
            kind: 'form',
            label: 'Session idle timeout…',
            execute: async () => openSessionTimeoutSettings(),
        },
        {
            id: 'form.reminders',
            kind: 'form',
            label: 'Reminders…',
            execute: async () => openReminders(),
        },
        {
            id: 'form.manage_sounds',
            kind: 'form',
            label: 'Manage sounds…',
            execute: async () => openSoundManager(),
        },
        {
            id: 'form.version_info',
            kind: 'form',
            label: 'Version info…',
            execute: async () => openVersionInfo(),
        },
        {
            id: 'form.note_layout_appearance',
            kind: 'form',
            label: 'Note Layout & Appearance…',
            execute: async () => openNoteLayoutAppearance(),
        },
        {
            id: 'form.switch_namespace',
            kind: 'form',
            label: 'Switch namespace…',
            execute: async () => openSwitchNamespace(),
        },
        {
            id: 'form.create_namespace',
            kind: 'form',
            label: 'Create namespace…',
            execute: async () => openCreateNamespace(),
        },
        {
            id: 'form.manage_namespace_ports',
            kind: 'form',
            label: 'Manage namespace ports…',
            execute: async () => openManageNamespacePorts(),
        },
        {
            id: 'form.rename_current_namespace',
            kind: 'form',
            label: 'Rename current namespace…',
            execute: async () => openRenameCurrentNamespace(),
        },
        {
            id: 'form.delete_current_namespace',
            kind: 'form',
            label: 'Delete namespace…',
            execute: async () => openDeleteCurrentNamespace(),
        },
        {
            id: 'action.create_backup',
            kind: 'action',
            label: 'Create backup now',
            execute: async () => createBackup(),
        },
        {
            id: 'form.restore_backup',
            kind: 'form',
            label: 'Restore from backup…',
            execute: async () => openBackupRestore(),
        },
        {
            id: 'action.logout',
            kind: 'action',
            label: 'Logout',
            execute: async () => logout(),
        },
        {
            id: 'form.random_password_generator',
            kind: 'form',
            label: 'Generate random password…',
            execute: async () => openRandomPasswordGenerator(),
        },
        {
            id: 'action.edit_tag_relationships',
            kind: 'action',
            label: 'Edit tag relationships…',
            execute: async () => openOntologyEditor(),
        },
        {
            id: 'action.export_html',
            kind: 'action',
            label: 'Export as HTML',
            execute: async () => exportCurrentViewAsHtml(),
        },
        {
            id: 'action.attach_file_to_current_note',
            kind: 'action',
            label: 'Attach file…',
            closeOnExecute: true,
            execute: async () => attachFileToCurrentNote(),
        },
        {
            id: 'action.trim_unused_files',
            kind: 'action',
            label: 'Trim unused files',
            closeOnExecute: true,
            execute: async () => trimUnusedFiles(),
        },
        {
            id: 'action.prioritize_tag_front',
            kind: 'action',
            label: 'Prioritize tag to front (global)…',
            closeOnExecute: true,
            execute: async () => prioritizeTagToFront(),
        },
        {
            id: 'action.prioritize_tag_back',
            kind: 'action',
            label: 'Prioritize tag to back (global)…',
            closeOnExecute: true,
            execute: async () => prioritizeTagToBack(),
        },
        {
            id: 'action.alphabetize_root_notes_asc',
            kind: 'action',
            label: 'Alphabetize root notes A-Z (current view)…',
            closeOnExecute: true,
            execute: async () => alphabetizeRootNotesAsc(),
        },
        {
            id: 'action.alphabetize_root_notes_desc',
            kind: 'action',
            label: 'Alphabetize root notes Z-A (current view)…',
            closeOnExecute: true,
            execute: async () => alphabetizeRootNotesDesc(),
        },
        {
            id: 'action.reset_updated_at_to_created_at',
            kind: 'action',
            label: 'Repair: reset updated time to created time (current view)…',
            closeOnExecute: true,
            execute: async () => resetUpdatedAtToCreatedAt(),
        },
        {
            id: 'action.open_keyboard_shortcuts_help',
            kind: 'action',
            label: 'Keyboard Shortcuts / Cheatsheet…',
            execute: async () => openKeyboardShortcutsHelp(),
        },
    ];
}
