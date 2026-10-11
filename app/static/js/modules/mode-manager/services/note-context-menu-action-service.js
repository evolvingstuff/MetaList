export async function prepareOutlineMoveContextAction(options) {
    if (options === null || typeof options !== 'object') {
        throw new Error('prepareOutlineMoveContextAction requires options object');
    }

    const {
        targetNoteId,
        modeContext,
        exitSearchModeFn,
        saveActiveNoteFn,
    } = options;

    if (typeof targetNoteId !== 'string' || targetNoteId.trim() === '') {
        throw new Error('prepareOutlineMoveContextAction requires targetNoteId');
    }
    if (modeContext === null || typeof modeContext !== 'object') {
        throw new Error('prepareOutlineMoveContextAction requires modeContext object');
    }
    if (typeof exitSearchModeFn !== 'function') {
        throw new Error('prepareOutlineMoveContextAction requires exitSearchModeFn');
    }
    if (typeof saveActiveNoteFn !== 'function') {
        throw new Error('prepareOutlineMoveContextAction requires saveActiveNoteFn');
    }

    if (modeContext.isSearching) {
        exitSearchModeFn();
    }

    if (!modeContext.isEditing) {
        return;
    }

    const currentNoteId = modeContext.currentNoteId;
    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        throw new Error('prepareOutlineMoveContextAction requires currentNoteId while editing');
    }
    if (currentNoteId === targetNoteId) {
        return;
    }
    if (!modeContext.editSessionHasEdits) {
        return;
    }

    await saveActiveNoteFn(currentNoteId);
}

export async function prepareDeleteNoteContextAction(options) {
    if (options === null || typeof options !== 'object') {
        throw new Error('prepareDeleteNoteContextAction requires options object');
    }

    const {
        targetNoteId,
        modeContext,
        exitSearchModeFn,
        saveAndExitEditingFn,
    } = options;

    if (typeof targetNoteId !== 'string' || targetNoteId.trim() === '') {
        throw new Error('prepareDeleteNoteContextAction requires targetNoteId');
    }
    if (modeContext === null || typeof modeContext !== 'object') {
        throw new Error('prepareDeleteNoteContextAction requires modeContext object');
    }
    if (typeof exitSearchModeFn !== 'function') {
        throw new Error('prepareDeleteNoteContextAction requires exitSearchModeFn');
    }
    if (typeof saveAndExitEditingFn !== 'function') {
        throw new Error('prepareDeleteNoteContextAction requires saveAndExitEditingFn');
    }

    if (modeContext.isSearching) {
        exitSearchModeFn();
    }

    if (!modeContext.isEditing) {
        return 'outside-edit';
    }

    const currentNoteId = modeContext.currentNoteId;
    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        throw new Error('prepareDeleteNoteContextAction requires currentNoteId while editing');
    }
    if (currentNoteId === targetNoteId) {
        return 'selected-edit';
    }

    await saveAndExitEditingFn();
    return 'outside-edit';
}
