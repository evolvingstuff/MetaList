import assert from 'node:assert/strict';

import {runThenCleanUp} from './suite-outcome.mjs';
import { waitForAppIdle } from './browser-app-idle.mjs';

// Right-clicking an entry in the tag bar's suggestion list (docs/ui/tag-bar.md,
// docs/ui/interaction-principles.md): the tag menu opens for that entry, saying
// why it is suggested, and the list, the typed letters, the cursor and the
// edited note stay as they were, also once the menu closes (Escape, or the
// pointer moving away). Edit Tag Relationships opens the relationships for
// that entry's tag.

const SETTLE_MS = 400;
const TYPED = 'zorb';
const TARGET_TAG = 'zorbmatic';
// The edited note has no evidence for zorbmatic: it matches the typed letters and is on one note.
const TARGET_REASONS = ['Why suggested', `Matches what you typed: "${TYPED}"`, "Listed by use: you've tagged 1 note with it"];

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppIdle(page);
  await page.waitForNetworkIdle({idleTime: 300});
}

// Top to bottom: the edited note, two notes giving the tags their use, then
// filler notes lying under the suggestion list.
async function createFixture(page) {
  const specs = [
    {html: '<p>Planning the zorbleflux rollout.</p>', tags: ''},
    {html: '<p>Uses zorbleflux daily.</p>', tags: 'zorbleflux'},
    {html: '<p>Bought a zorbmatic.</p>', tags: TARGET_TAG},
    ...Array.from({length: 12}, (_, index) => ({html: `<p>Filler ${index + 1}: an ordinary note.</p>`, tags: ''})),
  ];
  return page.evaluate(async specs => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    // createNote(null, '') inserts at the top, so create bottom-up.
    for (const spec of [...specs].reverse()) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, spec.html, spec.tags);
      ids.unshift(note.id);
    }
    return ids;
  }, specs);
}

async function deleteFixture(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

function tagBarState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const input = document.querySelector('.note.editing .note-tag-bar-input');
    const list = document.querySelector('.note.editing .note-tag-suggestions');
    const isListShown = list !== null && !list.hidden;
    const menu = document.querySelector('.context-menu:not(.context-menu-submenu)');
    const isMenuShown = menu !== null && menu.classList.contains('is-visible');
    return {
      editingNoteId: mode.isEditing ? mode.currentNoteId : null,
      value: input === null ? null : input.value,
      caret: input === null ? null : [input.selectionStart, input.selectionEnd],
      isTagBarFocused: input !== null && document.activeElement === input,
      entries: isListShown ? [...list.querySelectorAll('.note-tag-suggestion')].map(entry => entry.dataset.tag) : [],
      highlighted: isListShown ? [...list.querySelectorAll('.note-tag-suggestion.is-selected')].map(entry => entry.dataset.tag) : [],
      listTop: isListShown ? list.getBoundingClientRect().top : null,
      scrollY: window.scrollY,
      menu: isMenuShown ? [...menu.querySelectorAll('.context-menu-item-label')].map(label => label.textContent) : null,
      why: isMenuShown ? [...menu.querySelectorAll('.context-menu-explanation > *')].map(line => line.textContent) : null,
    };
  });
}

async function entryCenter(page, tag) {
  const entry = await page.$(`.note.editing .note-tag-suggestion[data-tag="${tag}"]`);
  assert(entry, `suggestion list has no ${tag} entry`);
  const box = await entry.boundingBox();
  assert(box, `${tag} entry is not on screen`);
  return {x: box.x + box.width / 2, y: box.y + box.height / 2};
}

async function startTyping(page, noteId) {
  await page.click(`[data-note-id="${noteId}"] > .note-content`);
  await page.waitForSelector('.note.editing .note-tag-bar-input');
  await idle(page);
  await page.click('.note.editing .note-tag-bar-input');
  await page.waitForFunction(() => document.activeElement.classList.contains('note-tag-bar-input'));
  // A click in the tag bar tidies it on a zero-delay timer; typing before that
  // timer runs (only a script types that fast) would get a space appended.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  assert.equal(await page.$eval('.note.editing .note-tag-bar-input', input => input.value), '', 'tag bar starts empty');
  await page.keyboard.type(TYPED);
  await page.waitForFunction(tag => document.querySelector(
    `.note.editing .note-tag-suggestions:not([hidden]) .note-tag-suggestion[data-tag="${tag}"]`,
  ) !== null, {}, TARGET_TAG);
  await pause(SETTLE_MS);
  const before = await tagBarState(page);
  assert.equal(before.editingNoteId, noteId);
  assert.equal(before.value, TYPED);
  assert.deepEqual(before.caret, [TYPED.length, TYPED.length]);
  assert.equal(before.isTagBarFocused, true);
  assert(before.entries.length >= 2, `expected at least two entries, got ${JSON.stringify(before.entries)}`);
  assert.notEqual(before.highlighted[0], TARGET_TAG, 'the right-clicked entry must not be the highlighted one');
  assert.equal(before.menu, null);
  assert.equal(before.why, null);
  return before;
}

async function rightClickEntry(page) {
  const point = await entryCenter(page, TARGET_TAG);
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await pause(SETTLE_MS);
  return point;
}

function assertTagBarUnchanged(name, before, after) {
  assert.deepEqual({...after, menu: null, why: null}, {...before, menu: null, why: null}, `${name}: the tag bar and its list changed`);
}

// Each case starts afresh: the note edited, its tag bar empty, then typing.
async function openTagMenu(page, noteId) {
  await leaveEditing(page);
  const before = await startTyping(page, noteId);
  const point = await rightClickEntry(page);
  const after = await tagBarState(page);
  assert.deepEqual(after.menu, ['Edit Tag Relationships'], 'right-click on an entry opens the tag menu');
  assert.deepEqual(after.why, TARGET_REASONS, 'the tag menu says why the entry is suggested');
  assertTagBarUnchanged('right-click', before, after);
  return {before, point};
}

async function escapeClosesMenuCase(page, noteId) {
  const {before} = await openTagMenu(page, noteId);
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  const after = await tagBarState(page);
  assert.equal(after.menu, null, 'Escape closes the menu');
  assertTagBarUnchanged('Escape', before, after);
}

async function pointerAwayClosesMenuCase(page, noteId) {
  const {before, point} = await openTagMenu(page, noteId);
  // Away from the menu (which opens to the right of the pointer) and the list.
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(point.x - step * 20, point.y - step * 20);
  }
  await pause(SETTLE_MS);
  const after = await tagBarState(page);
  assert.equal(after.menu, null, 'moving the pointer away closes the menu');
  assertTagBarUnchanged('pointer away', before, after);
}

async function editTagRelationshipsCase(page, noteId) {
  await openTagMenu(page, noteId);
  const focusRequest = page.waitForRequest(request => request.url().includes(`/focus?tag=${TARGET_TAG}`), {timeout: 10_000});
  const item = await page.waitForSelector('.context-menu.is-visible .context-menu-item');
  await item.click();
  await focusRequest;
  await page.waitForSelector('#ontology-modal', {visible: true});
  await idle(page);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#ontology-modal', {hidden: true});
  await idle(page);
}

// The search bar's suggestion list behaves the same way: right-clicking an
// entry opens the tag menu saying why it is suggested, and the search text,
// cursor and list stay as they were.
const SEARCH_REASONS = ['Why suggested', 'Tags are listed by how many notes have them', 'Searching for it finds 1 note'];

function searchState(page) {
  return page.evaluate(() => {
    const input = document.getElementById('search-input');
    const list = document.getElementById('search-suggestions');
    const isListShown = list !== null && !list.hidden;
    const menu = document.querySelector('.context-menu:not(.context-menu-submenu)');
    const isMenuShown = menu !== null && menu.classList.contains('is-visible');
    return {
      value: input.value,
      caret: [input.selectionStart, input.selectionEnd],
      isSearchFocused: document.activeElement === input,
      entries: isListShown ? [...list.querySelectorAll('.search-suggestion')].map(entry => entry.dataset.tag) : [],
      highlighted: isListShown ? [...list.querySelectorAll('.search-suggestion.is-selected')].map(entry => entry.dataset.tag) : [],
      listTop: isListShown ? list.getBoundingClientRect().top : null,
      scrollY: window.scrollY,
      menu: isMenuShown ? [...menu.querySelectorAll('.context-menu-item-label')].map(label => label.textContent) : null,
      why: isMenuShown ? [...menu.querySelectorAll('.context-menu-explanation > *')].map(line => line.textContent) : null,
    };
  });
}

async function clearSearch(page) {
  await page.click('#search-input');
  await page.evaluate(() => document.getElementById('search-input').select());
  await page.keyboard.press('Backspace');
  await pause(SETTLE_MS);
  await idle(page);
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
}

async function openSearchTagMenu(page) {
  await clearSearch(page);
  await page.click('#search-input');
  await page.keyboard.type(TYPED);
  await page.waitForFunction(tag => document.querySelector(
    `#search-suggestions:not([hidden]) .search-suggestion[data-tag="${tag}"]`,
  ) !== null, {}, TARGET_TAG);
  await pause(SETTLE_MS);
  await idle(page);
  const before = await searchState(page);
  assert.equal(before.value, TYPED);
  assert.equal(before.isSearchFocused, true);
  assert.notEqual(before.highlighted[0], TARGET_TAG, 'the right-clicked entry must not be the highlighted one');
  const entry = await page.$(`#search-suggestions .search-suggestion[data-tag="${TARGET_TAG}"]`);
  const box = await entry.boundingBox();
  const point = {x: box.x + box.width / 2, y: box.y + box.height / 2};
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await pause(SETTLE_MS);
  const after = await searchState(page);
  assert.deepEqual(after.menu, ['Edit Tag Relationships'], 'right-click on a search suggestion opens the tag menu');
  assert.equal(await page.$eval('.context-menu.is-visible', menu => menu.firstElementChild.classList.contains('context-menu-item')), true,
    'Edit Tag Relationships comes first, above the explanation');
  assert.deepEqual(after.why, SEARCH_REASONS, 'the tag menu says why the search suggestion is suggested');
  assertTagBarUnchanged('search right-click', before, after);
  return {before, point};
}

async function searchEscapeClosesMenuCase(page) {
  const {before} = await openSearchTagMenu(page);
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  const after = await searchState(page);
  assert.equal(after.menu, null, 'Escape closes the menu');
  assertTagBarUnchanged('search Escape', before, after);
}

async function searchPointerAwayClosesMenuCase(page) {
  const {before, point} = await openSearchTagMenu(page);
  // Up and left: away from the menu, staying over the search list's column.
  for (let step = 1; step <= 4; step += 1) {
    await page.mouse.move(point.x - step * 15, point.y - step * 12);
  }
  await pause(SETTLE_MS);
  const after = await searchState(page);
  assert.equal(after.menu, null, 'moving the pointer away closes the menu');
  assertTagBarUnchanged('search pointer away', before, after);
}

async function searchActivityTags(page) {
  return page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const statistics = await NotesAPI.getSearchSuggestionStatistics();
    return statistics.days.flatMap(day => day.tags.map(entry => entry.tag));
  });
}

// The menu can hang below the list; moving onto it is not leaving the list.
async function searchPointerOntoMenuCase(page) {
  const {before, point} = await openSearchTagMenu(page);
  const explanation = await page.$('.context-menu.is-visible .context-menu-explanation');
  const box = await explanation.boundingBox();
  const listBottom = await page.$eval('#search-suggestions', list => list.getBoundingClientRect().bottom);
  assert(box.y + box.height / 2 > listBottom, 'the lower part of the menu must lie below the list for this case');
  // From the right-click point straight onto the item, as a hand would.
  await page.mouse.move(point.x, point.y);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {steps: 6});
  await pause(SETTLE_MS);
  const after = await searchState(page);
  assert.deepEqual(after.menu, ['Edit Tag Relationships'], 'the menu stays open under the pointer');
  assertTagBarUnchanged('search pointer onto menu', before, after);
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
}

// Right-clicking is looking: it earns the tag no search-activity credit.
async function searchRightClickEarnsNoCreditCase(page) {
  assert.deepEqual(await searchActivityTags(page), [], 'activity starts empty');
  await openSearchTagMenu(page);
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  await idle(page);
  assert.deepEqual(await searchActivityTags(page), [], 'a right-click is not a pick');
}

async function searchEditTagRelationshipsCase(page) {
  const {before} = await openSearchTagMenu(page);
  const focusRequest = page.waitForRequest(request => request.url().includes(`/focus?tag=${TARGET_TAG}`), {timeout: 10_000});
  const item = await page.waitForSelector('.context-menu.is-visible .context-menu-item');
  await item.click();
  await focusRequest;
  await page.waitForSelector('#ontology-modal', {visible: true});
  await idle(page);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#ontology-modal', {hidden: true});
  await idle(page);
  assert.equal(await page.$eval('#search-input', input => input.value), before.value, 'the search stays');
}

// A tag already written in the tag bar or typed in the search box: its menu
// starts with "About this tag", and the text, focus and edit mode stay put.
const ENTERED_TAG = 'zorbleflux';

async function rightClickInputText(page, selector) {
  const point = await page.$eval(selector, input => {
    const style = getComputedStyle(input);
    const bounds = input.getBoundingClientRect();
    input.scrollLeft = 0;
    return {x: bounds.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) + 12, y: bounds.top + bounds.height / 2};
  });
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await page.waitForSelector('.context-menu.is-visible', {timeout: 5_000});
  await pause(SETTLE_MS);
}

async function enteredTagBarTagCase(page, noteId) {
  await leaveEditing(page);
  await page.click(`[data-note-id="${noteId}"] > .note-content`);
  await page.waitForSelector('.note.editing .note-tag-bar-input');
  await idle(page);
  await page.click('.note.editing .note-tag-bar-input');
  await page.waitForFunction(() => document.activeElement.classList.contains('note-tag-bar-input'));
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  // Earlier cases leave "zorb" saved in this bar; the right-click must land on the tag typed now.
  await page.$eval('.note.editing .note-tag-bar-input', input => input.select());
  await page.keyboard.press('Backspace');
  await page.keyboard.type(ENTERED_TAG);
  await pause(SETTLE_MS);
  await idle(page);
  const before = await tagBarState(page);
  await rightClickInputText(page, '.note.editing .note-tag-bar-input');
  const after = await tagBarState(page);
  assert.deepEqual(after.menu, ['Edit Tag Relationships'], 'right-click on an entered tag opens the tag menu');
  // This note is not saved with it yet; the other fixture note is.
  assert.deepEqual(after.why, ['About this tag', `Named in this note: "${ENTERED_TAG}"`, "You've tagged 1 note with it"]);
  assert.equal(after.editingNoteId, before.editingNoteId, 'still editing');
  assert.equal(after.value, before.value, 'the tag bar text is unchanged');
  assert.equal(after.isTagBarFocused, true, 'the tag bar keeps focus');
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  const closed = await tagBarState(page);
  assert.equal(closed.menu, null, 'Escape closes the menu');
  assert.equal(closed.editingNoteId, before.editingNoteId, 'Escape closes only the menu');
  assert.equal(closed.value, before.value);
}

async function enteredSearchTagCase(page) {
  await clearSearch(page);
  await page.click('#search-input');
  await page.keyboard.type(ENTERED_TAG);
  await pause(SETTLE_MS);
  await idle(page);
  const before = await searchState(page);
  await rightClickInputText(page, '#search-input');
  const after = await searchState(page);
  assert.deepEqual(after.menu, ['Edit Tag Relationships'], 'right-click on a searched tag opens the tag menu');
  assert.deepEqual(after.why, ['About this tag', 'Searching for it finds 1 note']);
  assert.equal(after.value, before.value, 'the search is unchanged');
  assert.equal(after.isSearchFocused, true, 'the search box keeps focus');
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  const closed = await searchState(page);
  assert.equal(closed.menu, null, 'Escape closes the menu');
  assert.equal(closed.value, before.value);
  assert.equal(closed.isSearchFocused, true, 'Escape closes only the menu');
}

// Leaves edit mode with the tag bar emptied, so typed letters are not saved as a tag.
async function leaveEditing(page) {
  if ((await tagBarState(page)).editingNoteId === null) return;
  await page.$eval('.note.editing .note-tag-bar-input', input => { input.focus(); input.select(); });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  if ((await tagBarState(page)).editingNoteId !== null) await page.keyboard.press('Escape');
  await idle(page);
  assert.equal((await tagBarState(page)).editingNoteId, null, 'could not leave edit mode');
}

export async function checkTagSuggestionMenu(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  const ids = await createFixture(page);
  const failures = [];
  const check = async (name, body) => {
    try {
      await body();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      failures.push(`${name}: ${error.message}`);
      await page.keyboard.press('Escape');
      await pause(300);
      await leaveEditing(page);
    }
  };
  await runThenCleanUp('tag suggestion menu', async () => {
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await idle(page);
    const noteId = ids[0];
    await check('Escape', () => escapeClosesMenuCase(page, noteId));
    await check('pointer away', () => pointerAwayClosesMenuCase(page, noteId));
    await check('Edit Tag Relationships', () => editTagRelationshipsCase(page, noteId));
    await check('entered tag-bar tag', () => enteredTagBarTagCase(page, noteId));
    await leaveEditing(page);
    // The steps above earn search-activity credits; without them the reasons are the ranking's alone.
    await page.evaluate(async () => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      await NotesAPI.resetSearchSuggestionHistory();
    });
    await check('search Escape', () => searchEscapeClosesMenuCase(page));
    await check('search pointer away', () => searchPointerAwayClosesMenuCase(page));
    await check('search pointer onto menu', () => searchPointerOntoMenuCase(page));
    await check('search right-click earns no credit', () => searchRightClickEarnsNoCreditCase(page));
    await check('search Edit Tag Relationships', () => searchEditTagRelationshipsCase(page));
    await check('entered search tag', () => enteredSearchTagCase(page));
    await clearSearch(page);
    assert.deepEqual(failures, [], `tag suggestion menu failures:\n${failures.join('\n')}`);
  }, async () => {
    await leaveEditing(page);
    await deleteFixture(page, ids);
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await idle(page);
  });
}
