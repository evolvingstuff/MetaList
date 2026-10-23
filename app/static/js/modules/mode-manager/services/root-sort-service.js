export const ROOT_SORT_MODES = Object.freeze({
    NORMAL: 'normal',
    CREATED: 'created',
    UPDATED: 'updated',
    ALPHABETICAL: 'alphabetical',
    CONTENT_VOLUME: 'content-volume',
});

// Reverse Order: any order, the manual one too, read bottom to top
// ('alphabetical-reversed' is Z to A; app/services/root_sorting.py).
export const ROOT_SORT_REVERSED_SUFFIX = '-reversed';
const BASE_ROOT_SORT_MODES = new Set(Object.values(ROOT_SORT_MODES));

export function normalizeRootSortMode(sortMode) {
    if (typeof sortMode !== 'string') {
        throw new Error('sortMode must be a string');
    }
    const normalized = sortMode.trim().toLowerCase();
    const base = normalized.endsWith(ROOT_SORT_REVERSED_SUFFIX)
        ? normalized.slice(0, -ROOT_SORT_REVERSED_SUFFIX.length)
        : normalized;
    if (!BASE_ROOT_SORT_MODES.has(base)) {
        throw new Error(`Unsupported root sort mode: ${sortMode}`);
    }
    return normalized;
}

export function isRootSortModeReversed(sortMode) {
    return normalizeRootSortMode(sortMode).endsWith(ROOT_SORT_REVERSED_SUFFIX);
}

/** The order a mode sorts by, without its direction. */
export function baseRootSortMode(sortMode) {
    const normalized = normalizeRootSortMode(sortMode);
    return isRootSortModeReversed(normalized)
        ? normalized.slice(0, -ROOT_SORT_REVERSED_SUFFIX.length)
        : normalized;
}

export function rootSortModeWithDirection(baseSortMode, isReversed) {
    if (typeof isReversed !== 'boolean') {
        throw new Error('rootSortModeWithDirection requires isReversed boolean');
    }
    const base = baseRootSortMode(baseSortMode);
    return isReversed ? `${base}${ROOT_SORT_REVERSED_SUFFIX}` : base;
}

export function isRootReorderLocked(sortMode) {
    return normalizeRootSortMode(sortMode) !== ROOT_SORT_MODES.NORMAL;
}

// Where a new root note may be added in a sorted tab (docs/ui/controls.md,
// "Sorted tabs"). `placement` is 'top' (the top of the list) or 'below' (right
// after a root note: Cmd+Enter, split, paste as sibling). Returns the banner
// explaining a block, or null when allowed. Child notes are never blocked: the
// root sort does not order them.
export function rootNoteCreationBlockMessage(sortMode, placement) {
    if (placement !== 'top' && placement !== 'below') {
        throw new Error(`Unknown root note placement: ${placement}`);
    }
    const normalized = normalizeRootSortMode(sortMode);
    if (normalized === ROOT_SORT_MODES.NORMAL) {
        return null;
    }
    // Reversed, the top of the list is not where a new note goes.
    if (isRootDateBucketSortMode(normalized) && !isRootSortModeReversed(normalized)) {
        if (placement === 'top') {
            return null;
        }
        return 'In this sort order new root notes can only be added at the top (press Enter outside edit mode). '
            + 'Switch to Normal order to add one here; child notes can still be added.';
    }
    return 'New root notes cannot be added while this sort order is active, because they would land far from here. '
        + 'Switch to Normal order, or add a child note.';
}

// The sort order's chip in the search input, by mode: [label, tooltip]. ↑ marks
// a reversed order that starts from the oldest or smallest.
const ROOT_SORT_CHIP_TEXT = Object.freeze({
    [ROOT_SORT_MODES.NORMAL]: ['', ''],
    [ROOT_SORT_MODES.CREATED]: ['Created', 'Sorted by datetime created'],
    [ROOT_SORT_MODES.UPDATED]: ['Updated', 'Sorted by datetime last updated'],
    [ROOT_SORT_MODES.ALPHABETICAL]: ['A\u2013Z', 'Sorted alphabetically'],
    [ROOT_SORT_MODES.CONTENT_VOLUME]: ['Size', 'Sorted by content volume'],
    [`${ROOT_SORT_MODES.NORMAL}${ROOT_SORT_REVERSED_SUFFIX}`]: ['Reversed', 'Normal order, reversed'],
    [`${ROOT_SORT_MODES.CREATED}${ROOT_SORT_REVERSED_SUFFIX}`]:
        ['Created \u2191', 'Sorted by datetime created, oldest first'],
    [`${ROOT_SORT_MODES.UPDATED}${ROOT_SORT_REVERSED_SUFFIX}`]:
        ['Updated \u2191', 'Sorted by datetime last updated, oldest first'],
    [`${ROOT_SORT_MODES.ALPHABETICAL}${ROOT_SORT_REVERSED_SUFFIX}`]:
        ['Z\u2013A', 'Sorted alphabetically, Z to A'],
    [`${ROOT_SORT_MODES.CONTENT_VOLUME}${ROOT_SORT_REVERSED_SUFFIX}`]:
        ['Size \u2191', 'Sorted by content volume, smallest first'],
});

const CHIP_LABEL_INDEX = 0;
const CHIP_TOOLTIP_INDEX = 1;

export function getRootSortModeChipLabel(sortMode) {
    return ROOT_SORT_CHIP_TEXT[normalizeRootSortMode(sortMode)][CHIP_LABEL_INDEX];
}

export function getRootSortModeIndicatorLabel(sortMode) {
    return ROOT_SORT_CHIP_TEXT[normalizeRootSortMode(sortMode)][CHIP_TOOLTIP_INDEX];
}

export function isRootDateBucketSortMode(sortMode) {
    const normalized = baseRootSortMode(sortMode);
    if (normalized === ROOT_SORT_MODES.CREATED) {
        return true;
    }
    if (normalized === ROOT_SORT_MODES.UPDATED) {
        return true;
    }
    return false;
}

// sortKeyBeforeWindow: the date bucket of the root just above the loaded band
// ('' at the first root), so a band that starts mid-day shows no header.
export function buildRootDateSeparatorPlan(rootIds, rootSortBuckets, sortKeyBeforeWindow) {
    if (!Array.isArray(rootIds)) {
        throw new Error('rootIds must be an array');
    }
    if (!rootSortBuckets || typeof rootSortBuckets !== 'object') {
        throw new Error('rootSortBuckets must be an object');
    }

    if (typeof sortKeyBeforeWindow !== 'string') {
        throw new Error('sortKeyBeforeWindow must be a string');
    }
    const plan = [];
    let previousKey = sortKeyBeforeWindow === '' ? null : sortKeyBeforeWindow;
    for (const rootId of rootIds) {
        if (typeof rootId !== 'string' || rootId.length === 0) {
            throw new Error('rootIds entries must be non-empty strings');
        }
        const bucket = rootSortBuckets[rootId];
        if (!bucket || typeof bucket !== 'object') {
            throw new Error(`Missing root sort bucket for ${rootId}`);
        }
        if (typeof bucket.key !== 'string' || bucket.key.length === 0) {
            throw new Error(`root sort bucket key missing for ${rootId}`);
        }
        if (typeof bucket.label !== 'string' || bucket.label.length === 0) {
            throw new Error(`root sort bucket label missing for ${rootId}`);
        }
        if (bucket.key !== previousKey) {
            plan.push({
                rootId,
                bucketKey: bucket.key,
                label: bucket.label,
            });
            previousKey = bucket.key;
        }
    }
    return plan;
}
