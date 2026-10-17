import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';

// Switching tabs: after each switch, the notes shown, the search box and the
// server's active tab all belong to the tab that was picked.

const SETTLE_MS = 400;
// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
// Each tab is switched to and from this many times.
const ROUND_TRIPS = 4;
const TAB_QUERIES = ['scratchpad', 'todo'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return !mode.isLoading && !CommandGate.isBusy();
  });
  await page.waitForNetworkIdle({idleTime: NETWORK_IDLE_MS});
}

async function createNotes(page) {
  return page.evaluate(async queries => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    for (const tag of queries) {
      for (const index of [1, 2]) {
        const note = await NotesAPI.createNote(null, '');
        await NotesAPI.saveNote(note.id, `<p>Tab switch ${tag} note ${index}</p>`, tag);
        ids.push(note.id);
      }
    }
    return ids;
  }, TAB_QUERIES);
}

async function searchFor(page, query) {
  await page.click('#search-input', {clickCount: 3});
  await page.keyboard.type(query);
  await idle(page);
  await pause(SETTLE_MS);
  await page.keyboard.press('Enter');
  await idle(page);
  await pause(SETTLE_MS);
}

async function viewState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    const response = await fetch('/api2/notes/tab-state', {headers: buildSessionHeaders(false), cache: 'no-store'});
    if (!response.ok) throw new Error(`tab-state read failed with status ${response.status}`);
    const server = await response.json();
    const shown = [...document.querySelectorAll('#notes-container .note > .note-content')]
      .filter(node => node.getClientRects().length > 0)
      .map(node => node.textContent.trim())
      .filter(text => text.startsWith('Tab switch '));
    return {
      activeTabId: mode.activeTabId,
      serverActiveTabId: server.activeTabId,
      searchQuery: mode.searchQuery,
      searchInput: document.getElementById('search-input').value,
      shown,
    };
  });
}

async function clickTab(page, tabId) {
  const zone = await (await page.$('#tab-hover-zone')).boundingBox();
  await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2);
  await page.waitForSelector(`#search-contexts-list .tab-context-item[data-tab-id="${tabId}"]`, {visible: true});
  await pause(SETTLE_MS);
  await page.click(`#search-contexts-list .tab-context-item[data-tab-id="${tabId}"] .tab-context-query`);
  await idle(page);
  await pause(SETTLE_MS);
}

function expectTab(state, tabId, query, label) {
  assert.equal(state.activeTabId, tabId, `${label}: the picked tab is active`);
  assert.equal(state.serverActiveTabId, tabId, `${label}: the server has the picked tab active`);
  assert.equal(state.searchQuery, query, `${label}: the tab's search is active`);
  assert.equal(state.searchInput, query, `${label}: the search box shows the tab's search`);
  assert.deepEqual(state.shown.toSorted(), [`Tab switch ${query} note 1`, `Tab switch ${query} note 2`],
    `${label}: only the tab's notes are shown`);
}

export async function checkTabSwitching(page) {
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.applyPreference('pref.show_tab_ui', true);
  });
  const ids = await createNotes(page);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await runThenCleanUp('tab switching', async () => {
    const firstTabId = (await viewState(page)).activeTabId;
    await searchFor(page, TAB_QUERIES[0]);
    expectTab(await viewState(page), firstTabId, TAB_QUERIES[0], 'first tab searched');
    await page.evaluate(async () => {
      const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
      const {createBlankSearchContextFromHover} = await import('/static/js/modules/mode-manager/events/keyboard-events.js');
      await CommandGate.run('test.new_tab', () => createBlankSearchContextFromHover());
    });
    await idle(page);
    const secondTabId = (await viewState(page)).activeTabId;
    assert.notEqual(secondTabId, firstTabId, 'a new tab is active');
    await searchFor(page, TAB_QUERIES[1]);
    expectTab(await viewState(page), secondTabId, TAB_QUERIES[1], 'second tab searched');
    for (let round = 1; round <= ROUND_TRIPS; round += 1) {
      await clickTab(page, firstTabId);
      expectTab(await viewState(page), firstTabId, TAB_QUERIES[0], `round ${round}, back to the first tab`);
      await clickTab(page, secondTabId);
      expectTab(await viewState(page), secondTabId, TAB_QUERIES[1], `round ${round}, back to the second tab`);
    }
  }, async () => {
    await page.evaluate(async ids => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const id of ids) await NotesAPI.deleteNote(id);
    }, ids);
  });
}
