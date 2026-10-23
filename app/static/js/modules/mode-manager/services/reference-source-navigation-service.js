import { NOT_FOUND } from '../../not-found.js';
import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { isReferenceViewTransitionPending } from './reference-view-transition-service.js';

// The kinds of temporary view: a note's source, the notes referencing it, or an AI
// answer's references (one of them, or all of them).
const REFERENCE_VIEW_KINDS = new Set(['source', 'backlinks', 'reference', 'references']);
// The views an AI answer opens; a later AI reference replaces any of them.
export const AI_REFERENCE_VIEW_KINDS = new Set(['reference', 'references']);
// What the tab list calls each kind of view.
const TAB_LABEL_BY_VIEW_KIND = Object.freeze({
    source: 'Reference source',
    backlinks: 'Referenced by',
    reference: 'Reference',
    references: 'All references',
});
// What the chip in the search bar says for the views that are not one note's source.
const CHIP_LABEL_BY_VIEW_KIND = Object.freeze({
    backlinks: 'Referenced by',
    reference: 'Reference',
    references: 'All references',
});
// A source view's chip: this arrow, then the source note's first line.
const SOURCE_CHIP_ARROW = '\u2196';
// On the chip, it shows in place of the search input (main.css).
const CHIP_SHOWN_CLASS = 'is-shown';
// On a note's content while its first line is read (main.css).
const READING_TITLE_CLASS = 'is-reading-reference-title';
// Reference views can stack: the one opened directly from a search is the first level.
const FIRST_REFERENCE_LEVEL = 1;

// Reference tabs are ordinary server tabs whose search is a hidden note-ID query.
// The navigation stack that hides that query is kept per browser tab in
// sessionStorage so a reload keeps the "Reference source" label instead of
// exposing raw IDs in the search field.
const REFERENCE_NAVIGATION_STORAGE_KEY = 'metalist_reference_navigation_stack';

const moduleState = ApplicationState.createFields('reference-source-navigation-service', {
    referenceNavigationStack: [],
    hasRestoredFromSession: false,
    // Each source view's note title, read from its rendered note, by reference tab id.
    // Kept in memory only: sessionStorage holds opaque ids, never note text.
    sourceTitlesByTabId: new Map(),
    // The reference tab whose chip gave way to an empty search input (the magnifier),
    // or '' when the chip shows.
    newSearchTabId: '',
});

function requireReferenceViewKind(viewKind) {
    if (!REFERENCE_VIEW_KINDS.has(viewKind)) {
        throw new Error('Reference navigation requires a source, backlinks or references viewKind');
    }
}


function copyOriginScope(originScope) {
    if (!originScope || typeof originScope !== 'object' || Array.isArray(originScope)) {
        throw new Error('Reference navigation requires originScope');
    }
    for (const key of ['scopeTabId', 'sortMode']) {
        if (typeof originScope[key] !== 'string' || originScope[key].length === 0) {
            throw new Error(`Reference origin scope missing ${key}`);
        }
    }
    if (typeof originScope.searchQuery !== 'string') {
        throw new Error('Reference origin scope missing searchQuery');
    }
    if (typeof originScope.isUntaggedView !== 'boolean') {
        throw new Error('Reference origin scope missing isUntaggedView');
    }
    return {
        scopeTabId: originScope.scopeTabId,
        searchQuery: originScope.searchQuery,
        sortMode: originScope.sortMode,
        isUntaggedView: originScope.isUntaggedView,
    };
}

function copyReferenceNavigationEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('Reference navigation stack entry must be an object');
    }
    for (const key of ['fromTabId', 'toTabId', 'referenceQuery']) {
        if (typeof entry[key] !== 'string' || entry[key].length === 0) {
            throw new Error(`Reference navigation stack entry missing ${key}`);
        }
    }
    requireReferenceViewKind(entry.viewKind);
    return {
        fromTabId: entry.fromTabId,
        toTabId: entry.toTabId,
        referenceQuery: entry.referenceQuery,
        originScope: copyOriginScope(entry.originScope),
        viewKind: entry.viewKind,
    };
}

function persistReferenceNavigationStack() {
    sessionStorage.setItem(
        REFERENCE_NAVIGATION_STORAGE_KEY,
        JSON.stringify(moduleState.referenceNavigationStack),
    );
}

export function parseStoredReferenceNavigationStack(rawValue) {
    if (rawValue === null) {
        return [];
    }
    if (typeof rawValue !== 'string') {
        throw new Error('Stored reference navigation must be a string');
    }
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
        throw new Error('Stored reference navigation must be a list');
    }
    // Only kinds of view this version knows are restored; others (e.g. the removed
    // similar-notes view, docs/design/similar-notes-learnings.md) are dropped, leaving
    // their tab as an ordinary tab.
    return parsed
        .filter((entry) => entry && typeof entry === 'object' && REFERENCE_VIEW_KINDS.has(entry.viewKind))
        .map(copyReferenceNavigationEntry);
}

/**
 * Restore this browser tab's reference navigation after the server tab state loads.
 *
 * Keeps only entries whose tabs still exist and whose reference tab still runs the
 * exact hidden query; any other search means the user already left that view.
 */
export function restoreReferenceNavigationFromSession(serverTabs) {
    if (moduleState.hasRestoredFromSession) {
        throw new Error('Reference navigation can be restored only once per page load');
    }
    if (!serverTabs || typeof serverTabs !== 'object' || Array.isArray(serverTabs)) {
        throw new Error('Reference navigation restore requires server tabs');
    }
    if (moduleState.referenceNavigationStack.length !== 0) {
        throw new Error('Reference navigation restore requires an empty in-memory stack');
    }
    moduleState.hasRestoredFromSession = true;
    const storedEntries = parseStoredReferenceNavigationStack(
        sessionStorage.getItem(REFERENCE_NAVIGATION_STORAGE_KEY),
    );
    for (const entry of storedEntries) {
        const fromTab = serverTabs[entry.fromTabId];
        const toTab = serverTabs[entry.toTabId];
        if (fromTab === undefined || toTab === undefined) continue;
        if (toTab.searchQuery !== entry.referenceQuery) continue;
        moduleState.referenceNavigationStack.push(entry);
    }
    persistReferenceNavigationStack();
    updateReferenceSourceIndicator();
}

function pruneReferenceNavigationStackToExistingTabs() {
    const tabOrder = ModeContext.tabOrder;
    if (!Array.isArray(tabOrder)) {
        throw new Error('ModeContext.tabOrder must be an array');
    }
    const existingTabIds = new Set(tabOrder);
    let writeIndex = 0;
    for (let i = 0; i < moduleState.referenceNavigationStack.length; i += 1) {
        const entry = moduleState.referenceNavigationStack[i];
        if (!entry || typeof entry !== 'object') {
            throw new Error('Reference navigation stack entry must be an object');
        }
        if (typeof entry.fromTabId !== 'string' || entry.fromTabId.length === 0) {
            throw new Error('Reference navigation stack entry missing fromTabId');
        }
        if (typeof entry.toTabId !== 'string' || entry.toTabId.length === 0) {
            throw new Error('Reference navigation stack entry missing toTabId');
        }
        if (!existingTabIds.has(entry.fromTabId) || !existingTabIds.has(entry.toTabId)) {
            continue;
        }
        if (writeIndex !== i) moduleState.referenceNavigationStack[writeIndex] = entry;
        writeIndex += 1;
    }
    if (writeIndex < moduleState.referenceNavigationStack.length) {
        moduleState.referenceNavigationStack.length = writeIndex;
        persistReferenceNavigationStack();
    }
}

function findReferenceNavigationEntryIndexForActiveTab() {
    return findReferenceNavigationEntryIndexForTab(ModeContext.activeTabId);
}


function findReferenceNavigationEntryIndexForTab(tabId) {
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('Reference navigation lookup requires tabId');
    }
    for (let i = moduleState.referenceNavigationStack.length - 1; i >= 0; i -= 1) {
        if (moduleState.referenceNavigationStack[i].toTabId === tabId) {
            return i;
        }
    }
    return NOT_FOUND;
}

export function isViewingReferenceSource() {
    pruneReferenceNavigationStackToExistingTabs();
    return findReferenceNavigationEntryIndexForActiveTab() !== NOT_FOUND;
}


/**
 * Return the temporary view label for a server tab, or an empty string for an
 * ordinary user search. Internal exact-note queries must never become tab labels
 * or search-history entries.
 */
export function getReferenceNavigationLabelForTab(tabId) {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForTab(tabId);
    if (entryIndex === NOT_FOUND) return '';
    return TAB_LABEL_BY_VIEW_KIND[moduleState.referenceNavigationStack[entryIndex].viewKind];
}

export function getActiveReferenceViewKind() {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === NOT_FOUND) {
        throw new Error('Active tab is not a reference view');
    }
    return moduleState.referenceNavigationStack[entryIndex].viewKind;
}

/**
 * The stack entries leading from the original search to the active reference view,
 * the first one opened from the search and the last one the active view's.
 */
export function getActiveReferenceChain() {
    pruneReferenceNavigationStackToExistingTabs();
    let entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === NOT_FOUND) {
        throw new Error('Active tab is not a reference view');
    }
    const chain = [];
    while (entryIndex !== NOT_FOUND) {
        const entry = moduleState.referenceNavigationStack[entryIndex];
        if (chain.some((chained) => chained.toTabId === entry.toTabId)) {
            throw new Error('Reference navigation stack forms a cycle');
        }
        chain.unshift(entry);
        entryIndex = findReferenceNavigationEntryIndexForTab(entry.fromTabId);
    }
    return chain;
}

export function getActiveReferenceSourceQuery() {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === NOT_FOUND) {
        return '';
    }
    const entry = moduleState.referenceNavigationStack[entryIndex];
    if (typeof entry.referenceQuery !== 'string' || entry.referenceQuery.length === 0) {
        throw new Error('Reference navigation entry missing referenceQuery');
    }
    return entry.referenceQuery;
}

export function getActiveReferenceOriginScope() {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === NOT_FOUND) {
        throw new Error('Active tab is not a reference source');
    }
    return copyOriginScope(moduleState.referenceNavigationStack[entryIndex].originScope);
}

export function captureReferenceOriginScopeForActiveTab() {
    if (isViewingReferenceSource()) {
        return getActiveReferenceOriginScope();
    }
    const scopeTabId = ModeContext.activeTabId;
    if (typeof scopeTabId !== 'string' || scopeTabId.length === 0) {
        throw new Error('Reference origin requires active tab id');
    }
    return copyOriginScope({
        scopeTabId,
        searchQuery: ModeContext.getExecutedSearchQuery(scopeTabId),
        sortMode: ModeContext.getTabSortMode(scopeTabId),
        isUntaggedView: ModeContext.isUntaggedView,
    });
}

function forgetSourceTitle(tabId) {
    if (moduleState.sourceTitlesByTabId.has(tabId)) {
        moduleState.sourceTitlesByTabId.delete(tabId);
    }
}

function requireChipElement(id) {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLElement)) {
        throw new Error(`${id} element missing`);
    }
    return element;
}

// The source note's first line as the view shows it (a password stays hidden), or
// null while the note is not rendered.
function readRenderedSourceTitle(noteId) {
    const notesContainer = requireChipElement('notes-container');
    const note = Array.from(notesContainer.querySelectorAll('.note[data-note-id]'))
        .find((element) => element.dataset.noteId === noteId);
    if (note === undefined) {
        return null;
    }
    const content = note.querySelector(':scope > .note-content');
    if (content === null) {
        throw new Error('A rendered note is missing its content');
    }
    // The note's arrows (↖ backlinks, an embed's ↗) are not its text: hidden while read.
    content.classList.add(READING_TITLE_CLASS);
    const text = content.innerText;
    content.classList.remove(READING_TITLE_CLASS);
    const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '');
    return firstLine === undefined ? '' : firstLine;
}

function resolveSourceTitle(entry) {
    const renderedTitle = readRenderedSourceTitle(entry.referenceQuery);
    if (renderedTitle !== null) {
        // Each render reads the title again; it changes only when the note's first line does.
        if (moduleState.sourceTitlesByTabId.get(entry.toTabId) !== renderedTitle) {
            moduleState.sourceTitlesByTabId.set(entry.toTabId, renderedTitle);
        }
        return renderedTitle;
    }
    // The view has not rendered yet (a reload): its title comes with the first render.
    if (moduleState.sourceTitlesByTabId.has(entry.toTabId)) {
        return moduleState.sourceTitlesByTabId.get(entry.toTabId);
    }
    return '';
}

function renderReferenceViewChip() {
    const chip = requireChipElement('reference-source-indicator');
    const label = requireChipElement('reference-source-indicator-label');
    const backButton = requireChipElement('reference-view-chip-back');
    const isReferenceView = isViewingReferenceSource();
    // The empty input shown for a new search belongs to one reference view; any
    // other view brings the chip back.
    if (moduleState.newSearchTabId !== ''
        && (!isReferenceView || moduleState.newSearchTabId !== ModeContext.activeTabId)) {
        moduleState.newSearchTabId = '';
    }
    if (!isReferenceView) {
        chip.classList.remove(CHIP_SHOWN_CLASS);
        return;
    }
    const chain = getActiveReferenceChain();
    const entry = chain[chain.length - 1];
    if (entry.viewKind === 'source') {
        const title = resolveSourceTitle(entry);
        label.textContent = `${SOURCE_CHIP_ARROW} ${title}`;
        label.title = title;
    } else {
        label.textContent = CHIP_LABEL_BY_VIEW_KIND[entry.viewKind];
        label.removeAttribute('title');
    }
    backButton.hidden = chain.length === FIRST_REFERENCE_LEVEL;
    chip.classList.toggle(CHIP_SHOWN_CLASS, moduleState.newSearchTabId === '');
}

/**
 * Show the active tab's reference view, if any, in the search bar: the chip with
 * its label and back arrow in place of the search input. While a reference
 * navigation is pending the bar keeps showing the view the user left.
 */
export function updateReferenceSourceIndicator() {
    if (isReferenceViewTransitionPending()) {
        return;
    }
    renderReferenceViewChip();
}

/**
 * The magnifier, or focus reaching the hidden search input: the chip gives way to
 * the empty input so a new search can be typed. The reference view stays until
 * the user types, as it always has.
 */
export function showNewSearchInReferenceView() {
    if (!isViewingReferenceSource()) {
        throw new Error('A new search from the chip requires a reference view');
    }
    if (moduleState.newSearchTabId === ModeContext.activeTabId) {
        return;
    }
    moduleState.newSearchTabId = ModeContext.activeTabId;
    updateReferenceSourceIndicator();
}

/** The empty search input lost focus without a search: the chip comes back. */
export function restoreReferenceChipAfterEmptySearch() {
    if (moduleState.newSearchTabId === '') {
        return;
    }
    moduleState.newSearchTabId = '';
    updateReferenceSourceIndicator();
}

export function isShowingNewSearchInReferenceView() {
    return moduleState.newSearchTabId !== '' && moduleState.newSearchTabId === ModeContext.activeTabId;
}

export function pushReferenceNavigationEntry(
    fromTabId,
    toTabId,
    referenceQuery,
    originScope,
    viewKind,
) {
    requireReferenceViewKind(viewKind);
    if (typeof fromTabId !== 'string' || fromTabId.length === 0) {
        throw new Error('pushReferenceNavigationEntry requires fromTabId');
    }
    if (typeof toTabId !== 'string' || toTabId.length === 0) {
        throw new Error('pushReferenceNavigationEntry requires toTabId');
    }
    if (typeof referenceQuery !== 'string' || referenceQuery.length === 0) {
        throw new Error('pushReferenceNavigationEntry requires referenceQuery');
    }
    moduleState.referenceNavigationStack.push({
        fromTabId,
        toTabId,
        referenceQuery,
        originScope: copyOriginScope(originScope),
        viewKind,
    });
    persistReferenceNavigationStack();
    updateReferenceSourceIndicator();
}

export function replaceActiveReferenceNavigationQuery(referenceQuery, viewKind) {
    requireReferenceViewKind(viewKind);
    if (typeof referenceQuery !== 'string' || referenceQuery.length === 0) {
        throw new Error('replaceActiveReferenceNavigationQuery requires referenceQuery');
    }
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === NOT_FOUND) {
        throw new Error('Cannot replace reference query outside reference source mode');
    }
    const entry = moduleState.referenceNavigationStack[entryIndex];
    moduleState.referenceNavigationStack[entryIndex] = {
        ...entry,
        referenceQuery,
        viewKind,
    };
    forgetSourceTitle(entry.toTabId);
    persistReferenceNavigationStack();
    updateReferenceSourceIndicator();
}

export function popReferenceNavigationEntryForActiveTab() {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === NOT_FOUND) {
        updateReferenceSourceIndicator();
        return null;
    }
    const [entry] = moduleState.referenceNavigationStack.splice(entryIndex, 1);
    if (!entry || typeof entry !== 'object') {
        throw new Error('Reference navigation stack entry must be an object');
    }
    forgetSourceTitle(entry.toTabId);
    persistReferenceNavigationStack();
    updateReferenceSourceIndicator();
    return entry;
}

/**
 * Leave every reference view between the active one and the original search:
 * removes their entries and returns them, the one opened from the search first.
 */
export function popActiveReferenceChain() {
    const chain = getActiveReferenceChain();
    const chainTabIds = new Set(chain.map((entry) => entry.toTabId));
    const stack = moduleState.referenceNavigationStack;
    let writeIndex = 0;
    for (let i = 0; i < stack.length; i += 1) {
        const entry = stack[i];
        if (chainTabIds.has(entry.toTabId)) continue;
        if (writeIndex !== i) stack[writeIndex] = entry;
        writeIndex += 1;
    }
    stack.length = writeIndex;
    for (const tabId of chainTabIds) {
        forgetSourceTitle(tabId);
    }
    persistReferenceNavigationStack();
    updateReferenceSourceIndicator();
    return chain;
}

export function dismissReferenceSourceModeForActiveTab() {
    return popReferenceNavigationEntryForActiveTab() !== null;
}
