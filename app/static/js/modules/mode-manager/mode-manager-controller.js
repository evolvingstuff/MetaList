console.log('+++ ModeManager: Module loaded');

import { ModeContextInstance as ModeContext } from './mode-context.js';
import * as Logger from './mode-logger.js';

import { initKeyboardEvents } from './events/keyboard-events.js';
import { initMouseEvents } from './events/mouse-events.js';
import { initContextMenuEvents } from './events/context-menu-events.js';
import { initInputEvents } from './events/input-events.js';
import { initFocusEvents } from './events/focus-events.js';
import { initContentAutoSave } from './events/inactivity-events.js';
import { initializeSearchEvents } from './events/search-events.js';
import { startPolling } from './services/polling-service.js';
import { startInfiniteScrollMonitor, resetInfiniteScrollState } from './services/infinite-scroll-service.js';
import { initializeScrollToTopButton } from './services/scroll-to-top-service.js';
import { initEditorToolbar, setToolbarVisible } from '../editor-toolbar.js';
import { installGlobalErrorOverlay } from '../error-overlay.js';

const DEFAULT_CONFIG = {};

const ModeManager = {
	    
	    async init(config) {
	        if (config === null || typeof config !== 'object') {
	            throw new Error('ModeManager.init requires config object');
	        }
	                
	        console.log('+++ ModeManager: init() called');
                
        // Global error overlay
        installGlobalErrorOverlay();

        Logger.logInit('Controller');

            const mergedConfig = {
                ...DEFAULT_CONFIG,
                ...config
            };

        await this._registerEventListeners(mergedConfig);
        initEditorToolbar();

            ModeContext.addListener(this._handleModeChange.bind(this));

        document.addEventListener('visibilitychange', this._handleVisibilityChange.bind(this));

        console.log('+++ ModeManager: init completed successfully');
        return this;
    },

    async _registerEventListeners(config) {
        initKeyboardEvents();
        initMouseEvents();
        initContextMenuEvents();
        initInputEvents();
        initFocusEvents();
        initContentAutoSave();
        await initializeSearchEvents();
        startPolling();
        startInfiniteScrollMonitor();
        initializeScrollToTopButton();
                    
        Logger.logDebug('Event handlers registered', { config });
    },

    _handleVisibilityChange(event) {
        Logger.logDebug('Page visibility: ' + (document.hidden ? 'hidden' : 'visible'));
    },

    _handleModeChange(property, newValue) {
        Logger.logDebug(`Mode change: ${property}`, { [property]: newValue });
        if (property === 'searchQuery') {
            resetInfiniteScrollState();
        }
        if (property === 'editing') {
            setToolbarVisible(Boolean(newValue));
        }
    },

    debugState() {
        const state = ModeContext.getFullState();
        Logger.logState(state);
        return this;
    },

    get isEditing() { return ModeContext.isEditing; },
    get isSearching() { return ModeContext.isSearching; },
    get isIdle() { return ModeContext.isIdle; },
    get isActive() { return ModeContext.isActive; }
};

console.log('+++ ModeManager: Exporting ModeManager object');

export { ModeManager };
