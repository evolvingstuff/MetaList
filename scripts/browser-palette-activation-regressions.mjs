import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;

// One activation of a command palette item does one thing. Picking an item first
// records the use (a round trip to the server) and only then runs it; a second
// activation in that time (a double-click, Enter twice, a click then Enter) used to
// run the item again, so a dialog opened twice: "[BaseModal] ontologyModal is already
// open" (reported 2026-10-19). The cases agreed with the user:
//   1. double-click a dialog item: it opens once, no error
//   2. Enter twice quickly: it opens once
//   3. a click, then Enter while it starts: it opens once
//   4. double-click an on/off setting: it toggles once
//   5. an item, then another after the first finished: both run
// and after each one the user is still signed in ("ontology ontology" then Enter, and
// Enter twice, were reported to sign the user out).

const DIALOG_ITEM = 'action.edit_tag_relationships';
const DIALOG_QUERY = 'ontology';
const DIALOG_ELEMENT = '#ontology-modal';
const TOGGLE_ITEM = 'pref.show_search_results_count';
const TOGGLE_QUERY = 'results count';
const SECOND_DIALOG_ITEM = 'form.version_info';
const SECOND_DIALOG_QUERY = 'pypi';
const SETTLE_MS = 400;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
  await pause(SETTLE_MS);
}

function fatalText(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById('fatal-error-overlay');
    return overlay ? overlay.textContent : '';
  });
}

async function openPaletteAt(page, query, endpointId) {
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.open();
  });
  await page.waitForSelector('#command-palette-input', {visible: true});
  await page.type('#command-palette-input', query);
  const row = await page.waitForSelector(`#command-palette-results [data-endpoint-id="${endpointId}"]`, {visible: true});
  // The typed query puts the item first, so Enter activates the same row.
  assert.equal(await page.$eval('#command-palette-results [data-endpoint-id]', first => first.dataset.endpointId),
    endpointId, `"${query}" lists ${endpointId} first`);
  return row;
}

function openModals(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return [...ModeContextInstance.modalStack];
  });
}

async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(async () => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return ModeContextInstance.modalStack.length === 0;
  });
  await idle(page);
}

// Still signed in: neither the login panel nor the lock page took over.
async function assertSignedIn(page, label) {
  const state = await page.evaluate(() => ({
    path: window.location.pathname,
    loginShown: document.querySelector('#login-panel[data-revealed="true"]') !== null,
    appReady: document.querySelector('[data-app-ready="true"]') !== null,
  }));
  assert.deepEqual(state, {path: '/', loginShown: false, appReady: true}, `${label}: still signed in`);
}

async function assertOpenedOnce(page, label) {
  await idle(page);
  assert.equal(await fatalText(page), '', `${label}: no error`);
  await assertSignedIn(page, label);
  assert.deepEqual(await openModals(page), ['ontologyModal'], `${label}: the dialog is open once`);
  await page.waitForSelector(DIALOG_ELEMENT, {visible: true});
  await closeDialog(page);
}

async function doubleClickDialogItem(page) {
  const row = await openPaletteAt(page, DIALOG_QUERY, DIALOG_ITEM);
  const box = await row.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {clickCount: 2});
  await assertOpenedOnce(page, 'double-click');
}

async function enterTwice(page) {
  await openPaletteAt(page, DIALOG_QUERY, DIALOG_ITEM);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await assertOpenedOnce(page, 'Enter twice');
}

async function queryTypedTwice(page) {
  await openPaletteAt(page, `${DIALOG_QUERY} ${DIALOG_QUERY}`, DIALOG_ITEM);
  await page.keyboard.press('Enter');
  await assertOpenedOnce(page, 'query typed twice');
}

async function clickThenEnter(page) {
  const row = await openPaletteAt(page, DIALOG_QUERY, DIALOG_ITEM);
  await row.click();
  await page.keyboard.press('Enter');
  await assertOpenedOnce(page, 'click then Enter');
}

function toggleValue(page) {
  return page.evaluate(async id => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    const endpoint = CommandPalette._endpoints.find(entry => entry.id === id);
    return CommandPalette._getBoolean(endpoint.persistenceKey, endpoint.defaultValue);
  }, TOGGLE_ITEM);
}

async function doubleClickToggle(page) {
  const before = await toggleValue(page);
  const row = await openPaletteAt(page, TOGGLE_QUERY, TOGGLE_ITEM);
  const box = await row.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {clickCount: 2});
  await idle(page);
  assert.equal(await fatalText(page), '', 'double-clicking a setting: no error');
  assert.equal(await toggleValue(page), !before, 'double-clicking a setting toggles it once');
  // Put it back, with one deliberate activation.
  await page.keyboard.press('Enter');
  await idle(page);
  assert.equal(await toggleValue(page), before, 'the setting is back as it was');
  await page.keyboard.press('Escape');
  await idle(page);
}

async function twoItemsInTurn(page) {
  await openPaletteAt(page, DIALOG_QUERY, DIALOG_ITEM);
  await page.keyboard.press('Enter');
  await assertOpenedOnce(page, 'first item');
  await openPaletteAt(page, SECOND_DIALOG_QUERY, SECOND_DIALOG_ITEM);
  await page.keyboard.press('Enter');
  await idle(page);
  assert.equal(await fatalText(page), '', 'second item: no error');
  assert.deepEqual(await openModals(page), ['versionInfoModal'], 'the second item runs too');
  await closeDialog(page);
}

export async function checkPaletteActivation(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await runThenCleanUp('palette activation', async () => {
    // Every case runs, and their assertion failures are reported together.
    const failures = [];
    for (const [label, run] of [['double-click a dialog item', doubleClickDialogItem], ['Enter twice', enterTwice],
      ['query typed twice', queryTypedTwice],
      ['click then Enter', clickThenEnter], ['double-click a setting', doubleClickToggle],
      ['two items in turn', twoItemsInTurn]]) {
      try {
        await run(page);
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        failures.push(`${label}: ${error.message}`);
        // A failed case leaves whatever it opened: reload to a clean page for the next.
        await page.reload();
        await page.waitForSelector('[data-app-ready="true"]');
        await idle(page);
      }
    }
    if (failures.length > 0) throw new assert.AssertionError({message: failures.join('\n')});
  }, async () => {});
}
