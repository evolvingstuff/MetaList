import { ApplicationState } from '../../application-state.js';

const moduleState = ApplicationState.createFields('tab-dom-cache-service', {
    tabDomCache: new Map(),
});


function requireNotesContainer() {
    const notesContainer = document.getElementById('notes-container');
    if (!notesContainer) {
        throw new Error('Notes container not found');
    }
    return notesContainer;
}

function requireTabId(tabId) {
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('tabId must be a non-empty string');
    }
}

function ensureCacheContainer(tabId) {
    requireTabId(tabId);
    let container = moduleState.tabDomCache.get(tabId);
    if (!container) {
        container = document.createElement('div');
        container.dataset.tabId = tabId;
        moduleState.tabDomCache.set(tabId, container);
    }
    return container;
}

function clearContainer(container) {
    while (container.firstChild) {
        container.removeChild(container.firstChild);
    }
}

export function cacheNotesDomForTab(tabId) {
    requireTabId(tabId);
    const notesContainer = requireNotesContainer();
    const cacheContainer = ensureCacheContainer(tabId);

    let moved = 0;
    while (notesContainer.firstChild) {
        cacheContainer.appendChild(notesContainer.firstChild);
        moved += 1;
    }

    return { moved };
}

export function restoreNotesDomForTab(tabId) {
    requireTabId(tabId);
    const notesContainer = requireNotesContainer();
    const cacheContainer = moduleState.tabDomCache.get(tabId);
    if (!cacheContainer) {
        return { restored: false, moved: 0 };
    }

    const hadNodes = cacheContainer.childNodes.length > 0;
    let moved = 0;
    while (cacheContainer.firstChild) {
        notesContainer.appendChild(cacheContainer.firstChild);
        moved += 1;
    }

    return { restored: hadNodes, moved };
}

export function cloneNotesDomForTab(sourceTabId, targetTabId, options) {
    if (options === null || typeof options !== 'object') {
        throw new Error('cloneNotesDomForTab requires options object');
    }
    requireTabId(sourceTabId);
    requireTabId(targetTabId);
    if (sourceTabId === targetTabId) {
        throw new Error('sourceTabId and targetTabId must differ');
    }

    const cachedSource = moduleState.tabDomCache.get(sourceTabId);
    // The cache container persists even after we restore nodes back into
    // `#notes-container`, leaving it empty. Treat an empty cache container as
    // a cache miss so we can clone from the active DOM when appropriate.
    let sourceContainer = cachedSource && cachedSource.childNodes.length > 0 ? cachedSource : null;
    if (!sourceContainer) {
        const { activeTabId } = options;
        if (typeof activeTabId !== 'string' || activeTabId.length === 0) {
            throw new Error('activeTabId is required when cloning from a non-cached source tab');
        }
        if (activeTabId !== sourceTabId) {
            return { cloned: false, nodeCount: 0 };
        }
        sourceContainer = requireNotesContainer();
    }

    const targetContainer = ensureCacheContainer(targetTabId);
    clearContainer(targetContainer);

    let nodeCount = 0;
    for (const node of Array.from(sourceContainer.childNodes)) {
        targetContainer.appendChild(node.cloneNode(true));
        nodeCount += 1;
    }

    const collectNoteHashes = options.collectNoteHashes !== false;
    if (!collectNoteHashes) {
        return { cloned: true, nodeCount, noteHashes: null };
    }

    const noteHashes = new Map();
    const noteElements = targetContainer.querySelectorAll('[data-note-id]');
    for (const element of Array.from(noteElements)) {
        const noteId = element.dataset.noteId;
        const snapshotHash = element.dataset.snapshotHash;
        const contentHash = element.dataset.contentHash;
        const hash = typeof snapshotHash === 'string' && snapshotHash.length > 0
            ? snapshotHash
            : contentHash;
        if (typeof noteId === 'string' && noteId.length > 0 && typeof hash === 'string' && hash.length > 0) {
            noteHashes.set(noteId, hash);
        }
    }

    return { cloned: true, nodeCount, noteHashes };
}

export function clearAllCachedNotesDom() {
    if (moduleState.tabDomCache.size > 0) moduleState.tabDomCache.clear();
}

export function clearCachedNotesDomForTab(tabId) {
    requireTabId(tabId);
    if (moduleState.tabDomCache.has(tabId)) moduleState.tabDomCache.delete(tabId);
}

export function clearActiveNotesDom() {
    const notesContainer = requireNotesContainer();
    if (typeof notesContainer.replaceChildren === 'function') {
        notesContainer.replaceChildren();
        return;
    }
    while (notesContainer.firstChild) {
        notesContainer.removeChild(notesContainer.firstChild);
    }
}
