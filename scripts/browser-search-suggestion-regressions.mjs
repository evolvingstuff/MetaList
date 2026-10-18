import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppIdle } from './browser-app-idle.mjs';

// Search suggestions act only on a list built for the text in the box. While
// a new list is on its way, the list on screen is for older text: Enter then
// searches what was typed, and the arrows wait for the new list. Each case
// holds the suggestions response, so the old list is on screen for certain.

const SETTLE_MS = 400;
// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
const TAGS = ['scratchpad', 'today', 'todo'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppIdle(page);
  await page.waitForNetworkIdle({idleTime: NETWORK_IDLE_MS});
}

async function createNotes(page) {
  return page.evaluate(async tags => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    for (const tag of tags) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, `<p>Suggestion ${tag} note</p>`, tag);
      ids.push(note.id);
    }
    return ids;
  }, TAGS);
}

// Suggestion responses wait while held, until released.
async function installHold(page) {
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    window.suggestionHold = {originalFetch, held: false, waiting: []};
    window.fetch = async (url, options) => {
      const response = await originalFetch(url, options);
      if (new URL(url, location.href).pathname.endsWith('/search-suggestions') && window.suggestionHold.held) {
        await new Promise(resolve => window.suggestionHold.waiting.push(resolve));
      }
      return response;
    };
  });
}

async function hold(page) {
  await page.evaluate(() => { window.suggestionHold.held = true; });
}

async function release(page) {
  await page.evaluate(() => {
    window.suggestionHold.held = false;
    for (const resolve of window.suggestionHold.waiting.splice(0)) resolve();
  });
  await idle(page);
  await pause(SETTLE_MS);
}

async function waitForHeldRequest(page) {
  await page.waitForFunction(() => window.suggestionHold.waiting.length > 0);
}

function suggestionState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const list = document.getElementById('search-suggestions');
    const items = [...list.querySelectorAll('.search-suggestion')];
    return {
      value: document.getElementById('search-input').value,
      executed: mode.getExecutedSearchQuery(mode.activeTabId),
      open: !list.hidden,
      // Enter with no list open would add a new root note and edit it.
      editing: mode.isEditing,
      emptyNotes: [...document.querySelectorAll('#notes-container .note > .note-content')]
        .filter(node => node.textContent.trim() === '').length,
      tags: items.map(item => item.dataset.tag),
      selected: items.findIndex(item => item.classList.contains('is-selected')),
    };
  });
}

// An empty search box with the cursor in it and no list open.
async function clearSearch(page) {
  await page.click('#search-input', {clickCount: 3});
  await page.keyboard.press('Backspace');
  await idle(page);
  await pause(SETTLE_MS);
}

// Type, then wait for the list built for what was typed.
async function typeAndWaitForList(page, text) {
  await page.keyboard.type(text);
  await idle(page);
  await pause(SETTLE_MS);
  const state = await suggestionState(page);
  assert.equal(state.value, text, `typed ${text}`);
  assert.ok(state.open && state.tags.length > 0, `a list is shown for ${text}: ${JSON.stringify(state)}`);
  return state;
}

async function staleEnterCase(page) {
  await clearSearch(page);
  const old = await typeAndWaitForList(page, 'scr');
  assert.deepEqual(old.tags, ['scratchpad'], 'the list for scr');
  await hold(page);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('todo');
  await waitForHeldRequest(page);
  assert.deepEqual((await suggestionState(page)).tags, ['scratchpad'], 'the list for scr is still on screen');
  await page.keyboard.press('Enter');
  await release(page);
  const state = await suggestionState(page);
  assert.equal(state.value, 'todo', 'Enter keeps what was typed');
  assert.equal(state.executed, 'todo', 'the search runs on what was typed');
  assert.equal(state.open, false, 'the old list is closed, and no list follows the Enter');
  assert.equal(state.editing, false, 'Enter does not add a note');
  assert.equal(state.emptyNotes, 0, 'no empty note was added');
}

async function freshEnterCase(page) {
  await clearSearch(page);
  const shown = await typeAndWaitForList(page, 'scr');
  assert.equal(shown.selected, 0, 'the first suggestion is highlighted');
  await page.keyboard.press('Enter');
  await idle(page);
  await pause(SETTLE_MS);
  const state = await suggestionState(page);
  assert.equal(state.value, shown.tags[0], 'Enter applies the highlighted suggestion');
  assert.equal(state.executed, shown.tags[0], 'and searches for it');
}

async function freshArrowCase(page) {
  await clearSearch(page);
  const shown = await typeAndWaitForList(page, 'to');
  assert.equal(shown.tags.length >= 2, true, `the list for to has two suggestions: ${shown.tags}`);
  await page.keyboard.press('ArrowDown');
  assert.equal((await suggestionState(page)).selected, 1, 'the arrow moves the highlight');
  await page.keyboard.press('Enter');
  await idle(page);
  await pause(SETTLE_MS);
  const state = await suggestionState(page);
  assert.equal(state.value, shown.tags[1], 'Enter applies the suggestion the arrow picked');
  assert.equal(state.executed, shown.tags[1], 'and searches for it');
}

async function staleArrowCase(page) {
  await clearSearch(page);
  await typeAndWaitForList(page, 't');
  await hold(page);
  await page.keyboard.type('o');
  await waitForHeldRequest(page);
  await page.keyboard.press('ArrowDown');
  assert.equal((await suggestionState(page)).selected, 0, 'the arrow does not move through the old list');
  await release(page);
  const state = await suggestionState(page);
  assert.equal(state.value, 'to', 'the text is unchanged');
  assert.equal(state.open, true, 'the new list is shown');
  assert.equal(state.selected, 0, 'its first suggestion is highlighted, not one the arrow picked in the old list');
}

async function arrivesWhileTypingCase(page) {
  await clearSearch(page);
  await hold(page);
  await page.keyboard.type('scr');
  await waitForHeldRequest(page);
  await release(page);
  const state = await suggestionState(page);
  assert.equal(state.value, 'scr', 'the text is unchanged');
  assert.deepEqual(state.tags, ['scratchpad'], 'the list shown is the one for what is in the box');
}

export async function checkSearchSuggestions(page) {
  const ids = await createNotes(page);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await installHold(page);
  await runThenCleanUp('search suggestions', async () => {
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
    if (failures.length > 0) throw new assert.AssertionError({message: failures.join('\n')});
  }, async () => {
    await page.evaluate(async ids => {
      window.fetch = window.suggestionHold.originalFetch;
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const id of ids) await NotesAPI.deleteNote(id);
    }, ids);
  });
}
