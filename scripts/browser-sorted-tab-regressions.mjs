import assert from 'node:assert/strict';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Sorted tabs: which new root notes may be added, the order staying frozen
// while a note is edited, and the surrounding notes staying on screen when the
// edited note moves to its sorted place on leaving edit mode.
//
// The fixture has more roots than the band of loaded roots (75 each side of
// the viewport), so a note that sorts to the far end is outside the band.

const ROOT_COUNT = 200;
const SETTLE_MS = 1500;
const TOLERANCE_PX = 2;
// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;
const BLOCKED_MESSAGE = 'sort order';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function createFixture(page) {
  return page.evaluate(async count => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    // Distinct sizes (content volume), names (alphabetical) and creation times.
    for (let index = 0; index < count; index += 1) {
      const note = await NotesAPI.createNote(null, '');
      const label = String(index).padStart(3, '0');
      await NotesAPI.saveNote(note.id, `<p>Sorted root ${label}: ${'x'.repeat(600 - index)}</p>`, '');
      ids.push(note.id);
    }
    return ids;
  }, ROOT_COUNT);
}

async function deleteNotes(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

async function reload(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
}

async function runPaletteCommand(page, query) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('/');
  await page.keyboard.up('Meta');
  await pause(400);
  await page.keyboard.type(query);
  await pause(300);
  await page.keyboard.press('Enter');
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
  await pause(300);
}

function modeState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {isEditing: mode.isEditing, currentNoteId: mode.currentNoteId, isLoading: mode.isLoading,
      rootCountTotal: mode.rootCountTotal};
  });
}

async function waitIdle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
}

async function waitForEditing(page, noteId) {
  await page.waitForFunction(async noteId => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.isEditing && mode.currentNoteId === noteId && !mode.isLoading;
  }, {}, noteId);
  await pause(400);
}

function rootOrder(page) {
  return page.evaluate(() => [...document.querySelectorAll('#notes-container > .note')].map(note => note.dataset.noteId));
}

function bannerText(page) {
  return page.evaluate(() => {
    const message = document.querySelector('#error-banner .error-banner-message');
    return message ? message.textContent : '';
  });
}

function fatalText(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById('fatal-error-overlay');
    return overlay ? overlay.textContent : '';
  });
}

function noteTop(page, noteId) {
  return page.evaluate(noteId => document.querySelector(`[data-note-id="${noteId}"]`).getBoundingClientRect().top, noteId);
}

// Hover the root at about a third down the screen (Enter outside edit mode acts there).
async function hoverRoot(page, noteId) {
  await page.evaluate(noteId => document.querySelector(`[data-note-id="${noteId}"]`).scrollIntoView({block: 'center'}), noteId);
  await pause(250);
  const point = await page.evaluate(noteId => {
    const rect = document.querySelector(`[data-note-id="${noteId}"] .note-content`).getBoundingClientRect();
    return {x: rect.left + 30, y: rect.top + Math.min(10, rect.height / 2)};
  }, noteId);
  await page.mouse.move(point.x, point.y);
  return point;
}

async function editRoot(page, noteId) {
  const point = await hoverRoot(page, noteId);
  await page.mouse.click(point.x, point.y);
  await waitForEditing(page, noteId);
}

// After a blocked action: nothing was created, a banner explains why, and
// scrolling afterwards still loads more roots without a fatal error.
async function assertBlocked(page, label, rootCountBefore) {
  await waitIdle(page);
  const banner = await bannerText(page);
  assert.ok(banner.toLowerCase().includes(BLOCKED_MESSAGE), `${label}: a banner should explain the block, got "${banner}"`);
  const {rootCountTotal} = await modeState(page);
  assert.equal(rootCountTotal, rootCountBefore, `${label}: no root note should be created`);
}

async function scrollThroughBand(page) {
  for (let step = 0; step < 6; step += 1) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await pause(700);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(1500);
  await waitIdle(page);
  assert.equal(await fatalText(page), '', 'scrolling the sorted tab must not hit a fatal error');
}

async function newNoteAtTopBlockedCase(page, ids, sortCommand, label) {
  await runPaletteCommand(page, sortCommand);
  const {rootCountTotal} = await modeState(page);
  await hoverRoot(page, (await rootOrder(page))[2]);
  await page.keyboard.press('Enter');
  await waitIdle(page);
  const banner = await bannerText(page);
  const state = await modeState(page);
  if (state.isEditing) {
    // Not blocked: scroll while editing the new note (how the crash was hit).
    await page.evaluate(() => window.scrollTo(0, 0));
    await pause(3000);
    assert.equal(await fatalText(page), '', `${label}: a new note sorted outside the loaded band must not hit a fatal error`);
  }
  await scrollThroughBand(page);
  assert.ok(banner.toLowerCase().includes(BLOCKED_MESSAGE), `${label}: a banner should explain the block, got "${banner}"`);
  assert.equal(state.rootCountTotal, rootCountTotal, `${label}: no root note should be created`);
}

async function newNoteBelowBlockedCase(page, ids, sortCommand, label) {
  await runPaletteCommand(page, sortCommand);
  const {rootCountTotal} = await modeState(page);
  const target = (await rootOrder(page))[2];
  await editRoot(page, target);
  await page.keyboard.down('Meta');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Meta');
  await assertBlocked(page, `${label}, new note below a root`, rootCountTotal);
  const state = await modeState(page);
  assert.ok(state.isEditing && state.currentNoteId === target, `${label}: still editing the same note after the block`);
  await page.keyboard.press('Escape');
  await waitIdle(page);
}

async function newNoteAtTopAllowedCase(page, sortCommand, label, created) {
  await runPaletteCommand(page, sortCommand);
  const {rootCountTotal} = await modeState(page);
  await hoverRoot(page, (await rootOrder(page))[2]);
  await page.keyboard.press('Enter');
  await waitIdle(page);
  const state = await modeState(page);
  assert.equal(state.rootCountTotal, rootCountTotal + 1, `${label}: Enter adds a note`);
  assert.ok(state.isEditing, `${label}: the new note is being edited`);
  assert.equal((await rootOrder(page))[0], state.currentNoteId, `${label}: the new note is at the top`);
  created.push(state.currentNoteId);
  await page.keyboard.press('Escape');
  await waitIdle(page);
  assert.equal(await fatalText(page), '', `${label}: no fatal error`);
}

// Grow (content volume) or touch (updated) a root in the middle of the screen:
// while editing it keeps its neighbours; after Escape it moves to the top and
// the note that was below it stays where it was on screen.
async function frozenWhileEditingCase(page, sortCommand, label) {
  await runPaletteCommand(page, sortCommand);
  const order = await rootOrder(page);
  const target = order[20];
  const before = order[19];
  const after = order[21];
  await editRoot(page, target);
  await page.evaluate(noteId => {
    const content = document.querySelector(`[data-note-id="${noteId}"] .note-content`);
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, ` ${'y'.repeat(2000)}`);
  }, target);
  // Save, then refresh the view while still editing, as a poll or band move
  // would: the server now sorts the grown/touched note elsewhere.
  await page.evaluate(async noteId => {
    const {actionSaveNote} = await import('/static/js/modules/mode-manager/actions/content-actions.js');
    const {actionRefreshAndMaybeSelect} = await import('/static/js/modules/mode-manager/actions/ui-actions.js');
    await actionSaveNote(noteId);
    await actionRefreshAndMaybeSelect({startedAt: performance.now(), context: 'sorted-tab-test'});
  }, target);
  await waitIdle(page);
  await pause(800);
  const editingOrder = await rootOrder(page);
  const index = editingOrder.indexOf(target);
  assert.ok(index > 0, `${label}: the edited note is still loaded`);
  assert.equal(editingOrder[index - 1], before, `${label}: while editing, the note keeps the note above it`);
  assert.equal(editingOrder[index + 1], after, `${label}: while editing, the note keeps the note below it`);

  const afterTop = await noteTop(page, after);
  await page.keyboard.press('Escape');
  await waitIdle(page);
  await pause(SETTLE_MS);
  const exitedOrder = await rootOrder(page);
  assert.equal(exitedOrder[0], target, `${label}: after leaving edit mode the note moves to its sorted place (the top)`);
  const afterTopNow = await noteTop(page, after);
  assert.ok(Math.abs(afterTopNow - afterTop) <= TOLERANCE_PX,
    `${label}: the surrounding notes stay on screen: y=${Math.round(afterTop)} -> ${Math.round(afterTopNow)}`);
  assert.equal(await fatalText(page), '', `${label}: no fatal error`);
}

export async function checkSortedTabs(page) {
  const ids = await createFixture(page);
  const created = [];
  const failures = [];
  const check = async (name, body) => {
    try {
      await body();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      failures.push(`${name}: ${error.message}`);
      if ((await modeState(page)).isEditing) {
        await page.keyboard.press('Escape');
        await pause(500);
      }
    }
  };
  try {
    await reload(page);
    // The reported crash: Enter in a content-volume tab added an empty note
    // that sorted to the far end, outside the band on screen.
    await check('content volume, Enter', () => newNoteAtTopBlockedCase(page, ids, 'Sort order: Content volume', 'content volume'));
    await check('alphabetical, Enter', () => newNoteAtTopBlockedCase(page, ids, 'Sort order: Alphabetical', 'alphabetical'));
    await check('content volume, new below', () => newNoteBelowBlockedCase(page, ids, 'Sort order: Content volume', 'content volume'));
    await check('created, new below', () => newNoteBelowBlockedCase(page, ids, 'Sort order: Datetime created', 'created'));
    await check('created, Enter', () => newNoteAtTopAllowedCase(page, 'Sort order: Datetime created', 'created', created));
    await check('updated, Enter', () => newNoteAtTopAllowedCase(page, 'Sort order: Datetime last updated', 'updated', created));
    await check('content volume, frozen', () => frozenWhileEditingCase(page, 'Sort order: Content volume', 'content volume'));
    await check('updated, frozen', () => frozenWhileEditingCase(page, 'Sort order: Datetime last updated', 'updated'));
    assert.deepEqual(failures, [], `sorted tab failures:\n${failures.join('\n')}`);
  } finally {
    await runPaletteCommand(page, 'Sort order: Normal');
    await deleteNotes(page, [...ids, ...created]);
    await reload(page);
  }
}
