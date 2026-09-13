import { ApplicationState } from '../../application-state.js';
import { CONFIG } from '../../config.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { updateCollapseAffordancesForNotes } from './collapse-affordance-service.js';
import { hydrateImageFilePreviews } from './file-image-preview-service.js';
import {
    hydrateRemoteImageProxies,
    prepareRemoteImageElementsForEditing,
} from './remote-image-proxy-service.js';
import { ensureAnchorsOpenInNewTabs } from './markdown-render-service.js';
import { queueMermaidDiagramRendering } from './mermaid-render-service.js';
import {
    animateNoteCollapseChanges,
    captureNoteCollapseAnimation,
} from './note-collapse-animation-service.js';
import {
    animateNoteRemovalAndRemove,
    captureNoteRemovalAnimation,
} from './note-reposition-animation-service.js';
import { setNoteSearchRedactionState } from './search-redaction-reveal-service.js';
import {
    formatBrowserNoteTimestamp,
    syncNoteTimestampDataset,
} from './note-timestamp-hover-service.js';
import { syncTagProposalPresentation } from './tag-proposal-service.js';

const CONTENT_ELEMENT_CACHE = ApplicationState.createWeakCollection('CONTENT_ELEMENT_CACHE', 'map');
const CHILD_CONTAINER_CACHE = ApplicationState.createWeakCollection('CHILD_CONTAINER_CACHE', 'map');

function hydrateRemoteImagesForCurrentMode(notesContainer) {
    hydrateRemoteImageProxies(notesContainer);
    void prepareRemoteImageElementsForEditing(notesContainer).then((prepared) => {
        if (prepared) {
            hydrateRemoteImageProxies(notesContainer);
        }
    });
}
const COLLAPSE_TOGGLE_CACHE = ApplicationState.createWeakCollection('COLLAPSE_TOGGLE_CACHE', 'map');
const LOCK_ICON_CACHE = ApplicationState.createWeakCollection('LOCK_ICON_CACHE', 'map');
const TAGS_ELEMENT_CACHE = ApplicationState.createWeakCollection('TAGS_ELEMENT_CACHE', 'map');

function logVDOM(action, details) {
    console.log(` [VDOM] ${action}`, details);
}

function captureCollapseAnimationsFromNotePayload(notePayload) {
    if (!notePayload || typeof notePayload !== 'object') {
        throw new Error('captureCollapseAnimationsFromNotePayload requires note payload object');
    }

    const captures = [];
    for (const [noteId, noteData] of Object.entries(notePayload)) {
        if (!noteData || typeof noteData !== 'object') {
            continue;
        }
        const flags = noteData.flags;
        if (!flags || typeof flags !== 'object') {
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(flags, 'isCollapsed')) {
            continue;
        }
        const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
        if (!(noteElement instanceof HTMLElement)) {
            continue;
        }
        const capture = captureNoteCollapseAnimation(noteElement, Boolean(flags.isCollapsed));
        if (capture !== null) {
            captures.push(capture);
        }
    }
    return captures;
}

function buildCollapseAnimationCaptures(notePayload, animateNoteChanges) {
    if (typeof animateNoteChanges !== 'boolean') {
        throw new Error('buildCollapseAnimationCaptures requires animateNoteChanges boolean');
    }
    if (!animateNoteChanges) {
        return [];
    }
    return captureCollapseAnimationsFromNotePayload(notePayload);
}

function buildCollapsingCaptureByNoteId(collapseAnimationCaptures) {
    if (!Array.isArray(collapseAnimationCaptures)) {
        throw new Error('buildCollapsingCaptureByNoteId requires captures array');
    }
    const collapsingCaptureByNoteId = new Map();
    for (const capture of collapseAnimationCaptures) {
        if (!capture || typeof capture !== 'object') {
            throw new Error('collapse animation capture must be object');
        }
        if (!capture.nextCollapsed) {
            continue;
        }
        const noteElement = capture.noteElement;
        if (!(noteElement instanceof HTMLElement)) {
            throw new Error('collapse animation capture missing note element');
        }
        const noteId = noteElement.dataset.noteId;
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('collapsing note must have note id');
        }
        collapsingCaptureByNoteId.set(noteId, capture);
    }
    return collapsingCaptureByNoteId;
}

function deferRemovalForCollapsingParent(collapsingCaptureByNoteId, parentId, noteElement) {
    if (!(collapsingCaptureByNoteId instanceof Map)) {
        throw new Error('deferRemovalForCollapsingParent requires capture map');
    }
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error('deferRemovalForCollapsingParent requires note element');
    }
    if (typeof parentId !== 'string' || parentId.length === 0) {
        return false;
    }
    const collapseCapture = collapsingCaptureByNoteId.get(parentId);
    if (!collapseCapture) {
        return false;
    }
    if (!Array.isArray(collapseCapture.deferredRemovalElements)) {
        throw new Error('collapse capture missing deferred removal array');
    }
    noteElement.style.pointerEvents = 'none';
    collapseCapture.deferredRemovalElements.push(noteElement);
    return true;
}

function removeNoteElement(noteElement, animateNoteChanges) {
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error('removeNoteElement requires HTMLElement');
    }
    if (typeof animateNoteChanges !== 'boolean') {
        throw new Error('removeNoteElement requires animateNoteChanges boolean');
    }
    if (!animateNoteChanges) {
        noteElement.remove();
        return;
    }
    const capture = captureNoteRemovalAnimation(noteElement);
    if (capture === null) {
        noteElement.remove();
        return;
    }
    animateNoteRemovalAndRemove(capture);
}

function applyServerDiffOps(payload, animateNoteChanges) {
    if (typeof animateNoteChanges !== 'boolean') {
        throw new Error('applyServerDiffOps requires animateNoteChanges boolean');
    }
    const notesContainer = document.getElementById('notes-container');
    if (!notesContainer) {
        throw new Error('Notes container not found');
    }

    let noteLocks = payload.locks;
    if (!noteLocks || typeof noteLocks !== 'object') {
        noteLocks = {};
    }
    let lockDiffs = payload.lockDiffs;
    if (!lockDiffs || typeof lockDiffs !== 'object') {
        lockDiffs = {};
    }
    let noteUpdates = payload.notes;
    if (!noteUpdates || typeof noteUpdates !== 'object') {
        noteUpdates = {};
    }
    if (payload.diffOps.length === 0
        && Object.keys(noteUpdates).length === 0
        && Object.keys(lockDiffs).length === 0) {
        return {
            notesContainer,
            editingNoteElement: payload.editingNoteId
                ? document.querySelector(`[data-note-id="${payload.editingNoteId}"]`)
                : null,
            vdomOperations: 0,
        };
    }
    const touchedParentIds = new Set();
    const affordanceDirtyElements = new Set();
    const collapseAnimationCaptures = buildCollapseAnimationCaptures(noteUpdates, animateNoteChanges);
    const collapsingCaptureByNoteId = buildCollapsingCaptureByNoteId(collapseAnimationCaptures);
    const noteElements = new Map();
    let vdomOperations = 0;
    let didRenderContent = false;
    const insertedIds = new Set();

    for (const op of payload.diffOps) {
        if (!op || typeof op !== 'object') {
            continue;
        }
        if (op.type === 'insert' && typeof op.noteId === 'string') {
            insertedIds.add(op.noteId);
        }
    }

    const normalizeParentId = (parentId) => {
        return typeof parentId === 'string' && parentId.length > 0 ? parentId : null;
    };
    const normalizeParentIdForDataset = (parentId) => {
        return typeof parentId === 'string' ? parentId : '';
    };

    const resolveParentContainer = (parentId) => {
        if (!parentId) {
            return notesContainer;
        }
        const parentElement = document.querySelector(`[data-note-id="${parentId}"]`);
        if (!parentElement) {
            throw new Error(`Parent note ${parentId} missing from DOM`);
        }
        return ensureChildContainer(parentElement);
    };

    const getOrCacheElement = (noteId) => {
        if (noteElements.has(noteId)) {
            return noteElements.get(noteId);
        }
        const element = document.querySelector(`[data-note-id="${noteId}"]`);
        if (element) {
            noteElements.set(noteId, element);
        }
        return element;
    };

    for (const op of payload.diffOps) {
        if (!op || typeof op !== 'object') {
            continue;
        }

        if (op.type === 'remove') {
            if (insertedIds.has(op.noteId)) {
                touchedParentIds.add(normalizeParentId(op.parentId));
                continue;
            }
            const element = getOrCacheElement(op.noteId);
            if (!element) {
                continue;
            }
            const ids = collectDomSubtreeIds(element);
            const isRemovalDeferred = deferRemovalForCollapsingParent(
                collapsingCaptureByNoteId,
                normalizeParentId(op.parentId),
                element,
            );
            if (!isRemovalDeferred) {
                removeNoteElement(element, animateNoteChanges);
            }
            ids.forEach((id) => {
                noteElements.delete(id);
                if (ModeContext.hasNoteHash(id)) {
                    ModeContext.removeNoteHash(id);
                }
            });
            touchedParentIds.add(normalizeParentId(op.parentId));
            vdomOperations += 1;
            continue;
        }

        if (op.type === 'insert') {
            const parentId = normalizeParentId(op.parentId);
            const parentContainer = resolveParentContainer(parentId);
            const index = typeof op.toIndex === 'number' ? op.toIndex : parentContainer.children.length;
            const reference = findNoteChildAt(parentContainer, index);
            const noteData = noteUpdates[op.noteId];
            const existingElement = getOrCacheElement(op.noteId);
            if (!noteData && !existingElement) {
                throw new Error(`Insert operation missing payload for ${op.noteId}`);
            }
            let element = existingElement;
            if (!element) {
                element = createNoteElement(op.noteId);
            }
            element.dataset.parentId = normalizeParentIdForDataset(op.parentId);
            let contentChanged = false;
            if (noteData) {
                contentChanged = applyNoteDataFromPayload(
                    element,
                    op.noteId,
                    noteData,
                    noteLocks,
                    payload.currentClientId,
                    affordanceDirtyElements,
                    !existingElement,
                );
            }
            parentContainer.insertBefore(element, reference);
            noteElements.set(op.noteId, element);
            touchedParentIds.add(parentId);
            vdomOperations += 1;
            if (contentChanged) {
                vdomOperations += 1;
                didRenderContent = true;
            }
            if (noteData) {
                delete noteUpdates[op.noteId];
            }
            continue;
        }

        if (op.type === 'move') {
            const element = getOrCacheElement(op.noteId);
            if (!element) {
                continue;
            }
            const parentId = normalizeParentId(op.parentId);
            const parentContainer = resolveParentContainer(parentId);
            const index = typeof op.toIndex === 'number' ? op.toIndex : parentContainer.children.length;
            const reference = findNoteChildAt(parentContainer, index);
            if (reference !== element) {
                parentContainer.insertBefore(element, reference);
                vdomOperations += 1;
            }
            element.dataset.parentId = normalizeParentIdForDataset(op.parentId);
            touchedParentIds.add(parentId);
        }
    }

    Object.entries(noteUpdates).forEach(([noteId, noteData]) => {
        let element = getOrCacheElement(noteId);
        if (!element) {
            element = createNoteElement(noteId);
        }
        if (!element.isConnected) {
            element.dataset.parentId = '';
            notesContainer.appendChild(element);
        }
        const contentChanged = applyNoteDataFromPayload(
            element,
            noteId,
            noteData,
            noteLocks,
            payload.currentClientId,
            affordanceDirtyElements,
            false,
        );
        noteElements.set(noteId, element);
        if (contentChanged) {
            vdomOperations += 1;
            didRenderContent = true;
        }
    });

    applyLockDiffs(lockDiffs, payload.currentClientId, affordanceDirtyElements);

    for (const parentId of touchedParentIds) {
        if (!parentId) {
            continue;
        }
        const parentElement = getOrCacheElement(parentId);
        if (parentElement) {
            affordanceDirtyElements.add(parentElement);
        }
    }

    if (didRenderContent) {
        hydrateImageFilePreviews(notesContainer);
        hydrateRemoteImagesForCurrentMode(notesContainer);
        void queueMermaidDiagramRendering(notesContainer);
    }
    updateCollapseAffordancesForNotes(affordanceDirtyElements);
    animateNoteCollapseChanges(collapseAnimationCaptures);

    return {
        notesContainer,
        editingNoteElement: payload.editingNoteId
            ? document.querySelector(`[data-note-id="${payload.editingNoteId}"]`)
            : null,
        vdomOperations,
    };
}

function diffSiblingOrder(currentIds, desiredIds) {
    const position = new Map(currentIds.map((id, idx) => [id, idx]));
    const working = currentIds.slice();
    const desiredSet = new Set(desiredIds);

    const ops = [];

    for (let i = working.length - 1; i >= 0; i -= 1) {
        const id = working[i];
        if (!desiredSet.has(id)) {
            working.splice(i, 1);
            position.delete(id);
            ops.push({ type: 'remove', id, fromIndex: i });
        }
    }

    for (let target = 0; target < desiredIds.length; target += 1) {
        const id = desiredIds[target];
        const existingIndex = position.has(id) ? position.get(id) : -1;

        if (existingIndex === -1) {
            working.splice(target, 0, id);
            ops.push({ type: 'insert', id, toIndex: target });

            for (let i = target + 1; i < working.length; i += 1) {
                position.set(working[i], i);
            }
            position.set(id, target);
            continue;
        }

        if (existingIndex === target) {
            continue;
        }

        working.splice(existingIndex, 1);
        working.splice(target, 0, id);
        ops.push({ type: 'move', id, fromIndex: existingIndex, toIndex: target });

        const start = Math.min(existingIndex, target);
        const end = Math.max(existingIndex, target);
        for (let i = start; i <= end; i += 1) {
            position.set(working[i], i);
        }
    }

    return ops;
}

function diffNoteForest(currentChildren, desiredChildren, parentId, results) {
    if (!Array.isArray(results)) {
        throw new Error('diffNoteForest requires results array');
    }
    const currentIds = currentChildren.map((node) => node.id);
    const desiredIds = desiredChildren.map((node) => node.id);

    const currentById = new Map(currentChildren.map((node) => [node.id, node]));
    const desiredById = new Map(desiredChildren.map((node) => [node.id, node]));

    const orderOps = diffSiblingOrder(currentIds, desiredIds).map((op) => {
        if (op.type === 'remove') {
            return { ...op, node: currentById.get(op.id) };
        }
        if (op.type === 'insert') {
            return { ...op, node: desiredById.get(op.id) };
        }
        return op;
    });

    if (orderOps.length > 0) {
        results.push({ parentId, operations: orderOps });
    }

    for (const id of desiredIds) {
        if (!currentById.has(id)) {
            continue;
        }
        const currentNode = currentById.get(id);
        const desiredNode = desiredById.get(id);
        diffNoteForest(currentNode.children, desiredNode.children, id, results);
    }

    return results;
}

function createNoteElement(noteId) {
    const noteElement = document.createElement('div');
    noteElement.classList.add(CONFIG.CLASSES.NOTE);
    noteElement.dataset.noteId = noteId;
    noteElement.dataset.parentId = '';
    noteElement.dataset.isCollapsed = 'false';
    noteElement.dataset.hasChildren = 'false';
    noteElement.dataset.isCollapsible = 'false';
    noteElement.dataset.noteTags = '';
    noteElement.dataset.noteProposedTags = '';
    noteElement.dataset.proposalCount = '0';
    noteElement.dataset.searchRedacted = 'false';

    const collapseToggle = document.createElement('button');
    collapseToggle.classList.add('note-collapse-toggle');
    collapseToggle.type = 'button';
    collapseToggle.setAttribute('aria-label', 'Collapse note');
    noteElement.appendChild(collapseToggle);
    COLLAPSE_TOGGLE_CACHE.set(noteElement, collapseToggle);

    const contentElement = document.createElement('div');
    contentElement.classList.add(CONFIG.CLASSES.NOTE_CONTENT);
    contentElement.setAttribute('contenteditable', 'false');
    noteElement.appendChild(contentElement);
    CONTENT_ELEMENT_CACHE.set(noteElement, contentElement);

    const tagsElement = document.createElement('div');
    tagsElement.classList.add('note-tags');
    tagsElement.setAttribute('aria-hidden', 'true');
    tagsElement.textContent = '';
    noteElement.appendChild(tagsElement);
    TAGS_ELEMENT_CACHE.set(noteElement, tagsElement);

    return noteElement;
}

function getDirectChildByClass(noteElement, className) {
    for (const child of Array.from(noteElement.children)) {
        if (child.classList && child.classList.contains(className)) {
            return child;
        }
    }
    return null;
}

function getContentElement(noteElement) {
    if (CONTENT_ELEMENT_CACHE.has(noteElement)) {
        return CONTENT_ELEMENT_CACHE.get(noteElement);
    }
    let contentElement = getDirectChildByClass(noteElement, CONFIG.CLASSES.NOTE_CONTENT);
    if (!contentElement) {
        contentElement = getDirectChildByClass(noteElement, 'note-content');
    }
    if (!contentElement) {
        throw new Error(`Note ${noteElement.dataset.noteId || '<unknown>'} missing content element`);
    }
    CONTENT_ELEMENT_CACHE.set(noteElement, contentElement);
    return contentElement;
}

function getCollapseToggle(noteElement) {
    if (COLLAPSE_TOGGLE_CACHE.has(noteElement)) {
        return COLLAPSE_TOGGLE_CACHE.get(noteElement);
    }
    const collapseToggle = getDirectChildByClass(noteElement, 'note-collapse-toggle');
    if (!collapseToggle) {
        throw new Error(`Note ${noteElement.dataset.noteId || '<unknown>'} missing collapse toggle element`);
    }
    COLLAPSE_TOGGLE_CACHE.set(noteElement, collapseToggle);
    return collapseToggle;
}

function getTagsElement(noteElement) {
    if (TAGS_ELEMENT_CACHE.has(noteElement)) {
        return TAGS_ELEMENT_CACHE.get(noteElement);
    }
    const tagsElement = getDirectChildByClass(noteElement, 'note-tags');
    if (!tagsElement) {
        throw new Error(`Note ${noteElement.dataset.noteId || '<unknown>'} missing tags element`);
    }
    TAGS_ELEMENT_CACHE.set(noteElement, tagsElement);
    return tagsElement;
}

function syncTagsElement(noteElement) {
    const tagsElement = getTagsElement(noteElement);
    const tags = typeof noteElement.dataset.noteTags === 'string' ? noteElement.dataset.noteTags : '';
    tagsElement.textContent = tags;
}

function getChildContainer(noteElement) {
    if (CHILD_CONTAINER_CACHE.has(noteElement)) {
        return CHILD_CONTAINER_CACHE.get(noteElement);
    }
    const childContainer = getDirectChildByClass(noteElement, 'note-children');
    if (childContainer) {
        CHILD_CONTAINER_CACHE.set(noteElement, childContainer);
    }
    return childContainer;
}

function ensureChildContainer(noteElement) {
    let childContainer = getChildContainer(noteElement);
    if (!childContainer) {
        childContainer = document.createElement('div');
        childContainer.classList.add('note-children');
        noteElement.appendChild(childContainer);
        CHILD_CONTAINER_CACHE.set(noteElement, childContainer);
    }
    return childContainer;
}

function updateLockIcon(noteElement, lockedByOther) {
    let lockIcon = LOCK_ICON_CACHE.has(noteElement)
        ? LOCK_ICON_CACHE.get(noteElement)
        : getDirectChildByClass(noteElement, 'lock-icon');
    if (lockedByOther) {
        if (!lockIcon) {
            lockIcon = document.createElement('span');
            lockIcon.classList.add('lock-icon');
            lockIcon.textContent = '🔒';
            noteElement.insertBefore(lockIcon, noteElement.firstChild);
            LOCK_ICON_CACHE.set(noteElement, lockIcon);
        }
    } else if (lockIcon) {
        lockIcon.remove();
        if (LOCK_ICON_CACHE.has(noteElement)) LOCK_ICON_CACHE.delete(noteElement);
    }
}

export function applyDifferentialView(payload, options) {
    if (options === null || typeof options !== 'object') {
        throw new Error('applyDifferentialView requires options object');
    }
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid differential payload');
    }

    const animateNoteChanges = options.animateNoteChanges !== false;

    if (Array.isArray(payload.diffOps)) {
        return applyServerDiffOps(payload, animateNoteChanges);
    }

    if (!Array.isArray(payload.structure)) {
        throw new Error('Invalid differential payload');
    }

    let previousHashes = options.previousHashes;
    if (!previousHashes || typeof previousHashes !== 'object') {
        previousHashes = {};
    }

    const notesContainer = document.getElementById('notes-container');
    if (!notesContainer) {
        throw new Error('Notes container not found');
    }

    const elementCache = new Map();
    const currentForest = buildDomForest(notesContainer, elementCache);
    let notePayload = payload.notes;
    if (!notePayload || typeof notePayload !== 'object') {
        notePayload = {};
    }
    const collapseAnimationCaptures = buildCollapseAnimationCaptures(notePayload, animateNoteChanges);
    const collapsingCaptureByNoteId = buildCollapsingCaptureByNoteId(collapseAnimationCaptures);
    const desired = buildDesiredForest(payload.structure, notePayload);
    const desiredIds = new Set(desired.nodeById.keys());

    const diffResults = diffNoteForest(currentForest, desired.roots, null, []);
    let vdomOperations = 0;
    const insertedIds = new Set();
    const touchedParentIds = new Set();
    const affordanceDirtyElements = new Set();

    let noteLocks = payload.locks;
    if (!noteLocks || typeof noteLocks !== 'object') {
        noteLocks = {};
    }

    const parentContainerCache = new Map();
    const ensureParentContainer = (parentId) => {
        const key = parentId ? parentId : '__root__';
        if (parentContainerCache.has(key)) {
            return parentContainerCache.get(key);
        }
        if (!parentId) {
            parentContainerCache.set(key, notesContainer);
            return notesContainer;
        }
        let parentElement = elementCache.get(parentId);
        if (!parentElement) {
            parentElement = document.querySelector(`[data-note-id="${parentId}"]`);
        }
        if (!parentElement) {
            throw new Error(`Parent note ${parentId} missing from DOM`);
        }
        const container = ensureChildContainer(parentElement);
        parentContainerCache.set(key, container);
        return container;
    };

    for (const { parentId, operations } of diffResults) {
        const parentContainer = ensureParentContainer(parentId);
        for (const op of operations) {
            if (op.type === 'remove') {
                const node = op.node;
                if (!node) {
                    throw new Error(`Remove operation missing node for ${op.id}`);
                }
                if (desiredIds.has(op.id)) {
                    if (parentId) {
                        touchedParentIds.add(parentId);
                    }
                    continue;
                }
                const element = elementCache.get(op.id);
                if (!element) {
                    continue;
                }
                const ids = collectSubtreeIds(node);
                const normalizedParentId = typeof parentId === 'string' ? parentId : '';
                const isRemovalDeferred = deferRemovalForCollapsingParent(
                    collapsingCaptureByNoteId,
                    normalizedParentId,
                    element,
                );
                if (!isRemovalDeferred) {
                    removeNoteElement(element, animateNoteChanges);
                }
                ids.forEach((id) => {
                    elementCache.delete(id);
                    if (ModeContext.hasNoteHash(id)) {
                        ModeContext.removeNoteHash(id);
                    }
                });
                logVDOM('removed note', { noteId: op.id, parentId });
                vdomOperations += 1;
                if (parentId) {
                    touchedParentIds.add(parentId);
                }
                continue;
            }

            if (op.type === 'insert') {
                const node = op.node;
                if (!node) {
                    throw new Error(`Insert operation missing node for ${op.id}`);
                }
                const reference = findNoteChildAt(parentContainer, op.toIndex);
                let element = elementCache.get(op.id);
                if (!element) {
                    element = document.querySelector(`[data-note-id="${op.id}"]`);
                }
                if (element) {
                    parentContainer.insertBefore(element, reference);
                    elementCache.set(op.id, element);
                    logVDOM('moved note', { noteId: op.id, parentId, index: op.toIndex });
                    vdomOperations += 1;
                    if (parentId) {
                        touchedParentIds.add(parentId);
                    }
                    continue;
                }

                const newElement = createNoteSubtree(node, desired.nodeById, elementCache, insertedIds, affordanceDirtyElements);
                parentContainer.insertBefore(newElement, reference);
                logVDOM('inserted note', { noteId: op.id, parentId, index: op.toIndex });
                vdomOperations += 1;
                if (parentId) {
                    touchedParentIds.add(parentId);
                }
                continue;
            }

            if (op.type === 'move') {
                const element = elementCache.get(op.id);
                if (!element) {
                    throw new Error(`Move target ${op.id} missing from DOM`);
                }
                const reference = findNoteChildAt(parentContainer, op.toIndex);
                if (reference !== element) {
                    parentContainer.insertBefore(element, reference);
                    logVDOM('moved note', { noteId: op.id, parentId, from: op.fromIndex, to: op.toIndex });
                    vdomOperations += 1;
                }
            }
        }
    }

    for (const entry of payload.structure) {
        const noteId = entry.id;
        let parentId = entry.parentId;
        if (typeof parentId !== 'string') {
            parentId = '';
        }

        let noteElement = elementCache.get(noteId);
        if (!noteElement) {
            noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
        }
        if (!noteElement) {
            throw new Error(`Note ${noteId} missing from DOM after diff`);
        }

        elementCache.set(noteId, noteElement);

        const noteData = Object.prototype.hasOwnProperty.call(notePayload, noteId)
            ? notePayload[noteId]
            : null;
        const incomingHash = typeof entry.hash === 'string' ? entry.hash : null;
        const existingSnapshotHash = typeof noteElement.dataset.snapshotHash === 'string'
            ? noteElement.dataset.snapshotHash
            : null;

        const lockOwner = noteLocks[noteId];
        const previousLockOwner = typeof noteElement.dataset.lockOwner === 'string'
            ? noteElement.dataset.lockOwner
            : '';
        const nextLockOwner = typeof lockOwner === 'string' ? lockOwner : '';
        const lockChanged = previousLockOwner !== nextLockOwner;

        const lockedByOther = Boolean(nextLockOwner) && nextLockOwner !== payload.currentClientId;

        let hashChanged = false;
        if (insertedIds.has(noteId)) {
            hashChanged = true;
        } else if (incomingHash === null) {
            hashChanged = true;
        } else if (existingSnapshotHash === null) {
            hashChanged = true;
        } else if (existingSnapshotHash !== incomingHash) {
            hashChanged = true;
        }

        if (!hashChanged && !lockChanged) {
            continue;
        }

        // Lock state can change without hash changes (lock payload is out-of-band).
        if (!hashChanged) {
            if (
                noteData
                && noteData.flags
                && typeof noteData.flags === 'object'
                && Object.prototype.hasOwnProperty.call(noteData.flags, 'hasChildren')
            ) {
                noteElement.dataset.hasChildren = Boolean(noteData.flags.hasChildren).toString();
            }
            if (
                noteData
                && noteData.flags
                && typeof noteData.flags === 'object'
                && Object.prototype.hasOwnProperty.call(noteData.flags, 'isCollapsible')
            ) {
                noteElement.dataset.isCollapsible = Boolean(noteData.flags.isCollapsible).toString();
            }
            if (
                noteData
                && noteData.flags
                && typeof noteData.flags === 'object'
                && Object.prototype.hasOwnProperty.call(noteData.flags, 'searchRedacted')
            ) {
                setNoteSearchRedactionState(noteElement, Boolean(noteData.flags.searchRedacted));
            }
            noteElement.dataset.lockOwner = nextLockOwner;
            noteElement.classList.toggle('locked', lockedByOther);
            noteElement.classList.toggle('interactive', !lockedByOther);
            if (lockedByOther) {
                noteElement.classList.remove(CONFIG.CLASSES.EDITING);
                const contentElement = getContentElement(noteElement);
                contentElement.setAttribute('contenteditable', 'false');
                contentElement.contentEditable = 'false';
            }
            updateLockIcon(noteElement, lockedByOther);
            const proposalCount = Number.parseInt(noteElement.dataset.proposalCount, 10);
            if (!Number.isInteger(proposalCount) || proposalCount < 0) {
                throw new Error(`Note ${noteId} has invalid cached proposal count`);
            }
            syncTagProposalPresentation(noteElement, {
                proposedTags: noteElement.dataset.noteProposedTags,
                proposalCount,
                isEditing: noteElement.classList.contains(CONFIG.CLASSES.EDITING) && !lockedByOther,
            });
            continue;
        }

        const previousHash = Object.prototype.hasOwnProperty.call(previousHashes, noteId)
            ? previousHashes[noteId]
            : (noteElement.dataset.contentHash || null);

        if (insertedIds.has(noteId) && !noteData) {
            throw new Error(`New note ${noteId} missing payload data`);
        }
        const existingFlags = {
            isEditing: noteElement.classList.contains(CONFIG.CLASSES.EDITING),
            isCollapsed: noteElement.classList.contains('collapsed'),
            searchRedacted: noteElement.dataset.searchRedacted === 'true',
        };
        let flags = existingFlags;
        if (noteData && noteData.flags && typeof noteData.flags === 'object') {
            flags = noteData.flags;
        }
        const isEditing = Boolean(flags.isEditing);
        const editingByCurrentClient = isEditing && nextLockOwner === payload.currentClientId;

        if (noteData) {
            if (!Object.prototype.hasOwnProperty.call(noteData, 'tags')) {
                throw new Error(`Note ${noteId} payload missing tags`);
            }
            if (typeof noteData.tags !== 'string') {
                throw new Error(`Note ${noteId} payload tags must be a string`);
            }
            if (!Object.prototype.hasOwnProperty.call(noteData, 'proposedTags')) {
                throw new Error(`Note ${noteId} payload missing proposedTags`);
            }
            if (typeof noteData.proposedTags !== 'string') {
                throw new Error(`Note ${noteId} payload proposedTags must be a string`);
            }
            if (!noteData.flags || typeof noteData.flags !== 'object') {
                throw new Error(`Note ${noteId} payload missing flags`);
            }
            if (!Number.isInteger(noteData.flags.proposalCount) || noteData.flags.proposalCount < 0) {
                throw new Error(`Note ${noteId} payload proposalCount must be a non-negative integer`);
            }
            noteElement.dataset.noteTags = noteData.tags;
            if (noteData.metadata && typeof noteData.metadata === 'object') {
                noteElement.dataset.noteMetadata = JSON.stringify(noteData.metadata);
                syncNoteTimestampDataset(
                    noteElement,
                    noteData.metadata,
                    formatBrowserNoteTimestamp,
                );
            }
            syncTagsElement(noteElement);
            syncTagProposalPresentation(noteElement, {
                proposedTags: noteData.proposedTags,
                proposalCount: noteData.flags.proposalCount,
                isEditing: isEditing && !lockedByOther,
            });
        }

        if (!incomingHash) {
            throw new Error(`Structure entry missing hash for ${noteId}`);
        }

        noteElement.dataset.snapshotHash = incomingHash;
        noteElement.dataset.lockOwner = nextLockOwner;
        noteElement.dataset.parentId = parentId;
        noteElement.dataset.isCollapsed = Boolean(flags.isCollapsed).toString();
        if (Object.prototype.hasOwnProperty.call(flags, 'hasChildren')) {
            noteElement.dataset.hasChildren = Boolean(flags.hasChildren).toString();
        }
        if (Object.prototype.hasOwnProperty.call(flags, 'isCollapsible')) {
            noteElement.dataset.isCollapsible = Boolean(flags.isCollapsible).toString();
        }

        noteElement.classList.add(CONFIG.CLASSES.NOTE);
        noteElement.classList.toggle('locked', lockedByOther);
        noteElement.classList.toggle('interactive', !lockedByOther);
        noteElement.classList.toggle(CONFIG.CLASSES.EDITING, isEditing && !lockedByOther);
        noteElement.classList.toggle('collapsed', Boolean(flags.isCollapsed));
        noteElement.classList.toggle('list-bulleted', flags.listStyle === 'bulleted');
        noteElement.classList.toggle('list-numbered', flags.listStyle === 'numbered');
        setNoteSearchRedactionState(noteElement, Boolean(flags.searchRedacted));

        updateLockIcon(noteElement, lockedByOther);

        const contentElement = getContentElement(noteElement);

        const shouldBeEditable = isEditing && !lockedByOther;
        const contentEditable = shouldBeEditable ? 'true' : 'false';
        contentElement.setAttribute('contenteditable', contentEditable);
        contentElement.contentEditable = contentEditable;

        const canReplaceWhileEditing = editingByCurrentClient
            && ModeContext.currentNoteId === noteId
            && !ModeContext.isDirty
            && !ModeContext.editSessionHasEdits
            && (previousHash === null || previousHash !== incomingHash);

        const shouldRenderContent = Boolean(noteData)
            && (!editingByCurrentClient || canReplaceWhileEditing)
            && (
                insertedIds.has(noteId)
                || incomingHash === null
                || previousHash === null
                || previousHash !== incomingHash
            );

        if (shouldRenderContent) {
            contentElement.innerHTML = noteData.content;
            ensureAnchorsOpenInNewTabs(contentElement);
            logVDOM('replaced note content', { noteId });
            vdomOperations += 1;
            if (incomingHash) {
                noteElement.dataset.contentHash = incomingHash;
            }
        } else if (incomingHash && noteElement.dataset.contentHash !== incomingHash && !editingByCurrentClient) {
            noteElement.dataset.contentHash = incomingHash;
        }

        affordanceDirtyElements.add(noteElement);
    }

    for (const parentId of touchedParentIds) {
        let parentElement = elementCache.get(parentId);
        if (!parentElement) {
            parentElement = document.querySelector(`[data-note-id="${parentId}"]`);
        }
        if (parentElement) {
            affordanceDirtyElements.add(parentElement);
        }
    }

    if (payload.treeHash && ModeContext.rootHash !== payload.treeHash) {
        ModeContext.setRootHash(payload.treeHash);
    }

    hydrateImageFilePreviews(notesContainer);
    hydrateRemoteImagesForCurrentMode(notesContainer);
    ensureAnchorsOpenInNewTabs(notesContainer);
    void queueMermaidDiagramRendering(notesContainer);
    updateCollapseAffordancesForNotes(affordanceDirtyElements);
    animateNoteCollapseChanges(collapseAnimationCaptures);

    return {
        notesContainer,
        editingNoteElement: payload.editingNoteId ? document.querySelector(`[data-note-id="${payload.editingNoteId}"]`) : null,
        vdomOperations,
    };
}

function buildDomForest(container, elementCache) {
    const result = [];
    const children = Array.from(container.children);
    for (const child of children) {
        if (!child.dataset || !child.dataset.noteId) {
            continue;
        }
        const noteId = child.dataset.noteId;
        elementCache.set(noteId, child);
        const childContainer = getChildContainer(child);
        const descendants = childContainer ? buildDomForest(childContainer, elementCache) : [];
        result.push({ id: noteId, element: child, children: descendants });
    }
    return result;
}

function buildDesiredForest(structure, notes) {
    const nodeById = new Map();
    const roots = [];
    const rootIds = new Set();

    const getOrCreate = (id) => {
        if (!nodeById.has(id)) {
            nodeById.set(id, { id, entry: null, data: null, children: [] });
        }
        return nodeById.get(id);
    };

    for (const entry of structure) {
        if (!entry || typeof entry !== 'object') {
            throw new Error('Malformed structure entry');
        }
        const id = entry.id;
        const parentId = Object.prototype.hasOwnProperty.call(entry, 'parentId') ? entry.parentId : null;
        if (typeof id !== 'string') {
            throw new Error('Structure entry missing id');
        }
        const node = getOrCreate(id);
        node.entry = entry;
        node.data = Object.prototype.hasOwnProperty.call(notes, id) ? notes[id] : null;

        if (parentId) {
            const parentNode = getOrCreate(parentId);
            if (!parentNode.children.some((child) => child.id === id)) {
                parentNode.children.push(node);
            }
        } else if (!rootIds.has(id)) {
            roots.push(node);
            rootIds.add(id);
        }
    }

    return { roots, nodeById };
}

function findNoteChildAt(parentContainer, index) {
    if (index === parentContainer.children.length) {
        return null;
    }
    let seen = 0;
    for (const child of Array.from(parentContainer.children)) {
        if (child.dataset && child.dataset.noteId) {
            if (seen === index) {
                return child;
            }
            seen += 1;
        }
    }
    return null;
}

function createNoteSubtree(node, nodeById, elementCache, insertedIds, affordanceDirtyElements) {
    const { id } = node;
    const noteElement = createNoteElement(id);
    elementCache.set(id, noteElement);
    if (insertedIds) {
        insertedIds.add(id);
    }
    if (affordanceDirtyElements) {
        affordanceDirtyElements.add(noteElement);
    }

    if (node.children.length > 0) {
        const container = ensureChildContainer(noteElement);
        for (const child of node.children) {
            let resolvedChild = nodeById.get(child.id);
            if (!resolvedChild) {
                resolvedChild = child;
            }
            const childElement = createNoteSubtree(resolvedChild, nodeById, elementCache, insertedIds, affordanceDirtyElements);
            container.appendChild(childElement);
        }
    }

    return noteElement;
}

function collectSubtreeIds(node) {
    const ids = [node.id];
    for (const child of node.children) {
        ids.push(...collectSubtreeIds(child));
    }
    return ids;
}

function applyNoteDataFromPayload(noteElement, noteId, noteData, noteLocks, currentClientId,
    affordanceSet, forceContentUpdate) {
    if (!noteElement || !noteData) {
        return false;
    }

    if (!Object.prototype.hasOwnProperty.call(noteData, 'tags')) {
        throw new Error(`Note ${noteId} payload missing tags`);
    }
    if (typeof noteData.tags !== 'string') {
        throw new Error(`Note ${noteId} payload tags must be a string`);
    }
    if (!Object.prototype.hasOwnProperty.call(noteData, 'proposedTags')) {
        throw new Error(`Note ${noteId} payload missing proposedTags`);
    }
    if (typeof noteData.proposedTags !== 'string') {
        throw new Error(`Note ${noteId} payload proposedTags must be a string`);
    }
    noteElement.dataset.noteTags = noteData.tags;
    if (noteData.metadata && typeof noteData.metadata === 'object') {
        noteElement.dataset.noteMetadata = JSON.stringify(noteData.metadata);
        syncNoteTimestampDataset(
            noteElement,
            noteData.metadata,
            formatBrowserNoteTimestamp,
        );
    }
    syncTagsElement(noteElement);
    let flags = noteData.flags;
    if (!flags || typeof flags !== 'object') {
        flags = {};
    }
    if (!Number.isInteger(flags.proposalCount) || flags.proposalCount < 0) {
        throw new Error(`Note ${noteId} payload proposalCount must be a non-negative integer`);
    }
    const lockOwner = typeof noteLocks[noteId] === 'string' ? noteLocks[noteId] : '';
    const lockedByOther = Boolean(lockOwner) && lockOwner !== currentClientId;
    const isEditing = Boolean(flags.isEditing);
    const editingByCurrentClient = isEditing && lockOwner === currentClientId;

    const snapshotHash = typeof noteData.hash === 'string' ? noteData.hash : '';
    const hasPreviousContentHash = Object.prototype.hasOwnProperty.call(noteElement.dataset, 'contentHash');
    const previousContentHash = hasPreviousContentHash ? noteElement.dataset.contentHash : null;
    noteElement.dataset.snapshotHash = snapshotHash;
    noteElement.dataset.lockOwner = lockOwner;
    noteElement.dataset.isCollapsed = Boolean(flags.isCollapsed).toString();
    if (Object.prototype.hasOwnProperty.call(flags, 'hasChildren')) {
        noteElement.dataset.hasChildren = Boolean(flags.hasChildren).toString();
    }
    if (Object.prototype.hasOwnProperty.call(flags, 'isCollapsible')) {
        noteElement.dataset.isCollapsible = Boolean(flags.isCollapsible).toString();
    }

    noteElement.classList.add(CONFIG.CLASSES.NOTE);
    noteElement.classList.toggle('locked', lockedByOther);
    noteElement.classList.toggle('interactive', !lockedByOther);
    noteElement.classList.toggle(CONFIG.CLASSES.EDITING, isEditing && !lockedByOther);
    noteElement.classList.toggle('collapsed', Boolean(flags.isCollapsed));
    noteElement.classList.toggle('list-bulleted', flags.listStyle === 'bulleted');
    noteElement.classList.toggle('list-numbered', flags.listStyle === 'numbered');
    setNoteSearchRedactionState(noteElement, Boolean(flags.searchRedacted));
    syncTagProposalPresentation(noteElement, {
        proposedTags: noteData.proposedTags,
        proposalCount: flags.proposalCount,
        isEditing: isEditing && !lockedByOther,
    });

    updateLockIcon(noteElement, lockedByOther);

    const contentElement = getContentElement(noteElement);
    const shouldBeEditable = isEditing && !lockedByOther;
    const contentEditable = shouldBeEditable ? 'true' : 'false';
    contentElement.setAttribute('contenteditable', contentEditable);
    contentElement.contentEditable = contentEditable;

    const canReplaceWhileEditing = editingByCurrentClient
        && ModeContext.currentNoteId === noteId
        && !ModeContext.isDirty
        && !ModeContext.editSessionHasEdits
        && previousContentHash !== snapshotHash;

    let contentChanged = false;
    if ((forceContentUpdate || !editingByCurrentClient || canReplaceWhileEditing) && typeof noteData.content === 'string') {
        contentElement.innerHTML = noteData.content;
        ensureAnchorsOpenInNewTabs(contentElement);
        noteElement.dataset.contentHash = snapshotHash;
        contentChanged = true;
    } else if (snapshotHash && !editingByCurrentClient) {
        noteElement.dataset.contentHash = snapshotHash;
    }

    if (snapshotHash) {
        // A server snapshot can change descendants while echoing the parent's
        // unchanged hash. Publish only the actual hash delta from that snapshot.
        if (!ModeContext.hasNoteHash(noteId) || ModeContext.getNoteHash(noteId) !== snapshotHash) {
            ModeContext.setNoteHash(noteId, snapshotHash);
        }
    }

    if (affordanceSet) {
        affordanceSet.add(noteElement);
    }

    return contentChanged;
}

function applyLockDiffs(lockDiffs, currentClientId, affordanceSet) {
    if (!lockDiffs || typeof lockDiffs !== 'object') {
        return;
    }
    for (const [noteId, owner] of Object.entries(lockDiffs)) {
        const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
        if (!noteElement) {
            continue;
        }
        const lockOwner = typeof owner === 'string' ? owner : '';
        const lockedByOther = Boolean(lockOwner) && lockOwner !== currentClientId;
        noteElement.dataset.lockOwner = lockOwner;
        noteElement.classList.toggle('locked', lockedByOther);
        noteElement.classList.toggle('interactive', !lockedByOther);
        if (lockedByOther) {
            noteElement.classList.remove(CONFIG.CLASSES.EDITING);
            const contentElement = getContentElement(noteElement);
            contentElement.setAttribute('contenteditable', 'false');
            contentElement.contentEditable = 'false';
        }
        updateLockIcon(noteElement, lockedByOther);
        if (affordanceSet) {
            affordanceSet.add(noteElement);
        }
    }
}

function collectDomSubtreeIds(rootElement) {
    const ids = [];
    if (rootElement?.dataset?.noteId) {
        ids.push(rootElement.dataset.noteId);
    }
    const descendants = rootElement ? rootElement.querySelectorAll('[data-note-id]') : [];
    for (const element of descendants) {
        if (element.dataset && element.dataset.noteId) {
            ids.push(element.dataset.noteId);
        }
    }
    return ids;
}
