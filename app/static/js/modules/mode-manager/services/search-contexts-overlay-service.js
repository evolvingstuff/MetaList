import { ApplicationState } from '../../application-state.js';
const SEARCH_CONTEXTS_SELECTOR = '#search-contexts-list';
const TAB_HOVER_ZONE_SELECTOR = '#tab-hover-zone';
const CONTROLS_SELECTOR = '.controls';
const HOVER_CLASS = 'search-contexts-list--hover';
const POINTER_DISMISS_BUFFER_PX = 28;

const moduleState = ApplicationState.createFields('search-contexts-overlay-service', {
    isHoverOverlayVisible: false,
    isHoverInitialized: false,
    lastPointerClientX: null,
    lastPointerClientY: null,
});


function getSearchContextsListElement() {
    const element = document.querySelector(SEARCH_CONTEXTS_SELECTOR);
    if (!element) {
        return null;
    }
    if (!(element instanceof HTMLElement)) {
        throw new Error('search-contexts-list must be an HTMLElement');
    }
    return element;
}

function getTabHoverZoneElement() {
    const element = document.querySelector(TAB_HOVER_ZONE_SELECTOR);
    if (!element) {
        return null;
    }
    if (!(element instanceof HTMLElement)) {
        throw new Error('tab-hover-zone must be an HTMLElement');
    }
    return element;
}

function getControlsElement() {
    const element = document.querySelector(CONTROLS_SELECTOR);
    if (!element) {
        return null;
    }
    if (!(element instanceof HTMLElement)) {
        throw new Error('controls element must be an HTMLElement');
    }
    return element;
}

function isTabUiEnabled() {
    return document.body.classList.contains('pref-show-tab-ui');
}

function hasRenderedTabRows(searchContextsList) {
    if (!(searchContextsList instanceof HTMLElement)) {
        throw new Error('hasRenderedTabRows requires search contexts element');
    }
    return searchContextsList.innerHTML.trim().length > 0;
}

function clampPopoverLeft(left, width) {
    if (!Number.isFinite(left) || !Number.isFinite(width)) {
        throw new Error('clampPopoverLeft requires finite values');
    }
    const viewportWidth = window.innerWidth;
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
        throw new Error('window.innerWidth must be a positive number');
    }
    const minLeft = 8;
    const maxLeft = Math.max(minLeft, viewportWidth - width - 8);
    return Math.min(Math.max(left, minLeft), maxLeft);
}

export function isSearchContextsOverlayBottomLeft() {
    return false;
}

export function updateSearchContextsOverlayPlacement() {
    const searchContextsList = getSearchContextsListElement();
    if (!searchContextsList) {
        return false;
    }

    searchContextsList.classList.add(HOVER_CLASS);

    if (!isTabUiEnabled() || !hasRenderedTabRows(searchContextsList)) {
        // Preference/DOM refresh can observe the overlay already hidden.
        if (moduleState.isHoverOverlayVisible) moduleState.isHoverOverlayVisible = false;
        searchContextsList.style.display = 'none';
        return false;
    }

    if (!moduleState.isHoverOverlayVisible) {
        searchContextsList.style.display = 'none';
        return false;
    }

    const hoverZone = getTabHoverZoneElement();
    if (!hoverZone) {
        searchContextsList.style.display = 'none';
        return false;
    }

    searchContextsList.style.display = 'block';
    const hoverRect = hoverZone.getBoundingClientRect();
    const controls = getControlsElement();
    const controlsRect = controls ? controls.getBoundingClientRect() : hoverRect;
    const listRect = searchContextsList.getBoundingClientRect();
    if (
        !hoverRect
        || !controlsRect
        || !listRect
        || !Number.isFinite(hoverRect.left)
        || !Number.isFinite(hoverRect.bottom)
        || !Number.isFinite(controlsRect.left)
        || !Number.isFinite(listRect.width)
    ) {
        throw new Error('search contexts placement requires valid element rects');
    }

    const popoverLeft = clampPopoverLeft(Math.round(controlsRect.left), Math.round(listRect.width));
    const popoverTop = Math.max(8, Math.round(hoverRect.bottom + 6));
    searchContextsList.style.left = `${popoverLeft}px`;
    searchContextsList.style.top = `${popoverTop}px`;
    searchContextsList.style.right = 'auto';
    searchContextsList.style.bottom = 'auto';
    return true;
}

export function showSearchContextsOverlay() {
    const searchContextsList = getSearchContextsListElement();
    if (!searchContextsList) {
        return false;
    }
    if (!isTabUiEnabled() || !hasRenderedTabRows(searchContextsList)) {
        return false;
    }
    // Repeated pointer-enter notifications only reposition an already open overlay.
    if (moduleState.isHoverOverlayVisible) return updateSearchContextsOverlayPlacement();
    moduleState.isHoverOverlayVisible = true;
    return updateSearchContextsOverlayPlacement();
}

export function hideSearchContextsOverlay() {
    // Pointer-leave and tab refresh can both request dismissal of an absent overlay.
    if (!moduleState.isHoverOverlayVisible) return false;
    moduleState.isHoverOverlayVisible = false;

    const searchContextsList = getSearchContextsListElement();
    if (!searchContextsList) {
        return false;
    }
    const wasVisible = window.getComputedStyle(searchContextsList).display !== 'none';
    searchContextsList.style.display = 'none';
    return wasVisible;
}

function buildBufferedBounds(rects) {
    if (!Array.isArray(rects) || rects.length === 0) {
        throw new Error('buildBufferedBounds requires rects');
    }

    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const rect of rects) {
        if (
            !rect
            || !Number.isFinite(rect.left)
            || !Number.isFinite(rect.right)
            || !Number.isFinite(rect.top)
            || !Number.isFinite(rect.bottom)
        ) {
            throw new Error('buildBufferedBounds requires valid rects');
        }
        left = Math.min(left, rect.left);
        right = Math.max(right, rect.right);
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
    }

    return {
        left: left - POINTER_DISMISS_BUFFER_PX,
        right: right + POINTER_DISMISS_BUFFER_PX,
        top: top - POINTER_DISMISS_BUFFER_PX,
        bottom: bottom + POINTER_DISMISS_BUFFER_PX,
    };
}

function isPointerInsideBounds(bounds, pointerClientX, pointerClientY) {
    if (!bounds || typeof bounds !== 'object') {
        throw new Error('isPointerInsideBounds requires bounds');
    }
    if (!Number.isFinite(pointerClientX) || !Number.isFinite(pointerClientY)) {
        throw new Error('isPointerInsideBounds requires finite pointer coordinates');
    }
    return (
        pointerClientX >= bounds.left
        && pointerClientX <= bounds.right
        && pointerClientY >= bounds.top
        && pointerClientY <= bounds.bottom
    );
}

function recordPointerPosition(pointerClientX, pointerClientY) {
    if (!Number.isFinite(pointerClientX) || !Number.isFinite(pointerClientY)) {
        return;
    }
    // One axis can remain still; hover and document handlers also observe the
    // same event. Publish only changed coordinates at this browser boundary.
    if (moduleState.lastPointerClientX !== pointerClientX) {
        moduleState.lastPointerClientX = pointerClientX;
    }
    if (moduleState.lastPointerClientY !== pointerClientY) {
        moduleState.lastPointerClientY = pointerClientY;
    }
}

function isPointerInsideRect(rect, pointerClientX, pointerClientY) {
    if (
        !rect
        || !Number.isFinite(rect.left)
        || !Number.isFinite(rect.right)
        || !Number.isFinite(rect.top)
        || !Number.isFinite(rect.bottom)
    ) {
        throw new Error('isPointerInsideRect requires valid rect');
    }
    if (!Number.isFinite(pointerClientX) || !Number.isFinite(pointerClientY)) {
        throw new Error('isPointerInsideRect requires finite pointer coordinates');
    }
    return (
        pointerClientX >= rect.left
        && pointerClientX <= rect.right
        && pointerClientY >= rect.top
        && pointerClientY <= rect.bottom
    );
}

function isElementHovered(element) {
    if (!(element instanceof HTMLElement)) {
        throw new Error('isElementHovered requires HTMLElement');
    }
    if (typeof element.matches !== 'function') {
        return false;
    }
    return element.matches(':hover');
}

export function isSearchContextsKeyboardCreateActive() {
    if (!moduleState.isHoverOverlayVisible) {
        return false;
    }

    const searchContextsList = getSearchContextsListElement();
    const hoverZone = getTabHoverZoneElement();
    if (!searchContextsList || !hoverZone) {
        return false;
    }

    if (Number.isFinite(moduleState.lastPointerClientX) && Number.isFinite(moduleState.lastPointerClientY)) {
        if (isPointerInsideRect(hoverZone.getBoundingClientRect(), moduleState.lastPointerClientX, moduleState.lastPointerClientY)) {
            return true;
        }
        if (window.getComputedStyle(searchContextsList).display !== 'none') {
            return isPointerInsideRect(
                searchContextsList.getBoundingClientRect(),
                moduleState.lastPointerClientX,
                moduleState.lastPointerClientY,
            );
        }
        return false;
    }

    if (isElementHovered(hoverZone)) {
        return true;
    }
    return window.getComputedStyle(searchContextsList).display !== 'none'
        && isElementHovered(searchContextsList);
}

export function hideSearchContextsOverlayForPointerMove(options) {
    if (!options || typeof options !== 'object') {
        throw new Error('hideSearchContextsOverlayForPointerMove requires options');
    }
    const { pointerClientX, pointerClientY } = options;
    if (!Number.isFinite(pointerClientX)) {
        throw new Error('hideSearchContextsOverlayForPointerMove requires pointerClientX');
    }
    if (!Number.isFinite(pointerClientY)) {
        throw new Error('hideSearchContextsOverlayForPointerMove requires pointerClientY');
    }
    recordPointerPosition(pointerClientX, pointerClientY);
    if (!moduleState.isHoverOverlayVisible) {
        return false;
    }

    const searchContextsList = getSearchContextsListElement();
    const hoverZone = getTabHoverZoneElement();
    if (!searchContextsList || !hoverZone) {
        return false;
    }
    if (window.getComputedStyle(searchContextsList).display === 'none') {
        return false;
    }

    const bounds = buildBufferedBounds([
        searchContextsList.getBoundingClientRect(),
        hoverZone.getBoundingClientRect(),
    ]);
    if (isPointerInsideBounds(bounds, pointerClientX, pointerClientY)) {
        return false;
    }

    hideSearchContextsOverlay();
    return true;
}

export function initializeSearchContextsHover() {
    if (moduleState.isHoverInitialized) {
        return;
    }
    const hoverZone = getTabHoverZoneElement();
    if (!hoverZone) {
        throw new Error('tab-hover-zone element missing from DOM');
    }

    const searchContextsList = getSearchContextsListElement();
    const showOverlay = (event) => {
        if (event) {
            recordPointerPosition(event.clientX, event.clientY);
        }
        showSearchContextsOverlay();
    };

    hoverZone.addEventListener('mouseenter', showOverlay);
    hoverZone.addEventListener('mousemove', showOverlay);
    if (searchContextsList) {
        searchContextsList.addEventListener('mouseenter', showOverlay);
        searchContextsList.addEventListener('mousemove', showOverlay);
    }
    moduleState.isHoverInitialized = true;
}
