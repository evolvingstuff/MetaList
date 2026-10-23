import assert from 'node:assert/strict';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;

// A search that does not parse (here "- tag": a space after the minus) is an
// expected failure: MetaList explains it in a polite banner and carries on.
// It never shows the fatal error overlay, also not when Enter then adds a
// note while that search is active (notes take their tags from the search).

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function typingWarning(page) {
  return page.evaluate(() => {
    const message = document.getElementById('search-validation-message');
    return message && !message.hidden ? message.textContent : '';
  });
}

function executedSearch(page) {
  return page.evaluate(async () => (await import('/static/js/modules/mode-manager/mode-context.js')).ModeContextInstance.getExecutedSearchQuery());
}

function rootCount(page) {
  return page.evaluate(async () => (await import('/static/js/modules/mode-manager/mode-context.js')).ModeContextInstance.rootCountTotal);
}

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
}

async function clearSearch(page) {
  await page.focus('#search-input');
  await page.evaluate(() => document.getElementById('search-input').select());
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await idle(page);
  const left = await page.evaluate(() => document.getElementById('search-input').value);
  assert.equal(left, '', 'the search field is cleared after the test');
}

export async function checkSearchInputRejected(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  const before = await rootCount(page);

  // Typing: the explanation shows under the search field, and nothing new
  // runs (above all not "tag", the opposite of what was meant).
  await page.click('#search-input');
  await page.keyboard.type('- tag');
  await pause(600);
  assert.match(await typingWarning(page), /no space \(for example -tag\)/, 'typing "- tag" explains the fix under the search field');
  assert.equal(await executedSearch(page), '', 'typing "- tag" runs no search');

  // Searching: a polite explanation instead of an error.
  await page.keyboard.press('Enter');
  await idle(page);
  await pause(300);
  const searchBanner = await bannerText(page);
  assert.match(searchBanner, /no space \(for example -tag\)/, `searching "- tag" explains the fix politely, got "${searchBanner}"`);
  assert.equal(await fatalText(page), '', 'searching "- tag" must not show the fatal error overlay');

  // Enter outside the search field adds a note with the search's tags: the
  // same polite explanation, no note, no fatal error.
  await page.mouse.click(5, 400);
  await pause(300);
  await page.keyboard.press('Enter');
  await idle(page);
  await pause(300);
  const createBanner = await bannerText(page);
  assert.match(createBanner, /no space \(for example -tag\)/, `adding a note under "- tag" explains the fix politely, got "${createBanner}"`);
  assert.equal(await fatalText(page), '', 'adding a note under "- tag" must not show the fatal error overlay');
  assert.equal(await rootCount(page), before, 'no note is added while the search does not parse');

  // After a reload with "- tag" still in the field, it is not run as "tag".
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  assert.notEqual(await executedSearch(page), 'tag', 'a restored "- tag" never runs as "tag"');
  assert.equal(await fatalText(page), '', 'restoring "- tag" must not show the fatal error overlay');

  await clearSearch(page);
}

// Right-clicking the search box past what is typed (or an empty box) offers View,
// Sort by and Date range, as the background menu does; on a typed tag it still
// offers the tag's own menu.
async function rightClickSearch(page, where) {
  const point = await page.evaluate(where => {
    const input = document.getElementById('search-input');
    const box = input.getBoundingClientRect();
    const y = box.top + box.height / 2;
    if (where === 'past-text') return {x: box.right - 40, y};
    // On the first character of the typed text.
    const style = getComputedStyle(input);
    return {x: box.left + parseFloat(style.paddingLeft) + 3, y};
  }, where);
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await page.waitForSelector('#context-menu.is-visible');
  const labels = await page.evaluate(() => [...document.querySelectorAll('#context-menu.is-visible .context-menu-item-label')]
    .map(node => node.textContent.trim()));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#context-menu.is-visible') === null);
  return labels;
}

export async function checkSearchBarMenu(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  assert.deepEqual(await rightClickSearch(page, 'past-text'), ['View', 'Sort by', 'Date range'], 'an empty search box offers View, Sort by and Date range');
  await page.click('#search-input');
  await page.keyboard.type('menucheck');
  await idle(page);
  await page.keyboard.press('Escape');
  assert.deepEqual(await rightClickSearch(page, 'past-text'), ['View', 'Sort by', 'Date range'], 'past the typed tag: View, Sort by and Date range');
  assert.deepEqual(await rightClickSearch(page, 'on-text'), ['Edit Tag Relationships'], 'on the typed tag: its own menu');
  await clearSearch(page);
}

function dateRangeChip(page) {
  return page.evaluate(() => {
    const chip = document.getElementById('date-range-indicator');
    return chip.classList.contains('is-shown') ? document.getElementById('date-range-indicator-label').textContent : '';
  });
}

// Picks Date range → <range> from the search box's menu past the typed text.
async function pickDateRange(page, label) {
  const box = await page.evaluate(() => {
    const rect = document.getElementById('search-input').getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  });
  await page.mouse.click(box.x, box.y, {button: 'right'});
  await page.waitForSelector('#context-menu.is-visible');
  const item = await page.evaluate(() => {
    const node = [...document.querySelectorAll('#context-menu.is-visible .context-menu-item-label')]
      .find(label => label.textContent.trim() === 'Date range');
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  });
  assert.ok(item, 'the search box menu offers Date range');
  // Pointing at it opens its submenu.
  await page.mouse.move(item.x, item.y);
  const point = await page.waitForFunction(label => {
    const node = [...document.querySelectorAll('#context-submenu .context-menu-item-label')].find(item => item.textContent.trim() === label);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0) return null;
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  }, {}, label);
  const {x, y} = await point.jsonValue();
  await page.mouse.click(x, y);
  await idle(page);
}

// Date range filters the root notes by date and shows a chip; its × and a new
// search end it, as they end a sort order (docs/ui/controls.md).
export async function checkDateRange(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  const all = await rootCount(page);
  assert.ok(all > 0, 'the vault has notes to filter');
  assert.equal(await dateRangeChip(page), '', 'no date range at first');

  await pickDateRange(page, 'Today');
  assert.equal(await dateRangeChip(page), 'Updated · today', 'the chip names the date and the range');
  const today = await rootCount(page);
  assert.ok(today <= all, 'Today shows no more notes than every date');

  // A range that ends before any note was written shows none.
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    await CommandGate.run('test.dateRange.custom', async () => {
      await CommandPalette.setDateFilter({field: 'created', rangeKind: 'custom', fromDate: '', toDate: '2000-01-01'});
    });
  });
  await idle(page);
  assert.equal(await rootCount(page), 0, 'nothing was created before 2000');
  assert.match(await dateRangeChip(page), /^Created · until /, 'a custom range names its end');

  // The chip's × shows every date again.
  await page.click('#date-range-indicator-clear');
  await idle(page);
  assert.equal(await dateRangeChip(page), '', 'the × ends the date range');
  assert.equal(await rootCount(page), all, 'every note is back');

  // Typing a new search ends it too.
  await pickDateRange(page, 'Today');
  assert.equal(await dateRangeChip(page), 'Updated · today');
  await page.click('#search-input');
  await page.keyboard.type('datecheck');
  await idle(page);
  assert.equal(await dateRangeChip(page), '', 'a new search ends the date range');
  const ended = await page.evaluate(async () => (await import('/static/js/modules/mode-manager/services/date-range-filter-service.js')).getActiveDateFilter());
  assert.equal(ended, null, 'the server has no date range for the tab');
  await page.keyboard.press('Escape');
  await clearSearch(page);
}
