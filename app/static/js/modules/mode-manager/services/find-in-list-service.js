import { ApplicationState, stateValuesEqual } from '../../application-state.js';
import { CONFIG } from '../../config.js';
import { NotesAPI } from '../../api-client.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { CommandGate } from './command-gate-service.js';
import { phraseRangesIn } from './search-highlight-service.js';
import { DELIBERATE_SCROLL_EVENT, scrollWindowToYFastAnimated } from './animated-scroll-service.js';
import { clampNumber, getScrollMaxY, getViewportTopInset, VIEWPORT_TOP_BUFFER_PX } from './viewport-reference.js';

// Find in the list (docs/ui/find.md): Cmd/Ctrl+F finds text in the notes the list shows,
// also far below what is loaded and folded away. The server answers one window at a
// time (the matches in whole roots, until 50 notes matched), so a common word costs a
// few notes per step. Landing on a match follows docs/ui/interaction-principles.md: in
// view, nothing scrolls (2); out of view, the list moves the minimum distance (3); a
// match folded away opens its note for the view only, never its saved collapse (4).
// The marks are painted with the CSS Custom Highlight API, so they move nothing (1).

const BAR_ID = 'find-in-list-bar';
const INPUT_ID = 'find-in-list-input';
const COUNT_ID = 'find-in-list-count';
const NOTES_CONTAINER_ID = 'notes-container';
const MARK_HIGHLIGHT = 'metalist-find';
const CURRENT_HIGHLIGHT = 'metalist-find-current';
// Find's marks paint over the search's phrase marks.
const MARK_PRIORITY = 1;
const CURRENT_PRIORITY = 2;
// Counting starts after the typing pauses this long.
const TYPING_PAUSE_MS = 200;
const TAG_COMMENT_SELECTOR = '.note-tag--comment';

const moduleState = ApplicationState.createFields('find-in-list-service', {
    isOpen: false,
    text: '',
    // Changes with every new find (text, tab, search, sort): answers to an older one are dropped.
    generation: 0,
    contextKey: '',
    // Disjoint windows of roots read so far, in list order: {first, end, matches}.
    windows: [],
    rootCount: 0,
    // {noteId, occurrence}: the current match.
    current: null,
    typingTimer: null,
    observer: null,
    isPaintRequested: false,
});

// ApplicationState refuses a write that changes nothing; find's writes often do not.
function update(target, key, value) {
    if (!stateValuesEqual(target[key], value)) {
        target[key] = value;
    }
}

function contextKeyNow() {
    return JSON.stringify([
        ModeContext.activeTabId, ModeContext.getExecutedSearchQuery(), ModeContext.isUntaggedView,
        ModeContext.activeTabSortMode,
    ]);
}

function barElement() {
    return document.getElementById(BAR_ID);
}

function inputElement() {
    const input = document.getElementById(INPUT_ID);
    if (!(input instanceof HTMLInputElement)) {
        throw new Error('The find bar has no text box');
    }
    return input;
}

export function isFindBarOpen() {
    return moduleState.isOpen;
}

export function isFindInput(element) {
    return element instanceof HTMLElement && element.id === INPUT_ID;
}

// ---------------------------------------------------------------------------
// Matches and windows

function occurrenceCount(match) {
    return match.contentCount + match.commentCount;
}

function allMatches() {
    return moduleState.windows.flatMap(window => window.matches);
}

function validateMatch(match) {
    for (const field of ['contentCount', 'commentCount', 'previewCount', 'rootIndex']) {
        if (!Number.isInteger(match[field]) || match[field] < 0) {
            throw new Error(`A find match needs a non-negative ${field}`);
        }
    }
    if (typeof match.noteId !== 'string' || typeof match.rootId !== 'string' || typeof match.isUnderFoldedNote !== 'boolean') {
        throw new Error('A find match needs noteId, rootId and isUnderFoldedNote');
    }
    if (match.previewCount > match.contentCount || occurrenceCount(match) === 0) {
        throw new Error('A find match must have occurrences, its preview no more than its content');
    }
    return { ...match };
}

// A new window joins the ones read: where it overlaps them, its matches are the newer.
function mergeWindow(window) {
    const merged = { first: window.first, end: window.end, matches: [...window.matches] };
    const kept = [];
    for (const existing of moduleState.windows) {
        if (existing.end < merged.first || existing.first > merged.end) {
            kept.push(existing);
            continue;
        }
        const outside = existing.matches.filter(match => match.rootIndex < window.first || match.rootIndex >= window.end);
        merged.first = Math.min(merged.first, existing.first);
        merged.end = Math.max(merged.end, existing.end);
        merged.matches.push(...outside);
    }
    // Stable: within a root the matches keep their list order.
    merged.matches.sort((first, second) => first.rootIndex - second.rootIndex);
    kept.push(merged);
    kept.sort((first, second) => first.first - second.first);
    update(moduleState, 'windows', kept);
}

async function readWindow(fromRootIndex, direction) {
    const generation = moduleState.generation;
    const answer = await NotesAPI.findInList({
        tabId: ModeContext.activeTabId,
        search: ModeContext.getExecutedSearchQuery(),
        isUntaggedView: ModeContext.isUntaggedView,
        text: moduleState.text,
        fromRootIndex,
        direction,
    });
    if (generation !== moduleState.generation) {
        return false;
    }
    if (!Array.isArray(answer.matches) || !Number.isInteger(answer.rootCount)) {
        throw new Error('A find answer needs matches and rootCount');
    }
    update(moduleState, 'rootCount', answer.rootCount);
    mergeWindow({ first: answer.firstRootIndex, end: answer.endRootIndex, matches: answer.matches.map(validateMatch) });
    return true;
}

function windowOf(rootIndex) {
    return moduleState.windows.find(window => window.first <= rootIndex && rootIndex < window.end);
}

function isListFullyRead() {
    return moduleState.windows.length === 1
        && moduleState.windows[0].first === 0
        && moduleState.windows[0].end === moduleState.rootCount;
}

// ---------------------------------------------------------------------------
// The page: where each occurrence is

function noteElementOf(noteId) {
    return document.querySelector(`#${NOTES_CONTAINER_ID} .${CONFIG.CLASSES.NOTE}[data-note-id="${CSS.escape(noteId)}"]`);
}

function directChild(element, className) {
    return Array.from(element.children).find(child => child.classList.contains(className));
}

// The note's occurrences on the page: in its content, then in its tag-bar comments.
function pageRangesOf(noteElement) {
    const phrases = [moduleState.text];
    const content = directChild(noteElement, CONFIG.CLASSES.NOTE_CONTENT);
    if (content === undefined) {
        throw new Error(`Note ${noteElement.dataset.noteId} has no content element`);
    }
    const tags = directChild(noteElement, 'note-tags');
    let commentRanges = [];
    if (tags !== undefined) {
        commentRanges = Array.from(tags.querySelectorAll(TAG_COMMENT_SELECTOR))
            .flatMap(comment => phraseRangesIn(comment, phrases));
    }
    return { content: phraseRangesIn(content, phrases), comments: commentRanges };
}

function isFolded(noteElement) {
    return noteElement.classList.contains('collapsed');
}

// The page is the truth for a note it shows whole: its counts there replace the
// server's. What shows when the note is folded again stays as the server said.
function syncCountsWithPage(match) {
    const noteElement = noteElementOf(match.noteId);
    if (noteElement === null || isFolded(noteElement)) {
        return;
    }
    const ranges = pageRangesOf(noteElement);
    update(match, 'contentCount', ranges.content.length);
    update(match, 'previewCount', Math.min(match.previewCount, ranges.content.length));
    update(match, 'commentCount', ranges.comments.length);
}

function dropEmptyMatches() {
    for (const window of moduleState.windows) {
        update(window, 'matches', window.matches.filter(match => occurrenceCount(match) > 0));
    }
}

// Whether an occurrence shows without opening anything.
function isShown(match, occurrence) {
    if (match.noteId === ModeContext.findRevealNoteId) {
        return true;
    }
    return isShownWithoutReveal(match, occurrence);
}

function pageRangeOf(match, occurrence) {
    const noteElement = noteElementOf(match.noteId);
    if (noteElement === null) {
        return null;
    }
    const ranges = pageRangesOf(noteElement);
    // A missing range means the page does not show that occurrence (a folded note).
    let place = { list: ranges.comments, index: occurrence - match.contentCount };
    if (occurrence < match.contentCount) {
        place = { list: ranges.content, index: occurrence };
    }
    if (place.index >= place.list.length) {
        return null;
    }
    return place.list[place.index];
}

// The usable screen for something on it: below the search controls, and below the find
// bar where it is under the bar (the bar covers only the right of the list's top).
function usableTopFor(rect) {
    const bar = barElement();
    const top = getViewportTopInset();
    if (bar === null || !moduleState.isOpen) {
        return top;
    }
    const barRect = bar.getBoundingClientRect();
    if (rect.right <= barRect.left || rect.left >= barRect.right) {
        return top;
    }
    return Math.max(top, Math.round(barRect.bottom + VIEWPORT_TOP_BUFFER_PX));
}

// Where an occurrence is on screen: its own text, or for one folded away the note that
// hides it (the note, or the folded note above it that is on the page).
function screenRectOf(match, occurrence) {
    if (isShown(match, occurrence)) {
        const range = pageRangeOf(match, occurrence);
        if (range !== null) {
            return range.getBoundingClientRect();
        }
    }
    let element = noteElementOf(match.noteId);
    if (element === null) {
        const root = noteElementOf(match.rootId);
        if (root === null) {
            return null;
        }
        element = root;
    }
    return element.getBoundingClientRect();
}

// ---------------------------------------------------------------------------
// Marks

function paint() {
    update(moduleState, 'isPaintRequested', false);
    if (!moduleState.isOpen || moduleState.text.trim() === '') {
        CSS.highlights.delete(MARK_HIGHLIGHT);
        CSS.highlights.delete(CURRENT_HIGHLIGHT);
        return;
    }
    const marks = [];
    let currentRange = null;
    for (const match of allMatches()) {
        const noteElement = noteElementOf(match.noteId);
        if (noteElement === null) {
            continue;
        }
        const ranges = pageRangesOf(noteElement);
        marks.push(...ranges.content, ...ranges.comments);
        const current = moduleState.current;
        if (current !== null && current.noteId === match.noteId && isShown(match, current.occurrence)) {
            currentRange = pageRangeOf(match, current.occurrence);
        }
    }
    const markHighlight = new Highlight(...marks);
    markHighlight.priority = MARK_PRIORITY;
    CSS.highlights.set(MARK_HIGHLIGHT, markHighlight);
    if (currentRange === null) {
        CSS.highlights.delete(CURRENT_HIGHLIGHT);
    } else {
        const currentHighlight = new Highlight(currentRange);
        currentHighlight.priority = CURRENT_PRIORITY;
        CSS.highlights.set(CURRENT_HIGHLIGHT, currentHighlight);
    }
}

function requestPaint() {
    if (moduleState.isPaintRequested) {
        return;
    }
    update(moduleState, 'isPaintRequested', true);
    requestAnimationFrame(paint);
}

function watchList() {
    if (moduleState.observer !== null) {
        return;
    }
    moduleState.observer = new MutationObserver(() => {
        for (const match of allMatches()) {
            syncCountsWithPage(match);
        }
        dropEmptyMatches();
        renderCount();
        requestPaint();
    });
    moduleState.observer.observe(document.getElementById(NOTES_CONTAINER_ID), {
        subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'],
    });
}

function stopWatchingList() {
    if (moduleState.observer === null) {
        return;
    }
    moduleState.observer.disconnect();
    update(moduleState, 'observer', null);
}

// ---------------------------------------------------------------------------
// The bar

function ordinalOfCurrent() {
    let ordinal = 0;
    for (const match of allMatches()) {
        if (moduleState.current !== null && match.noteId === moduleState.current.noteId) {
            return ordinal + moduleState.current.occurrence + 1;
        }
        ordinal += occurrenceCount(match);
    }
    return 0;
}

function renderCount() {
    const bar = barElement();
    if (bar === null) {
        return;
    }
    const total = allMatches().reduce((sum, match) => sum + occurrenceCount(match), 0);
    let label = '';
    if (moduleState.text.trim() !== '') {
        if (total === 0 && isListFullyRead()) {
            label = 'No matches';
        } else if (total > 0) {
            const more = isListFullyRead() ? '' : '+';
            label = `${ordinalOfCurrent()} of ${total}${more}`;
        }
    }
    document.getElementById(COUNT_ID).textContent = label;
    const canMove = total > 0;
    for (const button of bar.querySelectorAll('[data-find-action="previous"], [data-find-action="next"]')) {
        if (button.disabled === canMove) {
            button.disabled = !canMove;
        }
    }
}

function placeBar(bar) {
    const controls = document.querySelector('.controls');
    if (controls === null) {
        throw new Error('The find bar sits under the search controls');
    }
    const rect = controls.getBoundingClientRect();
    bar.style.top = `${Math.round(rect.bottom + VIEWPORT_TOP_BUFFER_PX)}px`;
    bar.style.right = `${Math.round(document.documentElement.clientWidth - rect.right)}px`;
}

function createBar() {
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.className = 'find-in-list-bar';
    bar.setAttribute('role', 'search');
    bar.innerHTML = `
        <input id="${INPUT_ID}" type="text" placeholder="Find in list" aria-label="Find in list" autocomplete="off" spellcheck="false">
        <span id="${COUNT_ID}" class="find-in-list-count" aria-live="polite"></span>
        <button type="button" class="find-in-list-button" data-find-action="previous" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled>↑</button>
        <button type="button" class="find-in-list-button" data-find-action="next" aria-label="Next match" title="Next match (Enter)" disabled>↓</button>
        <button type="button" class="find-in-list-button" data-find-action="close" aria-label="Close find" title="Close (Escape)">×</button>
    `;
    bar.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('[data-find-action]') : null;
        if (button === null || button.disabled) {
            return;
        }
        const action = button.dataset.findAction;
        if (action === 'close') {
            void closeFindBar();
        } else if (action === 'next' || action === 'previous') {
            void moveToMatch(action);
        } else {
            throw new Error(`Unknown find action: ${action}`);
        }
    });
    bar.addEventListener('input', () => scheduleFind());
    document.body.appendChild(bar);
    return bar;
}

function scheduleFind() {
    if (moduleState.typingTimer !== null) {
        clearTimeout(moduleState.typingTimer);
    }
    moduleState.typingTimer = setTimeout(() => {
        update(moduleState, 'typingTimer', null);
        void CommandGate.runWhenFree('find.start', () => startFind(inputElement().value));
    }, TYPING_PAUSE_MS);
}

function onModeChange(property, value) {
    if (!moduleState.isOpen) {
        return;
    }
    // Editing a note ends the find; what it opened folds back with the next view.
    if (property === 'editing' && value === true) {
        void closeFindBar();
        return;
    }
    if (property === 'executedSearchQuery' || property === 'activeTab' || property === 'isUntaggedView') {
        scheduleFind();
    }
}

// Cmd/Ctrl+F: the bar opens (or, open, has its text selected). A note being edited is
// saved and left first (principle 6).
export async function openFindBar() {
    if (ModeContext.isEditing) {
        const { actionDeselectNote } = await import('../actions/selection-actions.js');
        await CommandGate.runWhenFree('find.leave-edit', () => actionDeselectNote());
    }
    let bar = barElement();
    if (bar === null) {
        bar = createBar();
    }
    placeBar(bar);
    if (!moduleState.isOpen) {
        update(moduleState, 'isOpen', true);
        bar.hidden = false;
        ModeContext.addListener(onModeChange);
        watchList();
    }
    const input = inputElement();
    input.focus();
    input.select();
    renderCount();
}

// Escape, ×, or editing a note: the marks go, and a note find opened folds back.
export async function closeFindBar() {
    if (!moduleState.isOpen) {
        return;
    }
    update(moduleState, 'isOpen', false);
    moduleState.generation += 1;
    update(moduleState, 'windows', []);
    update(moduleState, 'current', null);
    if (moduleState.typingTimer !== null) {
        clearTimeout(moduleState.typingTimer);
        update(moduleState, 'typingTimer', null);
    }
    ModeContext.removeListener(onModeChange);
    stopWatchingList();
    const bar = barElement();
    bar.hidden = true;
    if (bar.contains(document.activeElement)) {
        document.activeElement.blur();
    }
    paint();
    if (ModeContext.findRevealNoteId !== null) {
        ModeContext.setFindRevealNoteId(null);
        if (!ModeContext.isEditing) {
            await CommandGate.runWhenFree('find.close', () => refreshView(null));
        }
    }
}

// ---------------------------------------------------------------------------
// Finding and moving

async function refreshView(anchorRootId) {
    const { actionRefreshAndMaybeSelect } = await import('../actions/ui-actions.js');
    const options = { context: 'find', requireExecution: true, animateNoteChanges: false };
    if (anchorRootId !== null) {
        options.visibleRootAnchorId = anchorRootId;
    }
    await actionRefreshAndMaybeSelect(options);
}

function topVisibleRootIndex() {
    const topRootId = ModeContext.getVisibleRootRange().topRootId;
    if (topRootId === null) {
        return 0;
    }
    const index = ModeContext.getLoadedRootIndex(topRootId);
    if (index === -1) {
        return ModeContext.getRootWindowStart();
    }
    return index;
}

// Typing: the first match at or below the top of the usable screen becomes the current
// one, else (none below) the first in the list.
async function startFind(text) {
    moduleState.generation += 1;
    update(moduleState, 'text', text);
    update(moduleState, 'windows', []);
    update(moduleState, 'current', null);
    update(moduleState, 'contextKey', contextKeyNow());
    if (text.trim() === '') {
        renderCount();
        paint();
        await showCurrent(null);
        return;
    }
    const fromRootIndex = topVisibleRootIndex();
    const generation = moduleState.generation;
    const wereRead = await Promise.all([readWindow(fromRootIndex, 'forward'), readWindow(fromRootIndex, 'backward')]);
    if (!wereRead.every(Boolean) || generation !== moduleState.generation) {
        return;
    }
    let target = null;
    for (const match of allMatches().filter(candidate => candidate.rootIndex >= fromRootIndex)) {
        for (let occurrence = 0; occurrence < occurrenceCount(match) && target === null; occurrence += 1) {
            const rect = screenRectOf(match, occurrence);
            if (rect === null || rect.top >= usableTopFor(rect)) {
                target = { noteId: match.noteId, occurrence };
            }
        }
        if (target !== null) {
            break;
        }
    }
    let placement = 'nearest';
    if (target === null) {
        target = await firstOfList();
        placement = 'above';
    }
    update(moduleState, 'current', target);
    renderCount();
    await showCurrent(placement);
}

async function firstOfList() {
    if (moduleState.windows.length === 0 || moduleState.windows[0].first > 0) {
        await readWindow(0, 'forward');
    }
    const first = allMatches()[0];
    if (first === undefined) {
        return null;
    }
    return { noteId: first.noteId, occurrence: 0 };
}

async function lastOfList() {
    const windows = moduleState.windows;
    if (windows.length === 0 || windows[windows.length - 1].end < moduleState.rootCount) {
        await readWindow(moduleState.rootCount, 'backward');
    }
    const matches = allMatches();
    const last = matches[matches.length - 1];
    if (last === undefined) {
        return null;
    }
    return { noteId: last.noteId, occurrence: occurrenceCount(last) - 1 };
}

function currentMatch() {
    if (moduleState.current === null) {
        return null;
    }
    const match = allMatches().find(candidate => candidate.noteId === moduleState.current.noteId);
    if (match === undefined) {
        return null;
    }
    return match;
}

// The occurrence after (or before) the current one, reading the next window when the
// read ones end there; wrapping at the list's ends. Returns {target, placement}.
async function neighbourOf(direction) {
    const match = currentMatch();
    if (match === null) {
        if (direction === 'next') {
            return { target: await firstOfList(), placement: 'above' };
        }
        return { target: await lastOfList(), placement: 'below' };
    }
    const occurrence = moduleState.current.occurrence;
    if (direction === 'next' && occurrence + 1 < occurrenceCount(match)) {
        return { target: { noteId: match.noteId, occurrence: occurrence + 1 }, placement: 'nearest' };
    }
    if (direction === 'previous' && occurrence > 0) {
        return { target: { noteId: match.noteId, occurrence: occurrence - 1 }, placement: 'nearest' };
    }
    let window = windowOf(match.rootIndex);
    let index = window.matches.indexOf(match);
    if (direction === 'next') {
        while (index + 1 >= window.matches.length) {
            if (window.end >= moduleState.rootCount) {
                return { target: await firstOfList(), placement: 'above' };
            }
            const end = window.end;
            if (!await readWindow(end, 'forward')) {
                return { target: null, placement: 'nearest' };
            }
            window = windowOf(match.rootIndex);
            index = window.matches.indexOf(match);
            if (window.end === end) {
                throw new Error('A forward find step read nothing');
            }
        }
        const next = window.matches[index + 1];
        return { target: { noteId: next.noteId, occurrence: 0 }, placement: 'below' };
    }
    while (index === 0) {
        if (window.first === 0) {
            return { target: await lastOfList(), placement: 'below' };
        }
        const first = window.first;
        if (!await readWindow(first, 'backward')) {
            return { target: null, placement: 'nearest' };
        }
        window = windowOf(match.rootIndex);
        index = window.matches.indexOf(match);
        if (window.first === first) {
            throw new Error('A backward find step read nothing');
        }
    }
    const previous = window.matches[index - 1];
    return { target: { noteId: previous.noteId, occurrence: occurrenceCount(previous) - 1 }, placement: 'above' };
}

// Enter / Cmd+G (next), Shift+Enter / Shift+Cmd+G (previous), or the bar's arrows.
export async function moveToMatch(direction) {
    if (direction !== 'next' && direction !== 'previous') {
        throw new Error(`moveToMatch direction must be next or previous, got ${direction}`);
    }
    if (!moduleState.isOpen) {
        return;
    }
    await CommandGate.runWhenFree(`find.${direction}`, async () => {
        if (moduleState.contextKey !== contextKeyNow() || moduleState.text !== inputElement().value) {
            await startFind(inputElement().value);
            return;
        }
        if (allMatches().length === 0) {
            return;
        }
        const { target, placement } = await neighbourOf(direction);
        if (target === null) {
            return;
        }
        update(moduleState, 'current', target);
        renderCount();
        await showCurrent(placement);
    });
}

// Puts the current match on screen. A match folded away opens its note (and the folded
// notes above it) for the view; moving elsewhere folds them back. In view, nothing
// moves; out of view, the minimum distance: below, to the window's bottom edge; above,
// to just below the find bar. A match not loaded yet arrives from where it was asked
// for (placement): below for the next one, above for the previous or a wrap.
async function showCurrent(placement) {
    const match = currentMatch();
    let reveal = null;
    if (match !== null && !isShownWithoutReveal(match, moduleState.current.occurrence)) {
        reveal = match.noteId;
    }
    let isLoaded = true;
    if (match !== null) {
        isLoaded = ModeContext.getLoadedRootIndex(match.rootId) !== -1;
    }
    await showView({ reveal, isLoaded, match });
    if (match === null) {
        paint();
        return;
    }
    syncCountsWithPage(match);
    renderCount();
    let range = pageRangeOf(match, moduleState.current.occurrence);
    if (range === null && reveal === null) {
        // The folded note's first line shows less than the server read in it: open it.
        await showView({ reveal: match.noteId, isLoaded: true, match });
        range = pageRangeOf(match, moduleState.current.occurrence);
    }
    if (range === null) {
        throw new Error(`Find could not show occurrence ${moduleState.current.occurrence} of note ${match.noteId}`);
    }
    // A loaded match is placed by where it is; one just loaded by where it was asked for,
    // at once: until it is placed the page shows the new notes' first one, and the list
    // would load more around that (infinite-scroll-service.js) and hold it still.
    if (isLoaded) {
        scrollToShow(range.getBoundingClientRect(), 'nearest', scrollWindowToYFastAnimated);
    } else {
        scrollToShow(range.getBoundingClientRect(), placementAfterLoad(placement), scrollWindowToYAtOnce);
    }
    paint();
}

// The view with the note find opens (null: none) and the match's root loaded.
async function showView({ reveal, isLoaded, match }) {
    if (reveal === ModeContext.findRevealNoteId && isLoaded) {
        return;
    }
    if (reveal !== ModeContext.findRevealNoteId) {
        ModeContext.setFindRevealNoteId(reveal);
    }
    let anchorRootId = null;
    if (!isLoaded) {
        anchorRootId = match.rootId;
    }
    await refreshView(anchorRootId);
}

function placementAfterLoad(placement) {
    if (placement === 'nearest') {
        return 'below';
    }
    return placement;
}

// Without the note find opened (if it is this one) the occurrence would show.
function isShownWithoutReveal(match, occurrence) {
    if (match.isUnderFoldedNote) {
        return false;
    }
    if (occurrence >= match.contentCount) {
        return true;
    }
    if (occurrence < match.previewCount) {
        return true;
    }
    return false;
}

function scrollWindowToYAtOnce(targetScrollY) {
    window.dispatchEvent(new Event(DELIBERATE_SCROLL_EVENT));
    window.scrollTo(0, targetScrollY);
}

function scrollToShow(rect, placement, scrollTo) {
    const top = usableTopFor(rect);
    const bottom = window.innerHeight;
    if (rect.top >= top && rect.bottom <= bottom) {
        return;
    }
    let delta = 0;
    if (placement === 'below') {
        delta = rect.bottom - bottom;
    } else if (placement === 'above') {
        delta = rect.top - top;
    } else if (rect.bottom > bottom) {
        delta = rect.bottom - bottom;
    } else {
        delta = rect.top - top;
    }
    if (delta === 0) {
        return;
    }
    scrollTo(Math.round(clampNumber(window.scrollY + delta, 0, getScrollMaxY())));
}
