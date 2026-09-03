// Toggle the notes API base here to switch between v1 and v2
const API_BASE = '/api2'; // change to '/api' to switch back to v1
const API_NOTES_BASE = `${API_BASE}/notes`;
const API_AUTH_BASE = `${API_BASE}/auth`;
const API_FILES_BASE = `${API_BASE}/files`;
const API_REMINDERS_BASE = `${API_BASE}/reminders`;
const API_AI_BASE = `${API_BASE}/ai`;
const RUNTIME_FLAGS = globalThis.__METALIST_RUNTIME__;
const STARTUP_ANIMATION_ENABLED = Boolean(
    RUNTIME_FLAGS &&
    typeof RUNTIME_FLAGS === 'object' &&
    RUNTIME_FLAGS.startupAnimationEnabled === true,
);

export const CONFIG = {
    API: {
        NOTES: {
            CREATE: `${API_NOTES_BASE}/new`,
            CREATE_SIBLING: (noteId) => `${API_NOTES_BASE}/new-sibling/${noteId}`,
            CREATE_CHILD: (noteId) => `${API_NOTES_BASE}/new-child/${noteId}`,
            UPDATE: (noteId) => `${API_NOTES_BASE}/${noteId}`,
            SAVE: (noteId) => `${API_NOTES_BASE}/${noteId}/save`,
            ADD_SELECTED_TEXT_TAG: (noteId) => `${API_NOTES_BASE}/${noteId}/add-selected-text-tag`,
            MAKE_PSEUDO_TAG_PROPOSALS: (noteId) => `${API_NOTES_BASE}/${noteId}/tag-proposals/pseudo`,
            ACCEPT_TAG_PROPOSAL: (noteId) => `${API_NOTES_BASE}/${noteId}/tag-proposals/accept`,
            REJECT_TAG_PROPOSAL: (noteId) => `${API_NOTES_BASE}/${noteId}/tag-proposals/reject`,
            SPLIT: (noteId) => `${API_NOTES_BASE}/${noteId}/split`,
            TOGGLE_TODO: (noteId) => `${API_NOTES_BASE}/${noteId}/toggle-todo`,
            UNFORMAT: (noteId) => `${API_NOTES_BASE}/${noteId}/unformat`,
            RESIZE_IMAGE: (noteId) => `${API_NOTES_BASE}/${noteId}/resize-image`,
            RUN_SHELL: (noteId) => `${API_NOTES_BASE}/${noteId}/run-shell`,
            RUN_SHELL_STATUS: (noteId, runId) => `${API_NOTES_BASE}/${noteId}/run-shell/${runId}`,
            REFERENCE_MODE: (noteId) => `${API_NOTES_BASE}/${noteId}/reference-mode`,
            MOVE: (noteId) => `${API_NOTES_BASE}/${noteId}/move`,
            MOVE_TO_TOP: (noteId) => `${API_NOTES_BASE}/${noteId}/move-to-top`,
            PRIORITIZE: `${API_NOTES_BASE}/prioritize`,
            ALPHABETIZE_ROOT_NOTES: `${API_NOTES_BASE}/alphabetize-root-notes`,
            RESET_UPDATED_AT_TO_CREATED_AT: `${API_NOTES_BASE}/reset-updated-at-to-created-at`,
            INDENT: (noteId) => `${API_NOTES_BASE}/${noteId}/indent`,
            OUTDENT: (noteId) => `${API_NOTES_BASE}/${noteId}/outdent`,
            COLLAPSE: (noteId) => `${API_NOTES_BASE}/${noteId}/collapse`,
            EXPAND: (noteId) => `${API_NOTES_BASE}/${noteId}/expand`,
            SET_COLLAPSED_BULK: `${API_NOTES_BASE}/set-collapsed-bulk`,
            SET_COLLAPSED_IN_CONTEXT: `${API_NOTES_BASE}/set-collapsed-in-context`,
            DELETE: (noteId) => `${API_NOTES_BASE}/${noteId}`,
            COPY: (noteId) => `${API_NOTES_BASE}/${noteId}/copy`,
            FULLSCREEN: (noteId) => `${API_NOTES_BASE}/${noteId}/fullscreen`,
            EXPORT_HTML: `${API_NOTES_BASE}/export-html`,
            PASTE_SIBLING: (targetNoteId) => `${API_NOTES_BASE}/paste-sibling/${targetNoteId}`,
            PASTE_CHILD: (targetNoteId) => `${API_NOTES_BASE}/paste-child/${targetNoteId}`,
            UNDO: `${API_NOTES_BASE}/undo`,
            REDO: `${API_NOTES_BASE}/redo`,
            VIEW: `${API_NOTES_BASE}/view`,
            TAB_STATE: `${API_NOTES_BASE}/tab-state`,
            TAB_STATE_NEW_TAB: `${API_NOTES_BASE}/tab-state/new-tab`,
            TAB_STATE_DELETE_TAB: `${API_NOTES_BASE}/tab-state/delete-tab`,
            TAB_STATE_SORT_MODE: `${API_NOTES_BASE}/tab-state/sort-mode`,
            TAB_STATE_DATE_FILTER: `${API_NOTES_BASE}/tab-state/date-filter`,
            ACTIVITY: `${API_NOTES_BASE}/activity`,
            TAG_INTERACTIONS: `${API_NOTES_BASE}/tag-interactions`,
            SEARCH_SUGGESTION_INTERACTION: `${API_NOTES_BASE}/tag-interactions/search-suggestion`,
            TAB_SEARCH_INTERACTION: `${API_NOTES_BASE}/tag-interactions/tab-selection`,
            SEARCH_SUGGESTIONS: `${API_NOTES_BASE}/search-suggestions`,
            PRIORITIZE_TAG_SUGGESTIONS: `${API_NOTES_BASE}/prioritize-tag-suggestions`,
            TAG_SUGGESTIONS: `${API_NOTES_BASE}/tag-suggestions`,
            BACKLINKS: (noteId) => `${API_NOTES_BASE}/${noteId}/backlinks`,
        },
        AUTH: {
            STATUS: `${API_AUTH_BASE}/status`,
            LOGIN: `${API_AUTH_BASE}/login`,
            LOGIN_NAMESPACES: {
                LIST: `${API_AUTH_BASE}/login-namespaces`,
                OPEN: `${API_AUTH_BASE}/login-namespaces/open`,
            },
            LOGOUT: `${API_AUTH_BASE}/logout`,
            SESSION: `${API_AUTH_BASE}/session`,
            SESSIONS: `${API_AUTH_BASE}/sessions`,
            HYDRATE: `${API_AUTH_BASE}/hydrate`,
            HYDRATION_STATUS: `${API_AUTH_BASE}/hydration-status`,
            CLIENT_STATE: `${API_AUTH_BASE}/client-state`,
            CLIENT_PREFERENCES: `${API_AUTH_BASE}/client-state/preferences`,
            COMMAND_PALETTE_USAGE: `${API_AUTH_BASE}/client-state/command-palette-usage`,
            BACKUP: {
                CREATE: `${API_AUTH_BASE}/backup/create`,
                LIST: `${API_AUTH_BASE}/backup/list`,
                DELETE_OLDEST: `${API_AUTH_BASE}/backup/delete-oldest`,
                RESTORE: `${API_AUTH_BASE}/backup/restore`,
            },
            NAMESPACES: {
                LIST: `${API_AUTH_BASE}/namespaces`,
                OPEN: `${API_AUTH_BASE}/namespaces/open`,
                SAVE_PORTS: `${API_AUTH_BASE}/namespaces/ports`,
                RENAME_CURRENT: `${API_AUTH_BASE}/namespaces/rename-current`,
                RENAME_JOB_STATUS: (jobId) => `${API_AUTH_BASE}/namespaces/rename-jobs/${jobId}`,
                DELETE: `${API_AUTH_BASE}/namespaces/delete`,
                DELETE_PREFLIGHT: `${API_AUTH_BASE}/namespaces/delete/preflight`,
                DELETE_CURRENT: `${API_AUTH_BASE}/namespaces/delete-current`,
                DELETE_JOB_STATUS: (jobId) => `${API_AUTH_BASE}/namespaces/delete-jobs/${jobId}`,
            },
            SETTINGS: {
                PASSWORD: {
                    CREATE: `${API_AUTH_BASE}/settings/password/create`,
                    CHANGE: `${API_AUTH_BASE}/settings/password/change`,
                    REMOVE: `${API_AUTH_BASE}/settings/password/remove`
                },
                SESSION_TIMEOUT: `${API_AUTH_BASE}/settings/session-timeout`,
            }
        },
        BACKUP: {
            SETTINGS: `${API_BASE}/backup/settings`,
            RUN: `${API_BASE}/backup/run`,
            LIST: `${API_BASE}/backup/list`,
            RESTORE: `${API_BASE}/backup/restore`,
            RESTORE_PREFLIGHT: `${API_BASE}/backup/restore/preflight`,
            RESTORE_IMPORT: `${API_BASE}/backup/restore/import`,
            FOLDER_PICK: `${API_BASE}/backup/folder/pick`,
        },
        FILES: {
            UPLOAD: `${API_FILES_BASE}/upload`,
            DOWNLOAD: (fileId) => `${API_FILES_BASE}/${fileId}/download`,
            TRIM_UNUSED: `${API_FILES_BASE}/trim-unused`,
        },
        SOUNDS: {
            LIST: `${API_BASE}/sounds`,
            UPLOAD: `${API_BASE}/sounds/upload`,
            UPDATE: (soundId) => `${API_BASE}/sounds/${soundId}`,
            DELETE: (soundId) => `${API_BASE}/sounds/${soundId}`,
            PLAY: (soundId) => `${API_BASE}/sounds/${soundId}/play`,
        },
        REMINDERS: {
            LIST: API_REMINDERS_BASE,
            CREATE: API_REMINDERS_BASE,
            UPDATE: (reminderId) => `${API_REMINDERS_BASE}/${reminderId}`,
            DELETE: (reminderId) => `${API_REMINDERS_BASE}/${reminderId}`,
            ACKNOWLEDGE: (reminderId) => `${API_REMINDERS_BASE}/${reminderId}/acknowledge`,
            PRE_ACKNOWLEDGE: (reminderId) => `${API_REMINDERS_BASE}/${reminderId}/pre-acknowledge`,
            DISMISS: (reminderId) => `${API_REMINDERS_BASE}/${reminderId}/dismiss`,
            DONE: (reminderId) => `${API_REMINDERS_BASE}/${reminderId}/done`,
            PAUSE: (reminderId) => `${API_REMINDERS_BASE}/${reminderId}/pause`,
            RESUME: (reminderId) => `${API_REMINDERS_BASE}/${reminderId}/resume`,
            SKIP_NEXT: (reminderId) => `${API_REMINDERS_BASE}/${reminderId}/skip-next`,
            EVALUATE: `${API_REMINDERS_BASE}/evaluate`,
        },
        AI: {
            MODELS: `${API_AI_BASE}/models`,
            PULL_MODEL: `${API_AI_BASE}/models/pull`,
            OPENAI_CREDENTIAL: `${API_AI_BASE}/openai/credential`,
            OPENAI_COST: `${API_AI_BASE}/openai/cost`,
            OPENAI_COST_RESET: `${API_AI_BASE}/openai/cost/reset`,
            PROMPT_DEFAULTS: `${API_AI_BASE}/prompts/defaults`,
            SESSION: `${API_AI_BASE}/session`,
            DEBUG: `${API_AI_BASE}/debug`,
            CLOUD_PRIVACY_PREVIEW: `${API_AI_BASE}/cloud-privacy/preview`,
            CHAT: `${API_AI_BASE}/chat`,
            COPY_MESSAGE: (messageId) => `${API_AI_BASE}/messages/${messageId}/copy`,
        }
    },

    CLASSES: {
        NOTE: 'note',
        NOTE_CONTENT: 'note-content',
        EDITING: 'editing',
        CARET_HIDDEN: 'caret-hidden',
        SEARCH_INPUT: 'search-input',
        SEARCH_RESULTS: 'search-results',
        LOADING: 'loading'
    },

    SYNC: {
        POLL_INTERVAL_MS: 5_000,
    },

    DEBUG: {
        LOG_API_CALLS: false,
        LOG_STATE_CHANGES: false
    },
    
    LOADING: {
        
        ARTIFICIAL_DELAY: 0,

        SPINNER_DELAY: 1000,

        BLOCK_ACTIONS: true
    },
    
    SEARCH: {
        DEBOUNCE_MS: 300  // Delay before executing search after typing stops
    },
    
    TRANSITIONS: {
        ENABLE_INITIAL_FADE: true,  // Enable fade effect on initial page load only
        FADE_DURATION_MS: 150       // Duration of fade effect in milliseconds
    },
    
    EDITOR: {
        DEFAULT_CURSOR_POSITION: 'END'    // Where to place cursor when entering edit mode ('START' or 'END')
    },

    PASTE: {
        MAX_DATA_IMAGE_BYTES: 10_485_760,
        EMBED_TARGET_IMAGE_BYTES: 350_000,
        EMBED_MAX_DIMENSION_PX: 1_600,
        MAX_CLIPBOARD_IMAGE_BYTES: 31_457_280,
    },

    TABS: {
        MAX_TABS: 1000,
        CREATE_AND_SWITCH: true,
    },

    REFERENCE_NAVIGATION: {
        CLOSE_REF_TAB_ON_BACK: true,
    },

    BACKUP: {
        RETENTION_PROMPT_THRESHOLD: 25,
        RETENTION_SUGGESTED_KEEP_COUNT: 3,
    },

    STARTUP: {
        ENABLE_LOGIN_INTRO: STARTUP_ANIMATION_ENABLED,
    },
};
