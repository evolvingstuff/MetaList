import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Edit Tag Relationships' tag search acts only on a result list built for the
// text in its box, as the search box and the tag bar do. While a new list is
// on its way, the list on screen is for older text: Enter then closes it and
// opens the tag that was typed (what Enter does with no list), and the arrows
// wait for the new list. Each case holds the tag search response, so the old
// list is on screen for certain.

const SETTLE_MS = 400;
// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;
const TAGS = ['quxalpha', 'quxbeta', 'zebrafoo'];
const INPUT = '#ontology-search-input';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
  await pause(SETTLE_MS);
}

async function createNotes(page) {
  return page.evaluate(async tags => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    for (const tag of tags) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, `<p>Ontology search ${tag} note</p>`, tag);
      ids.push(note.id);
    }
    return ids;
  }, TAGS);
}

// Tag search responses wait while held, until released; every tag Enter opens is recorded.
async function installHold(page) {
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    window.ontologySearchHold = {originalFetch, held: false, waiting: [], focused: []};
    window.fetch = async (url, options) => {
      const parsed = new URL(url, location.href);
      if (parsed.pathname === '/api2/ontology/focus') window.ontologySearchHold.focused.push(parsed.searchParams.get('tag'));
      const response = await originalFetch(url, options);
      if (parsed.pathname === '/api2/ontology/tags' && window.ontologySearchHold.held) {
        await new Promise(resolve => window.ontologySearchHold.waiting.push(resolve));
      }
      return response;
    };
  });
}

async function hold(page) {
  await page.evaluate(() => { window.ontologySearchHold.held = true; });
}

async function release(page) {
  await page.evaluate(() => {
    window.ontologySearchHold.held = false;
    for (const resolve of window.ontologySearchHold.waiting.splice(0)) resolve();
  });
  await idle(page);
}

async function waitForHeldRequest(page) {
  await page.waitForFunction(() => window.ontologySearchHold.waiting.length > 0);
}

function searchState(page) {
  return page.evaluate(input => {
    const list = document.getElementById('ontology-search-results');
    const isListShown = list !== null && list.style.display !== 'none';
    const items = isListShown ? [...list.querySelectorAll('.ontology-search-result')] : [];
    return {
      value: document.querySelector(input).value,
      open: isListShown && items.length > 0,
      tags: items.map(item => item.dataset.tag),
      selected: items.findIndex(item => item.classList.contains('is-selected')),
      focused: [...window.ontologySearchHold.focused],
    };
  }, INPUT);
}

// An empty search box with the cursor in it, nothing opened yet in this case.
async function clearSearch(page) {
  await page.click(INPUT, {clickCount: 3});
  await page.keyboard.press('Backspace');
  await idle(page);
  await page.evaluate(() => { window.ontologySearchHold.focused.splice(0); });
  assert.equal((await searchState(page)).value, '', 'the search box is empty');
}

// Type, then wait for the list built for what was typed.
async function typeAndWaitForList(page, text) {
  await page.keyboard.type(text);
  await idle(page);
  const state = await searchState(page);
  assert.equal(state.value, text, `typed ${text}`);
  assert.ok(state.open, `a list is shown for ${text}: ${JSON.stringify(state)}`);
  return state;
}

async function staleEnterCase(page) {
  await clearSearch(page);
  const old = await typeAndWaitForList(page, 'zeb');
  assert.deepEqual(old.tags, ['zebrafoo'], 'the list for zeb');
  await hold(page);
  for (let count = 0; count < 'zeb'.length; count += 1) await page.keyboard.press('Backspace');
  await page.keyboard.type('quxalpha');
  await waitForHeldRequest(page);
  assert.deepEqual((await searchState(page)).tags, ['zebrafoo'], 'the list for zeb is still on screen');
  await page.keyboard.press('Enter');
  await release(page);
  const state = await searchState(page);
  assert.deepEqual(state.focused, ['quxalpha'], 'Enter opens the tag that was typed, not the old suggestion');
  assert.equal(state.open, false, 'the old list is closed, and no list follows the Enter');
}

async function freshEnterCase(page) {
  await clearSearch(page);
  const shown = await typeAndWaitForList(page, 'zeb');
  assert.equal(shown.selected, 0, 'the first result is highlighted');
  await page.keyboard.press('Enter');
  await idle(page);
  assert.deepEqual((await searchState(page)).focused, [shown.tags[0]], 'Enter opens the highlighted result');
}

async function freshArrowCase(page) {
  await clearSearch(page);
  const shown = await typeAndWaitForList(page, 'qux');
  assert.ok(shown.tags.length >= 2, `the list for qux has two results: ${shown.tags}`);
  await page.keyboard.press('ArrowDown');
  assert.equal((await searchState(page)).selected, 1, 'the arrow moves the highlight');
  await page.keyboard.press('Enter');
  await idle(page);
  assert.deepEqual((await searchState(page)).focused, [shown.tags[1]], 'Enter opens the result the arrow picked');
}

async function staleArrowCase(page) {
  await clearSearch(page);
  await typeAndWaitForList(page, 'qu');
  await hold(page);
  await page.keyboard.type('x');
  await waitForHeldRequest(page);
  await page.keyboard.press('ArrowDown');
  assert.equal((await searchState(page)).selected, 0, 'the arrow does not move through the old list');
  await release(page);
  const state = await searchState(page);
  assert.equal(state.value, 'qux', 'the text is unchanged');
  assert.equal(state.open, true, 'the new list is shown');
  assert.equal(state.selected, 0, 'its first result is highlighted, not one the arrow picked in the old list');
}

async function arrivesWhileTypingCase(page) {
  await clearSearch(page);
  await hold(page);
  await page.keyboard.type('zeb');
  await waitForHeldRequest(page);
  await release(page);
  const state = await searchState(page);
  assert.equal(state.value, 'zeb', 'the text is unchanged');
  assert.deepEqual(state.tags, ['zebrafoo'], 'the list shown is the one for what is in the box');
}

export async function checkOntologySearch(page) {
  const ids = await createNotes(page);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await installHold(page);
  await runThenCleanUp('ontology search', async () => {
    await page.evaluate(async () => {
      const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
      await CommandPalette.openOntologyEditor();
    });
    await page.waitForSelector(INPUT, {visible: true});
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
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const modal = document.getElementById('ontology-modal');
      return modal === null || modal.style.display === 'none';
    });
    if (failures.length > 0) throw new assert.AssertionError({message: failures.join('\n')});
  }, async () => {
    await page.evaluate(async ids => {
      window.fetch = window.ontologySearchHold.originalFetch;
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const id of ids) await NotesAPI.deleteNote(id);
    }, ids);
  });
}
