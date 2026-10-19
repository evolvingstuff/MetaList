const NOTE_REPOSITION_ANIMATION_EASING = 'cubic-bezier(0.2, 0, 0.2, 1)';
const NOTE_REMOVAL_ANIMATION_CLASS = 'is-removal-collapsing';
const NOTE_REMOVAL_ANIMATION_FALLBACK_MS = 240;
const NOTE_REMOVAL_ANIMATION_DURATION_MS = 180;
const NOTE_REMOVAL_HEIGHT_TOLERANCE_PX = 0.5;
const NOTE_REMOVAL_COLLAPSED_SCALE_Y = '0.04';
const NOTE_REMOVAL_WRAPPER_MARGIN = '2px 0';

function requireNoteElement(noteElement, functionName) {
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error(`${functionName} requires HTMLElement`);
    }
    if (!noteElement.classList.contains('note')) {
        throw new Error(`${functionName} requires note element`);
    }
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
