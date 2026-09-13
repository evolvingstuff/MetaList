import { ApplicationState } from '../../application-state.js';
const NOTE_REPOSITION_GHOST_CLASS = 'note-reposition-ghost';
const NOTE_REPOSITION_TARGET_CLASS = 'is-reposition-expanding';
const NOTE_REPOSITION_ANIMATION_FALLBACK_MS = 320;
const NOTE_REPOSITION_ANIMATION_DURATION_MS = 260;
const NOTE_REPOSITION_RECT_TOLERANCE_PX = 0.5;
const NOTE_REPOSITION_GHOST_Z_INDEX = '15';
const NOTE_REPOSITION_COLLAPSED_SCALE_Y = '0.08';
const NOTE_REPOSITION_ANIMATION_EASING = 'cubic-bezier(0.2, 0, 0.2, 1)';
const NOTE_REMOVAL_ANIMATION_CLASS = 'is-removal-collapsing';
const NOTE_REMOVAL_ANIMATION_FALLBACK_MS = 240;
const NOTE_REMOVAL_ANIMATION_DURATION_MS = 180;
const NOTE_REMOVAL_HEIGHT_TOLERANCE_PX = 0.5;
const NOTE_REMOVAL_COLLAPSED_SCALE_Y = '0.04';
const NOTE_REMOVAL_WRAPPER_MARGIN = '2px 0';

const noteRepositionAnimationVersions = ApplicationState.createWeakCollection('noteRepositionAnimationVersions', 'map');

function requireNoteElement(noteElement, functionName) {
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error(`${functionName} requires HTMLElement`);
    }
    if (!noteElement.classList.contains('note')) {
        throw new Error(`${functionName} requires note element`);
    }
}

function nextNoteRepositionAnimationVersion(noteElement) {
    const currentVersion = noteRepositionAnimationVersions.has(noteElement)
        ? noteRepositionAnimationVersions.get(noteElement)
        : 0;
    if (!Number.isInteger(currentVersion)) {
        throw new Error('Note reposition animation version must be an integer');
    }
    const nextVersion = currentVersion + 1;
    noteRepositionAnimationVersions.set(noteElement, nextVersion);
    return nextVersion;
}

function stripNoteIdentityAttributes(element) {
    if (!(element instanceof HTMLElement)) {
        return;
    }
    delete element.dataset.noteId;
    delete element.dataset.parentId;
    const identifiedDescendants = element.querySelectorAll('[data-note-id], [data-parent-id]');
    identifiedDescendants.forEach((descendant) => {
        if (!(descendant instanceof HTMLElement)) {
            return;
        }
        delete descendant.dataset.noteId;
        delete descendant.dataset.parentId;
    });
}

function requireFiniteRectDimension(value, fieldName) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Note reposition animation requires finite ${fieldName}`);
    }
}

function resolveMotionDurationMs(defaultDurationMs) {
    if (typeof defaultDurationMs !== 'number' || !Number.isFinite(defaultDurationMs) || defaultDurationMs <= 0) {
        throw new Error('resolveMotionDurationMs requires positive duration');
    }
    if (
        typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
        return 1;
    }
    return defaultDurationMs;
}

function rectsMatchWithinTolerance(startRect, targetRect) {
    return (
        Math.abs(startRect.top - targetRect.top) <= NOTE_REPOSITION_RECT_TOLERANCE_PX
        && Math.abs(startRect.left - targetRect.left) <= NOTE_REPOSITION_RECT_TOLERANCE_PX
        && Math.abs(startRect.width - targetRect.width) <= NOTE_REPOSITION_RECT_TOLERANCE_PX
        && Math.abs(startRect.height - targetRect.height) <= NOTE_REPOSITION_RECT_TOLERANCE_PX
    );
}

export function shouldAnimateNoteReposition(noteId, animationNoteIds) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('shouldAnimateNoteReposition requires noteId string');
    }
    if (animationNoteIds === null || typeof animationNoteIds === 'undefined') {
        return false;
    }
    if (animationNoteIds instanceof Set) {
        return animationNoteIds.has(noteId);
    }
    if (Array.isArray(animationNoteIds)) {
        return animationNoteIds.includes(noteId);
    }
    throw new Error('animationNoteIds must be a Set, array, null, or undefined');
}

export function captureNoteRepositionAnimation(noteElement) {
    requireNoteElement(noteElement, 'captureNoteRepositionAnimation');
    if (!noteElement.isConnected) {
        return null;
    }

    const rect = noteElement.getBoundingClientRect();
    if (!rect) {
        throw new Error('Note reposition animation requires bounding rect');
    }
    requireFiniteRectDimension(rect.top, 'top');
    requireFiniteRectDimension(rect.left, 'left');
    requireFiniteRectDimension(rect.width, 'width');
    requireFiniteRectDimension(rect.height, 'height');
    if (
        rect.width <= NOTE_REPOSITION_RECT_TOLERANCE_PX
        || rect.height <= NOTE_REPOSITION_RECT_TOLERANCE_PX
    ) {
        return null;
    }

    const ghostElement = noteElement.cloneNode(true);
    if (!(ghostElement instanceof HTMLElement)) {
        throw new Error('Note reposition animation ghost must be HTMLElement');
    }
    stripNoteIdentityAttributes(ghostElement);
    ghostElement.classList.remove(NOTE_REPOSITION_TARGET_CLASS);
    ghostElement.classList.add(NOTE_REPOSITION_GHOST_CLASS);
    ghostElement.setAttribute('aria-hidden', 'true');
    ghostElement.style.position = 'fixed';
    ghostElement.style.top = `${rect.top}px`;
    ghostElement.style.left = `${rect.left}px`;
    ghostElement.style.width = `${rect.width}px`;
    ghostElement.style.height = `${rect.height}px`;
    ghostElement.style.margin = '0';
    ghostElement.style.zIndex = NOTE_REPOSITION_GHOST_Z_INDEX;
    document.body.appendChild(ghostElement);

    return {
        noteElement,
        ghostElement,
        startRect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
        },
    };
}

export function animateNoteRepositionChanges(captures) {
    if (!Array.isArray(captures)) {
        throw new Error('animateNoteRepositionChanges requires captures array');
    }
    if (captures.length === 0) {
        return;
    }

    for (const capture of captures) {
        animateNoteRepositionChange(capture);
    }
}

function animateNoteRepositionChange(capture) {
    if (!capture || typeof capture !== 'object') {
        throw new Error('animateNoteRepositionChange requires capture object');
    }
    const noteElement = capture.noteElement;
    const ghostElement = capture.ghostElement;
    requireNoteElement(noteElement, 'animateNoteRepositionChange');
    if (!(ghostElement instanceof HTMLElement)) {
        throw new Error('animateNoteRepositionChange requires ghost HTMLElement');
    }
    if (!capture.startRect || typeof capture.startRect !== 'object') {
        throw new Error('animateNoteRepositionChange requires startRect object');
    }
    requireFiniteRectDimension(capture.startRect.width, 'startRect.width');
    requireFiniteRectDimension(capture.startRect.height, 'startRect.height');
    if (!noteElement.isConnected) {
        ghostElement.remove();
        return;
    }
    if (!ghostElement.isConnected) {
        throw new Error('Reposition animation ghost must still be connected');
    }

    const targetRect = noteElement.getBoundingClientRect();
    if (!targetRect) {
        throw new Error('Note reposition animation requires target bounding rect');
    }
    requireFiniteRectDimension(targetRect.width, 'target width');
    requireFiniteRectDimension(targetRect.height, 'target height');
    if (
        targetRect.width <= NOTE_REPOSITION_RECT_TOLERANCE_PX
        || targetRect.height <= NOTE_REPOSITION_RECT_TOLERANCE_PX
    ) {
        ghostElement.remove();
        return;
    }
    if (rectsMatchWithinTolerance(capture.startRect, targetRect)) {
        ghostElement.remove();
        return;
    }

    const animationVersion = nextNoteRepositionAnimationVersion(noteElement);
    const previousTransformOrigin = typeof noteElement.style.transformOrigin === 'string' ? noteElement.style.transformOrigin : '';
    const previousTransform = typeof noteElement.style.transform === 'string' ? noteElement.style.transform : '';
    const previousOpacity = typeof noteElement.style.opacity === 'string' ? noteElement.style.opacity : '';
    const previousTransition = typeof noteElement.style.transition === 'string' ? noteElement.style.transition : '';

    noteElement.style.transformOrigin = 'top left';
    noteElement.classList.add(NOTE_REPOSITION_TARGET_CLASS);

    ghostElement.style.transformOrigin = 'top left';
    ghostElement.style.transform = 'scaleY(1)';
    ghostElement.style.opacity = '0.72';

    let didFinish = false;
    const finishAnimation = () => {
        if (didFinish) {
            return;
        }
        if (noteRepositionAnimationVersions.get(noteElement) !== animationVersion) {
            didFinish = true;
            ghostElement.remove();
            return;
        }
        didFinish = true;
        noteElement.classList.remove(NOTE_REPOSITION_TARGET_CLASS);
        noteElement.style.transformOrigin = previousTransformOrigin;
        noteElement.style.transform = previousTransform;
        noteElement.style.opacity = previousOpacity;
        noteElement.style.transition = previousTransition;
        ghostElement.remove();
    };

    if (typeof noteElement.animate !== 'function' || typeof ghostElement.animate !== 'function') {
        noteElement.style.transform = `scaleY(${NOTE_REPOSITION_COLLAPSED_SCALE_Y})`;
        noteElement.style.opacity = '0.18';
        noteElement.getBoundingClientRect();
        ghostElement.getBoundingClientRect();
        window.requestAnimationFrame(() => {
            if (noteRepositionAnimationVersions.get(noteElement) !== animationVersion) {
                return;
            }
            noteElement.style.transition = `opacity ${NOTE_REPOSITION_ANIMATION_DURATION_MS}ms ${NOTE_REPOSITION_ANIMATION_EASING}, transform ${NOTE_REPOSITION_ANIMATION_DURATION_MS}ms ${NOTE_REPOSITION_ANIMATION_EASING}`;
            ghostElement.style.transition = `opacity ${NOTE_REPOSITION_ANIMATION_DURATION_MS}ms ${NOTE_REPOSITION_ANIMATION_EASING}, transform ${NOTE_REPOSITION_ANIMATION_DURATION_MS}ms ${NOTE_REPOSITION_ANIMATION_EASING}`;
            noteElement.style.transform = 'scaleY(1)';
            noteElement.style.opacity = '1';
            ghostElement.style.transform = `scaleY(${NOTE_REPOSITION_COLLAPSED_SCALE_Y})`;
            ghostElement.style.opacity = '0';
        });
        window.setTimeout(finishAnimation, NOTE_REPOSITION_ANIMATION_FALLBACK_MS);
        return;
    }

    let remainingAnimations = 2;
    const markAnimationFinished = () => {
        remainingAnimations -= 1;
        if (remainingAnimations === 0) {
            finishAnimation();
        }
    };

    const animationOptions = {
        duration: NOTE_REPOSITION_ANIMATION_DURATION_MS,
        easing: NOTE_REPOSITION_ANIMATION_EASING,
        fill: 'none',
    };
    const noteAnimation = noteElement.animate([
        { transform: `scaleY(${NOTE_REPOSITION_COLLAPSED_SCALE_Y})`, opacity: 0.18 },
        { transform: 'scaleY(1)', opacity: 1 },
    ], animationOptions);
    const ghostAnimation = ghostElement.animate([
        { transform: 'scaleY(1)', opacity: 0.72 },
        { transform: `scaleY(${NOTE_REPOSITION_COLLAPSED_SCALE_Y})`, opacity: 0 },
    ], animationOptions);
    noteAnimation.onfinish = markAnimationFinished;
    ghostAnimation.onfinish = markAnimationFinished;
    window.setTimeout(finishAnimation, NOTE_REPOSITION_ANIMATION_FALLBACK_MS);
}

export function captureNoteRemovalAnimation(noteElement) {
    requireNoteElement(noteElement, 'captureNoteRemovalAnimation');
    if (!noteElement.isConnected) {
        return null;
    }

    const rect = noteElement.getBoundingClientRect();
    if (!rect) {
        throw new Error('Note removal animation requires bounding rect');
    }
    requireFiniteRectDimension(rect.height, 'height');
    if (rect.height <= NOTE_REMOVAL_HEIGHT_TOLERANCE_PX) {
        return null;
    }

    return {
        noteElement,
        startHeight: rect.height,
    };
}

export function animateNoteRemovalAndRemove(capture) {
    if (!capture || typeof capture !== 'object') {
        throw new Error('animateNoteRemovalAndRemove requires capture object');
    }
    const noteElement = capture.noteElement;
    requireNoteElement(noteElement, 'animateNoteRemovalAndRemove');
    requireFiniteRectDimension(capture.startHeight, 'startHeight');
    if (!noteElement.isConnected) {
        return;
    }

    const parentElement = noteElement.parentElement;
    if (!(parentElement instanceof HTMLElement)) {
        throw new Error('animateNoteRemovalAndRemove requires connected note parent');
    }

    const removalWrapper = document.createElement('div');
    if (!(removalWrapper instanceof HTMLElement)) {
        throw new Error('Removal animation wrapper must be HTMLElement');
    }
    removalWrapper.classList.add(NOTE_REMOVAL_ANIMATION_CLASS);
    removalWrapper.style.height = `${capture.startHeight}px`;
    removalWrapper.style.boxSizing = 'border-box';
    removalWrapper.style.overflow = 'hidden';
    noteElement.style.pointerEvents = 'none';
    noteElement.style.margin = '0';
    noteElement.style.transformOrigin = 'top left';
    removalWrapper.style.margin = NOTE_REMOVAL_WRAPPER_MARGIN;
    parentElement.insertBefore(removalWrapper, noteElement);
    removalWrapper.appendChild(noteElement);
    removalWrapper.getBoundingClientRect();

    let didFinish = false;
    const finishAnimation = () => {
        if (didFinish) {
            return;
        }
        didFinish = true;
        removalWrapper.remove();
    };

    removalWrapper.addEventListener('transitionend', (event) => {
        if (event.propertyName !== 'height') {
            return;
        }
        finishAnimation();
    }, { once: true });

    window.requestAnimationFrame(() => {
        if (!removalWrapper.isConnected) {
            return;
        }
        const durationMs = resolveMotionDurationMs(NOTE_REMOVAL_ANIMATION_DURATION_MS);
        removalWrapper.style.transition = `height ${durationMs}ms ${NOTE_REPOSITION_ANIMATION_EASING}`;
        noteElement.style.transition = `transform ${durationMs}ms ${NOTE_REPOSITION_ANIMATION_EASING}`;
        removalWrapper.style.height = '0px';
        noteElement.style.transform = `scaleY(${NOTE_REMOVAL_COLLAPSED_SCALE_Y})`;
    });
    window.setTimeout(finishAnimation, NOTE_REMOVAL_ANIMATION_FALLBACK_MS);
    return removalWrapper;
}
