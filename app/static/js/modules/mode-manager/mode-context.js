import * as Logger from './mode-logger.js';
import { CONFIG } from '../config.js';
import { restoreScrollFromAnchor } from './services/scroll-restoration-service.js';
import { ROOT_SORT_MODES, normalizeRootSortMode } from './services/root-sort-service.js';
import { reorderTabOrderToHoveredSlot } from './services/tab-drag-service.js';
import { createUuid } from '../uuid.js';
import { stateValuesEqual, ApplicationState, immutableSnapshot } from '../application-state.js';

class ModeContext {
    constructor() {
        this._modalScopes = new Map();
                
        this._editing = false;     
        this._searching = false;
        this._active = true;       
        this._dirty = false;       
        this._loading = false;     
        this._loadingTimeoutId = null;
        this._loadingNotifyTimeoutId = null;
        this._loadingStartedAt = null;

        this._currentNoteId = null;     
        this._lastSavedContent = null;  
        this._cursorOffset = null;      
        this._searchQuery = null;       
        this._currentContent = null;    

        this._lastKeyPressed = null;    
        this._lastClickTarget = null;   
        this._metaKeyPressed = false;   
        this._shiftKeyPressed = false;  
        this._hoveredNoteId = null;
        this._caretHidden = false;

        // Tracks whether this edit session has created editor undo history.
        // This is intentionally separate from "dirty" because autosave can clear dirty
        // while the editor still has undo history.
        this._editSession = { generation: 0, hasEdits: false, startedCollapsed: false, expandedPersisted: false };

        this._listeners = [];
        this._lastContentChangeTime = null;
        this._searchQuery = '';
        this._isInitialPageLoad = true;
        this._isUntaggedView = false;
        this._scrollRestoreVersion = 0;
        
        // Tab state management
        this._activeTabId = '0';
        this._tabs = {
            '0': {
                searchQuery: '',
                scrollY: 0,
                scrollAnchor: null,
                sortMode: ROOT_SORT_MODES.NORMAL,
            }
        };
        this._tabOrder = ['0'];
        this._tabRootAnchors = Object.create(null);
        
        // Multi-device sync
        this._clientId = this._generateClientId();
        this._lastUpdateUUID = null;

        this._undoContextEpoch = this._loadUndoContextEpoch();
        
        // Clipboard mode tracking
        this._clipboardNoteId = null;
        this._clipboardMode = 'system'; // 'system' for text, 'note' for note copying
        
        // Connection state tracking
        this._isConnected = true;
        this._connectionErrorBannerVisible = false;
        
        // User activity tracking for token refresh
        this._userActivity = false;

        // Diff protocol cache per tab + per-tab root tracking
        this._tabNoteHashes = Object.create(null);
        this._tabKnownRootIds = Object.create(null);
        this._tabSeenRootIds = Object.create(null);
        this._tabRootOrder = Object.create(null);
        this._tabRootCountTotals = Object.create(null);
        this._tabSearchRootCountTotals = Object.create(null);
        this._tabExecutedSearchQuery = Object.create(null);
        this._tabRevealedRedactions = Object.create(null);
        this._ensureTabContainers(this._activeTabId);
        this._lowestVisibleRootId = null;

        // asdf hack
        this._requestStartedAt = null;

        this._tabStateUpdateHook = null;
        this._tabStateVersion = 0;
        this._ignoreScrollEventsDepth = 0;
        this._modalStack = [];

        ApplicationState.own(this, 'ModeContext', new.target === ModeContext);
    }

    _assertStateChanged(property, currentValue, nextValue) {
        if (Object.is(currentValue, nextValue)) {
            throw new Error(`Redundant state change: ${property} is already ${nextValue}`);
        }
    }

    _ensureTabContainers(tabId) {
        if (!this._tabNoteHashes[tabId]) {
            this._tabNoteHashes[tabId] = new Map();
        }
        if (!this._tabKnownRootIds[tabId]) {
            this._tabKnownRootIds[tabId] = new Set();
        }
        if (!this._tabSeenRootIds[tabId]) {
            this._tabSeenRootIds[tabId] = new Set();
        }
        if (!Object.hasOwn(this._tabRootAnchors, tabId)) {
            this._tabRootAnchors[tabId] = null;
        }
        if (!Array.isArray(this._tabRootOrder[tabId])) {
            this._tabRootOrder[tabId] = [];
        }
        if (!Object.prototype.hasOwnProperty.call(this._tabRootCountTotals, tabId)) {
            this._tabRootCountTotals[tabId] = null;
        }
        if (!Object.prototype.hasOwnProperty.call(this._tabSearchRootCountTotals, tabId)) {
            this._tabSearchRootCountTotals[tabId] = null;
        }
        if (typeof this._tabExecutedSearchQuery[tabId] !== 'string') {
            this._tabExecutedSearchQuery[tabId] = '';
        }
        if (!(this._tabRevealedRedactions[tabId] instanceof Set)) {
            this._tabRevealedRedactions[tabId] = new Set();
        }
    }

    setRootCountTotals(rootCountTotal, searchRootCountTotal, tabId) {
        if (typeof tabId !== 'string' || tabId.length === 0) {
            throw new Error('tabId must be a non-empty string');
        }
        this._ensureTabContainers(tabId);
        if (!Number.isInteger(rootCountTotal) || rootCountTotal < 0) {
            throw new Error('rootCountTotal must be a non-negative integer');
        }
        if (!Number.isInteger(searchRootCountTotal) || searchRootCountTotal < 0) {
            throw new Error('searchRootCountTotal must be a non-negative integer');
        }
        if (
            this._tabRootCountTotals[tabId] === rootCountTotal
            && this._tabSearchRootCountTotals[tabId] === searchRootCountTotal
        ) {
            throw new Error(`Redundant state change: root count totals are already ${rootCountTotal}/${searchRootCountTotal} for tab ${tabId}`);
        }
        // The pair is one transition; either component may remain unchanged.
        if (this._tabRootCountTotals[tabId] !== rootCountTotal) {
            this._tabRootCountTotals[tabId] = rootCountTotal;
        }
        if (this._tabSearchRootCountTotals[tabId] !== searchRootCountTotal) {
            this._tabSearchRootCountTotals[tabId] = searchRootCountTotal;
        }
        return this;
    }

    getRootCountTotals(tabId) {
        const targetTabId = typeof tabId === 'string' && tabId.length > 0 ? tabId : this._activeTabId;
        this._ensureTabContainers(targetTabId);
        return {
            rootCountTotal: this._tabRootCountTotals[targetTabId],
            searchRootCountTotal: this._tabSearchRootCountTotals[targetTabId],
        };
    }

    get rootCountTotal() {
        this._ensureTabContainers(this._activeTabId);
        const value = this._tabRootCountTotals[this._activeTabId];
        if (!Number.isInteger(value) || value < 0) {
            throw new Error('ModeContext.rootCountTotal is unavailable (notes.view not processed yet)');
        }
        return value;
    }

    get searchRootCountTotal() {
        this._ensureTabContainers(this._activeTabId);
        const value = this._tabSearchRootCountTotals[this._activeTabId];
        if (!Number.isInteger(value) || value < 0) {
            throw new Error('ModeContext.searchRootCountTotal is unavailable (notes.view not processed yet)');
        }
        return value;
    }

    getExecutedSearchQuery(tabId) {
        const targetTabId = typeof tabId === 'string' && tabId.length > 0 ? tabId : this._activeTabId;
        this._ensureTabContainers(targetTabId);
        return this._tabExecutedSearchQuery[targetTabId];
    }

    setExecutedSearchQuery(query, tabId) {
        const targetTabId = typeof tabId === 'string' && tabId.length > 0 ? tabId : this._activeTabId;
        this._ensureTabContainers(targetTabId);
        const normalized = typeof query === 'string' ? query : '';
        this._assertStateChanged('executedSearchQuery', this._tabExecutedSearchQuery[targetTabId], normalized);
        this._tabExecutedSearchQuery[targetTabId] = normalized;
        if (targetTabId === this._activeTabId) {
            this._notifyListeners('executedSearchQuery', normalized);
        }
        return this;
    }

    clearActiveTabDiffCacheForSearchExecution(executedQuery, options) {
        const tabId = this._activeTabId;
        const normalized = typeof executedQuery === 'string' ? executedQuery : '';
        if (typeof options === 'undefined') {
            options = {};
        }
        if (options === null || typeof options !== 'object') {
            throw new Error('clearActiveTabDiffCacheForSearchExecution options must be an object');
        }
        const forceClear = options.forceClear === true;
        const previousExecuted = this.getExecutedSearchQuery(tabId);
        if (!forceClear && previousExecuted === normalized) {
            return this;
        }
        this.clearTabRevealedRedactions(tabId);
        this.resetTabDiffCache(tabId, { preserveRootAnchor: false });
        // A forced cache clear can preserve the same executed query while discarding stale hashes.
        if (previousExecuted !== normalized) {
            this.setExecutedSearchQuery(normalized, tabId);
        }
        return this;
    }

    _ensureTabNoteHashes(tabId) {
        this._ensureTabContainers(tabId);
        return this._tabNoteHashes[tabId];
    }

    _getActiveNoteHashes() {
        return this._ensureTabNoteHashes(this._activeTabId);
    }

    _getActiveKnownRoots() {
        this._ensureTabContainers(this._activeTabId);
        return this._tabKnownRootIds[this._activeTabId];
    }

    _getActiveSeenRoots() {
        this._ensureTabContainers(this._activeTabId);
        return this._tabSeenRootIds[this._activeTabId];
    }

    hasNoteHash(noteId) {
        if (!noteId) {
            throw new Error('noteId is required for hasNoteHash');
        }
        return this._getActiveNoteHashes().has(noteId);
    }

    getNoteHash(noteId) {
        if (!noteId) {
            throw new Error('noteId is required for getNoteHash');
        }
        const noteHashes = this._getActiveNoteHashes();
        if (!noteHashes.has(noteId)) {
            throw new Error(`Hash for note ${noteId} is not cached`);
        }
        return noteHashes.get(noteId);
    }

    setNoteHash(noteId, hash) {
        if (!noteId) {
            throw new Error('noteId is required for setNoteHash');
        }
        if (typeof hash !== 'string' || hash.length === 0) {
            throw new Error('hash must be a non-empty string');
        }
        const hashes = this._getActiveNoteHashes();
        this._assertStateChanged('noteHash', hashes.get(noteId), hash);
        hashes.set(noteId, hash);
        return this;
    }

    removeNoteHash(noteId) {
        if (!noteId) {
            throw new Error('noteId is required for removeNoteHash');
        }
        this._getActiveNoteHashes().delete(noteId);
        return this;
    }

    clearNoteHashes() {
        this._getActiveNoteHashes().clear();
        return this;
    }

    clearTabViewCache(tabId) {
        if (typeof tabId !== 'string' || tabId.length === 0) {
            throw new Error('tabId must be a non-empty string');
        }
        this._ensureTabContainers(tabId);
        if (this._tabNoteHashes[tabId].size > 0) this._tabNoteHashes[tabId].clear();
        if (this._tabKnownRootIds[tabId].size > 0) this._tabKnownRootIds[tabId].clear();
        if (this._tabSeenRootIds[tabId].size > 0) this._tabSeenRootIds[tabId].clear();
        if (this._tabRootOrder[tabId].length > 0) this._tabRootOrder[tabId] = [];
        if (this._tabRootAnchors[tabId] !== null) this._tabRootAnchors[tabId] = null;
        return this;
    }

	resetTabDiffCache(tabId, options) {
		if (typeof tabId !== 'string' || tabId.length === 0) {
			throw new Error('tabId must be a non-empty string');
		}
		if (typeof options === 'undefined') {
			options = {};
		}
		if (options === null || typeof options !== 'object') {
			throw new Error('options must be an object');
		}
		const preserveRootAnchor = Boolean(options.preserveRootAnchor);

        this._ensureTabContainers(tabId);
        if (tabId === this._activeTabId) {
            this._scrollRestoreVersion += 1;
        }
        if (this._tabNoteHashes[tabId].size > 0) this._tabNoteHashes[tabId].clear();
        if (this._tabKnownRootIds[tabId].size > 0) this._tabKnownRootIds[tabId].clear();
        if (this._tabSeenRootIds[tabId].size > 0) this._tabSeenRootIds[tabId].clear();
        if (this._tabRootOrder[tabId].length > 0) this._tabRootOrder[tabId] = [];
        if (!preserveRootAnchor) {
            if (this._tabRootAnchors[tabId] !== null) this._tabRootAnchors[tabId] = null;
        }
        return this;
    }

    seedTabNoteHashes(tabId, noteHashes) {
        if (typeof tabId !== 'string' || tabId.length === 0) {
            throw new Error('tabId must be a non-empty string');
        }
        if (!(noteHashes instanceof Map)) {
            throw new Error('noteHashes must be a Map');
        }

        this._ensureTabContainers(tabId);
        const target = this._tabNoteHashes[tabId];
        if (target.size > 0) target.clear();
        for (const [noteId, hash] of noteHashes.entries()) {
            if (typeof noteId !== 'string' || noteId.length === 0) {
                throw new Error('noteHashes contains invalid noteId');
            }
            if (typeof hash !== 'string' || hash.length === 0) {
                throw new Error(`noteHashes contains invalid hash for ${noteId}`);
            }
            target.set(noteId, hash);
        }
        return this;
    }

    getTabNoteHashCount(tabId) {
        if (typeof tabId !== 'string' || tabId.length === 0) {
            throw new Error('tabId must be a non-empty string');
        }
        if (!this._tabs[tabId]) {
            throw new Error(`Unknown tabId: ${tabId}`);
        }
        this._ensureTabContainers(tabId);
        const hashes = this._tabNoteHashes[tabId];
        if (!(hashes instanceof Map)) {
            throw new Error(`Invariant violation: tab note hashes missing for ${tabId}`);
        }
        return hashes.size;
    }

    cloneTabNoteHashes(sourceTabId, targetTabId) {
        if (typeof sourceTabId !== 'string' || sourceTabId.length === 0) {
            throw new Error('sourceTabId must be a non-empty string');
        }
        if (typeof targetTabId !== 'string' || targetTabId.length === 0) {
            throw new Error('targetTabId must be a non-empty string');
        }
        if (sourceTabId === targetTabId) {
            throw new Error('sourceTabId and targetTabId must differ');
        }
        if (!this._tabs[sourceTabId]) {
            throw new Error(`Unknown sourceTabId: ${sourceTabId}`);
        }
        if (!this._tabs[targetTabId]) {
            throw new Error(`Unknown targetTabId: ${targetTabId}`);
        }

        this._ensureTabContainers(sourceTabId);
        this._ensureTabContainers(targetTabId);

        const source = this._tabNoteHashes[sourceTabId];
        const target = this._tabNoteHashes[targetTabId];
        if (!(source instanceof Map) || !(target instanceof Map)) {
            throw new Error('Invariant violation: tab note hashes missing');
        }
        if (source.size === 0) {
            return { cloned: false, count: 0 };
        }

        if (target.size > 0) target.clear();
        for (const [noteId, hash] of source.entries()) {
            if (typeof noteId !== 'string' || noteId.length === 0) {
                throw new Error('source noteHashes contains invalid noteId');
            }
            if (typeof hash !== 'string' || hash.length === 0) {
                throw new Error(`source noteHashes contains invalid hash for ${noteId}`);
            }
            target.set(noteId, hash);
        }
        return { cloned: true, count: target.size };
    }

    clearActiveTabRevealedRedactions() {
        return this.clearTabRevealedRedactions(this._activeTabId);
    }

    clearTabRevealedRedactions(tabId) {
        if (typeof tabId !== 'string' || tabId.length === 0) {
            throw new Error('tabId must be a non-empty string');
        }
        this._ensureTabContainers(tabId);
        if (this._tabRevealedRedactions[tabId].size > 0) this._tabRevealedRedactions[tabId].clear();
        return this;
    }

    revealTabRedactedNote(tabId, noteId) {
        if (typeof tabId !== 'string' || tabId.length === 0) {
            throw new Error('tabId must be a non-empty string');
        }
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('noteId must be a non-empty string');
        }
        this._ensureTabContainers(tabId);
        this._tabRevealedRedactions[tabId].add(noteId);
        return this;
    }

    revealActiveTabRedactedNote(noteId) {
        return this.revealTabRedactedNote(this._activeTabId, noteId);
    }

    hideTabRedactedNote(tabId, noteId) {
        if (typeof tabId !== 'string' || tabId.length === 0) {
            throw new Error('tabId must be a non-empty string');
        }
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('noteId must be a non-empty string');
        }
        this._ensureTabContainers(tabId);
        this._tabRevealedRedactions[tabId].delete(noteId);
        return this;
    }

    hideActiveTabRedactedNote(noteId) {
        return this.hideTabRedactedNote(this._activeTabId, noteId);
    }

    isTabRedactedNoteRevealed(tabId, noteId) {
        if (typeof tabId !== 'string' || tabId.length === 0) {
            throw new Error('tabId must be a non-empty string');
        }
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('noteId must be a non-empty string');
        }
        this._ensureTabContainers(tabId);
        return this._tabRevealedRedactions[tabId].has(noteId);
    }

    isActiveTabRedactedNoteRevealed(noteId) {
        return this.isTabRedactedNoteRevealed(this._activeTabId, noteId);
    }

    cloneTabRedactedReveals(sourceTabId, targetTabId) {
        if (typeof sourceTabId !== 'string' || sourceTabId.length === 0) {
            throw new Error('sourceTabId must be a non-empty string');
        }
        if (typeof targetTabId !== 'string' || targetTabId.length === 0) {
            throw new Error('targetTabId must be a non-empty string');
        }
        if (!this._tabs[sourceTabId]) {
            throw new Error(`Unknown sourceTabId: ${sourceTabId}`);
        }
        if (!this._tabs[targetTabId]) {
            throw new Error(`Unknown targetTabId: ${targetTabId}`);
        }
        this._ensureTabContainers(sourceTabId);
        this._ensureTabContainers(targetTabId);
        const source = this._tabRevealedRedactions[sourceTabId];
        const target = this._tabRevealedRedactions[targetTabId];
        // Hydrating a duplicated tab already initializes its empty reveal set.
        if (!stateValuesEqual(source, target)) this._tabRevealedRedactions[targetTabId] = new Set(source);
        return this;
    }

	clearAllTabViewCaches() {
		const tabs = this._tabs;
		const noteHashesByTab = this._tabNoteHashes;
		const tabIds = new Set([
			...Object.keys(tabs ? tabs : {}),
			...Object.keys(noteHashesByTab ? noteHashesByTab : {}),
		]);
		for (const tabId of tabIds) {
			this.clearTabViewCache(tabId);
		}
		return this;
	}

    getNoteHashPayload() {
        const payload = {};
        for (const [noteId, hash] of this._getActiveNoteHashes().entries()) {
            payload[noteId] = hash;
        }
        return payload;
    }

    syncNoteHashesFromSnapshot(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.structure)) {
            throw new Error('Invalid snapshot payload');
        }

        const validIds = new Set();
        const noteHashes = this._getActiveNoteHashes();
        for (const entry of snapshot.structure) {
            if (!entry || typeof entry !== 'object') {
                throw new Error('Malformed structure entry in snapshot');
            }
            const { id, hash } = entry;
            if (typeof id !== 'string' || typeof hash !== 'string' || !hash) {
                throw new Error('Structure entry missing id/hash');
            }
            validIds.add(id);
            if (noteHashes.get(id) !== hash) noteHashes.set(id, hash);
        }

        for (const noteId of Array.from(noteHashes.keys())) {
            if (!validIds.has(noteId)) {
                noteHashes.delete(noteId);
            }
        }

        this._updateRootTracking(snapshot.structure);

        return this;
    }

    syncRootIds(rootIds) {
        if (!Array.isArray(rootIds)) {
            return this;
        }

        const knownRoots = this._getActiveKnownRoots();
        if (knownRoots.size > 0) knownRoots.clear();
        const order = [];
        for (const id of rootIds) {
            if (typeof id === 'string' && id) {
                knownRoots.add(id);
                order.push(id);
            }
        }

        const intersectedSeen = new Set();
        const seenRoots = this._getActiveSeenRoots();
        for (const rootId of seenRoots) {
            if (knownRoots.has(rootId)) {
                intersectedSeen.add(rootId);
            }
        }
        const active = this._activeTabId;
        if (!stateValuesEqual(this._tabSeenRootIds[active], intersectedSeen)) this._tabSeenRootIds[active] = intersectedSeen;
        if (!stateValuesEqual(this._tabRootOrder[active], order)) this._tabRootOrder[active] = order;

        queueMicrotask(async () => {
            const module = await import('./services/infinite-scroll-service.js');
            module.refreshOverlayMetrics();
        });

        return this;
    }

    setEditing(value) {
        const normalized = Boolean(value);
        this._assertStateChanged('editing', this._editing, normalized);

        const oldValue = this._editing;
        this._editing = normalized;

        this.resetEditSessionState({ startedCollapsed: false });
        if (!this._editing && this._caretHidden) {
            this._caretHidden = false;
        }
        
        if (oldValue !== this._editing) {
            this._notifyListeners('editing', this._editing);
        }
                
        return this;
    }

    get isEditing() {
        return this._editing;
    }

    get noteCount() {
        return this._getActiveNoteHashes().size;
    }

    resetEditSessionState(options) {
        if (typeof options === 'undefined') {
            options = {};
        }
        if (options === null || typeof options !== 'object') {
            throw new Error('resetEditSessionState requires options object');
        }

        const startedCollapsed = options.startedCollapsed === true;
        this._editSession = {
            generation: this._editSession.generation + 1,
            hasEdits: false, startedCollapsed, expandedPersisted: false,
        };
        return this;
    }

    markEditSessionHasEdits() {
        this._editSession.hasEdits = true;
        return this;
    }

    get editSessionHasEdits() {
        return Boolean(this._editSession.hasEdits);
    }

    get editSessionStartedCollapsed() {
        return Boolean(this._editSession.startedCollapsed);
    }

    markEditSessionExpandedPersisted() {
        this._editSession.expandedPersisted = true;
        return this;
    }

    get editSessionExpandedPersisted() {
        return Boolean(this._editSession.expandedPersisted);
    }

    setSearching(value) {
        const normalized = Boolean(value);
        this._assertStateChanged('searching', this._searching, normalized);

        const oldValue = this._searching;
        this._searching = normalized;
                
        if (oldValue !== this._searching) {
            this._notifyListeners('searching', this._searching);
        }

        // Don't clear search query when exiting search mode
        // This preserves the search context for note creation
                
        return this;
    }

    get isSearching() {
        return this._searching;
    }

    get isIdle() {
        return !this._editing && !this._searching && !this._loading;
    }

    setActive(value) {
                
        const normalized = Boolean(value);
        this._assertStateChanged('active', this._active, normalized);

        this._active = normalized;
        this._notifyListeners('active', this._active);
        return this;
    }

    get isActive() {
        return this._active;
    }

    setDirty(value) {
        const normalized = Boolean(value);

        this._assertStateChanged('dirty', this._dirty, normalized);

        this._dirty = normalized;
        if (this._dirty && this._editing && !this.editSessionHasEdits) {
            this.markEditSessionHasEdits();
        }
        this._notifyListeners('dirty', this._dirty);
        return this;
    }

    get isDirty() {
        return this._dirty;
    }

    setLoading(value) {
        const normalized = Boolean(value);
        this._assertStateChanged('loading', this._loading, normalized);
        
        this._loading = normalized;

        if (this._loading) {
            this._loadingStartedAt = performance.now();
            if (CONFIG.LOADING.SPINNER_DELAY > 0) {
                if (this._loadingTimeoutId) {
                    clearTimeout(this._loadingTimeoutId);
                    this._loadingTimeoutId = null;
                }

                this._loadingTimeoutId = setTimeout(() => {
                    document.body.classList.add(CONFIG.CLASSES.LOADING);
                    this._loadingTimeoutId = null;
                }, CONFIG.LOADING.SPINNER_DELAY);
            } else {
                document.body.classList.add(CONFIG.CLASSES.LOADING);
            }
        } else {
            document.body.classList.remove(CONFIG.CLASSES.LOADING);

            if (this._loadingTimeoutId) {
                clearTimeout(this._loadingTimeoutId);
                this._loadingTimeoutId = null;
            }

            if (this._loadingStartedAt === null) {
                throw new Error('setLoading(false) called without a prior setLoading(true)');
            }
            const durationMs = performance.now() - this._loadingStartedAt;
            this._loadingStartedAt = null;
        }

        if (CONFIG.LOADING.ARTIFICIAL_DELAY > 0) {
            if (this._loadingNotifyTimeoutId) {
                clearTimeout(this._loadingNotifyTimeoutId);
            }
            this._loadingNotifyTimeoutId = setTimeout(() => {
                this._loadingNotifyTimeoutId = null;
                this._notifyListeners('loading', this._loading);
            }, CONFIG.LOADING.ARTIFICIAL_DELAY);
        } else {
            this._notifyListeners('loading', this._loading);
        }

        return this;
    }

    get isLoading() {
        return this._loading;
    }

    setCurrentNoteId(noteId) {
        this._assertStateChanged('currentNoteId', this._currentNoteId, noteId);
                
        this._currentNoteId = noteId;
        this._notifyListeners('currentNoteId', noteId);
        return this;
    }

    get currentNoteId() {
        return this._currentNoteId;
    }

	setHoveredNoteId(noteId) {
		let normalized = noteId;
		if (!normalized) {
			normalized = null;
		}

        this._assertStateChanged('hoveredNoteId', this._hoveredNoteId, normalized);

        this._hoveredNoteId = normalized;
        this._notifyListeners('hoveredNoteId', this._hoveredNoteId);
        return this;
    }

    get hoveredNoteId() {
        return this._hoveredNoteId;
    }

    markCaretHidden() {
        this._assertStateChanged('caretHidden', this._caretHidden, true);
        this._caretHidden = true;
        return this;
    }

    markCaretVisible() {
        this._assertStateChanged('caretHidden', this._caretHidden, false);
        this._caretHidden = false;
        return this;
    }

    get isCaretHidden() {
        return this._editing && this._caretHidden;
    }

    setLastSavedContent(content) {
        this._assertStateChanged('lastSavedContent', this._lastSavedContent, content);
        this._lastSavedContent = content;
        return this;
    }

    get lastSavedContent() {
        return this._lastSavedContent;
    }

    setCursorOffset(offset) {
        this._assertStateChanged('cursorOffset', this._cursorOffset, offset);
        this._cursorOffset = offset;
        return this;
    }

    get cursorOffset() {
        return this._cursorOffset;
    }

    setCurrentContent(content) {
                
        this._assertStateChanged('currentContent', this._currentContent, content);
                
        this._currentContent = content;
        if (content === null) {
            if (this._lastSavedContent !== null) this._lastSavedContent = null;
        } else {
            // Distinct input events can share a millisecond. The content setter
            // remains strict; only the clock observation may be unchanged.
            const observedTime = Date.now();
            if (this._lastContentChangeTime !== observedTime) this._lastContentChangeTime = observedTime;
        }
        this._notifyListeners('currentContent', content);
        return this;
    }

    get currentContent() {
        return this._currentContent;
    }

	setKeyPressed(key, metaKey, shiftKey) {
        if (
            this._lastKeyPressed === key
            && this._metaKeyPressed === Boolean(metaKey)
            && this._shiftKeyPressed === Boolean(shiftKey)
        ) {
            throw new Error(`Redundant state change: keyInfo is already ${key}`);
        }
        if (this._lastKeyPressed !== key) this._lastKeyPressed = key;
        if (this._metaKeyPressed !== Boolean(metaKey)) this._metaKeyPressed = Boolean(metaKey);
        if (this._shiftKeyPressed !== Boolean(shiftKey)) this._shiftKeyPressed = Boolean(shiftKey);
		return this;
	}

    get keyInfo() {
        return {
            key: this._lastKeyPressed,
            meta: this._metaKeyPressed,
            shift: this._shiftKeyPressed
        };
    }

	setClickTarget(target, coordinates) {
        this._assertStateChanged('clickTarget', this._lastClickTarget, target);
		this._lastClickTarget = target;
		if (coordinates) {
			this._coordinates = coordinates;
		}
		return this;
	}

    get clickTarget() {
        return this._lastClickTarget;
    }

    get coordinates() {
        return immutableSnapshot(this._coordinates);
    }

    resetCoordinates() {
        this._assertStateChanged('coordinates', this._coordinates, null);
        this._coordinates = null;
        return this;
    }

    addListener(callback) {
        if (typeof callback === 'function') {
            this._listeners.push(callback);
        }
        return this;
    }

    removeListener(callback) {
        this._listeners = this._listeners.filter(listener => listener !== callback);
        return this;
    }

    _notifyListeners(property, newValue) {
                
        const oldValue = this[`_${property}`];

        Logger.logState(property, newValue, oldValue);
                
		this._listeners.forEach(listener => {
			listener(property, newValue);
		});
	}

    getFullState() {
        const state = {
            modes: {
                editing: this._editing,
                searching: this._searching,
                loading: this._loading
            },
            context: {
                currentNoteId: this._currentNoteId,
                currentContent: this._currentContent,
                searchQuery: this._searchQuery
            },
            event: this._eventMemory
        };

        Logger.logFullState(state);
                
        return state;
    }

    validate() {
                
        if (this._editing && !this._currentNoteId) {
            const errorMsg = `Invariant violation: editing mode is active (${this._editing}) but no currentNoteId is set`;
            Logger.logError(errorMsg);
            throw new Error(errorMsg);
        }

        if (!this._editing && this._currentNoteId) {
            const errorMsg = `Invariant violation: editing mode is inactive (${this._editing}) but currentNoteId is set (${this._currentNoteId})`;
            Logger.logError(errorMsg);
            throw new Error(errorMsg);
        }
    }

    get lastContentChangeTime() {
        return this._lastContentChangeTime;
    }

    setClipboardNoteId(noteId) {
        
        this._assertStateChanged('clipboardNoteId', this._clipboardNoteId, noteId);
        
        Logger.logAction(noteId === null ? 'Clearing clipboard note ID' : `Setting clipboard note ID to: ${noteId}`);
        this._clipboardNoteId = noteId;
        this._notifyListeners('clipboardNoteId', noteId);
        return this;
    }

    get clipboardNoteId() {
        return this._clipboardNoteId;
    }
    
    setClipboardMode(mode) {
        if (mode !== 'system' && mode !== 'note') {
            throw new Error(`Invalid clipboard mode: ${mode}. Must be 'system' or 'note'`);
        }
        
        this._assertStateChanged('clipboardMode', this._clipboardMode, mode);
        
        Logger.logAction(`Setting clipboard mode to: ${mode}`);
        this._clipboardMode = mode;
        return this;
    }
    
    get clipboardMode() {
        return this._clipboardMode;
    }

		setSearchQuery(query) {
        let normalized = query;
        if (typeof normalized !== 'string') {
            normalized = '';
        }
        this._assertStateChanged('searchQuery', this._searchQuery, normalized);
        this._searchQuery = normalized;

        // Update current tab's search query and save tab state
        const entry = this._ensureTabEntry(this._activeTabId);
        entry.searchQuery = this._searchQuery;
        this._notifyListeners('searchQuery', this._searchQuery);
        this._emitTabStateMutation('searchQuery');
        
        return this;
    }

    get searchQuery() {
        return this._searchQuery;
    }

    // Infinite scroll helpers ------------------------------------------------

    _updateRootTracking(structure) {
        const knownRoots = this._getActiveKnownRoots();
        if (knownRoots.size > 0) knownRoots.clear();
        const order = [];
        if (Array.isArray(structure)) {
            for (const entry of structure) {
                if (!entry || typeof entry !== 'object') {
                    continue;
                }
                const { id, parentId } = entry;
                if (typeof id !== 'string' || !id) {
                    continue;
                }
                if (parentId === null || parentId === undefined || parentId === '') {
                    knownRoots.add(id);
                    order.push(id);
                }
            }
        }
        if (!stateValuesEqual(this._tabRootOrder[this._activeTabId], order)) this._tabRootOrder[this._activeTabId] = order;

        const currentTabId = this._activeTabId;
        const intersectedSeen = new Set();
        const seenRoots = this._getActiveSeenRoots();
        for (const rootId of seenRoots) {
            if (knownRoots.has(rootId)) {
                intersectedSeen.add(rootId);
            }
        }
        if (!stateValuesEqual(this._tabSeenRootIds[currentTabId], intersectedSeen)) this._tabSeenRootIds[currentTabId] = intersectedSeen;

        queueMicrotask(async () => {
            const module = await import('./services/infinite-scroll-service.js');
            module.refreshOverlayMetrics();
        });
    }

		resetRootTracking(options) {
			if (typeof options === 'undefined') {
				options = {};
			}
			if (options === null || typeof options !== 'object') {
				throw new Error('resetRootTracking requires options object');
			}
			const shouldClear = options.clear !== false;
        if (shouldClear) {
            const tabId = this._activeTabId;
            if (this._getActiveKnownRoots().size > 0) this._getActiveKnownRoots().clear();
            if (this._getActiveSeenRoots().size > 0) this._getActiveSeenRoots().clear();
            if (this._tabRootOrder[tabId].length > 0) this._tabRootOrder[tabId] = [];
            if (this._tabRootAnchors[tabId] !== null) this._tabRootAnchors[tabId] = null;
        }
        queueMicrotask(async () => {
            const module = await import('./services/infinite-scroll-service.js');
            module.resetInfiniteScrollState();
        });
        return this;
    }

    _notifyInfiniteScrollTabSwitch() {
        queueMicrotask(async () => {
            const module = await import('./services/infinite-scroll-service.js');
            if (typeof module.handleTabSwitch === 'function') {
                module.handleTabSwitch();
                return;
            }
            module.resetInfiniteScrollState();
        });
    }

    markRootsAsSeen(rootIds) {
        if (!Array.isArray(rootIds)) {
            return false;
        }
        let changed = false;
        const knownRoots = this._getActiveKnownRoots();
        const seenRoots = this._getActiveSeenRoots();
        for (const id of rootIds) {
            if (typeof id !== 'string' || !knownRoots.has(id)) {
                continue;
            }
            if (seenRoots.has(id)) continue;
            seenRoots.add(id);
            changed = true;
        }
        return changed;
    }

    clearSeenRoots() {
        if (this._getActiveSeenRoots().size === 0) {
            throw new Error('Redundant state change: seen roots are already empty');
        }
        if (this._getActiveSeenRoots().size > 0) this._getActiveSeenRoots().clear();
        return this;
    }

    getUnseenRootCount() {
        const knownRoots = this._getActiveKnownRoots();
        const seenRoots = this._getActiveSeenRoots();
        return Math.max(0, knownRoots.size - seenRoots.size);
    }

    get seenRootCount() {
        return this._getActiveSeenRoots().size;
    }

    get knownRootCount() {
        return this._getActiveKnownRoots().size;
    }

    getSeenRootIds() {
        return Array.from(this._getActiveSeenRoots());
    }

		getLastKnownRootId() {
			let order = this._tabRootOrder[this._activeTabId];
			if (!Array.isArray(order)) {
				order = [];
			}
			if (!Array.isArray(order) || order.length === 0) {
				return null;
			}
			return order[order.length - 1];
		}

	isAnchorNearEnd(anchorId, distance) {
		if (typeof distance === 'undefined') {
			distance = 3;
		}
		if (typeof anchorId !== 'string' || !anchorId) {
			return false;
		}
		let order = this._tabRootOrder[this._activeTabId];
		if (!Array.isArray(order)) {
			order = [];
		}
		const idx = order.indexOf(anchorId);
		if (idx === -1) return false;
		return (order.length - 1 - idx) <= distance;
	}

    setRootAnchorId(anchorId) {
        const tabId = this._activeTabId;
        const normalized = typeof anchorId === 'string' && anchorId.length > 0 ? anchorId : null;
        this._assertStateChanged('rootAnchorId', this._tabRootAnchors[tabId], normalized);
        this._tabRootAnchors[tabId] = normalized;
        return this;
    }

	getRootAnchorId() {
		const anchorId = this._tabRootAnchors[this._activeTabId];
		return typeof anchorId === 'string' && anchorId.length > 0 ? anchorId : null;
	}


    // Tab management methods
    _ensureTabEntry(tabId) {
        if (!this._tabs[tabId]) {
            throw new Error(`Unknown tabId: ${tabId}`);
        }
        this._ensureTabNoteHashes(tabId);
        return this._tabs[tabId];
    }

    _emitTabStateMutation(reason) {
        if (typeof this._tabStateUpdateHook === 'function') {
            this._tabStateUpdateHook({ reason, payload: this.getTabStatePayload() });
        }
    }

    moveTabToHoveredSlot(tabId, hoveredTabId) {
        if (typeof tabId !== 'string' || tabId.length === 0) {
            throw new Error('tabId must be a non-empty string');
        }
        if (typeof hoveredTabId !== 'string' || hoveredTabId.length === 0) {
            throw new Error('hoveredTabId must be a non-empty string');
        }
        if (!this._tabs[tabId]) {
            throw new Error(`Unknown tabId: ${tabId}`);
        }
        if (!this._tabs[hoveredTabId]) {
            throw new Error(`Unknown hoveredTabId: ${hoveredTabId}`);
        }
        if (!Array.isArray(this._tabOrder) || this._tabOrder.length === 0) {
            throw new Error('tabOrder must be a non-empty array');
        }

        this._tabOrder = reorderTabOrderToHoveredSlot(this._tabOrder, tabId, hoveredTabId);

        this._notifyListeners('tabOrder', this._tabOrder);
        this._emitTabStateMutation('moveTab');
        return this;
    }

    get activeTabId() {
        return this._activeTabId;
    }

    get tabs() {
        return immutableSnapshot(this._tabs);
    }

    get tabOrder() {
        return Object.freeze(this._tabOrder.slice());
    }

    setTabStateUpdateHook(callback) {
        if (callback && typeof callback !== 'function') {
            throw new Error('tab state update hook must be a function');
        }
        this._assertStateChanged('tabStateUpdateHook', this._tabStateUpdateHook, callback);
        this._tabStateUpdateHook = callback;
        return this;
    }

    clearTabStateUpdateHook() {
        this._assertStateChanged('tabStateUpdateHook', this._tabStateUpdateHook, null);
        this._tabStateUpdateHook = null;
        return this;
    }

    setTabStateVersion(version) {
        if (typeof version !== 'number' || Number.isNaN(version)) {
            throw new Error('tab state version must be a number');
        }
        this._assertStateChanged('tabStateVersion', this._tabStateVersion, version);
        this._tabStateVersion = version;
        return this;
    }

    get tabStateVersion() {
        return this._tabStateVersion;
    }

    getTabStatePayload() {
        const tabs = {};
        if (!Array.isArray(this._tabOrder) || this._tabOrder.length === 0) {
            throw new Error('tabOrder must be a non-empty array');
        }
        for (const tabId of this._tabOrder) {
            const entry = this._tabs[tabId];
            if (!entry) {
                throw new Error(`tabOrder references missing tab ${tabId}`);
            }
            const scrollY = typeof entry.scrollY === 'number' && entry.scrollY >= 0 ? entry.scrollY : 0;
            let anchorRootId = null;
            if (Object.prototype.hasOwnProperty.call(this._tabRootAnchors, tabId)) {
                const candidateAnchorRootId = this._tabRootAnchors[tabId];
                if (candidateAnchorRootId !== null && candidateAnchorRootId !== undefined) {
                    anchorRootId = candidateAnchorRootId;
                }
            }
            let scrollAnchor = null;
            if (entry.scrollAnchor !== null && entry.scrollAnchor !== undefined) {
                scrollAnchor = immutableSnapshot(entry.scrollAnchor);
            }
            let sortMode = ROOT_SORT_MODES.NORMAL;
            if (entry.sortMode !== null && entry.sortMode !== undefined) {
                sortMode = entry.sortMode;
            }
            tabs[tabId] = {
                searchQuery: typeof entry.searchQuery === 'string' ? entry.searchQuery : '',
                scrollY,
                anchorRootId,
                scrollAnchor,
                sortMode: normalizeRootSortMode(sortMode),
            };
        }
        return {
            activeTabId: this._activeTabId,
            tabs,
            tabOrder: this._tabOrder.slice(),
            version: this._tabStateVersion
        };
    }

	hydrateTabState(state, options) {
		if (typeof options === 'undefined') {
			options = {};
		}
		if (options === null || typeof options !== 'object') {
			throw new Error('hydrateTabState requires options object');
		}
		const emitUpdate = options.emitUpdate !== false;
        const preserveActiveRootTracking = options.preserveActiveRootTracking === true;
        const previousActiveTabId = this._activeTabId;
        if (!state || typeof state !== 'object') {
            throw new Error('hydrateTabState requires a state object');
        }
        const { activeTabId, tabs, tabOrder } = state;
        if (!tabs || typeof tabs !== 'object' || Object.keys(tabs).length === 0) {
            throw new Error('hydrateTabState requires at least one tab');
        }
        if (!Array.isArray(tabOrder) || tabOrder.length === 0) {
            throw new Error('hydrateTabState requires tabOrder');
        }
        if (tabOrder.length !== Object.keys(tabs).length) {
            throw new Error('hydrateTabState tabOrder length mismatch');
        }
		const previousRootAnchors = this._tabRootAnchors ? this._tabRootAnchors : Object.create(null);
		const nextRootAnchors = Object.create(null);
        const normalized = {};
        const tabIds = Object.keys(tabs);
        for (const tabId of tabIds) {
            const entry = tabs[tabId];
            if (!entry || typeof entry !== 'object') {
                throw new Error(`Invalid tab payload for tab ${tabId}`);
            }
            if (typeof entry.searchQuery !== 'string') {
                throw new Error(`Invalid searchQuery for tab ${tabId}`);
            }
            if (typeof entry.scrollY !== 'number' || entry.scrollY < 0) {
                throw new Error(`Invalid scrollY for tab ${tabId}`);
            }
            const sortMode = normalizeRootSortMode(entry.sortMode);
            if (Object.prototype.hasOwnProperty.call(entry, 'anchorRootId')) {
                if (
                    entry.anchorRootId !== null
                    && entry.anchorRootId !== undefined
                    && typeof entry.anchorRootId !== 'string'
                ) {
                    throw new Error(`Invalid anchorRootId for tab ${tabId}`);
                }
            }

            if (entry.scrollAnchor !== null && entry.scrollAnchor !== undefined && typeof entry.scrollAnchor !== 'object') {
                throw new Error(`Invalid scrollAnchor for tab ${tabId}`);
            }
            const searchQuery = entry.searchQuery;
            const scrollY = entry.scrollY;
            let anchorRootId = null;
            if (Object.prototype.hasOwnProperty.call(entry, 'anchorRootId')) {
                if (entry.anchorRootId !== null && entry.anchorRootId !== undefined) {
                    anchorRootId = entry.anchorRootId;
                }
            } else if (Object.prototype.hasOwnProperty.call(previousRootAnchors, tabId)) {
                const previousAnchorRootId = previousRootAnchors[tabId];
                if (previousAnchorRootId !== null && previousAnchorRootId !== undefined) {
                    anchorRootId = previousAnchorRootId;
                }
            }

            let scrollAnchor = null;
            if (entry.scrollAnchor && typeof entry.scrollAnchor === 'object') {
                const candidate = entry.scrollAnchor;
                if (typeof candidate.anchorId !== 'string' || candidate.anchorId.length === 0) {
                    throw new Error(`scrollAnchor.anchorId missing for tab ${tabId}`);
                }
                if (candidate.anchorBias !== 'center' && candidate.anchorBias !== 'top') {
                    throw new Error(`scrollAnchor.anchorBias invalid for tab ${tabId}`);
                }
                if (typeof candidate.intraOffset !== 'number' || candidate.intraOffset < 0) {
                    throw new Error(`scrollAnchor.intraOffset invalid for tab ${tabId}`);
                }
                if (!Array.isArray(candidate.beltPrev) || !Array.isArray(candidate.beltNext)) {
                    throw new Error(`scrollAnchor belt invalid for tab ${tabId}`);
                }
                if (!candidate.anchorSortKey || typeof candidate.anchorSortKey !== 'object') {
                    throw new Error(`scrollAnchor.anchorSortKey missing for tab ${tabId}`);
                }
                if (typeof candidate.anchorSortKey.domIndex !== 'number' || candidate.anchorSortKey.domIndex < 0) {
                    throw new Error(`scrollAnchor.anchorSortKey.domIndex invalid for tab ${tabId}`);
                }
                scrollAnchor = {
                    anchorId: candidate.anchorId,
                    anchorBias: candidate.anchorBias,
                    intraOffset: candidate.intraOffset,
                    beltPrev: candidate.beltPrev.filter(id => typeof id === 'string' && id.length > 0),
                    beltNext: candidate.beltNext.filter(id => typeof id === 'string' && id.length > 0),
                    anchorSortKey: { domIndex: candidate.anchorSortKey.domIndex },
                };
            }

            normalized[tabId] = {
                searchQuery,
                scrollY,
                anchorRootId,
                scrollAnchor,
                sortMode,
            };
            nextRootAnchors[tabId] = anchorRootId;
        }
        if (!normalized[activeTabId]) {
            throw new Error('Active tab missing from provided state');
        }
        if (preserveActiveRootTracking && activeTabId !== previousActiveTabId) {
            throw new Error('Cannot preserve active root tracking while changing active tabs');
        }

        const normalizedOrder = [];
        const seenIds = new Set();
        for (const rawId of tabOrder) {
            const tabId = String(rawId);
            if (!normalized[tabId]) {
                throw new Error(`tabOrder references missing tab ${tabId}`);
            }
            if (seenIds.has(tabId)) {
                throw new Error('tabOrder contains duplicates');
            }
            seenIds.add(tabId);
            normalizedOrder.push(tabId);
        }
		const tabIdsList = Object.keys(normalized);
		const previousHashCaches = this._tabNoteHashes ? this._tabNoteHashes : Object.create(null);
		const nextHashCaches = Object.create(null);
		const previousKnownRoots = this._tabKnownRootIds ? this._tabKnownRootIds : Object.create(null);
		const nextKnownRoots = Object.create(null);
		const previousSeenRoots = this._tabSeenRootIds ? this._tabSeenRootIds : Object.create(null);
		const nextSeenRoots = Object.create(null);
        const previousRevealedRedactions = this._tabRevealedRedactions ? this._tabRevealedRedactions : Object.create(null);
        const nextRevealedRedactions = Object.create(null);

		for (const tabId of tabIdsList) {
			const existingHashes = previousHashCaches[tabId];
			nextHashCaches[tabId] = existingHashes ? existingHashes : new Map();
			const existingKnownRoots = previousKnownRoots[tabId];
			nextKnownRoots[tabId] = existingKnownRoots ? existingKnownRoots : new Set();
			const existingSeenRoots = previousSeenRoots[tabId];
			nextSeenRoots[tabId] = existingSeenRoots ? existingSeenRoots : new Set();
            const existingRevealedRedactions = previousRevealedRedactions[tabId];
            nextRevealedRedactions[tabId] = existingRevealedRedactions instanceof Set
                ? existingRevealedRedactions
                : new Set();
		}

        // Hydration receives a complete server snapshot. Unchanged fields are
        // observations, not transition requests, and are compared at this boundary.
        ApplicationState.receiveOwnerSnapshot(this, {
            _tabs: normalized,
            _tabOrder: normalizedOrder,
            _tabRootAnchors: nextRootAnchors,
            _tabNoteHashes: nextHashCaches,
            _tabKnownRootIds: nextKnownRoots,
            _tabSeenRootIds: nextSeenRoots,
            _tabRevealedRedactions: nextRevealedRedactions,
            _activeTabId: activeTabId,
            _searchQuery: normalized[activeTabId].searchQuery,
        });
        this._ensureTabContainers(activeTabId);
        if (!preserveActiveRootTracking) {
            this.resetRootTracking({ clear: true });
        }
        if (emitUpdate) {
            this._emitTabStateMutation('hydrate');
        }
        return this;
    }

    updateActiveTabScroll(scrollY) {
        return this.updateTabScroll(this._activeTabId, scrollY, true);
    }

	updateTabScroll(tabId, scrollY, emit) {
		if (typeof emit === 'undefined') {
			emit = true;
		}
		if (typeof scrollY !== 'number' || scrollY < 0) {
			throw new Error('scrollY must be a non-negative number');
		}
        const entry = this._ensureTabEntry(tabId);
        this._assertStateChanged('tabScrollY', entry.scrollY, scrollY);
        entry.scrollY = scrollY;
        if (entry.scrollAnchor !== null) entry.scrollAnchor = null;
        if (emit) {
            this._emitTabStateMutation('scroll');
        }
        return this;
    }

	updateActiveTabScrollAnchor(scrollAnchor, emit) {
		if (typeof emit === 'undefined') {
			emit = true;
		}
		return this.updateTabScrollAnchor(this._activeTabId, scrollAnchor, emit);
	}

	updateTabScrollAnchor(tabId, scrollAnchor, emit) {
		if (typeof emit === 'undefined') {
			emit = true;
		}
		const entry = this._ensureTabEntry(tabId);
		if (scrollAnchor !== null && typeof scrollAnchor !== 'object') {
			throw new Error('scrollAnchor must be an object or null');
		}
        this._assertStateChanged('tabScrollAnchor', entry.scrollAnchor, scrollAnchor);
        entry.scrollAnchor = scrollAnchor;
        if (emit) {
            this._emitTabStateMutation('scrollAnchor');
        }
        return this;
    }

	getTabScrollAnchor(tabId) {
		const targetTabId = typeof tabId === 'string' && tabId.length > 0 ? tabId : this._activeTabId;
		const entry = this._tabs[targetTabId];
		return entry && entry.scrollAnchor ? immutableSnapshot(entry.scrollAnchor) : null;
	}

    beginIgnoreScrollEvents() {
        this._ignoreScrollEventsDepth += 1;
        return this;
    }

    endIgnoreScrollEvents() {
        if (this._ignoreScrollEventsDepth <= 0) {
            throw new Error('endIgnoreScrollEvents called without beginIgnoreScrollEvents');
        }
        this._ignoreScrollEventsDepth -= 1;
        return this;
    }

    shouldIgnoreScrollEvents() {
        return this._ignoreScrollEventsDepth > 0;
    }

	restoreScrollForActiveTab() {
        const tabId = this._activeTabId;
        this._scrollRestoreVersion += 1;
        const restoreVersion = this._scrollRestoreVersion;
        const savedAnchor = this.getTabScrollAnchor(tabId);
        const savedScrollY = this.getTabScrollPosition(tabId);

        let lastProgrammaticScrollY = null;
		const applyRestore = () => {
			if (this._activeTabId !== tabId || this._scrollRestoreVersion !== restoreVersion) {
				return;
			}
			this.beginIgnoreScrollEvents();
			Promise.resolve().then(() => {
                if (this._activeTabId !== tabId || this._scrollRestoreVersion !== restoreVersion) {
                    return;
                }
				restoreScrollFromAnchor(savedAnchor, { scrollYFallback: savedScrollY });
				const entry = this._ensureTabEntry(tabId);
				const observedScrollY = Math.max(0, Math.round(window.scrollY));
                if (entry.scrollY !== observedScrollY) entry.scrollY = observedScrollY;
				lastProgrammaticScrollY = entry.scrollY;
                queueMicrotask(async () => {
                    const module = await import('./services/search-interaction-service.js');
                    module.primeActiveSearchInteractionState();
                });
			}).finally(() => {
				this.endIgnoreScrollEvents();
			});
		};

        const maybeApplyRestore = () => {
            if (this._activeTabId !== tabId || this._scrollRestoreVersion !== restoreVersion) {
                return;
            }
            if (lastProgrammaticScrollY !== null) {
                const current = Math.max(0, Math.round(window.scrollY));
                if (Math.abs(current - lastProgrammaticScrollY) > 60) {
                    return;
                }
            }
            applyRestore();
        };

        // Restoring the page top needs no deferred note measurements.
        if (savedScrollY === 0) {
            applyRestore();
            return;
        }

        // Multi-pass restore: fixes layout shifts after diff reconciliation (e.g. images loading).
        window.requestAnimationFrame(() => {
            applyRestore();
            window.requestAnimationFrame(() => {
                maybeApplyRestore();
            });
            window.setTimeout(() => {
                maybeApplyRestore();
            }, 250);
        });
    }

    switchToTab(tabId, options) {
        if (typeof tabId !== 'string' || tabId.length === 0) {
            throw new Error('Invalid tab ID: must be a non-empty string');
        }
        if (!this._tabs[tabId]) {
            throw new Error(`Invalid tab ID: ${tabId} not found`);
        }
        if (typeof options === 'undefined') {
            options = {};
        }
        if (options === null || typeof options !== 'object') {
            throw new Error('switchToTab requires options object');
        }
        const force = options.force === true;

        if (this._loading && !force) {
            Logger.logNoop('Tab switch ignored while request is in-flight', {
                requestedTab: tabId,
                activeTab: this._activeTabId
            });
            return this;
        }
        if (this._activeTabId === tabId) {
            throw new Error(`Redundant state change: activeTabId is already ${tabId}`);
        }

        // Save current scroll position to current tab
        const currentEntry = this._ensureTabEntry(this._activeTabId);
        const observedScrollY = Math.max(0, Math.round(window.scrollY));
        if (currentEntry.scrollY !== observedScrollY) {
            currentEntry.scrollY = observedScrollY;
        }
        if (currentEntry.searchQuery !== this._searchQuery) {
            currentEntry.searchQuery = this._searchQuery;
        }

        // Switch to new tab
        const oldTabId = this._activeTabId;
        this._activeTabId = tabId;

        // Initialize tab if it doesn't exist
        const targetEntry = this._ensureTabEntry(tabId);

        // Update search query to match new tab
        const newQuery = targetEntry.searchQuery;
        if (this._searchQuery !== newQuery) {
            this._searchQuery = newQuery;
        }
        // Switching tabs can land on a tab whose executed query already matches its saved query.
        if (this.getExecutedSearchQuery(tabId) !== this._searchQuery) {
            this.setExecutedSearchQuery(this._searchQuery, tabId);
        }
        this._notifyInfiniteScrollTabSwitch();

        // Notify listeners of changes
        if (oldTabId !== this._activeTabId) {
            this._notifyListeners('activeTab', this._activeTabId);
        }
        this._notifyListeners('searchQuery', this._searchQuery);
        this._emitTabStateMutation('switchTab');

        return this;
    }

    getTabScrollPosition(tabId) {
		const targetTabId = typeof tabId === 'string' && tabId.length > 0 ? tabId : this._activeTabId;
		const entry = this._tabs[targetTabId];
		if (!entry || typeof entry.scrollY !== 'number' || entry.scrollY < 0) {
			return 0;
		}
		return entry.scrollY;
	}

    getTabSortMode(tabId) {
        const targetTabId = typeof tabId === 'string' && tabId.length > 0 ? tabId : this._activeTabId;
        const entry = this._tabs[targetTabId];
        if (!entry) {
            throw new Error(`Unknown tabId: ${targetTabId}`);
        }
        return normalizeRootSortMode(entry.sortMode);
    }

    get activeTabSortMode() {
        return this.getTabSortMode(this._activeTabId);
    }

    setUntaggedView(value) {
        if (typeof value !== 'boolean') {
            throw new Error('isUntaggedView must be a boolean');
        }
        this._assertStateChanged('isUntaggedView', this._isUntaggedView, value);
        this._isUntaggedView = value;
        this._notifyListeners('isUntaggedView', value);
        return this;
    }

    get isUntaggedView() {
        return this._isUntaggedView;
    }

    get isInitialPageLoad() {
        return this._isInitialPageLoad;
    }

    markInitialPageLoadComplete() {
        this._assertStateChanged('isInitialPageLoad', this._isInitialPageLoad, false);
        this._isInitialPageLoad = false;
        return this;
    }

    // Multi-device sync methods
    _generateClientId() {
        // Get or create a unique client ID for this browser tab
        let clientId = sessionStorage.getItem('metalist_client_id');
        if (!clientId) {
            clientId = createUuid();
            sessionStorage.setItem('metalist_client_id', clientId);
        }
        return clientId;
    }

    _loadUndoContextEpoch() {
        const raw = sessionStorage.getItem('metalist_undo_context_epoch');
        if (raw === null) {
            sessionStorage.setItem('metalist_undo_context_epoch', '0');
            return 0;
        }
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0) {
            throw new Error('metalist_undo_context_epoch must be a non-negative integer string');
        }
        return parsed;
    }

    bumpUndoContextEpoch(reason) {
        if (typeof reason !== 'string' || reason.length === 0) {
            throw new Error('bumpUndoContextEpoch requires reason string');
        }
        const next = this._undoContextEpoch + 1;
        if (!Number.isInteger(next) || next < 0) {
            throw new Error('Undo context epoch overflow');
        }
        this._undoContextEpoch = next;
        sessionStorage.setItem('metalist_undo_context_epoch', String(next));
        Logger.logAction('undo_context_epoch.bump', { reason, epoch: next });
        return this;
    }

    get undoContextEpoch() {
        return this._undoContextEpoch;
    }

    get clientId() {
        return this._clientId;
    }

    setLastUpdateUUID(uuid) {
        this._assertStateChanged('lastUpdateUUID', this._lastUpdateUUID, uuid);
        this._lastUpdateUUID = uuid;
        return this;
    }

    get lastUpdateUUID() {
        return this._lastUpdateUUID;
    }
    
    // Connection state management
    setConnected(connected) {
        if (typeof connected !== 'boolean') {
            throw new Error('connected must be a boolean');
        }
        
        this._assertStateChanged('isConnected', this._isConnected, connected);
        
        Logger.logAction(`Connection state changed: ${connected ? 'connected' : 'disconnected'}`);
        this._isConnected = connected;
        this._notifyListeners('connectionState', connected);
        
        return this;
    }
    
    get isConnected() {
        return this._isConnected;
    }
    
    setConnectionErrorBannerVisible(visible) {
        if (typeof visible !== 'boolean') {
            throw new Error('visible must be a boolean');
        }
        
        this._assertStateChanged('connectionErrorBannerVisible', this._connectionErrorBannerVisible, visible);
        
        this._connectionErrorBannerVisible = visible;
        return this;
    }
    
    get connectionErrorBannerVisible() {
        return this._connectionErrorBannerVisible;
    }
    
    setUserActivity(active) {
        if (typeof active !== 'boolean') {
            throw new Error('active must be a boolean');
        }
        
        this._assertStateChanged('userActivity', this._userActivity, active);
        
        this._userActivity = active;
        return this;
    }
    
    get userActivity() {
        return this._userActivity;
    }

    get modalStack() {
        return Object.freeze(this._modalStack.slice());
    }

    initializeModalState(name, initial) {
        if (this._modalScopes.has(name)) throw new Error(`Modal state already initialized: ${name}`);
        this._modalScopes.set(name, ApplicationState.createScope(`modal.${name}`, initial));
    }

    getModalState(name) {
        if (!this._modalScopes.has(name)) throw new Error(`Modal state not initialized: ${name}`);
        return this._modalScopes.get(name).get();
    }

    updateModalState(name, updates) {
        const previous = this.getModalState(name);
        this._modalScopes.get(name).set({ ...previous, ...updates });
    }

    removeModalState(name) {
        this.getModalState(name);
        this._modalScopes.get(name).dispose();
        this._modalScopes.delete(name);
    }

    get topModal() {
        if (this._modalStack.length === 0) {
            return null;
        }
        return this._modalStack[this._modalStack.length - 1];
    }

    pushModal(modalName) {
        if (typeof modalName !== 'string' || modalName.length === 0) {
            throw new Error('modalName must be a non-empty string');
        }
        if (this.topModal === modalName) {
            throw new Error(`Redundant state change: modalStack already has ${modalName} on top`);
        }
        this._modalStack.push(modalName);
        this._notifyListeners('modalStack', this.modalStack);
        return this;
    }

    removeModal(modalName) {
        if (typeof modalName !== 'string' || modalName.length === 0) {
            throw new Error('modalName must be a non-empty string');
        }
        const index = this._modalStack.indexOf(modalName);
        if (index === -1) {
            throw new Error(`Redundant state change: modalStack does not contain ${modalName}`);
        }
        this._modalStack.splice(index, 1);
        this._notifyListeners('modalStack', this.modalStack);
        return this;
    }
}

export const ModeContextInstance = new ModeContext();
