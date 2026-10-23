import assert from 'node:assert/strict';

import {runThenCleanUp} from './suite-outcome.mjs';
import {waitForAppIdle} from './browser-app-idle.mjs';

// Find in the list (docs/ui/find.md), each agreed case at exact positions:
// - Ctrl/Cmd+F opens the bar just under the search controls and moves nothing; while
//   editing it first saves and leaves the note, which stays at its height; in a dialog
//   it stays the browser's;
// - typing makes the first match at or below the usable top current; in view nothing
//   scrolls; "No matches" dims the arrows;
// - Enter / Shift+Enter: a match below the window lands with its line's bottom at the
//   window's bottom, one above with its top just below the find bar, a far one not
//   loaded yet is loaded and placed by direction, the ends wrap;
// - a match folded away opens its note (or its folded parent) for the view only, and
//   moving on folds it back; Escape clears the marks and folds back what find opened;
// - a common word is read a window at a time: "1 of 50+" until the list is read.

// Positions are compared to the pixel; 1px covers sub-pixel rounding only.
const EXACT_PX = 1;
const VIEWPORT = {width: 1100, height: 700};
// Find counts after the typing pauses (find-in-list-service.js TYPING_PAUSE_MS) and
// the list has settled.
const TYPING_SETTLE_MS = 500;
const SCROLL_SETTLE_MS = 400;
const WORD = 'zqfind';
const NEAR = 'zqnear';
const COMMON = 'zqcommon';
const COMMON_NOTES = 55;
const FAR_INDEX = 240;
const ROOT_COUNT = 250;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppIdle(page);
  await page.waitForNetworkIdle({idleTime: 300});
}

// Roots top to bottom: the first match in view; two near ones; fillers; one below the
// window; a folded note whose second line matches; a folded parent whose child
// matches; fillers (some with the common word); one far below the loaded band.
function fixtureSpecs() {
  const specs = [];
  for (let index = 0; index < ROOT_COUNT; index += 1) {
    let html = `<p>Filler ${index}: one line.</p>`;
    if (index === 0) html = `<p>First ${WORD} in view.</p>`;
    if (index === 2 || index === 3) html = `<p>Near ${NEAR} ${index}.</p>`;
    if (index === 25) html = `<p>Second ${WORD} below the window.</p>`;
    if (index === 30) html = `<p>Folded first line.</p><p>Hidden ${WORD} in a folded note.</p>`;
    if (index === 31) html = '<p>Folded parent.</p>';
    if (index >= 40 && index < 40 + COMMON_NOTES) html = `<p>Common ${COMMON} ${index}.</p>`;
    if (index === FAR_INDEX) html = `<p>Far ${WORD} below the loaded notes.</p>`;
    specs.push({html, isCollapsed: index === 30 || index === 31, childHtml: index === 31 ? `<p>Child ${WORD} of a folded parent.</p>` : null});
  }
  return specs;
}

async function createFixture(page) {
  return page.evaluate(async specs => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    const collapse = [];
    // createNote(null, '') inserts at the top, so create bottom-up.
    for (const spec of specs.slice().reverse()) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, spec.html, '');
      ids.push(note.id);
      if (spec.childHtml !== null) {
        const child = await NotesAPI.createChild(note.id, '');
        await NotesAPI.saveNote(child.id, spec.childHtml, '');
      }
      if (spec.isCollapsed) collapse.push(note.id);
    }
    await NotesAPI.setCollapsedBulk(collapse, true);
    return ids;
  }, fixtureSpecs());
}

async function deleteFixture(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    // Deleting a parent deletes its child: delete the roots only.
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

async function reloadAtTop(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(SCROLL_SETTLE_MS);
}

function findState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const bar = document.getElementById('find-in-list-bar');
    const controls = document.querySelector('.controls').getBoundingClientRect();
    const current = CSS.highlights.get('metalist-find-current');
    let currentRange = null;
    if (current !== undefined) {
      const range = [...current][0];
      const rect = range.getBoundingClientRect();
      const note = range.startContainer.parentElement.closest('.note');
      currentRange = {top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, text: range.toString(), noteText: note.querySelector(':scope > .note-content').textContent.trim()};
    }
    const noteNamed = prefix => [...document.querySelectorAll('#notes-container .note')]
      .find(note => note.querySelector(':scope > .note-content').textContent.trim().startsWith(prefix));
    const describe = prefix => {
      const note = noteNamed(prefix);
      if (note === undefined) return null;
      return {top: note.getBoundingClientRect().top, isFolded: note.classList.contains('collapsed')};
    };
    let barBox = null;
    let count = '';
    let arrowsDisabled = [];
    if (bar !== null) {
      count = document.getElementById('find-in-list-count').textContent;
      arrowsDisabled = [...bar.querySelectorAll('[data-find-action="previous"], [data-find-action="next"]')].map(button => button.disabled);
      if (!bar.hidden) {
        const rect = bar.getBoundingClientRect();
        barBox = {top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right};
      }
    }
    return {
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      controlsBottom: controls.bottom,
      controlsRight: controls.right,
      bar: barBox,
      isInputFocused: document.activeElement !== null && document.activeElement.id === 'find-in-list-input',
      count,
      arrowsDisabled,
      markCount: CSS.highlights.has('metalist-find') ? CSS.highlights.get('metalist-find').size : 0,
      current: currentRange,
      revealNoteId: mode.findRevealNoteId,
      isEditing: mode.isEditing,
      folded: describe('Folded first line'),
      foldedParent: describe('Folded parent'),
      filler5: describe('Filler 5:'),
    };
  });
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= EXACT_PX, `${message}: ${actual} vs ${expected}`);
}

// The top of the usable screen for the current match: just below the find bar where the
// match is under it, else just below the search controls.
function usableTopOf(state) {
  const isUnderBar = state.current.right > state.bar.left && state.current.left < state.bar.right;
  if (isUnderBar) return state.bar.bottom + 8;
  return state.controlsBottom + 8;
}

async function openFind(page) {
  await page.keyboard.down('Control');
  await page.keyboard.press('f');
  await page.keyboard.up('Control');
  await page.waitForSelector('#find-in-list-bar:not([hidden])');
}

async function typeFind(page, text) {
  await page.click('#find-in-list-input', {clickCount: 3});
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
  await pause(TYPING_SETTLE_MS);
  await idle(page);
  await pause(SCROLL_SETTLE_MS);
}

async function settleAfterMove(page) {
  await pause(SCROLL_SETTLE_MS);
  await idle(page);
  await pause(SCROLL_SETTLE_MS);
}

// Enter in the find bar: the next match.
async function pressNext(page) {
  await page.keyboard.press('Enter');
  await settleAfterMove(page);
}

// Shift+Enter in the find bar: the previous match.
async function pressPrevious(page) {
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await settleAfterMove(page);
}

function savedCollapse(page, prefix) {
  return page.evaluate(async prefix => {
    const response = await fetch('/api2/notes/find', {
      method: 'POST',
      headers: (await import('/static/js/modules/session-auth.js')).buildSessionHeaders(true),
      body: JSON.stringify({tabId: (await import('/static/js/modules/mode-manager/mode-context.js')).ModeContextInstance.activeTabId,
        search: null, isUntaggedView: false, text: prefix, fromRootIndex: 0, direction: 'forward'}),
    });
    const answer = await response.json();
    return answer.matches.map(match => match.previewCount < match.contentCount || match.isUnderFoldedNote);
  }, prefix);
}

async function openingMovesNothing(page) {
  const before = await findState(page);
  await openFind(page);
  const after = await findState(page);
  assert.equal(after.scrollY, before.scrollY, 'opening the find bar scrolls nothing');
  assertClose(after.filler5.top, before.filler5.top, 'opening the find bar moves no note');
  assertClose(after.bar.top, after.controlsBottom + 8, 'the bar sits just under the search controls');
  assertClose(after.bar.right, after.controlsRight, 'the bar lines up with the controls on the right');
  assert.equal(after.isInputFocused, true, 'the bar takes the typing');
}

async function typingCurrentInView(page) {
  await typeFind(page, WORD);
  const state = await findState(page);
  assert.equal(state.count, '1 of 5', 'every match counted, the first current');
  assert.equal(state.scrollY, 0, 'a current match in view scrolls nothing');
  assert.equal(state.current.text.toLowerCase(), WORD, 'the current match is marked');
  assert.ok(state.current.noteText.startsWith('First'), 'the first match at or below the usable top is current');
}

async function nextBelowWindow(page) {
  await pressNext(page);
  const state = await findState(page);
  assert.equal(state.count, '2 of 5');
  assert.ok(state.current.noteText.startsWith('Second'), 'Enter goes to the next match');
  assertClose(state.current.bottom, state.innerHeight, 'a match below the window lands at its bottom edge');
}

async function nextFoldedNote(page) {
  await pressNext(page);
  const state = await findState(page);
  assert.equal(state.count, '3 of 5');
  assert.ok(state.current.noteText.startsWith('Folded first line'), 'the match in the folded note is current');
  assert.equal(state.folded.isFolded, false, 'the folded note opens to show it');
  assertClose(state.current.bottom, state.innerHeight, 'it lands at the window bottom edge');
  assert.deepEqual(await savedCollapse(page, 'Hidden'), [true], 'its saved collapse is unchanged');
}

async function nextUnderFoldedParent(page) {
  await pressNext(page);
  const state = await findState(page);
  assert.equal(state.count, '4 of 5');
  assert.ok(state.current.noteText.startsWith('Child'), 'the match under the folded parent is current');
  assert.equal(state.foldedParent.isFolded, false, 'its folded parent opens');
  assert.equal(state.folded.isFolded, true, 'the note opened before folds back');
  assertClose(state.current.bottom, state.innerHeight, 'it lands at the window bottom edge');
}

async function nextFarBelow(page) {
  await pressNext(page);
  const state = await findState(page);
  assert.equal(state.count, '5 of 5');
  assert.ok(state.current.noteText.startsWith('Far'), 'the far match, not loaded before, is current');
  assertClose(state.current.bottom, state.innerHeight, 'loaded from below, it lands at the window bottom edge');
  assert.equal(state.foldedParent, null, 'the band moved away from the folded parent');
}

async function wrapToFirst(page) {
  await pressNext(page);
  const state = await findState(page);
  assert.equal(state.count, '1 of 5', 'Enter at the last match wraps to the first');
  assert.ok(state.current.noteText.startsWith('First'));
  assertClose(state.current.top, usableTopOf(state), 'loaded from above, it lands at the top of the usable screen');
}

async function wrapToLast(page) {
  await pressPrevious(page);
  const state = await findState(page);
  assert.equal(state.count, '5 of 5', 'Shift+Enter at the first match wraps to the last');
  assertClose(state.current.bottom, state.innerHeight, 'loaded from below, it lands at the window bottom edge');
}

async function previousFarAbove(page) {
  await pressPrevious(page);
  const state = await findState(page);
  assert.equal(state.count, '4 of 5');
  assert.ok(state.current.noteText.startsWith('Child'));
  assertClose(state.current.top, usableTopOf(state), 'loaded from above, it lands at the top of the usable screen');
}

async function escapeFoldsBack(page) {
  await pressPrevious(page);
  const opened = await findState(page);
  assert.equal(opened.count, '3 of 5');
  assert.equal(opened.folded.isFolded, false);
  await page.keyboard.press('Escape');
  await pause(SCROLL_SETTLE_MS);
  await idle(page);
  const closed = await findState(page);
  assert.equal(closed.bar, null, 'Escape closes the bar');
  assert.equal(closed.markCount, 0, 'and clears the marks');
  assert.equal(closed.current, null);
  assert.equal(closed.revealNoteId, null);
  assert.equal(closed.folded.isFolded, true, 'the note find opened folds back');
  assertClose(closed.folded.top, opened.folded.top, 'with its first line where it was');
}

async function noMatches(page) {
  await reloadAtTop(page);
  await openFind(page);
  await typeFind(page, 'zqnothing');
  const state = await findState(page);
  assert.equal(state.count, 'No matches');
  assert.deepEqual(state.arrowsDisabled, [true, true], 'the arrows are dimmed');
  assert.equal(state.scrollY, 0, 'nothing moves');
}

async function nextInView(page) {
  await typeFind(page, NEAR);
  const first = await findState(page);
  assert.equal(first.count, '1 of 2');
  await pressNext(page);
  const second = await findState(page);
  assert.equal(second.count, '2 of 2');
  assert.equal(second.scrollY, first.scrollY, 'a next match in view scrolls nothing');
}

async function commonWordWindows(page) {
  await typeFind(page, COMMON);
  const first = await findState(page);
  assert.equal(first.count, '1 of 50+', 'a common word is read a window at a time');
  await pressPrevious(page);
  const last = await findState(page);
  assert.equal(last.count, `${COMMON_NOTES} of ${COMMON_NOTES}`, 'wrapping reads the end, and the list is read');
  await page.keyboard.press('Escape');
  await pause(SCROLL_SETTLE_MS);
}

async function openWhileEditing(page) {
  await reloadAtTop(page);
  const before = await findState(page);
  const box = await page.evaluate(() => {
    const note = [...document.querySelectorAll('#notes-container .note')]
      .find(element => element.querySelector(':scope > .note-content').textContent.trim().startsWith('Filler 5:'));
    const rect = note.querySelector(':scope > .note-content').getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  });
  await page.mouse.click(box.x, box.y);
  await idle(page);
  const editing = await findState(page);
  assert.equal(editing.isEditing, true);
  await openFind(page);
  await idle(page);
  const after = await findState(page);
  assert.equal(after.isEditing, false, 'Cmd+F saves and leaves the note first');
  assertClose(after.filler5.top, editing.filler5.top, 'the note stays at its height');
  assert.equal(after.isInputFocused, true);
  assertClose(after.filler5.top, before.filler5.top, 'nothing else moved');
  await page.keyboard.press('Escape');
  await pause(SCROLL_SETTLE_MS);
}

async function dialogKeepsBrowserFind(page) {
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.openKeyboardShortcutsHelp();
  });
  await page.waitForSelector('#help-modal', {visible: true});
  const prevented = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true});
    document.querySelector('#help-modal').dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(prevented, false, 'in a dialog Cmd+F stays the browser find');
  const bar = await page.$('#find-in-list-bar:not([hidden])');
  assert.equal(bar, null, 'and the find bar does not open');
  await page.keyboard.press('Escape');
  await pause(SCROLL_SETTLE_MS);
}

export async function checkFindInList(page) {
  const viewport = page.viewport();
  await page.setViewport(VIEWPORT);
  const ids = await createFixture(page);
  await runThenCleanUp('find in list', async () => {
    await reloadAtTop(page);
    // The cases run in order (each starts where the one before left the list); their
    // assertion failures are reported together.
    const failures = [];
    const cases = [
      ['opening moves nothing', openingMovesNothing], ['typing: current in view', typingCurrentInView],
      ['next below the window', nextBelowWindow], ['next in a folded note', nextFoldedNote],
      ['next under a folded parent', nextUnderFoldedParent], ['next far below', nextFarBelow],
      ['wrap to the first', wrapToFirst], ['wrap to the last', wrapToLast],
      ['previous far above', previousFarAbove], ['Escape folds back', escapeFoldsBack],
      ['no matches', noMatches], ['next in view', nextInView], ['a common word in windows', commonWordWindows],
      ['opening while editing', openWhileEditing], ['a dialog keeps browser find', dialogKeepsBrowserFind],
    ];
    for (const [label, run] of cases) {
      try {
        await run(page);
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        failures.push(`${label}: ${error.message}`);
      }
    }
    if (failures.length > 0) throw new assert.AssertionError({message: failures.join('\n')});
  }, async () => {
    await page.setViewport(viewport);
    await deleteFixture(page, ids);
  });
}
