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

// Right-clicking the search box past what is typed (or an empty box) offers View and
// Sort by, the background menu's two; on a typed tag it still offers the tag's own menu.
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
  assert.deepEqual(await rightClickSearch(page, 'past-text'), ['View', 'Sort by'], 'an empty search box offers View and Sort by');
  await page.click('#search-input');
  await page.keyboard.type('menucheck');
  await idle(page);
  await page.keyboard.press('Escape');
  assert.deepEqual(await rightClickSearch(page, 'past-text'), ['View', 'Sort by'], 'past the typed tag: View and Sort by');
  assert.deepEqual(await rightClickSearch(page, 'on-text'), ['Edit Tag Relationships'], 'on the typed tag: its own menu');
  await clearSearch(page);
}
