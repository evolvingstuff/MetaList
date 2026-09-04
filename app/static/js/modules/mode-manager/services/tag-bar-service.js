import { CONFIG } from '../../config.js';
import { analyzeTagBarInput, enforceTagBarInputForEditing, normalizeTagBarInput } from './tag-syntax-service.js';
import { syncTagProposalEditingState } from './tag-proposal-service.js';

const TAG_BAR_CLASS = 'note-tag-bar';
const TAG_BAR_INPUT_CLASS = 'note-tag-bar-input';
const TAG_BAR_VALIDATION_MESSAGE_CLASS = 'note-tag-bar-validation-message';
const TAG_BAR_ENTERING_CLASS = 'is-entering';
const TAG_BAR_EXITING_CLASS = 'is-exiting';
const COLLAPSED_CHILDREN_INDICATOR_CLASS = 'note-collapsed-children-indicator';
const TAG_BAR_ANIMATION_FALLBACK_MS = 200;

let activeNoteElement = null;
let activeObserver = null;
let activeFallbackHandler = null;
let activeSyncedTags = null;
const tagBarAnimationVersions = new WeakMap();

function getDirectChildByClass(parent, className) {
    for (const child of Array.from(parent.children)) {
        if (child.classList && child.classList.contains(className)) {
            return child;
        }
    }
    return null;
}

function isElementPartiallyInViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0
        && rect.top < window.innerHeight
        && rect.right > 0
        && rect.left < window.innerWidth;
}

function nextTagBarAnimationVersion(tagBar) {
    const currentVersion = tagBarAnimationVersions.has(tagBar)
        ? tagBarAnimationVersions.get(tagBar)
        : 0;
    if (!Number.isInteger(currentVersion)) {
        throw new Error('Tag bar animation version must be an integer');
    }
    const nextVersion = currentVersion + 1;
    tagBarAnimationVersions.set(tagBar, nextVersion);
    return nextVersion;
}

function areAnimatedTransitionsEnabled() {
    if (!(document.body instanceof HTMLElement)) {
        throw new Error('document.body is required for animated transition preference');
    }
    return document.body.classList.contains('pref-animated-transitions');
}

function animateTagBarEnter(tagBar) {
    if (!(tagBar instanceof HTMLElement)) {
        throw new Error('animateTagBarEnter requires HTMLElement');
    }
    if (!areAnimatedTransitionsEnabled()) {
        nextTagBarAnimationVersion(tagBar);
        tagBar.hidden = false;
        tagBar.classList.remove(TAG_BAR_ENTERING_CLASS, TAG_BAR_EXITING_CLASS);
        tagBar.style.height = '';
        tagBar.style.overflow = '';
        return;
    }

    const animationVersion = nextTagBarAnimationVersion(tagBar);
    tagBar.hidden = false;
    tagBar.classList.remove(TAG_BAR_EXITING_CLASS);
    const targetHeight = tagBar.getBoundingClientRect().height;
    tagBar.style.height = '0px';
    tagBar.style.overflow = 'hidden';
    tagBar.classList.add(TAG_BAR_ENTERING_CLASS);
    tagBar.getBoundingClientRect();

    let didFinish = false;
    const finishEnter = () => {
        if (didFinish || tagBarAnimationVersions.get(tagBar) !== animationVersion) {
            return;
        }
        didFinish = true;
        tagBar.classList.remove(TAG_BAR_ENTERING_CLASS);
        tagBar.style.height = '';
        tagBar.style.overflow = '';
    };

    tagBar.addEventListener('transitionend', (event) => {
        if (event.propertyName !== 'height') {
            return;
        }
        finishEnter();
    }, { once: true });

    window.requestAnimationFrame(() => {
        if (tagBarAnimationVersions.get(tagBar) !== animationVersion) {
            return;
        }
        tagBar.classList.remove(TAG_BAR_ENTERING_CLASS);
        tagBar.style.height = `${targetHeight}px`;
    });
    window.setTimeout(finishEnter, TAG_BAR_ANIMATION_FALLBACK_MS);
}

function removeTagBarElement(tagBar) {
    if (!(tagBar instanceof HTMLElement)) {
        throw new Error('removeTagBarElement requires HTMLElement');
    }
    if (tagBar.classList.contains(TAG_BAR_EXITING_CLASS)) {
        return;
    }
    if (!areAnimatedTransitionsEnabled()) {
        nextTagBarAnimationVersion(tagBar);
        tagBar.remove();
        return;
    }

    const animationVersion = nextTagBarAnimationVersion(tagBar);
    const currentHeight = tagBar.getBoundingClientRect().height;
    tagBar.style.height = `${currentHeight}px`;
    tagBar.style.overflow = 'hidden';
    tagBar.getBoundingClientRect();
    tagBar.classList.remove(TAG_BAR_ENTERING_CLASS);
    tagBar.classList.add(TAG_BAR_EXITING_CLASS);

    let didRemove = false;
    const removeAfterTransition = () => {
        if (didRemove || tagBarAnimationVersions.get(tagBar) !== animationVersion) {
            return;
        }
        didRemove = true;
        tagBar.remove();
    };

    tagBar.addEventListener('transitionend', (event) => {
        if (event.propertyName !== 'height') {
            return;
        }
        removeAfterTransition();
    }, { once: true });

    window.requestAnimationFrame(() => {
        if (tagBarAnimationVersions.get(tagBar) !== animationVersion) {
            return;
        }
        tagBar.style.height = '0px';
    });
    window.setTimeout(removeAfterTransition, TAG_BAR_ANIMATION_FALLBACK_MS);
}

function ensureTagBarElement(noteElement) {
    const existing = getDirectChildByClass(noteElement, TAG_BAR_CLASS);
    if (existing) {
        return { element: existing, created: false };
    }

    const tagBar = document.createElement('div');
    tagBar.classList.add(TAG_BAR_CLASS);

    const validationMessage = document.createElement('div');
    validationMessage.classList.add(TAG_BAR_VALIDATION_MESSAGE_CLASS);
    validationMessage.hidden = true;
    tagBar.appendChild(validationMessage);

    const input = document.createElement('input');
    input.classList.add(TAG_BAR_INPUT_CLASS);
    input.type = 'text';
    input.setAttribute('aria-label', 'Tags');
    input.setAttribute('title', 'Tags');
    input.autocomplete = 'off';
    input.spellcheck = false;

    tagBar.appendChild(input);

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.classList.add('note-tag-bar-empty-icon');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('focusable', 'false');
    icon.setAttribute('aria-hidden', 'true');

    const tagPathData = 'M1.5 1.5h4l6.75 6.75a1.5 1.5 0 0 1 0 2.12l-1.88 1.88a1.5 1.5 0 0 1-2.12 0L1.5 5.5v-4ZM4.25 3.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z';

    const backIconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    backIconPath.classList.add('note-tag-bar-empty-icon-back');
    backIconPath.setAttribute('d', tagPathData);
    backIconPath.setAttribute('transform', 'translate(4 0)');

    const frontIconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    frontIconPath.classList.add('note-tag-bar-empty-icon-front');
    frontIconPath.setAttribute('d', tagPathData);
    frontIconPath.setAttribute('fill-rule', 'evenodd');
    icon.append(backIconPath, frontIconPath);
    tagBar.appendChild(icon);

    const suggestions = document.createElement('div');
    suggestions.classList.add('note-tag-suggestions');
    suggestions.hidden = true;
    suggestions.style.display = 'none';
    tagBar.appendChild(suggestions);

    const contentElement = getDirectChildByClass(noteElement, CONFIG.CLASSES.NOTE_CONTENT);
    const childContainer = getDirectChildByClass(noteElement, 'note-children');

    if (!contentElement) {
        throw new Error('Cannot attach tag bar: note missing direct note-content child');
    }

    if (childContainer) {
        noteElement.insertBefore(tagBar, childContainer);
    } else if (contentElement.nextSibling) {
        noteElement.insertBefore(tagBar, contentElement.nextSibling);
    } else {
        noteElement.appendChild(tagBar);
    }

    return { element: tagBar, created: true };
}

function ensureCollapsedChildrenIndicator(noteElement, tagBar) {
    if (!noteElement) {
        throw new Error('ensureCollapsedChildrenIndicator requires a note element');
    }
    if (!tagBar) {
        throw new Error('ensureCollapsedChildrenIndicator requires a tag bar element');
    }

    let indicator = getDirectChildByClass(noteElement, COLLAPSED_CHILDREN_INDICATOR_CLASS);
    if (!indicator) {
        indicator = document.createElement('button');
        indicator.classList.add(COLLAPSED_CHILDREN_INDICATOR_CLASS);
        indicator.type = 'button';
        indicator.textContent = '⋮';
        indicator.setAttribute('aria-label', 'Expand note to show hidden children');
    }

    if (indicator.previousSibling !== tagBar) {
        noteElement.insertBefore(indicator, tagBar.nextSibling);
    }

    return indicator;
}

function syncCollapsedChildrenIndicator(noteElement, tagBar) {
    const indicator = ensureCollapsedChildrenIndicator(noteElement, tagBar);
    const shouldShow = noteElement.classList.contains(CONFIG.CLASSES.EDITING)
        && noteElement.dataset.isCollapsed === 'true'
        && noteElement.dataset.hasChildren === 'true';
    indicator.hidden = !shouldShow;
}

function ensureValidationMessageElement(tagBar) {
    if (!tagBar) {
        return null;
    }

    const existing = tagBar.querySelector(`.${TAG_BAR_VALIDATION_MESSAGE_CLASS}`);
    if (existing) {
        return existing;
    }

    const validationMessage = document.createElement('div');
    validationMessage.classList.add(TAG_BAR_VALIDATION_MESSAGE_CLASS);
    validationMessage.hidden = true;
    tagBar.insertBefore(validationMessage, tagBar.firstChild);
    return validationMessage;
}

function setTagBarValidationState(tagBar, analysis) {
    if (!tagBar) {
        throw new Error('setTagBarValidationState requires a tag bar element');
    }
    if (!analysis || typeof analysis.isValid !== 'boolean') {
        throw new Error('setTagBarValidationState requires an analysis result');
    }

    const validationMessage = ensureValidationMessageElement(tagBar);
    if (analysis.isValid) {
        if (validationMessage) {
            validationMessage.hidden = true;
            validationMessage.textContent = '';
        }
        return;
    }

    if (!validationMessage) {
        return;
    }

    if (typeof analysis.errorMessage !== 'string') {
        throw new Error('Invariant violation: invalid tag bar state missing errorMessage');
    }
    validationMessage.textContent = analysis.errorMessage;
    validationMessage.hidden = false;
}

export function enforceTagBarInputElement(tagBarInput) {
    if (!tagBarInput) {
        throw new Error('enforceTagBarInputElement requires an input element');
    }

    const rawValue = typeof tagBarInput.value === 'string' ? tagBarInput.value : '';
    const enforcedValue = enforceTagBarInputForEditing(rawValue);
    if (enforcedValue === rawValue) {
        return false;
    }

    const selectionStart = Number.isInteger(tagBarInput.selectionStart) ? tagBarInput.selectionStart : rawValue.length;
    const selectionEnd = Number.isInteger(tagBarInput.selectionEnd) ? tagBarInput.selectionEnd : selectionStart;

    const nextSelectionStart = enforceTagBarInputForEditing(rawValue.slice(0, selectionStart)).length;
    const nextSelectionEnd = enforceTagBarInputForEditing(rawValue.slice(0, selectionEnd)).length;

    tagBarInput.value = enforcedValue;
    if (typeof tagBarInput.setSelectionRange === 'function') {
        tagBarInput.setSelectionRange(nextSelectionStart, nextSelectionEnd);
    }

    return true;
}

function getTagBarInput(tagBar) {
    if (!tagBar) {
        return null;
    }
    return tagBar.querySelector(`.${TAG_BAR_INPUT_CLASS}`);
}

function isTagBarFocused(tagBar) {
    const input = getTagBarInput(tagBar);
    if (!input) {
        return false;
    }
    return document.activeElement === input;
}

export function normalizeTags(rawTags) {
    if (typeof rawTags !== 'string') {
        throw new Error('normalizeTags expects a string');
    }
    return normalizeTagBarInput(rawTags);
}

export function sanitizeTags(rawTags) {
    if (typeof rawTags !== 'string') {
        throw new Error('sanitizeTags expects a string');
    }
    return analyzeTagBarInput(rawTags).sanitizedText;
}

export function normalizeTagBarForNewTag(noteElement, tagBarInput) {
    if (!noteElement) {
        throw new Error('normalizeTagBarForNewTag requires a note element');
    }
    if (!tagBarInput) {
        throw new Error('normalizeTagBarForNewTag requires a tag bar input element');
    }

    const inputValue = typeof tagBarInput.value === 'string' ? tagBarInput.value : '';
    const storedTags = typeof noteElement.dataset.noteTags === 'string' ? noteElement.dataset.noteTags : '';
    const existingTags = inputValue.length > 0 ? inputValue : storedTags;
    const normalized = normalizeTags(existingTags);
    const nextValue = normalized.length > 0 ? `${normalized} ` : '';

    tagBarInput.value = nextValue;
    const end = nextValue.length;
    if (typeof tagBarInput.setSelectionRange === 'function') {
        tagBarInput.setSelectionRange(end, end);
    }

    return nextValue;
}

export function validateAndRenderTagBar(noteElement) {
    if (!noteElement) {
        throw new Error('validateAndRenderTagBar requires a note element');
    }

    const tagBar = getDirectChildByClass(noteElement, TAG_BAR_CLASS);
    const input = getTagBarInput(tagBar);
    if (!tagBar || !input || typeof input.value !== 'string') {
        return null;
    }

    const analysis = analyzeTagBarInput(input.value);
    setTagBarValidationState(tagBar, analysis);
    return analysis;
}

export function getTagBarValue(noteElement) {
    if (!noteElement) {
        throw new Error('getTagBarValue requires a note element');
    }
    const tagBar = getDirectChildByClass(noteElement, TAG_BAR_CLASS);
    const input = getTagBarInput(tagBar);
    if (input && typeof input.value === 'string') {
        return analyzeTagBarInput(input.value).sanitizedText;
    }
    const storedTags = typeof noteElement.dataset.noteTags === 'string' ? noteElement.dataset.noteTags : '';
    return analyzeTagBarInput(storedTags).sanitizedText;
}

export function setTagBarValue(noteElement, tags) {
    if (!noteElement) {
        throw new Error('setTagBarValue requires a note element');
    }
    if (typeof tags !== 'string') {
        throw new Error('setTagBarValue requires tags string');
    }
    const normalized = normalizeTagBarInput(tags);
    noteElement.dataset.noteTags = normalized;
    const tagBar = getDirectChildByClass(noteElement, TAG_BAR_CLASS);
    const input = getTagBarInput(tagBar);
    if (input) {
        input.value = normalized;
    }

    if (tagBar) {
        setTagBarValidationState(tagBar, analyzeTagBarInput(normalized));
    }
}

function removeTagBar(noteElement) {
    const existing = getDirectChildByClass(noteElement, TAG_BAR_CLASS);
    if (existing) {
        removeTagBarElement(existing);
    }

    const indicator = getDirectChildByClass(noteElement, COLLAPSED_CHILDREN_INDICATOR_CLASS);
    if (indicator) {
        indicator.remove();
    }
}

function disconnectVisibilityTracking() {
    if (activeObserver) {
        activeObserver.disconnect();
        activeObserver = null;
    }

    if (activeFallbackHandler) {
        window.removeEventListener('scroll', activeFallbackHandler, true);
        window.removeEventListener('resize', activeFallbackHandler);
        activeFallbackHandler = null;
    }
}

function isEditingByMe(noteElement) {
    const isEditing = noteElement.classList.contains(CONFIG.CLASSES.EDITING);
    if (!isEditing) {
        return false;
    }

	let contentElement = noteElement.querySelector(`:scope > .${CONFIG.CLASSES.NOTE_CONTENT}`);
	if (!contentElement) {
		contentElement = noteElement.querySelector(`.${CONFIG.CLASSES.NOTE_CONTENT}`);
	}
	if (!contentElement) {
		throw new Error('Cannot determine edit state: note missing content element');
	}
    return contentElement.getAttribute('contenteditable') === 'true';
}

export function syncTagBar(editingNoteElement) {
    if (!editingNoteElement || !isEditingByMe(editingNoteElement)) {
        if (activeNoteElement) {
            disconnectVisibilityTracking();
            syncTagProposalEditingState(activeNoteElement, false);
            removeTagBar(activeNoteElement);
            activeNoteElement = null;
            activeSyncedTags = null;
        }
        return;
    }

    if (activeNoteElement && activeNoteElement !== editingNoteElement) {
        disconnectVisibilityTracking();
        syncTagProposalEditingState(activeNoteElement, false);
        removeTagBar(activeNoteElement);
        activeNoteElement = null;
        activeSyncedTags = null;
    }

    activeNoteElement = editingNoteElement;
    const tagBarResult = ensureTagBarElement(editingNoteElement);
    const tagBar = tagBarResult.element;
    let shouldAnimateEntry = tagBarResult.created;
    if (!shouldAnimateEntry && tagBar.classList.contains(TAG_BAR_EXITING_CLASS)) {
        shouldAnimateEntry = true;
    }
    const input = getTagBarInput(tagBar);

    const storedTags = typeof editingNoteElement.dataset.noteTags === 'string'
        ? editingNoteElement.dataset.noteTags
        : '';
    const normalizedStoredTags = normalizeTagBarInput(storedTags);

    if (tagBarResult.created) {
        setTagBarValue(editingNoteElement, normalizedStoredTags);
        activeSyncedTags = normalizedStoredTags;
    } else if (input) {
        if (activeSyncedTags === null) {
            activeSyncedTags = normalizeTagBarInput(typeof input.value === 'string' ? input.value : '');
        }

        if (normalizedStoredTags !== activeSyncedTags) {
            const currentInputValue = typeof input.value === 'string' ? input.value : '';

            if (currentInputValue === activeSyncedTags) {
                setTagBarValue(editingNoteElement, normalizedStoredTags);
                activeSyncedTags = normalizedStoredTags;
            } else if (currentInputValue === normalizedStoredTags) {
                activeSyncedTags = normalizedStoredTags;
            }
        }
    }

    validateAndRenderTagBar(editingNoteElement);
    syncCollapsedChildrenIndicator(editingNoteElement, tagBar);

    // While editing, the tag bar is part of the core editing UI. Keep it visible
    // (and avoid any observer-driven hiding that can get out of sync during
    // move/undo reorder operations).
    disconnectVisibilityTracking();
    tagBar.hidden = false;
    syncTagProposalEditingState(editingNoteElement, true);
    if (shouldAnimateEntry) {
        animateTagBarEnter(tagBar);
    }
}

export function clearTagBar() {
    syncTagBar(null);
}
