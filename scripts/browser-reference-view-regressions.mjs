import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Reference views and the search bar's chips (docs/ui/references.md,
// docs/ui/controls.md). Following a reference, an embed's reference icon or an AI
// answer's references: the search input fades out and a chip grows in, centered in
// the bar; the column slides as one piece, left when going deeper and right when
// coming back; ← (or Escape) goes back one level and × all the way to the search,
// each to the exact place the user left. Reference views are kept with the tabs on
// the server, so a reload (or another window) shows them too. Sort orders (Reverse Order too) and
// Untagged show as chips inside the input. One check per agreed case, positions
// compared exactly. Notes are put in place with the mouse wheel, as a person scrolls.

const SETTLE_MS = 300;
// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;
const SEARCH = 'refview';
const FILLERS_ABOVE = 10;
const FILLERS_BELOW = 14;
const TARGET_CHILDREN = 24;
// The target's child that links on to the second target, far enough down to need a scroll.
const LINKING_CHILD_INDEX = 16;
// Where a note is brought on screen, with the wheel, before a reference is followed from it.
const NOTE_TOP_BEFORE_FOLLOWING_PX = 320;
const TARGET_TITLE = 'Reference view target whose first line runs long enough that a chip would cut it short';
const SECOND_TITLE = 'Second reference target';
const SOURCE_LABEL = 'Source note';
const SLIDE_MS = 250;
const REDUCED_MOTION_FADE_MS = 120;
// Firefox lays out at 1/60 px (Chrome at 1/64); centers computed from two boxes can
// differ by one layout unit and no more.
const LAYOUT_UNIT_PX = 1 / 60;
// The sort and Untagged chips end this far inside the input's right edge (main.css).
const INPUT_CHIPS_INSET_PX = 4;
// The input's own right padding, before the chips' width is added (main.css).
const INPUT_RIGHT_PADDING_PX = 12;
const HALF = 0.5;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
  await pause(SETTLE_MS);
}

async function createNotes(page) {
  return page.evaluate(async ({search, fillersAbove, fillersBelow, targetChildren, linkingChildIndex, targetTitle, secondTitle}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = {fillers: [], children: []};
    const make = async (html, tags) => {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, html, tags);
      return note.id;
    };
    // createNote(null, '') inserts at the top, so the list is built bottom-up.
    for (let index = fillersBelow; index >= 1; index -= 1) {
      ids.fillers.push(await make(`<p>Reference view filler below ${index}</p><p>second line</p><p>third line</p>`, search));
    }
    ids.second = await make(`<p>${secondTitle}</p><p>its second line</p>`, 'refother');
    ids.target = await make(`<p>${targetTitle}</p><p>the target's second line</p>`, search);
    for (let index = 1; index <= targetChildren; index += 1) {
      const child = await NotesAPI.createChild(ids.target, '');
      const html = index === linkingChildIndex
        ? `<p>Target child ${index} links to [[${ids.second}]] in its text</p><p>more</p>`
        : `<p>Target child ${index}</p><p>second line</p><p>third line</p>`;
      await NotesAPI.saveNote(child.id, html, '');
      ids.children.push(child.id);
      if (index === linkingChildIndex) ids.linkingChild = child.id;
    }
    ids.holder = await make(`<p>Holder links to [[${ids.target}]] in its text</p><p>second line</p>`, search);
    for (let index = fillersAbove; index >= 1; index -= 1) {
      ids.fillers.push(await make(`<p>Reference view filler above ${index}</p><p>second line</p><p>third line</p>`, search));
    }
    return ids;
  }, {search: SEARCH, fillersAbove: FILLERS_ABOVE, fillersBelow: FILLERS_BELOW, targetChildren: TARGET_CHILDREN,
    linkingChildIndex: LINKING_CHILD_INDEX, targetTitle: TARGET_TITLE, secondTitle: SECOND_TITLE});
}

// Records, in the page, every reference transition the moment it plays: the column
// animations, the bar's state and the input's text. Survives reloads.
async function installTransitionRecorder(page) {
  const recorder = () => {
    window.__referenceTransitions = [];
    const record = () => {
      const state = document.documentElement.dataset.referenceTransition;
      if (state === undefined) return;
      const describe = element => (element === null ? [] : element.getAnimations()
        .filter(animation => animation.constructor.name === 'Animation')
        .map(animation => ({
          keyframes: animation.effect.getKeyframes().map(frame => (frame.transform === undefined
            ? {opacity: Number(frame.opacity)} : {transform: frame.transform})),
          duration: animation.effect.getTiming().duration,
        })));
      const row = document.querySelector('.controls .search-input-row');
      window.__referenceTransitions.push({
        state,
        ghost: describe(document.querySelector('.reference-slide-ghost')),
        column: describe(document.getElementById('notes-container')),
        isChipAnimating: row.classList.contains('is-chip-animating'),
        isChipShown: document.getElementById('reference-source-indicator').classList.contains('is-shown'),
        inputValue: document.getElementById('search-input').value,
        windowWidth: window.innerWidth,
      });
    };
    new MutationObserver(record).observe(document, {
      attributes: true, subtree: true, attributeFilter: ['data-reference-transition'],
    });
  };
  await page.evaluateOnNewDocument(recorder);
  await page.evaluate(recorder);
}

async function transitionCount(page) {
  return page.evaluate(() => window.__referenceTransitions.length);
}

// Runs the action, waits for the reference transition it starts to finish, and returns
// what was recorded as it played.
async function navigate(page, action) {
  const before = await transitionCount(page);
  await action();
  await page.waitForFunction(count => window.__referenceTransitions.length > count
      && document.documentElement.dataset.referenceTransition === undefined
      && document.querySelector('.reference-slide-ghost') === null,
  {}, before);
  await idle(page);
  const records = await page.evaluate(count => window.__referenceTransitions.slice(count), before);
  const playing = records.filter(record => record.state === 'playing');
  assert.equal(playing.length, 1, 'one transition played');
  return playing[0];
}

function expectSlide(record, direction, label) {
  const width = record.windowWidth;
  const outgoing = direction === 'forward' ? -width : width;
  assert.deepEqual(record.ghost, [{keyframes: [{transform: 'translateX(0px)'}, {transform: `translateX(${outgoing}px)`}],
    duration: SLIDE_MS}], `${label}: the old column slides ${direction === 'forward' ? 'left' : 'right'} as one piece`);
  assert.deepEqual(record.column, [{keyframes: [{transform: `translateX(${-outgoing}px)`}, {transform: 'translateX(0px)'}],
    duration: SLIDE_MS}], `${label}: the new column slides in from the ${direction === 'forward' ? 'right' : 'left'}`);
}

function expectSameSpot(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= LAYOUT_UNIT_PX, `${label}: ${actual} is ${expected}`);
}

// Types the search and lets it run; never Enter, which on a search already run adds a note.
async function searchFor(page, query) {
  await page.click('#search-input', {clickCount: 3});
  await page.keyboard.type(query);
  await idle(page);
}

async function notePlace(page, noteId) {
  return page.evaluate(noteId => {
    const note = document.querySelector(`#notes-container .note[data-note-id="${noteId}"]`);
    return {scrollY: window.scrollY, top: note.getBoundingClientRect().top};
  }, noteId);
}

// Brings the note near the given height with the mouse wheel, as a person scrolls,
// and returns exactly where it ended up.
async function wheelNoteTo(page, noteId, top) {
  const {top: current} = await notePlace(page, noteId);
  const viewport = page.viewport();
  await page.mouse.move(viewport.width * HALF, viewport.height * HALF);
  await page.mouse.wheel({deltaY: Math.round(current - top)});
  await page.waitForFunction(() => new Promise(resolve => {
    const y = window.scrollY;
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY === y)));
  }));
  await idle(page);
  return notePlace(page, noteId);
}

async function clickReferenceLink(page, holderId, targetId) {
  await page.click(`#notes-container .note[data-note-id="${holderId}"] > .note-content `
    + `.note-reference-link[data-ref-note-id="${targetId}"] .note-reference-link-title`);
}

// The bar, the column and the view as they are now.
async function barState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {isViewingReferenceSource} = await import('/static/js/modules/mode-manager/services/reference-source-navigation-service.js');
    const box = element => {
      const rect = element.getBoundingClientRect();
      return {left: rect.left, top: rect.top, right: rect.right, width: rect.width, height: rect.height,
        centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2};
    };
    const chip = document.getElementById('reference-source-indicator');
    const label = document.getElementById('reference-source-indicator-label');
    const icon = document.getElementById('reference-view-chip-icon');
    const input = document.getElementById('search-input');
    const back = document.getElementById('reference-view-chip-back');
    const clear = document.getElementById('reference-source-indicator-clear');
    const newSearch = document.getElementById('reference-view-new-search');
    const row = document.querySelector('.controls .search-input-row');
    const column = document.getElementById('notes-container');
    const roots = [...column.children].filter(node => node.matches('.note[data-note-id]'))
      .map(node => node.dataset.noteId);
    return {
      isReferenceView: isViewingReferenceSource(),
      searchQuery: mode.searchQuery,
      tabCount: mode.tabOrder.length,
      activeTabId: mode.activeTabId,
      chipShown: chip.classList.contains('is-shown'),
      chipVisibility: getComputedStyle(chip).visibility,
      chipOpacity: getComputedStyle(chip).opacity,
      chip: box(chip),
      chipChildren: [...chip.children].map(child => child.id),
      label: label.textContent,
      labelTitle: label.getAttribute('title'),
      icon: icon.hidden ? 'none' : (icon.classList.contains('is-several-notes') ? 'several' : 'one'),
      backShown: !back.hidden && getComputedStyle(back).display !== 'none',
      backTitle: back.getAttribute('title'),
      clearTitle: clear.getAttribute('title'),
      newSearchTitle: newSearch.getAttribute('title'),
      newSearchVisible: getComputedStyle(newSearch).visibility === 'visible',
      newSearch: box(newSearch),
      emptyIcon: box(document.querySelector('.search-input-empty-icon')),
      inputValue: input.value,
      inputOpacity: getComputedStyle(input).opacity,
      inputVisibility: getComputedStyle(input).visibility,
      inputFocused: document.activeElement === input,
      input: box(input),
      row: box(row),
      rowAnimating: row.classList.contains('is-chip-animating'),
      column: box(column),
      columnTransform: getComputedStyle(column).transform,
      columnVisibility: getComputedStyle(column).visibility,
      ghosts: document.querySelectorAll('.reference-slide-ghost').length,
      isSliding: document.documentElement.classList.contains('reference-sliding'),
      roots,
      scrollY: window.scrollY,
    };
  });
}

function expectChipCentered(state, label) {
  expectSameSpot(state.chip.centerX, state.row.centerX, `${label}: the chip is centered in the bar`);
  expectSameSpot(state.chip.centerY, state.input.centerY, `${label}: the chip sits on the input's line`);
}

function expectReferenceBar(state, expected, label) {
  assert.equal(state.isReferenceView, true, `${label}: a reference view`);
  assert.equal(state.chipShown, true, `${label}: the chip shows`);
  assert.equal(state.chipVisibility, 'visible', `${label}: the chip is visible`);
  assert.equal(state.chipOpacity, '1', `${label}: the chip is fully grown in`);
  assert.equal(state.label, expected.label, `${label}: the chip's label`);
  assert.equal(state.icon, expected.icon, `${label}: the chip's icon`);
  assert.equal(state.backShown, expected.hasBack, `${label}: the chip ${expected.hasBack ? 'has' : 'has no'} ←`);
  assert.equal(state.inputOpacity, '0', `${label}: the search input is faded out`);
  assert.equal(state.inputVisibility, 'hidden', `${label}: the search input takes no clicks`);
  assert.equal(state.inputValue, '', `${label}: the hidden input is empty, never a note ID`);
  assert.equal(state.newSearchVisible, true, `${label}: the magnifier shows`);
  expectChipCentered(state, label);
  expectSettled(state, label);
}

const SOURCE_BAR = {label: SOURCE_LABEL, icon: 'one', hasBack: false};

function expectSearchBar(state, query, label) {
  assert.equal(state.isReferenceView, false, `${label}: back at the search`);
  assert.equal(state.searchQuery, query, `${label}: the search is the one the user typed`);
  assert.equal(state.chipShown, false, `${label}: no chip`);
  assert.equal(state.chipVisibility, 'hidden', `${label}: the chip is gone`);
  assert.equal(state.inputValue, query, `${label}: the input shows the search`);
  assert.equal(state.inputOpacity, '1', `${label}: the input has faded back in`);
  assert.equal(state.inputVisibility, 'visible', `${label}: the input is visible`);
  assert.equal(state.newSearchVisible, false, `${label}: no magnifier button`);
  expectSettled(state, label);
}

function expectSettled(state, label) {
  assert.equal(state.ghosts, 0, `${label}: the old column's copy is gone`);
  assert.equal(state.isSliding, false, `${label}: the page no longer clips the slide`);
  assert.equal(state.columnTransform, 'none', `${label}: the column is back in place`);
  assert.equal(state.columnVisibility, 'visible', `${label}: the column is visible`);
  assert.equal(state.rowAnimating, false, `${label}: the bar is no longer animating`);
}

async function setAnimatedTransitions(page, isOn) {
  await page.evaluate(async isOn => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.applyPreference('pref.animated_transitions', isOn);
  }, isOn);
}

async function setSortMode(page, sortMode) {
  await page.evaluate(async sortMode => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.setSortMode(sortMode);
  }, sortMode);
  await idle(page);
}

async function setUntagged(page, isUntagged) {
  await page.evaluate(async isUntagged => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.setIsUntaggedView(isUntagged);
  }, isUntagged);
  await idle(page);
}

// Stands in for an AI answer's references (an AI provider is not set up in tests):
// the same markup the answer renders, fixed at the window's bottom left.
async function addAiReference(page, id, html) {
  await page.evaluate(({id, html}) => {
    document.getElementById(id)?.remove();
    const holder = document.createElement('div');
    holder.id = id;
    holder.className = 'ai-chat-message-content';
    holder.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:20000;background:#fff;padding:4px';
    holder.innerHTML = html;
    document.body.append(holder);
  }, {id, html});
}

async function tabLabels(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return [...document.querySelectorAll('#search-contexts-list .tab-context-item')].map(item => ({
      tabId: item.dataset.tabId,
      label: item.querySelector('.tab-context-query').textContent,
      icon: item.querySelector('.tab-context-reference-icon') === null ? 'none'
        : (item.querySelector('.tab-context-reference-icon').classList.contains('is-several-notes') ? 'several' : 'one'),
      isActive: item.dataset.tabId === mode.activeTabId,
    }));
  });
}

async function clickTab(page, tabId) {
  const zone = await (await page.$('#tab-hover-zone')).boundingBox();
  await page.mouse.move(zone.x + zone.width * HALF, zone.y + zone.height * HALF);
  const item = `#search-contexts-list .tab-context-item[data-tab-id="${tabId}"] .tab-context-query`;
  await page.waitForSelector(item, {visible: true});
  await pause(SETTLE_MS);
  await page.click(item);
  await idle(page);
}

async function showTabs(page, isShown) {
  await page.evaluate(async isShown => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.applyPreference('pref.show_tab_ui', isShown);
  }, isShown);
}

// Case 1 (and "where the target lands is unchanged"): a reference followed from the search.
async function checkFollowFromSearch(page, ids) {
  // Where the target lands with no motion, the way it has always landed.
  await setAnimatedTransitions(page, false);
  const stillLeft = await wheelNoteTo(page, ids.holder, NOTE_TOP_BEFORE_FOLLOWING_PX);
  await clickReferenceLink(page, ids.holder, ids.target);
  await page.waitForFunction(() => document.getElementById('reference-source-indicator').classList.contains('is-shown'));
  await idle(page);
  const stillLanding = await notePlace(page, ids.target);
  await page.click('#reference-source-indicator-clear');
  await page.waitForFunction(() => !document.getElementById('reference-source-indicator').classList.contains('is-shown'));
  await idle(page);
  assert.deepEqual(await notePlace(page, ids.holder), stillLeft, 'with no motion, × returns to the exact place');
  await setAnimatedTransitions(page, true);

  const left = await wheelNoteTo(page, ids.holder, NOTE_TOP_BEFORE_FOLLOWING_PX);
  const before = await barState(page);
  const played = await navigate(page, () => clickReferenceLink(page, ids.holder, ids.target));
  expectSlide(played, 'forward', 'follow from the search');
  assert.equal(played.isChipAnimating, true, 'follow from the search: the chip grows in as the column slides');
  assert.equal(played.isChipShown, true, 'follow from the search: the chip appears with the slide');
  assert.equal(played.inputValue, SEARCH, 'follow from the search: the input fades out with its text');
  const after = await barState(page);
  expectReferenceBar(after, SOURCE_BAR, 'follow from the search');
  assert.deepEqual(await notePlace(page, ids.target), stillLanding, 'the target lands where it always has');
  assert.equal(after.column.left, before.column.left, 'the column ends where it was, side to side');
  // The note's first line is the label's tooltip.
  assert.equal(after.labelTitle, TARGET_TITLE, 'the source note\'s first line is the tooltip');
  // Tooltips only, and no other text.
  assert.deepEqual(after.chipChildren, ['reference-view-chip-back', 'reference-view-chip-icon',
    'reference-source-indicator-label', 'reference-source-indicator-clear'], 'the chip holds ←, its icon, its label and ×');
  assert.equal(after.clearTitle, 'Back to your search', '× says where it goes');
  assert.equal(after.backTitle, 'Back', '← says Back');
  assert.equal(after.newSearchTitle, null, 'the magnifier has no tooltip');
  return left;
}

// Case 5 at the first level: × back to the search, where the user left it.
async function checkCloseToSearch(page, ids, left, label) {
  const played = await navigate(page, () => page.click('#reference-source-indicator-clear'));
  expectSlide(played, 'back', label);
  assert.equal(played.isChipAnimating, true, `${label}: the chip leaves as the column slides`);
  assert.equal(played.inputValue, SEARCH, `${label}: the input fades in with its text`);
  const after = await barState(page);
  expectSearchBar(after, SEARCH, label);
  assert.deepEqual(await notePlace(page, ids.holder), left, `${label}: the search is at the exact place the user left it`);
  return after;
}

// Cases 3, 4 and 5: deeper, back one level (← and Escape), and × from two levels down.
async function checkStack(page, ids) {
  const left = await wheelNoteTo(page, ids.holder, NOTE_TOP_BEFORE_FOLLOWING_PX);
  const searchTabs = (await barState(page)).tabCount;
  await navigate(page, () => clickReferenceLink(page, ids.holder, ids.target));
  const atLink = await wheelNoteTo(page, ids.linkingChild, NOTE_TOP_BEFORE_FOLLOWING_PX);
  assert.ok(atLink.scrollY > 0, 'the linking child is far enough down to need a scroll');

  // Case 3: following again slides left once more; the chip shows the new target and a ←.
  const deeper = await navigate(page, () => clickReferenceLink(page, ids.linkingChild, ids.second));
  expectSlide(deeper, 'forward', 'follow again');
  const deeperBar = await barState(page);
  expectReferenceBar(deeperBar, {...SOURCE_BAR, hasBack: true}, 'follow again');
  assert.equal(deeperBar.labelTitle, SECOND_TITLE, 'follow again: the new source note is the tooltip');

  // Case 4: ← goes back one level, to the exact scroll position.
  const backed = await navigate(page, () => page.click('#reference-view-chip-back'));
  expectSlide(backed, 'back', '←');
  expectReferenceBar(await barState(page), SOURCE_BAR, '←');
  assert.deepEqual(await notePlace(page, ids.linkingChild), atLink, '←: exactly where the user left the first level');

  // Case 4: Escape (not editing, no dialog) does the same.
  await navigate(page, () => clickReferenceLink(page, ids.linkingChild, ids.second));
  const escaped = await navigate(page, () => page.keyboard.press('Escape'));
  expectSlide(escaped, 'back', 'Escape');
  expectReferenceBar(await barState(page), SOURCE_BAR, 'Escape');
  assert.deepEqual(await notePlace(page, ids.linkingChild), atLink, 'Escape: exactly where the user left the first level');

  // Case 5: × from two levels down goes straight back to the search, in one slide.
  await navigate(page, () => clickReferenceLink(page, ids.linkingChild, ids.second));
  const after = await checkCloseToSearch(page, ids, left, '× from two levels down');
  assert.equal(after.tabCount, searchTabs, '× closes every reference view it leaves');
}

// Cases 2 and 6: an AI answer's references, then one of them; the same again does nothing.
async function checkAiReferences(page, ids) {
  const left = await wheelNoteTo(page, ids.holder, NOTE_TOP_BEFORE_FOLLOWING_PX);
  await addAiReference(page, 'test-ai-open-all',
    `<a href="#" class="ai-chat-open-all-references" data-ref-query="${ids.target} OR ${ids.second}">Open all references</a>`);
  const opened = await navigate(page, () => page.click('#test-ai-open-all .ai-chat-open-all-references'));
  expectSlide(opened, 'forward', 'Show all references');
  assert.equal(opened.isChipAnimating, true, 'Show all references: the chip grows in');
  const references = await barState(page);
  expectReferenceBar(references, {label: 'All references', icon: 'several', hasBack: false}, 'Show all references');
  assert.equal(references.labelTitle, null, 'All references has no tooltip');
  assert.deepEqual(references.roots.toSorted(), [ids.target, ids.second].toSorted(), 'both cited notes are shown');

  // The same references again, while they are shown: nothing happens.
  const transitionsBefore = await transitionCount(page);
  await page.click('#test-ai-open-all .ai-chat-open-all-references');
  await idle(page);
  const again = await barState(page);
  assert.equal(await transitionCount(page), transitionsBefore, 'the references already shown: no transition');
  assert.deepEqual({tab: again.activeTabId, tabs: again.tabCount, label: again.label, roots: again.roots},
    {tab: references.activeTabId, tabs: references.tabCount, label: 'All references', roots: references.roots},
    'the references already shown: nothing changes');

  // Case 6: one AI reference replaces the view, sliding in from the right, with no new level.
  await addAiReference(page, 'test-ai-reference',
    `<ul><li data-ref-query="${ids.second}"><a href="#" class="note-reference-link"><span>AI reference</span></a></li></ul>`);
  const replaced = await navigate(page, () => page.click('#test-ai-reference .note-reference-link'));
  expectSlide(replaced, 'forward', 'one AI reference');
  assert.equal(replaced.isChipShown, true, 'one AI reference: the chip stays');
  const after = await barState(page);
  expectReferenceBar(after, {label: 'Reference', icon: 'one', hasBack: false}, 'one AI reference');
  assert.equal(after.tabCount, references.tabCount, 'one AI reference adds no level');
  assert.deepEqual(after.roots, [ids.second], 'the reference replaced the view');
  await page.evaluate(() => {
    document.getElementById('test-ai-open-all').remove();
    document.getElementById('test-ai-reference').remove();
  });
  await checkCloseToSearch(page, ids, left, '× from AI references');
}

// Case 7: the magnifier starts a new search; typing works as it always has.
async function checkNewSearch(page, ids) {
  await navigate(page, () => clickReferenceLink(page, ids.holder, ids.target));
  const inView = await barState(page);
  expectSameSpot(inView.newSearch.centerX, inView.emptyIcon.centerX, 'the magnifier sits where the input\'s begins');
  expectSameSpot(inView.newSearch.centerY, inView.emptyIcon.centerY, 'the magnifier is on the input\'s line');
  await page.click('#reference-view-new-search');
  const opened = await barState(page);
  assert.equal(opened.chipShown, false, 'magnifier: the chip gives way');
  assert.equal(opened.inputVisibility, 'visible', 'magnifier: the input is back');
  assert.equal(opened.inputOpacity, '1', 'magnifier: the input is back');
  assert.equal(opened.inputValue, '', 'magnifier: the input is empty');
  assert.equal(opened.inputFocused, true, 'magnifier: the input is focused');
  assert.equal(opened.isReferenceView, true, 'magnifier: the view stays until the user types');
  // Leaving the empty input brings the chip back.
  await page.evaluate(() => document.getElementById('search-input').blur());
  expectReferenceBar(await barState(page), SOURCE_BAR, 'leaving the empty input');
  await page.click('#reference-view-new-search');
  await page.keyboard.type(SEARCH);
  await idle(page);
  const typed = await barState(page);
  expectSearchBar(typed, SEARCH, 'typing a new search');
  assert.equal(typed.inputFocused, true, 'typing a new search: the input keeps the focus');
  assert.equal(typed.roots.includes(ids.holder), true, 'the new search shows its notes');
}

// Case 10: with Reduce Motion, a quick fade instead of the slide.
async function checkReducedMotion(page, ids) {
  const left = await wheelNoteTo(page, ids.holder, NOTE_TOP_BEFORE_FOLLOWING_PX);
  await page.emulateMediaFeatures([{name: 'prefers-reduced-motion', value: 'reduce'}]);
  const played = await navigate(page, () => clickReferenceLink(page, ids.holder, ids.target));
  const fade = [{keyframes: [{opacity: 1}, {opacity: 0}], duration: REDUCED_MOTION_FADE_MS}];
  assert.deepEqual(played.ghost, fade, 'reduce motion: the old column fades out');
  assert.deepEqual(played.column, [{keyframes: [{opacity: 0}, {opacity: 1}], duration: REDUCED_MOTION_FADE_MS}],
    'reduce motion: the new column fades in, without moving');
  expectReferenceBar(await barState(page), SOURCE_BAR, 'reduce motion');
  const closed = await navigate(page, () => page.click('#reference-source-indicator-clear'));
  assert.deepEqual(closed.ghost, fade, 'reduce motion: × fades too');
  expectSearchBar(await barState(page), SEARCH, 'reduce motion: back at the search');
  assert.deepEqual(await notePlace(page, ids.holder), left, 'reduce motion: the search is where the user left it');
  await page.emulateMediaFeatures([{name: 'prefers-reduced-motion', value: 'no-preference'}]);
}

// Case 11, and reference views kept with the tabs: no animation on a reload, a tab
// switch, or opening a tab already in a reference view; another window labels them too.
async function checkNoAnimationWithoutNavigation(page, ids) {
  await showTabs(page, true);
  const searchTabId = (await barState(page)).activeTabId;
  await navigate(page, () => clickReferenceLink(page, ids.holder, ids.target));
  const shown = await barState(page);
  const referenceTabId = shown.activeTabId;
  const expectedTabs = await tabLabels(page);
  assert.deepEqual(expectedTabs.find(tab => tab.tabId === referenceTabId),
    {tabId: referenceTabId, label: SOURCE_LABEL, icon: 'one', isActive: true}, 'the reference view\'s tab says Source note, with its icon');
  assert.ok(expectedTabs.every(tab => !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(tab.label)), 'no tab is named by a note ID');

  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  assert.deepEqual(await page.evaluate(() => window.__referenceTransitions), [], 'a reload plays no transition');
  const reloaded = await barState(page);
  expectReferenceBar(reloaded, SOURCE_BAR, 'after a reload');
  assert.deepEqual(reloaded.chip, shown.chip, 'after a reload the chip is exactly where it was');

  await clickTab(page, searchTabId);
  expectSearchBar(await barState(page), SEARCH, 'switched to the search tab');
  await clickTab(page, referenceTabId);
  const reopened = await barState(page);
  expectReferenceBar(reopened, SOURCE_BAR, 'opening a tab already in a reference view');
  assert.deepEqual(reopened.chip, shown.chip, 'the reopened tab\'s chip is exactly where it was');
  assert.deepEqual(await page.evaluate(() => window.__referenceTransitions), [], 'tab switches play no transition');

  // The view came back from the server's tab state, not from this window: nothing
  // about it is kept in the window's session storage, so another window shows it too.
  assert.equal(await page.evaluate(() => sessionStorage.getItem('metalist_reference_navigation_stack')), null,
    'no reference view is kept in the window');
  assert.deepEqual(await tabLabels(page), expectedTabs, 'after a reload the tabs are labeled the same way');

  await navigate(page, () => page.click('#reference-source-indicator-clear'));
  await showTabs(page, false);
}

async function inputChipsState(page) {
  return page.evaluate(() => {
    const chip = id => {
      const element = document.getElementById(id);
      const rect = element.getBoundingClientRect();
      return {
        shown: element.classList.contains('is-shown'),
        animating: element.classList.contains('is-growing') || element.classList.contains('is-leaving'),
        label: element.querySelector('.search-input-chip-label').textContent,
        title: element.querySelector('.search-input-chip-label').getAttribute('title'),
        left: rect.left, right: rect.right,
      };
    };
    const input = document.getElementById('search-input');
    const chips = document.querySelector('.controls .search-input-chips');
    return {
      untagged: chip('untagged-view-indicator'),
      sort: chip('root-sort-indicator'),
      inputRight: input.getBoundingClientRect().right,
      inputPaddingRight: getComputedStyle(input).paddingRight,
      chipsLeft: chips.getBoundingClientRect().left,
      chipsWidth: chips.offsetWidth,
    };
  });
}

// Sort orders (Reverse Order too) and Untagged: chips at the right end inside the input.
async function checkInputChips(page) {
  await setSortMode(page, 'alphabetical');
  let chips = await inputChipsState(page);
  assert.equal(chips.sort.shown, true, 'a sort order shows its chip');
  assert.deepEqual([chips.sort.label, chips.sort.title], ['A–Z', 'Sorted alphabetically'], 'short label, full name as tooltip');
  expectSameSpot(chips.sort.right, chips.inputRight - INPUT_CHIPS_INSET_PX, 'the chip ends just inside the input\'s right edge');
  assert.equal(chips.inputPaddingRight, `${INPUT_RIGHT_PADDING_PX + chips.chipsWidth}px`, 'the typed text stops before the chips');

  await setSortMode(page, 'alphabetical-reversed');
  chips = await inputChipsState(page);
  assert.deepEqual([chips.sort.label, chips.sort.title], ['Z–A', 'Sorted alphabetically, Z to A'], 'Reverse Order shows Z–A');
  await setSortMode(page, 'created-reversed');
  chips = await inputChipsState(page);
  assert.deepEqual([chips.sort.label, chips.sort.title], ['Created ↑', 'Sorted by datetime created, oldest first'],
    'a reversed date order starts from the oldest');

  await setUntagged(page, true);
  chips = await inputChipsState(page);
  assert.equal(chips.untagged.shown, true, 'Untagged shows its chip');
  assert.ok(chips.untagged.right <= chips.sort.left, 'Untagged comes first, before the sort');
  assert.equal(chips.inputPaddingRight, `${INPUT_RIGHT_PADDING_PX + chips.chipsWidth}px`, 'the text stops before both chips');

  // A reload shows the chips as they are, without growing them in.
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  chips = await inputChipsState(page);
  assert.deepEqual([chips.sort.shown, chips.sort.animating], [true, false], 'after a reload the sort chip is simply there');

  // × on the sort chip returns to Normal, not reversed.
  await page.click('#root-sort-indicator-clear');
  await idle(page);
  assert.equal(await page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.activeTabSortMode;
  }), 'normal', '× ends the sort order and its direction');

  // Typing a new search ends the sort and Untagged.
  await setSortMode(page, 'alphabetical');
  await searchFor(page, SEARCH);
  chips = await inputChipsState(page);
  assert.deepEqual([chips.sort.shown, chips.untagged.shown], [false, false], 'a new search ends the sort and Untagged');
  assert.equal(await page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.activeTabSortMode;
  }), 'normal', 'a new search runs in normal order');
}

export async function checkReferenceViews(page) {
  const ids = await createNotes(page);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await installTransitionRecorder(page);
  await runThenCleanUp('reference views', async () => {
    await searchFor(page, SEARCH);
    const left = await checkFollowFromSearch(page, ids);
    await checkCloseToSearch(page, ids, left, '× from the first level');
    await checkStack(page, ids);
    await checkAiReferences(page, ids);
    await checkReducedMotion(page, ids);
    await checkNoAnimationWithoutNavigation(page, ids);
    await checkNewSearch(page, ids);
    await checkInputChips(page);
  }, async () => {
    await page.evaluate(async ids => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const id of [ids.holder, ids.target, ids.second, ...ids.fillers]) await NotesAPI.deleteNote(id);
    }, ids);
  });
}
