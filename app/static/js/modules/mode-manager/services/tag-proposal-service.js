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

function buildProposalAction(noteId, proposal, action, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('note-tag-proposal-action', `note-tag-proposal-${action}`);
    button.dataset.noteId = noteId;
    button.dataset.proposal = proposal;
    button.dataset.proposalAction = action;
    button.setAttribute('aria-label', `${label} proposed tag ${proposal}`);
    button.textContent = action === 'accept' ? '+' : '−';
    return button;
}

function syncProposalRow(noteElement, noteId, tokens, isEditing) {
    removeDirectChild(noteElement, 'note-tag-proposals');
    if (!isEditing || tokens.length === 0) {
        return;
    }

    const row = document.createElement('div');
    row.classList.add('note-tag-proposals');
    row.setAttribute('aria-label', 'AI tag proposals');
    for (const proposal of tokens) {
        const proposalElement = document.createElement('span');
        proposalElement.classList.add('note-tag-proposal');

        const label = document.createElement('span');
        label.classList.add('note-tag-proposal-label');
        label.textContent = proposal;
        proposalElement.appendChild(label);
        proposalElement.appendChild(
            buildProposalAction(noteId, proposal, 'accept', 'Accept'),
        );
        proposalElement.appendChild(
            buildProposalAction(noteId, proposal, 'reject', 'Reject'),
        );
        row.appendChild(proposalElement);
    }
    insertAfterTagPresentation(noteElement, row);
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
    const noteId = noteElement.dataset.noteId;
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('Proposal presentation note is missing note id');
    }
    syncProposalRow(noteElement, noteId, parseProposalTokens(proposedTags), isEditing);
}

export function syncTagProposalPresentation(
    noteElement,
    { proposedTags, proposalCount, isEditing },
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
    noteElement.dataset.noteProposedTags = proposedTags;
    noteElement.dataset.proposalCount = String(proposalCount);
    syncProposalRow(noteElement, noteId, tokens, isEditing);
    syncProposalIndicator(noteElement, proposalCount);
}
