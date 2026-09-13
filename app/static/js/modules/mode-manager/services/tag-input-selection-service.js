import { findSearchTagAtIndex } from './search-syntax-service.js';
import { findTagAtIndexInTagBar } from './tag-syntax-service.js';

export function selectTagOnDoubleClick(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || event.button !== 0) return;
    const isSearch = input.id === 'search-input';
    if (!isSearch && !input.classList.contains('note-tag-bar-input')) return;

    // Native word selection has already happened on the second mousedown.
    // Resolve the tag from inside that selection, even if it is just "@" or "-".
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error('Tag input must expose selection offsets');
    }
    if (input.value.slice(start, end).trim() === '') return;
    const index = start + Math.floor((end - start) / 2);
    const tag = isSearch
        ? findSearchTagAtIndex(input.value, index)
        : findTagAtIndexInTagBar(input.value, index);
    if (tag === null) return;

    event.preventDefault();
    input.setSelectionRange(tag.start, tag.end);
}
