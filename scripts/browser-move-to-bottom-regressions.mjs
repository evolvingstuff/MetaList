import assert from 'node:assert/strict';

import {runThenCleanUp} from './suite-outcome.mjs';

// Move to Bottom keeps the view still (docs/ui/interaction-principles.md): the
// notes above stay put and the ones below close the gap; nothing scrolls. In a
// short list the note is seen landing at the end. A child goes after its last
// sibling, a root in a search after the last matching root. Moving the note
// being edited saves it and leaves edit mode. ⌘Z puts it back.

const SETTLE_MS = 1500;
// Positions are compared to the pixel; 1px covers sub-pixel rounding only.
const EXACT_PX = 1;
const SEARCH_TAG = 'movebottomfixture';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function paragraphs(label, count) {
  return Array.from({length: count}, (_, index) =>
    `<p>${label} paragraph ${index + 1}: ordinary sentence text giving the line a realistic width.</p>`).join('');
}

async function idle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return !mode.isLoading && !CommandGate.isBusy();
  });
  await page.waitForNetworkIdle({idleTime: 300});
}

async function reload(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}

// Roots top to bottom: "Root 1" … "Root 16" (3 lines each), then a parent with
// "Child 1" … "Child 3", then three short notes tagged for the search case.
async function createFixture(page) {
  return page.evaluate(async ({roots, tag}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    // createNote(null, '') inserts at the top, so create bottom-up.
    for (let index = 3; index >= 1; index -= 1) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, `<p>Listed ${index}: a short note.</p>`, tag);
      ids.push(note.id);
    }
    const parent = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(parent.id, '<p>Parent of children</p>', '');
    ids.push(parent.id);
    for (let index = 3; index >= 1; index -= 1) {
      const child = await NotesAPI.createChild(parent.id, '');
      // Deleted with their parent.
      await NotesAPI.saveNote(child.id, `<p>Child ${index}: a line of text.</p>`, '');
    }
    for (const html of roots) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, html, '');
      ids.push(note.id);
    }
    return ids;
  }, {roots: Array.from({length: 16}, (_, index) => paragraphs(`Root ${16 - index}`, 3)), tag: SEARCH_TAG});
}

async function deleteFixture(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

function noteRect(page, prefix) {
  return page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    if (!paragraph) return null;
    const rect = paragraph.closest('.note').getBoundingClientRect();
    return {top: rect.top, bottom: rect.bottom};
  }, prefix);
}

// Labels ("Root 3", "Child 1", …) of the loaded notes in screen order.
function order(page, selector) {
  return page.evaluate(selector => [...document.querySelectorAll(selector)]
    .map(note => note.querySelector(':scope > .note-content').textContent.trim().split(/[: ]paragraph|:/)[0].trim()), selector);
}

async function scrollNoteTopTo(page, prefix, viewportY) {
  const rect = await noteRect(page, prefix);
  assert.notEqual(rect, null, `"${prefix}" should be loaded`);
  await page.evaluate(delta => window.scrollBy(0, delta), rect.top - viewportY);
  await pause(400);
}

function startScrollSampling(page) {
  return page.evaluate(() => {
    window.__moveScrolls = [];
    const sample = () => {
      window.__moveScrolls.push(window.scrollY);
      if (window.__moveScrolls.length < 180) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function assertNothingScrolled(page, label, scrollBefore) {
  const scrolls = await page.evaluate(() => window.__moveScrolls);
  const worst = Math.max(...scrolls.map(y => Math.abs(y - scrollBefore)));
  assert.ok(worst <= EXACT_PX, `${label}: the page should not scroll, but moved up to ${Math.round(worst)}px`);
}

function assertAt(label, what, actual, expected) {
  assert.ok(Math.abs(actual - expected) <= EXACT_PX, `${label}: ${what} should be at y=${Math.round(expected)}, got y=${Math.round(actual)}`);
}

// Right-click the note and choose Move to Bottom (inside Move when the note
// has more than one possible move).
async function moveToBottomFromMenu(page, prefix) {
  const point = await page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    const rect = paragraph.getBoundingClientRect();
    return {x: rect.left + 60, y: rect.top + Math.min(10, rect.height / 2)};
  }, prefix);
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await page.waitForSelector('.context-menu-item');
  const find = label => page.evaluateHandle(label => [...document.querySelectorAll('.context-menu-item')]
    .filter(item => item.offsetParent !== null).find(item => item.textContent.trim().startsWith(label)) || null, label);
  const moveGroup = (await find('Move')).asElement();
  if (moveGroup !== null && (await moveGroup.evaluate(node => node.textContent.trim())).startsWith('Move›')) {
    await moveGroup.hover();
    await pause(400);
  }
  const item = (await find('Move to Bottom')).asElement();
  assert.notEqual(item, null, `"${prefix}": the menu should offer Move to Bottom`);
  await startScrollSampling(page);
  await item.click();
  await idle(page);
  await pause(SETTLE_MS);
}

// Long list, the note in the middle of the window: it leaves, the note above
// stays put and the one below takes its place.
async function longListCase(page) {
  await reload(page);
  await scrollNoteTopTo(page, 'Root 6 paragraph 1:', 300);
  const above = await noteRect(page, 'Root 5 paragraph 1:');
  const moved = await noteRect(page, 'Root 6 paragraph 1:');
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await moveToBottomFromMenu(page, 'Root 6 paragraph 1:');
  const label = 'long list';
  await assertNothingScrolled(page, label, scrollBefore);
  assertAt(label, 'the note above ("Root 5")', (await noteRect(page, 'Root 5 paragraph 1:')).top, above.top);
  assertAt(label, 'the note below ("Root 7")', (await noteRect(page, 'Root 7 paragraph 1:')).top, moved.top);
  const roots = await order(page, '#notes-container > .note');
  assert.equal(roots[roots.length - 1], 'Root 6', `${label}: "Root 6" should be the last root, got ${roots.join(', ')}`);
}

// ⌘Z right after puts it back where it was. (Where the page ends up is undo's
// own viewport restore, shared by every undo, and not checked here.)
async function undoCase(page) {
  await page.mouse.move(5, 300);
  await page.keyboard.down('Meta');
  await page.keyboard.press('z');
  await page.keyboard.up('Meta');
  await idle(page);
  await pause(SETTLE_MS);
  const roots = await order(page, '#notes-container > .note');
  assert.deepEqual(roots.slice(roots.indexOf('Root 5'), roots.indexOf('Root 5') + 3), ['Root 5', 'Root 6', 'Root 7'], 'undo: "Root 6" should be back between "Root 5" and "Root 7"');
}

// The note at the top of the window, partly behind the search controls: the
// note above it (off screen) holds, so the next one moves up into its place.
async function topOfWindowCase(page) {
  await reload(page);
  await scrollNoteTopTo(page, 'Root 8 paragraph 1:', 20);
  const moved = await noteRect(page, 'Root 8 paragraph 1:');
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await moveToBottomFromMenu(page, 'Root 8 paragraph 2:');
  const label = 'top of the window';
  await assertNothingScrolled(page, label, scrollBefore);
  assertAt(label, 'the note below ("Root 9")', (await noteRect(page, 'Root 9 paragraph 1:')).top, moved.top);
}

// A child goes after its last sibling; the parent and the page stay put and the
// child is seen landing.
async function childCase(page) {
  await reload(page);
  await scrollNoteTopTo(page, 'Parent of children', 250);
  const parent = await noteRect(page, 'Parent of children');
  const first = await noteRect(page, 'Child 1:');
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await moveToBottomFromMenu(page, 'Child 1:');
  const label = 'child note';
  await assertNothingScrolled(page, label, scrollBefore);
  assertAt(label, 'the parent', (await noteRect(page, 'Parent of children')).top, parent.top);
  assertAt(label, '"Child 2"', (await noteRect(page, 'Child 2:')).top, first.top);
  const children = await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith('Parent of children'));
    return [...paragraph.closest('.note').querySelectorAll('.note')]
      .map(note => note.querySelector(':scope > .note-content').textContent.trim().split(':')[0]);
  });
  assert.deepEqual(children, ['Child 2', 'Child 3', 'Child 1'],
    `${label}: the children should be ordered Child 2, Child 3, Child 1`);
  const landed = await noteRect(page, 'Child 1:');
  const innerHeight = await page.evaluate(() => window.innerHeight);
  assert.ok(landed.bottom <= innerHeight, `${label}: "Child 1" should be seen landing on screen`);
}

// A short list (a search for three notes): the note is seen landing at the end
// of the matches, the others move up, and nothing scrolls.
async function shortListSearchCase(page) {
  await reload(page);
  await page.click('#search-input');
  // The search runs as you type (Enter would add a note at the top).
  await page.keyboard.type(SEARCH_TAG);
  await pause(SETTLE_MS);
  await idle(page);
  await page.keyboard.press('Escape');
  await pause(300);
  assert.deepEqual(await order(page, '#notes-container > .note'), ['Listed 1', 'Listed 2', 'Listed 3'], 'short list: the search should show the three listed notes');
  const first = await noteRect(page, 'Listed 1:');
  const third = await noteRect(page, 'Listed 3:');
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await moveToBottomFromMenu(page, 'Listed 1:');
  const label = 'short list';
  await assertNothingScrolled(page, label, scrollBefore);
  assert.deepEqual(await order(page, '#notes-container > .note'), ['Listed 2', 'Listed 3', 'Listed 1'], `${label}: "Listed 1" should be after the last match`);
  assertAt(label, '"Listed 2"', (await noteRect(page, 'Listed 2:')).top, first.top);
  const landed = await noteRect(page, 'Listed 1:');
  assert.ok(landed.top > third.top - (third.bottom - third.top) && landed.bottom <= await page.evaluate(() => window.innerHeight),
    `${label}: "Listed 1" should be seen landing at the end, got y=${Math.round(landed.top)}`);
}

async function clearSearch(page) {
  await page.focus('#search-input');
  await page.evaluate(() => document.getElementById('search-input').select());
  await page.keyboard.press('Backspace');
  await pause(SETTLE_MS);
  await idle(page);
  await page.keyboard.press('Escape');
  await pause(300);
}

// ⇧⌘↓ on the note being edited: the edit is saved, edit mode ends, the note
// goes to the bottom and nothing scrolls.
async function editingShortcutCase(page) {
  await reload(page);
  await scrollNoteTopTo(page, 'Root 10 paragraph 1:', 300);
  const below = 'Root 11 paragraph 1:';
  const moved = await noteRect(page, 'Root 10 paragraph 1:');
  const point = await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith('Root 10 paragraph 3:'));
    const rect = paragraph.getBoundingClientRect();
    return {x: rect.right - 4, y: rect.top + rect.height / 2};
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.isEditing && !mode.isLoading;
  });
  await pause(400);
  // The click put the caret at the end of the line (no End key: Firefox scrolls the page on it).
  await page.keyboard.type(' edited');
  await pause(400);
  assertAt('editing, ⇧⌘↓ (setup)', '"Root 10" before the shortcut', (await noteRect(page, 'Root 10 paragraph 1:')).top, moved.top);
  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  await idle(page);
  await pause(SETTLE_MS);
  const label = 'editing, ⇧⌘↓';
  assert.equal(await page.evaluate(async () => (await import('/static/js/modules/mode-manager/mode-context.js')).ModeContextInstance.isEditing), false,
    `${label}: edit mode should end`);
  assertAt(label, 'the note below ("Root 11")', (await noteRect(page, below)).top, moved.top);
  await reload(page);
  const saved = await page.evaluate(() => [...document.querySelectorAll('#notes-container p')]
    .some(p => p.textContent.trim().startsWith('Root 10 paragraph 3:') && p.textContent.includes(' edited')));
  assert.equal(saved, true, `${label}: the edit should be saved`);
  const roots = await order(page, '#notes-container > .note');
  assert.equal(roots[roots.length - 1], 'Root 10', `${label}: "Root 10" should be the last root, got ${roots.join(', ')}`);
}

export async function checkMoveToBottom(page) {
  const ids = await createFixture(page);
  const failures = [];
  const check = async (name, body) => {
    try {
      await body();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      failures.push(`${name}: ${error.message}`);
      await page.keyboard.press('Escape');
      await pause(500);
    }
  };
  await runThenCleanUp('move to bottom', async () => {
    await check('long list', () => longListCase(page));
    await check('undo', () => undoCase(page));
    await check('top of the window', () => topOfWindowCase(page));
    await check('child note', () => childCase(page));
    await check('short list (search)', () => shortListSearchCase(page));
    await clearSearch(page);
    await check('editing, shortcut', () => editingShortcutCase(page));
    assert.deepEqual(failures, [], `move to bottom failures:\n${failures.join('\n')}`);
  }, async () => {
    await deleteFixture(page, ids);
    await reload(page);
  });
}
