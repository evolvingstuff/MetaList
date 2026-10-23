import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';

// The sort order and Untagged chips at the right end inside the search input
// (main.css). A chip grows in or shrinks out only when the user turned its view on
// or off in the tab they are looking at; on a reload or a tab switch it is simply
// there or not. The typed text always stops before the chips.

const SHOWN_CLASS = 'is-shown';
const GROWING_CLASS = 'is-growing';
const LEAVING_CLASS = 'is-leaving';
const GROW_ANIMATION = 'search-input-chip-grow';
const SHRINK_ANIMATION = 'search-input-chip-shrink';

const moduleState = ApplicationState.createFields('search-input-chip-service', {
    // The tab each chip was last shown for, by chip id: a change in another tab
    // is a tab switch, not the user's choice.
    tabIdByChipId: new Map(),
});

function isMotionEnabled() {
    return document.body.classList.contains('pref-animated-transitions');
}

function requireSearchInputRow(chip) {
    const row = chip.closest('.search-input-row');
    if (!(row instanceof HTMLElement)) {
        throw new Error('A search input chip must sit in the search input row');
    }
    return row;
}

// The text stops where the chips begin.
function syncChipsWidth(chip) {
    const chips = chip.parentElement;
    if (!(chips instanceof HTMLElement)) {
        throw new Error('A search input chip must sit in its chips container');
    }
    requireSearchInputRow(chip).style.setProperty('--search-input-chips-width', `${chips.offsetWidth}px`);
}

function finishAnimation(chip, className, animationName) {
    chip.addEventListener('animationend', function handleEnd(event) {
        if (event.animationName !== animationName) {
            return;
        }
        chip.removeEventListener('animationend', handleEnd);
        chip.classList.remove(className);
        syncChipsWidth(chip);
    });
}

/** Show or hide a chip, animating only a change the user made in this tab. */
export function showSearchInputChip(chip, isShown) {
    if (!(chip instanceof HTMLElement)) {
        throw new Error('showSearchInputChip requires a chip element');
    }
    if (typeof isShown !== 'boolean') {
        throw new Error('showSearchInputChip requires isShown boolean');
    }
    const activeTabId = ModeContext.activeTabId;
    const wasShown = chip.classList.contains(SHOWN_CLASS);
    const isSameTab = moduleState.tabIdByChipId.get(chip.id) === activeTabId;
    if (!isSameTab) {
        moduleState.tabIdByChipId.set(chip.id, activeTabId);
    }
    if (wasShown === isShown) {
        // A shown chip's label can change (another sort order).
        syncChipsWidth(chip);
        return;
    }
    chip.classList.remove(GROWING_CLASS, LEAVING_CLASS);
    chip.classList.toggle(SHOWN_CLASS, isShown);
    if (isSameTab && isMotionEnabled()) {
        if (isShown) {
            chip.classList.add(GROWING_CLASS);
            finishAnimation(chip, GROWING_CLASS, GROW_ANIMATION);
        } else {
            chip.classList.add(LEAVING_CLASS);
            finishAnimation(chip, LEAVING_CLASS, SHRINK_ANIMATION);
        }
    }
    syncChipsWidth(chip);
}
