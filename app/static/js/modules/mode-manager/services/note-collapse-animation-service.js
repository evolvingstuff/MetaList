import { ApplicationState } from '../../application-state.js';
const NOTE_COLLAPSE_ANIMATION_CLASS = 'is-collapse-transitioning';
const NOTE_COLLAPSE_ANIMATION_FALLBACK_MS = 200;
const NOTE_COLLAPSE_HEIGHT_DELTA_TOLERANCE_PX = 0.5;

const noteCollapseAnimationVersions = ApplicationState.createWeakCollection('noteCollapseAnimationVersions', 'map');

function requireNoteElement(noteElement, functionName) {
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error(`${functionName} requires HTMLElement`);
    }
    if (!noteElement.classList.contains('note')) {
        throw new Error(`${functionName} requires note element`);
    }
}

function areAnimatedTransitionsEnabled() {
    if (!(document.body instanceof HTMLElement)) {
        throw new Error('document.body is required for animated transition preference');
    }
    return document.body.classList.contains('pref-animated-transitions');
}

function nextNoteCollapseAnimationVersion(noteElement) {
    const currentVersion = noteCollapseAnimationVersions.has(noteElement)
        ? noteCollapseAnimationVersions.get(noteElement)
        : 0;
    if (!Number.isInteger(currentVersion)) {
        throw new Error('Note collapse animation version must be an integer');
    }
    const nextVersion = currentVersion + 1;
    noteCollapseAnimationVersions.set(noteElement, nextVersion);
    return nextVersion;
}

export function captureNoteCollapseAnimation(noteElement, nextCollapsed) {
    requireNoteElement(noteElement, 'captureNoteCollapseAnimation');
    if (typeof nextCollapsed !== 'boolean') {
        throw new Error('captureNoteCollapseAnimation requires nextCollapsed boolean');
    }
    if (!areAnimatedTransitionsEnabled()) {
        return null;
    }
    if (!noteElement.isConnected) {
        return null;
    }

    const currentCollapsed = noteElement.dataset.isCollapsed === 'true';
    if (currentCollapsed === nextCollapsed) {
        return null;
    }

    const rect = noteElement.getBoundingClientRect();
    if (!rect || typeof rect.height !== 'number') {
        throw new Error('Note collapse animation requires bounding rect height');
    }
    if (rect.height <= 0) {
        return null;
    }

    return {
        noteElement,
        nextCollapsed,
        startHeight: rect.height,
        deferredRemovalElements: [],
    };
}

export function animateNoteCollapseChanges(captures) {
    if (!Array.isArray(captures)) {
        throw new Error('animateNoteCollapseChanges requires captures array');
    }
    if (captures.length === 0) {
        return;
    }
    if (!areAnimatedTransitionsEnabled()) {
        return;
    }

    for (const capture of captures) {
        animateNoteCollapseChange(capture);
    }
}

function animateNoteCollapseChange(capture) {
    if (!capture || typeof capture !== 'object') {
        throw new Error('animateNoteCollapseChange requires capture object');
    }
    const noteElement = capture.noteElement;
    requireNoteElement(noteElement, 'animateNoteCollapseChange');
    if (typeof capture.nextCollapsed !== 'boolean') {
        throw new Error('animateNoteCollapseChange requires nextCollapsed boolean');
    }
    if (typeof capture.startHeight !== 'number' || !Number.isFinite(capture.startHeight)) {
        throw new Error('animateNoteCollapseChange requires finite startHeight');
    }
    if (!noteElement.isConnected) {
        return;
    }

    const deferredRemovalElements = validateDeferredRemovalElements(capture);
    const targetRect = measureTargetRectWithoutDeferredRemovals(noteElement, deferredRemovalElements);
    if (!targetRect || typeof targetRect.height !== 'number') {
        throw new Error('Note collapse animation requires target bounding rect height');
    }
    const targetHeight = targetRect.height;
    if (Math.abs(capture.startHeight - targetHeight) <= NOTE_COLLAPSE_HEIGHT_DELTA_TOLERANCE_PX) {
        removeDeferredRemovalElements(deferredRemovalElements);
        return;
    }

    animateNoteHeightChange(capture, targetHeight, deferredRemovalElements);
}

function validateDeferredRemovalElements(capture) {
    if (!Object.prototype.hasOwnProperty.call(capture, 'deferredRemovalElements')) {
        return [];
    }
    if (!Array.isArray(capture.deferredRemovalElements)) {
        throw new Error('animateNoteCollapseChange requires deferredRemovalElements array');
    }
    for (const deferredRemovalElement of capture.deferredRemovalElements) {
        if (!(deferredRemovalElement instanceof HTMLElement)) {
            throw new Error('deferred removal element must be HTMLElement');
        }
    }
    return capture.deferredRemovalElements;
}

function measureTargetRectWithoutDeferredRemovals(noteElement, deferredRemovalElements) {
    if (deferredRemovalElements.length === 0) {
        return noteElement.getBoundingClientRect();
    }

    const previousDisplays = [];
    for (const deferredRemovalElement of deferredRemovalElements) {
        previousDisplays.push([
            deferredRemovalElement,
            typeof deferredRemovalElement.style.display === 'string' ? deferredRemovalElement.style.display : '',
        ]);
        deferredRemovalElement.style.display = 'none';
    }

    const targetRect = noteElement.getBoundingClientRect();

    for (const [deferredRemovalElement, previousDisplay] of previousDisplays) {
        deferredRemovalElement.style.display = previousDisplay;
    }

    return targetRect;
}

function removeDeferredRemovalElements(deferredRemovalElements) {
    for (const deferredRemovalElement of deferredRemovalElements) {
        if (deferredRemovalElement.isConnected) {
            deferredRemovalElement.remove();
        }
    }
}

function animateNoteHeightChange(capture, targetHeight, deferredRemovalElements) {
    const noteElement = capture.noteElement;
    const animationVersion = nextNoteCollapseAnimationVersion(noteElement);
    const previousBoxSizing = typeof noteElement.style.boxSizing === 'string' ? noteElement.style.boxSizing : '';
    noteElement.style.height = `${capture.startHeight}px`;
    noteElement.style.boxSizing = 'border-box';
    noteElement.style.overflow = 'hidden';
    noteElement.classList.add(NOTE_COLLAPSE_ANIMATION_CLASS);
    noteElement.getBoundingClientRect();

    let didFinish = false;
    const finishAnimation = () => {
        if (didFinish) {
            return;
        }
        if (noteCollapseAnimationVersions.get(noteElement) !== animationVersion) {
            didFinish = true;
            removeDeferredRemovalElements(deferredRemovalElements);
            return;
        }
        didFinish = true;
        removeDeferredRemovalElements(deferredRemovalElements);
        noteElement.classList.remove(NOTE_COLLAPSE_ANIMATION_CLASS);
        noteElement.style.height = '';
        noteElement.style.boxSizing = previousBoxSizing;
        noteElement.style.overflow = '';
    };

    noteElement.addEventListener('transitionend', (event) => {
        if (event.propertyName !== 'height') {
            return;
        }
        finishAnimation();
    }, { once: true });

    window.requestAnimationFrame(() => {
        if (noteCollapseAnimationVersions.get(noteElement) !== animationVersion) {
            return;
        }
        noteElement.style.height = `${targetHeight}px`;
    });
    window.setTimeout(finishAnimation, NOTE_COLLAPSE_ANIMATION_FALLBACK_MS);
}
