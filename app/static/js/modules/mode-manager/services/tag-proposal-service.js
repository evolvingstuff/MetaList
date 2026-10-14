import { ApplicationState } from '../../application-state.js';

// Suggest Tags with AI, per note: 'asking' while the AI works, 'nothing-new'
// when it had nothing to add. Shown on a card floating above the tag bar's
// right end (a child of the tag bar, so it floats with it); it never takes
// space in the note. "No new tags to suggest" goes with the next key, click or
// the end of editing.
const AI_STATUS_TEXT = new Map([
    ['asking', 'Asking the AI…'],
    ['nothing-new', 'No new tags to suggest'],
]);
const AI_STATUS_CARD_CLASS = 'note-tag-bar-ai-status';

// The proposals row floats under the tag bar when the tag bar floats at the
// window's bottom (a long note): both are sticky, and the tag bar rides higher
// by the row's exact height, which this property on the note gives (main.css).
const PROPOSALS_HEIGHT_PROPERTY = '--note-tag-proposals-height';

const moduleState = ApplicationState.createFields('tag-proposal-service', {
    aiStatusByNoteId: new Map(),
    // With children, how far the batches have got ("2 of 3"), shown after the status.
    aiDetailByNoteId: new Map(),
    // The note whose "No new tags to suggest" the next key or click dismisses.
    dismissibleNoteElement: null,
    rowObserver: null,
});

function aiStatusFor(noteId) {
    if (!moduleState.aiStatusByNoteId.has(noteId)) {
        return '';
    }
    return moduleState.aiStatusByNoteId.get(noteId);
}

export function isAskingAiForTags(noteId) {
    return aiStatusFor(noteId) === 'asking';
}

function aiDetailFor(noteId) {
    if (!moduleState.aiDetailByNoteId.has(noteId)) {
        return '';
    }
    return moduleState.aiDetailByNoteId.get(noteId);
}

// status: 'asking', 'nothing-new' or '' (none); detail: progress shown after it
// ('' for none). Redraws the note's card when the note is on the page
// (noteElement null: it is not rendered, e.g. scrolled away).
export function setAiTagSuggestionStatus({ noteId, status, detail, noteElement, isEditing }) {
    if (typeof detail !== 'string' || (detail !== '' && status !== 'asking')) {
        throw new Error('setAiTagSuggestionStatus detail is progress while asking, or empty');
    }
    if (aiStatusFor(noteId) === status && aiDetailFor(noteId) === detail) {
        return;
    }
    if (detail === '') {
        if (moduleState.aiDetailByNoteId.has(noteId)) {
            moduleState.aiDetailByNoteId.delete(noteId);
        }
    } else {
        moduleState.aiDetailByNoteId.set(noteId, detail);
    }
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('setAiTagSuggestionStatus requires noteId');
    }
    if (status !== '' && !AI_STATUS_TEXT.has(status)) {
        throw new Error(`Unknown Suggest Tags with AI status: ${status}`);
    }
    if (noteElement !== null && (!(noteElement instanceof HTMLElement) || noteElement.dataset.noteId !== noteId)) {
        throw new Error('setAiTagSuggestionStatus noteElement must be that note or null');
    }
    if (status === '' && aiStatusFor(noteId) !== '') {
        moduleState.aiStatusByNoteId.delete(noteId);
    } else if (status !== '' && aiStatusFor(noteId) !== status) {
        moduleState.aiStatusByNoteId.set(noteId, status);
    }
    if (noteElement !== null) {
        syncAiStatusCard(noteElement, noteId, isEditing);
    }
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

function dismissNothingNew() {
    const noteElement = moduleState.dismissibleNoteElement;
    stopDismissingNothingNew();
    const noteId = noteElement.dataset.noteId;
    if (aiStatusFor(noteId) === 'nothing-new') {
        moduleState.aiStatusByNoteId.delete(noteId);
    }
    const tagBar = getDirectChild(noteElement, 'note-tag-bar');
    if (tagBar !== null) {
        removeDirectChild(tagBar, AI_STATUS_CARD_CLASS);
    }
}

function dismissNothingNewOnKey(event) {
    if (!MODIFIER_KEYS.has(event.key)) {
        dismissNothingNew();
    }
}

function startDismissingNothingNew(noteElement) {
    if (moduleState.dismissibleNoteElement === noteElement) {
        return;
    }
    if (moduleState.dismissibleNoteElement !== null) {
        stopDismissingNothingNew();
    }
    moduleState.dismissibleNoteElement = noteElement;
    window.addEventListener('keydown', dismissNothingNewOnKey, { capture: true });
    document.addEventListener('mousedown', dismissNothingNew, { capture: true });
}

function stopDismissingNothingNew() {
    moduleState.dismissibleNoteElement = null;
    window.removeEventListener('keydown', dismissNothingNewOnKey, { capture: true });
    document.removeEventListener('mousedown', dismissNothingNew, { capture: true });
}

// The status card lives in the tag bar, which exists only while the note is edited.
function syncAiStatusCard(noteElement, noteId, isEditing) {
    // "No new tags to suggest" is about this edit; it goes when editing ends.
    if (!isEditing && aiStatusFor(noteId) === 'nothing-new') {
        moduleState.aiStatusByNoteId.delete(noteId);
    }
    const tagBar = getDirectChild(noteElement, 'note-tag-bar');
    if (tagBar !== null) {
        removeDirectChild(tagBar, AI_STATUS_CARD_CLASS);
    }
    const aiStatus = aiStatusFor(noteId);
    if (aiStatus !== 'nothing-new' && moduleState.dismissibleNoteElement === noteElement) {
        stopDismissingNothingNew();
    }
    if (!isEditing || tagBar === null || aiStatus === '') {
        return;
    }
    const card = document.createElement('div');
    card.classList.add(AI_STATUS_CARD_CLASS);
    card.setAttribute('role', 'status');
    const detail = aiDetailFor(noteId);
    card.textContent = detail === '' ? AI_STATUS_TEXT.get(aiStatus) : `${AI_STATUS_TEXT.get(aiStatus)} ${detail}`;
    tagBar.appendChild(card);
    if (aiStatus === 'nothing-new') {
        startDismissingNothingNew(noteElement);
    }
}

function proposalRowObserver() {
    if (moduleState.rowObserver === null) {
        moduleState.rowObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const row = entry.target;
                if (row.parentElement !== null) {
                    row.parentElement.style.setProperty(PROPOSALS_HEIGHT_PROPERTY, `${row.getBoundingClientRect().height}px`);
                }
            }
        });
    }
    return moduleState.rowObserver;
}

function removeProposalRow(noteElement) {
    const row = getDirectChild(noteElement, 'note-tag-proposals');
    if (row === null) {
        return;
    }
    proposalRowObserver().unobserve(row);
    row.remove();
    noteElement.style.removeProperty(PROPOSALS_HEIGHT_PROPERTY);
}

function parseProposalTokens(proposedTags) {
    if (typeof proposedTags !== 'string') {
        throw new Error('parseProposalTokens requires proposedTags string');
    }
    const trimmed = proposedTags.trim();
    if (trimmed === '') {
        return [];
    }
    const tokens = trimmed.split(/\s+/u);
    const normalizedKeys = new Set(tokens.map((token) => token.toLowerCase()));
    if (normalizedKeys.size !== tokens.length) {
        throw new Error('Proposal tokens must be case-insensitively unique');
    }
    return tokens;
}

// The new-tag proposals, checked against the note's proposals (case-insensitive).
function parseNewProposalKeys(newProposedTags, tokens) {
    const proposalKeys = new Set(tokens.map((token) => token.toLowerCase()));
    const newKeys = new Set(parseProposalTokens(newProposedTags).map((token) => token.toLowerCase()));
    for (const key of newKeys) {
        if (!proposalKeys.has(key)) {
            throw new Error(`New proposal ${key} is not one of the note's proposals`);
        }
    }
    return newKeys;
}

function getDirectChild(noteElement, className) {
    for (const child of noteElement.children) {
        if (child.classList.contains(className)) {
            return child;
        }
    }
    return null;
}

function removeDirectChild(noteElement, className) {
    const child = getDirectChild(noteElement, className);
    if (child !== null) {
        child.remove();
    }
}

function insertAfterTagPresentation(noteElement, child) {
    const editingTagBar = getDirectChild(noteElement, 'note-tag-bar');
    if (editingTagBar instanceof HTMLElement) {
        editingTagBar.after(child);
        return;
    }
    const tagsElement = getDirectChild(noteElement, 'note-tags');
    if (!(tagsElement instanceof HTMLElement)) {
        throw new Error(`Note ${noteElement.dataset.noteId || '<unknown>'} missing tags element`);
    }
    tagsElement.after(child);
}

function buildProposalAction(noteId, proposal, isNew, action, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('note-tag-proposal-action', `note-tag-proposal-${action}`);
    button.dataset.noteId = noteId;
    button.dataset.proposal = proposal;
    button.dataset.proposalAction = action;
    const kind = isNew ? 'new tag' : 'tag';
    button.setAttribute('aria-label', `${label} proposed ${kind} ${proposal}`);
    button.textContent = action === 'accept' ? '+' : '−';
    // Pressing + or − keeps focus and the caret where the user was working.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    return button;
}

function buildNewTagBadge() {
    const badge = document.createElement('span');
    badge.classList.add('note-tag-proposal-new');
    badge.textContent = 'new';
    badge.setAttribute('title', 'Not on any of your notes yet');
    return badge;
}

// Proposals for tags already in use come first; new tags sit together on the right.
function syncProposalRow(noteElement, noteId, tokens, newKeys, isEditing) {
    removeProposalRow(noteElement);
    if (!isEditing || tokens.length === 0) {
        return;
    }

    const row = document.createElement('div');
    row.classList.add('note-tag-proposals');
    row.setAttribute('aria-label', 'AI tag proposals');
    const inUse = tokens.filter((token) => !newKeys.has(token.toLowerCase()));
    const created = tokens.filter((token) => newKeys.has(token.toLowerCase()));
    for (const proposal of [...inUse, ...created]) {
        const isNew = newKeys.has(proposal.toLowerCase());
        const proposalElement = document.createElement('span');
        proposalElement.classList.add('note-tag-proposal');
        if (isNew) {
            proposalElement.classList.add('note-tag-proposal-is-new');
        }

        const label = document.createElement('span');
        label.classList.add('note-tag-proposal-label');
        label.textContent = proposal;
        proposalElement.appendChild(label);
        if (isNew) {
            proposalElement.appendChild(buildNewTagBadge());
        }
        proposalElement.appendChild(
            buildProposalAction(noteId, proposal, isNew, 'accept', 'Accept'),
        );
        proposalElement.appendChild(
            buildProposalAction(noteId, proposal, isNew, 'reject', 'Reject'),
        );
        row.appendChild(proposalElement);
    }
    insertAfterTagPresentation(noteElement, row);
    proposalRowObserver().observe(row);
}

function syncProposalIndicator(noteElement, proposalCount) {
    removeDirectChild(noteElement, 'note-proposal-indicator');
    if (proposalCount === 0) {
        return;
    }
    const indicator = document.createElement('span');
    indicator.classList.add('note-proposal-indicator');
    indicator.setAttribute(
        'aria-label',
        `${proposalCount} AI tag ${proposalCount === 1 ? 'proposal' : 'proposals'}`,
    );
    indicator.textContent = `🤖 ${proposalCount}`;
    // Pressing it (to click or right-click) keeps focus and the caret where the
    // user was working; MetaList's own handlers still act on the press.
    indicator.addEventListener('mousedown', (event) => event.preventDefault());
    insertAfterTagPresentation(noteElement, indicator);
}

export function syncTagProposalEditingState(noteElement, isEditing) {
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error('syncTagProposalEditingState requires note element');
    }
    if (typeof isEditing !== 'boolean') {
        throw new Error('syncTagProposalEditingState requires isEditing boolean');
    }
    const proposedTags = noteElement.dataset.noteProposedTags;
    if (typeof proposedTags !== 'string') {
        throw new Error('Proposal presentation note is missing proposed tags data');
    }
    const newProposedTags = noteElement.dataset.noteNewProposedTags;
    if (typeof newProposedTags !== 'string') {
        throw new Error('Proposal presentation note is missing new proposed tags data');
    }
    const noteId = noteElement.dataset.noteId;
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('Proposal presentation note is missing note id');
    }
    const tokens = parseProposalTokens(proposedTags);
    syncProposalRow(noteElement, noteId, tokens, parseNewProposalKeys(newProposedTags, tokens), isEditing);
    syncAiStatusCard(noteElement, noteId, isEditing);
}

export function syncTagProposalPresentation(
    noteElement,
    { proposedTags, newProposedTags, proposalCount, isEditing },
) {
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error('syncTagProposalPresentation requires note element');
    }
    if (!Number.isInteger(proposalCount) || proposalCount < 0) {
        throw new Error('syncTagProposalPresentation requires non-negative proposalCount');
    }
    if (typeof isEditing !== 'boolean') {
        throw new Error('syncTagProposalPresentation requires isEditing boolean');
    }
    const noteId = noteElement.dataset.noteId;
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('Proposal presentation note is missing note id');
    }
    const tokens = parseProposalTokens(proposedTags);
    const newKeys = parseNewProposalKeys(newProposedTags, tokens);
    noteElement.dataset.noteProposedTags = proposedTags;
    noteElement.dataset.noteNewProposedTags = newProposedTags;
    noteElement.dataset.proposalCount = String(proposalCount);
    syncProposalRow(noteElement, noteId, tokens, newKeys, isEditing);
    syncAiStatusCard(noteElement, noteId, isEditing);
    syncProposalIndicator(noteElement, proposalCount);
}
