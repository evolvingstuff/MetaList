export function shouldUseApplicationHistory({ isEditing, isDirty, editSessionHasEdits }) {
    if (typeof isEditing !== 'boolean') {
        throw new Error('isEditing must be a boolean');
    }
    if (typeof isDirty !== 'boolean') {
        throw new Error('isDirty must be a boolean');
    }
    if (typeof editSessionHasEdits !== 'boolean') {
        throw new Error('editSessionHasEdits must be a boolean');
    }
    if (!isEditing) {
        return true;
    }
    return !isDirty && !editSessionHasEdits;
}

export function shouldExecuteEditorRedo({ isEditing, key }) {
    if (typeof isEditing !== 'boolean') {
        throw new Error('isEditing must be a boolean');
    }
    if (typeof key !== 'string' || key.length === 0) {
        throw new Error('key must be a non-empty string');
    }
    return isEditing && key === 'y';
}

export function executeEditorRedo(documentObject) {
    if (!documentObject || typeof documentObject.execCommand !== 'function') {
        throw new Error('Editor redo requires document.execCommand');
    }
    return documentObject.execCommand('redo');
}
