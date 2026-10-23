import { showSearchInputChip } from './search-input-chip-service.js';

export function updateUntaggedViewIndicator(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        throw new Error('updateUntaggedViewIndicator requires snapshot object');
    }
    if (typeof snapshot.isUntaggedView !== 'boolean') {
        throw new Error('snapshot.isUntaggedView must be a boolean');
    }
    const indicator = document.getElementById('untagged-view-indicator');
    if (!(indicator instanceof HTMLElement)) {
        throw new Error('untagged-view-indicator element missing');
    }
    showSearchInputChip(indicator, { isShown: snapshot.isUntaggedView });
}
