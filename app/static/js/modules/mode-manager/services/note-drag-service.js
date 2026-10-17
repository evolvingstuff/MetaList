function normalizeNullableNoteId(noteId, fieldName) {
    if (noteId === null) {
        return null;
    }
    if (typeof noteId !== 'string') {
        throw new Error(`${fieldName} must be a string or null`);
    }
    if (noteId.length === 0) {
        return null;
    }
    return noteId;
}

const MOVE_DRAG_VERTICAL_ACTIVATION_PX = 8;
const MOVE_DRAG_DISTANCE_ACTIVATION_PX = 20;
const MOVE_DRAG_DISTANCE_ACTIVATION_SQ = MOVE_DRAG_DISTANCE_ACTIVATION_PX * MOVE_DRAG_DISTANCE_ACTIVATION_PX;

export function shouldActivateMoveDrag({ dx, dy }) {
    if (typeof dx !== 'number' || Number.isNaN(dx)) {
        throw new Error('shouldActivateMoveDrag requires numeric dx');
    }
    if (typeof dy !== 'number' || Number.isNaN(dy)) {
        throw new Error('shouldActivateMoveDrag requires numeric dy');
    }

    const absY = Math.abs(dy);
    if (absY >= MOVE_DRAG_VERTICAL_ACTIVATION_PX) {
        return true;
    }

    const distanceSq = dx * dx + dy * dy;
    return distanceSq >= MOVE_DRAG_DISTANCE_ACTIVATION_SQ;
}

export function updateMoveDragGestureState(previousState, movement) {
    if (previousState === null || typeof previousState !== 'object') {
        throw new Error('updateMoveDragGestureState requires previousState object');
    }
    if (typeof previousState.dragActive !== 'boolean') {
        throw new Error('updateMoveDragGestureState requires previousState.dragActive boolean');
    }
    if (typeof previousState.hasCrossedActivationThreshold !== 'boolean') {
        throw new Error('updateMoveDragGestureState requires previousState.hasCrossedActivationThreshold boolean');
    }

    const dragActive = shouldActivateMoveDrag(movement);
    return {
        dragActive,
        hasCrossedActivationThreshold: previousState.hasCrossedActivationThreshold || dragActive,  // shockharness: ignore[DEF003] reason="a boolean OR of two conditions, not a fallback"
    };
}

export function resolveVerticalSiblingDropDestination(args) {
    if (args === null || typeof args !== 'object') {
        throw new Error('resolveVerticalSiblingDropDestination requires args object');
    }

    const siblingPlacements = args.siblingPlacements;
    const dropY = args.dropY;
    let currentPrevId = null;
    if (Object.prototype.hasOwnProperty.call(args, 'currentPrevId')) {
        currentPrevId = args.currentPrevId;
    }
    let currentNextId = null;
    if (Object.prototype.hasOwnProperty.call(args, 'currentNextId')) {
        currentNextId = args.currentNextId;
    }
    let parentId = null;
    if (Object.prototype.hasOwnProperty.call(args, 'parentId')) {
        parentId = args.parentId;
    }
    let hoveredSiblingId = null;
    if (Object.prototype.hasOwnProperty.call(args, 'hoveredSiblingId')) {
        hoveredSiblingId = args.hoveredSiblingId;
    }
    let dragDirection = null;
    if (Object.prototype.hasOwnProperty.call(args, 'dragDirection')) {
        dragDirection = args.dragDirection;
    }

    if (!Array.isArray(siblingPlacements)) {
        throw new Error('resolveVerticalSiblingDropDestination requires siblingPlacements array');
    }
    if (typeof dropY !== 'number' || Number.isNaN(dropY)) {
        throw new Error('resolveVerticalSiblingDropDestination requires numeric dropY');
    }

    const normalizedCurrentPrevId = normalizeNullableNoteId(currentPrevId, 'currentPrevId');
    const normalizedCurrentNextId = normalizeNullableNoteId(currentNextId, 'currentNextId');
    const normalizedParentId = normalizeNullableNoteId(parentId, 'parentId');
    const normalizedHoveredSiblingId = normalizeNullableNoteId(hoveredSiblingId, 'hoveredSiblingId');

    if (siblingPlacements.length === 0) {
        return null;
    }

    const normalizedPlacements = siblingPlacements.map((placement, index) => {
        if (!placement || typeof placement !== 'object') {
            throw new Error(`siblingPlacements[${index}] must be an object`);
        }
        if (typeof placement.id !== 'string' || placement.id.length === 0) {
            throw new Error(`siblingPlacements[${index}].id must be a non-empty string`);
        }
        if (typeof placement.midY !== 'number' || Number.isNaN(placement.midY)) {
            throw new Error(`siblingPlacements[${index}].midY must be numeric`);
        }
        return placement;
    });

    let destinationPrevId = null;
    let destinationNextId = null;

    if (normalizedHoveredSiblingId !== null) {
        if (dragDirection !== 'up' && dragDirection !== 'down') {
            throw new Error('dragDirection must be up or down when hoveredSiblingId is set');
        }
        const hoveredIndex = normalizedPlacements.findIndex((placement) => placement.id === normalizedHoveredSiblingId);
        if (hoveredIndex === -1) {
            throw new Error(`hoveredSiblingId not found in siblingPlacements: ${normalizedHoveredSiblingId}`);
        }

        if (dragDirection === 'up') {
            destinationPrevId = hoveredIndex === 0 ? null : normalizedPlacements[hoveredIndex - 1].id;
            destinationNextId = normalizedPlacements[hoveredIndex].id;
        } else {
            destinationPrevId = normalizedPlacements[hoveredIndex].id;
            destinationNextId = hoveredIndex === normalizedPlacements.length - 1
                ? null
                : normalizedPlacements[hoveredIndex + 1].id;
        }
    } else {
        let insertionIndex = 0;
        while (
            insertionIndex < normalizedPlacements.length
            && dropY >= normalizedPlacements[insertionIndex].midY
        ) {
            insertionIndex += 1;
        }

        destinationPrevId = insertionIndex === 0 ? null : normalizedPlacements[insertionIndex - 1].id;
        destinationNextId = insertionIndex === normalizedPlacements.length
            ? null
            : normalizedPlacements[insertionIndex].id;
    }

    if (
        destinationPrevId === normalizedCurrentPrevId
        && destinationNextId === normalizedCurrentNextId
    ) {
        return null;
    }

    if (destinationNextId !== null) {
        return {
            siblingId: destinationNextId,
            position: 'BEFORE',
            newParentId: normalizedParentId,
        };
    }

    if (destinationPrevId !== null) {
        return {
            siblingId: destinationPrevId,
            position: 'AFTER',
            newParentId: normalizedParentId,
        };
    }

    return null;
}
