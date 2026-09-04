import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCommandPaletteEndpoints } from '../../app/static/js/modules/command-palette/endpoint-registry.js';

function noop() {}

test('buildCommandPaletteEndpoints includes utility action endpoints', () => {
    const storedPreferences = new Map();
    const endpoints = buildCommandPaletteEndpoints({
        preferencesStore: {
            getRaw: (key) => storedPreferences.has(key) ? storedPreferences.get(key) : null,
        },
        actions: {
            applyPreference: noop,
            openAddPassword: noop,
            openChangePassword: noop,
            openRemovePassword: noop,
            openSessionTimeoutSettings: noop,
            openReminders: noop,
            openSoundManager: noop,
            openVersionInfo: noop,
            openNoteLayoutAppearance: noop,
            openAiAgentSettings: noop,
            openCloudPrivacySettings: noop,
            openAgentPromptEditor: noop,
            openOntologyEditor: noop,
            createBackup: noop,
            openBackupRestore: noop,
            logout: noop,
            openRandomPasswordGenerator: noop,
            collapseAll: noop,
            expandAll: noop,
            resetViewFilters: noop,
            resetAllPreferences: noop,
            openSearchSuggestionStatistics: noop,
            openKeyboardShortcutsHelp: noop,
            exportCurrentViewAsHtml: noop,
            attachFileToCurrentNote: noop,
            trimUnusedFiles: noop,
            openSwitchNamespace: noop,
            openCreateNamespace: noop,
            openManageNamespacePorts: noop,
            openRenameCurrentNamespace: noop,
            openDeleteCurrentNamespace: noop,
            prioritizeTagToFront: noop,
            prioritizeTagToBack: noop,
            alphabetizeRootNotesAsc: noop,
            alphabetizeRootNotesDesc: noop,
            resetUpdatedAtToCreatedAt: noop,
            getSortMode: () => 'normal',
            setSortMode: noop,
            getIsUntaggedView: () => false,
            setIsUntaggedView: noop,
        },
    });

    const endpointIds = new Set(endpoints.map((endpoint) => endpoint.id));
    const attachFileEndpoint = endpoints.find((endpoint) => endpoint.id === 'action.attach_file_to_current_note');
    const animatedTransitionsEndpoint = endpoints.find((endpoint) => endpoint.id === 'pref.animated_transitions');
    assert.equal(endpointIds.has('action.create_backup'), true);
    assert.equal(endpointIds.has('form.switch_namespace'), true);
    assert.equal(endpointIds.has('form.create_namespace'), true);
    assert.equal(endpointIds.has('form.manage_namespace_ports'), true);
    assert.equal(endpointIds.has('form.rename_current_namespace'), true);
    assert.equal(endpointIds.has('form.delete_current_namespace'), true);
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'form.delete_current_namespace').label,
        'Delete namespace…',
    );
    assert.equal(endpointIds.has('form.restore_backup'), true);
    assert.equal(endpointIds.has('form.add_password'), true);
    assert.equal(endpointIds.has('form.change_password'), true);
    assert.equal(endpointIds.has('form.remove_password'), true);
    assert.equal(endpointIds.has('form.password_protection'), false);
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'form.add_password').label,
        'Add password…',
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'form.change_password').label,
        'Change password…',
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'form.remove_password').label,
        'Remove password…',
    );
    assert.equal(endpointIds.has('form.session_timeout'), true);
    assert.equal(endpointIds.has('pref.show_rhs_panel'), false);
    assert.equal(endpointIds.has('pref.show_note_timestamps'), false);
    assert.equal(animatedTransitionsEndpoint.defaultValue, true);
    assert.equal(animatedTransitionsEndpoint.label, 'Hide animated transitions');
    assert.equal(endpointIds.has('form.reminders'), true);
    assert.equal(endpointIds.has('form.version_info'), true);
    assert.equal(endpointIds.has('form.note_layout_appearance'), true);
    assert.equal(endpointIds.has('form.agent_prompts'), true);
    assert.equal(endpointIds.has('form.cloud_ai_privacy'), true);
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'form.cloud_ai_privacy').label,
        'Cloud AI privacy…',
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'form.agent_prompts').label,
        'Agent prompts…',
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'form.note_layout_appearance').label,
        'Note Layout & Appearance…',
    );
    assert.equal(endpointIds.has('action.logout'), true);
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'action.expand_all').label,
        'Expand all root notes (current view)',
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'action.collapse_all').label,
        'Collapse all root notes (current view)',
    );
    assert.equal(endpointIds.has('form.random_password_generator'), true);
    assert.equal(endpointIds.has('pref.auto_collapse_long_notes'), false);
    assert.equal(endpointIds.has('action.export_html'), true);
    assert.equal(endpointIds.has('action.attach_file_to_current_note'), true);
    assert.equal(attachFileEndpoint.label, 'Attach file…');
    assert.equal(endpointIds.has('action.trim_unused_files'), true);
    assert.equal(endpointIds.has('form.search_suggestion_statistics'), true);
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'form.search_suggestion_statistics').label,
        'Search suggestion stats & settings…',
    );
    assert.equal(endpointIds.has('action.prioritize_tag_front'), true);
    assert.equal(endpointIds.has('action.prioritize_tag_back'), true);
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'action.prioritize_tag_front').label,
        'Prioritize tag to front (global)…',
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'action.prioritize_tag_back').label,
        'Prioritize tag to back (global)…',
    );
    assert.equal(endpointIds.has('action.open_keyboard_shortcuts_help'), true);
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'action.open_keyboard_shortcuts_help').label,
        'Keyboard Shortcuts / Cheatsheet…',
    );
    assert.equal(endpointIds.has('action.run_mcp_client'), false);
    assert.equal(endpointIds.has('view.sort_mode'), false);
    assert.equal(endpointIds.has('view.sort_mode.normal'), true);
    assert.equal(endpointIds.has('view.sort_mode.created'), true);
    assert.equal(endpointIds.has('view.sort_mode.updated'), true);
    assert.equal(endpointIds.has('view.sort_mode.alphabetical'), true);
    assert.equal(endpointIds.has('view.sort_mode.content_volume'), true);
    assert.equal(endpointIds.has('view.all_notes'), true);
    assert.equal(endpointIds.has('view.untagged_notes'), true);
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'view.sort_mode.alphabetical').label,
        'Sort order: Alphabetical',
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'view.sort_mode.content_volume').label,
        'Sort order: Content volume (largest first)',
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'view.sort_mode.normal').getValue(),
        'Current',
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'view.sort_mode.alphabetical').getValue(),
        '↵',
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'view.sort_mode.alphabetical').closeOnExecute,
        true,
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'action.alphabetize_root_notes_asc').closeOnExecute,
        true,
    );
    assert.equal(endpointIds.has('action.reset_updated_at_to_created_at'), true);
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'action.reset_updated_at_to_created_at').closeOnExecute,
        true,
    );
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'action.open_keyboard_shortcuts_help').closeOnExecute,
        undefined,
    );

    assert.equal(endpoints.find((endpoint) => endpoint.id === 'pref.show_backlinks').label, 'Hide backlinks');
    assert.equal(endpoints.find((endpoint) => endpoint.id === 'pref.show_note_tags').label, 'Show tags in list');
    assert.equal(endpoints.find((endpoint) => endpoint.id === 'pref.show_tab_ui').label, 'Show tabs');
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'pref.show_search_results_count').label,
        'Hide search result count',
    );
    assert.equal(endpoints.find((endpoint) => endpoint.id === 'pref.show_perf_overlay').label, 'Show performance overlay');

    storedPreferences.set('pref.show_backlinks', 'false');
    storedPreferences.set('pref.show_note_tags', 'true');
    storedPreferences.set('pref.show_tab_ui', 'true');
    storedPreferences.set('pref.show_search_results_count', 'false');
    storedPreferences.set('pref.show_perf_overlay', 'true');
    storedPreferences.set('pref.animated_transitions', 'false');

    assert.equal(endpoints.find((endpoint) => endpoint.id === 'pref.show_backlinks').label, 'Show backlinks');
    assert.equal(endpoints.find((endpoint) => endpoint.id === 'pref.show_note_tags').label, 'Hide tags in list');
    assert.equal(endpoints.find((endpoint) => endpoint.id === 'pref.show_tab_ui').label, 'Hide tabs');
    assert.equal(
        endpoints.find((endpoint) => endpoint.id === 'pref.show_search_results_count').label,
        'Show search result count',
    );
    assert.equal(endpoints.find((endpoint) => endpoint.id === 'pref.show_perf_overlay').label, 'Hide performance overlay');
    assert.equal(animatedTransitionsEndpoint.label, 'Show animated transitions');
});
