import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';

// The tag bar's suggestions act only on a list built for the text in the bar,
// as the search box's do. While a new list is on its way, the list on screen
// is for older text: Enter then closes it and leaves the typed text alone, and
// the arrows wait for the new list. Each case holds the suggestions response,
// so the old list is on screen for certain.

const SETTLE_MS = 400;
// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
const TAGS = ['quxalpha', 'quxbeta', 'zebrafoo'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return !mode.isLoading && !CommandGate.isBusy();
  });
  await page.waitForNetworkIdle({idleTime: NETWORK_IDLE_MS});
}

// The edited note first, then one note per tag giving it its use.
async function createNotes(page) {
  return page.evaluate(async tags => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    for (const tag of [...tags].reverse()) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, `<p>Tag bar ${tag} note</p>`, tag);
      ids.unshift(note.id);
    }
    const edited = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(edited.id, '<p>Tag bar race note</p>', '');
    ids.unshift(edited.id);
    return ids;
  }, TAGS);
}

// Tag suggestion responses wait while held, until released.
async function installHold(page) {
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    window.tagSuggestionHold = {originalFetch, held: false, waiting: []};
    window.fetch = async (url, options) => {
      const response = await originalFetch(url, options);
      if (new URL(url, location.href).pathname === '/api2/notes/tag-suggestions' && window.tagSuggestionHold.held) {
        await new Promise(resolve => window.tagSuggestionHold.waiting.push(resolve));
      }
      return response;
    };
  });
}

async function hold(page) {
  await page.evaluate(() => { window.tagSuggestionHold.held = true; });
}

async function release(page) {
  await page.evaluate(() => {
    window.tagSuggestionHold.held = false;
    for (const resolve of window.tagSuggestionHold.waiting.splice(0)) resolve();
  });
  await idle(page);
  await pause(SETTLE_MS);
}

async function waitForHeldRequest(page) {
  await page.waitForFunction(() => window.tagSuggestionHold.waiting.length > 0);
}

function tagBarState(page) {
  return page.evaluate(() => {
    const input = document.querySelector('.note.editing .note-tag-bar-input');
    const list = document.querySelector('.note.editing .note-tag-suggestions');
    const isListShown = list !== null && !list.hidden;
    const entries = isListShown ? [...list.querySelectorAll('.note-tag-suggestion')] : [];
    return {
      value: input.value,
      open: isListShown,
      entries: entries.map(entry => entry.dataset.tag),
      selected: entries.findIndex(entry => entry.classList.contains('is-selected')),
    };
  });
}

// An empty tag bar with the cursor in it, the list for the empty bar settled.
async function clearTagBar(page) {
  await page.click('.note.editing .note-tag-bar-input', {clickCount: 3});
  await page.keyboard.press('Backspace');
  await idle(page);
  await pause(SETTLE_MS);
  assert.equal((await tagBarState(page)).value, '', 'the tag bar is empty');
}

// Type, then wait for the list built for what was typed.
async function typeAndWaitForList(page, text) {
  await page.keyboard.type(text);
  await idle(page);
  await pause(SETTLE_MS);
  const state = await tagBarState(page);
  assert.equal(state.value, text, `typed ${text}`);
  assert.ok(state.open && state.entries.length > 0, `a list is shown for ${text}: ${JSON.stringify(state)}`);
  return state;
}

async function staleEnterCase(page) {
  await clearTagBar(page);
  const old = await typeAndWaitForList(page, 'zeb');
  assert.deepEqual(old.entries, ['zebrafoo'], 'the list for zeb');
  await hold(page);
  for (let count = 0; count < 'zeb'.length; count += 1) await page.keyboard.press('Backspace');
  await page.keyboard.type('qux');
  await waitForHeldRequest(page);
  assert.deepEqual((await tagBarState(page)).entries, ['zebrafoo'], 'the list for zeb is still on screen');
  await page.keyboard.press('Enter');
  await release(page);
  const state = await tagBarState(page);
  assert.equal(state.value, 'qux', 'Enter leaves the typed text alone');
  assert.equal(state.open, false, 'the old list is closed, and no list follows the Enter');
}

async function freshEnterCase(page) {
  await clearTagBar(page);
  const shown = await typeAndWaitForList(page, 'zeb');
  assert.equal(shown.selected, 0, 'the first suggestion is highlighted');
  await page.keyboard.press('Enter');
  await idle(page);
  await pause(SETTLE_MS);
  assert.equal((await tagBarState(page)).value, shown.entries[0], 'Enter applies the highlighted suggestion');
}

async function freshArrowCase(page) {
  await clearTagBar(page);
  const shown = await typeAndWaitForList(page, 'qux');
  assert.ok(shown.entries.length >= 2, `the list for qux has two suggestions: ${shown.entries}`);
  await page.keyboard.press('ArrowDown');
  assert.equal((await tagBarState(page)).selected, 1, 'the arrow moves the highlight');
  await page.keyboard.press('Enter');
  await idle(page);
  await pause(SETTLE_MS);
  assert.equal((await tagBarState(page)).value, shown.entries[1], 'Enter applies the suggestion the arrow picked');
}

async function staleArrowCase(page) {
  await clearTagBar(page);
  await typeAndWaitForList(page, 'q');
  await hold(page);
  await page.keyboard.type('u');
  await waitForHeldRequest(page);
  await page.keyboard.press('ArrowDown');
  assert.equal((await tagBarState(page)).selected, 0, 'the arrow does not move through the old list');
  await release(page);
  const state = await tagBarState(page);
  assert.equal(state.value, 'qu', 'the text is unchanged');
  assert.equal(state.open, true, 'the new list is shown');
  assert.equal(state.selected, 0, 'its first suggestion is highlighted, not one the arrow picked in the old list');
}

async function arrivesWhileTypingCase(page) {
  await clearTagBar(page);
  await hold(page);
  await page.keyboard.type('zeb');
  await waitForHeldRequest(page);
  await release(page);
  const state = await tagBarState(page);
  assert.equal(state.value, 'zeb', 'the text is unchanged');
  assert.deepEqual(state.entries, ['zebrafoo'], 'the list shown is the one for what is in the bar');
}

export async function checkTagBarSuggestions(page) {
  const ids = await createNotes(page);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await installHold(page);
  await runThenCleanUp('tag bar suggestions', async () => {
    await page.click(`[data-note-id="${ids[0]}"] > .note-content`);
    await page.waitForSelector('.note.editing .note-tag-bar-input');
    await idle(page);
    // Every case runs, and their assertion failures are reported together.
    const failures = [];
    for (const [label, run] of [
      ['Enter on an old list', staleEnterCase],
      ['Enter on an up-to-date list', freshEnterCase],
      ['arrow then Enter on an up-to-date list', freshArrowCase],
      ['arrow on an old list', staleArrowCase],
      ['a list arriving while typing', arrivesWhileTypingCase],
    ]) {
      try {
        await run(page);
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        failures.push(`${label}: ${error.message}`);
        await release(page);
      }
    }
    await clearTagBar(page);
    await page.keyboard.press('Escape');
    await idle(page);
    if (failures.length > 0) throw new assert.AssertionError({message: failures.join('\n')});
  }, async () => {
    await page.evaluate(async ids => {
      window.fetch = window.tagSuggestionHold.originalFetch;
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const id of ids) await NotesAPI.deleteNote(id);
    }, ids);
  });
}
