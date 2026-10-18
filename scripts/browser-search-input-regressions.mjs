import assert from 'node:assert/strict';
import { waitForAppIdle } from './browser-app-idle.mjs';

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
  await waitForAppIdle(page);
  await page.waitForNetworkIdle({idleTime: 300});
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
