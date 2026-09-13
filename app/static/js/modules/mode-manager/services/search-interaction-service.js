import { ApplicationState } from '../../application-state.js';
import { NotesAPI } from '../../api-client.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { getLimitNoteCreditsPerSearchContext } from './search-suggestion-windows-service.js';


const moduleState = ApplicationState.createFields('search-interaction-service', {
    stateByTabId: Object.create(null),

    activeContext: null,
});


function getActiveTabId() {
    const tabId = ModeContext.activeTabId;
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('ModeContext.activeTabId must be a non-empty string');
    }
    return tabId;
}

function getExecutedQuery() {
    const query = ModeContext.getExecutedSearchQuery();
    if (typeof query !== 'string') {
        throw new Error('ModeContext.getExecutedSearchQuery() must return a string');
    }
    return query;
}

export function primeActiveSearchInteractionState() {
    const tabId = getActiveTabId();
    const query = getExecutedQuery();
    // A rendered context is observed before each interaction; only entering a
    // different tab/query starts a new crediting episode.
    const previous = moduleState.activeContext;
    const enteredContext = previous === null ? true : (previous.tabId !== tabId ? true : previous.query !== query);
    if (enteredContext) {
        moduleState.activeContext = { tabId, query };
    }
    if (!Object.prototype.hasOwnProperty.call(moduleState.stateByTabId, tabId)) {
        moduleState.stateByTabId[tabId] = {
            query,
            creditedNoteIds: new Set(),
            pendingNoteIds: new Set(),
        };
        return;
    }
    const state = moduleState.stateByTabId[tabId];
    // Returning to an untouched tab already has the empty record needed for
    // the new episode. Only a changed query or existing credits need a reset.
    const hasInteractions = state.creditedNoteIds.size + state.pendingNoteIds.size > 0;
    if (state.query !== query || (enteredContext && hasInteractions)) {
        moduleState.stateByTabId[tabId] = {
            query,
            creditedNoteIds: new Set(),
            pendingNoteIds: new Set(),
        };
    }
}

export async function recordNoteInteractionIfNew(noteId, interactionType) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('recordNoteInteractionIfNew requires noteId');
    }
    if (typeof interactionType !== 'string' || interactionType.length === 0) {
        throw new Error('recordNoteInteractionIfNew requires interactionType');
    }
    primeActiveSearchInteractionState();
    const tabId = getActiveTabId();
    const state = moduleState.stateByTabId[tabId];
    const shouldLimitCredits = getLimitNoteCreditsPerSearchContext();
    if (
        shouldLimitCredits
        && (state.creditedNoteIds.has(noteId) || state.pendingNoteIds.has(noteId))
    ) {
        return false;
    }
    state.pendingNoteIds.add(noteId);
    const response = await NotesAPI.recordNoteInteraction(noteId, interactionType).then(
        (payload) => payload,
        (error) => {
            state.pendingNoteIds.delete(noteId);
            throw error;
        },
    );
    if (!response || typeof response !== 'object') {
        state.pendingNoteIds.delete(noteId);
        throw new Error('Note interaction response missing');
    }
    if (typeof response.credited !== 'boolean') {
        state.pendingNoteIds.delete(noteId);
        throw new Error('Note interaction response requires credited boolean');
    }
    state.pendingNoteIds.delete(noteId);
    if (response.credited && !state.creditedNoteIds.has(noteId)) {
        state.creditedNoteIds.add(noteId);
    }
    return response.credited;
}

export async function recordStructuralNoteInteractionIfMoved(noteId, interactionType, mutationResponse) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('recordStructuralNoteInteractionIfMoved requires noteId');
    }
    if (interactionType !== 'move' && interactionType !== 'indent' && interactionType !== 'outdent') {
        throw new Error('Structural interaction type must be move, indent, or outdent');
    }
    if (mutationResponse === null || typeof mutationResponse !== 'object') {
        throw new Error('Structural interaction mutation response missing');
    }
    if (mutationResponse.status === 'noop') {
        return false;
    }
    if (mutationResponse.status !== 'moved') {
        throw new Error(`Unknown structural interaction status: ${mutationResponse.status}`);
    }
    return recordNoteInteractionIfNew(noteId, interactionType);
}

export function resetNoteInteractionStateForTests() {
    for (const tabId of Object.keys(moduleState.stateByTabId)) {
        delete moduleState.stateByTabId[tabId];
    }
    // Test fixture teardown is explicitly safe before the first interaction.
    if (moduleState.activeContext !== null) moduleState.activeContext = null;
}
