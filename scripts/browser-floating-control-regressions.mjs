import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Floating controls pressed while a note is being edited (docs/ui/interaction-principles.md):
// - the error banner's × closes it on the first press and leaves the note in edit mode,
//   as the notice cards and the Reminders popup do;
// - Zoom Image is full screen, so opening it saves and leaves the note first
//   (principle 6), and its × then closes it on the first press.

const SETTLE_MS = 400;
// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;
// Where in the image the menu is opened: its middle.
const MIDDLE = 0.5;
// A 48×48 red PNG (as in browser-image-menu-regressions.mjs).
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQklEQVR4nO3OQQ0AIAwAsQlDBLKRhQuOR5MK6Jy9vjL5QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF21V9KbVaAsfAAAAAElFTkSuQmCC';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
}

function modeState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {editing: mode.isEditing, current: mode.currentNoteId};
  });
}

async function createNote(page, html) {
  return page.evaluate(async html => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, html, '');
    return note.id;
  }, html);
}

// Click just after the given text, so the caret lands there and the note is edited.
async function startEditingAfter(page, noteId, text) {
  const point = await page.evaluate(({noteId, text}) => {
    const content = document.querySelector(`.note[data-note-id="${noteId}"] > .note-content`);
    content.scrollIntoView({block: 'center'});
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent.indexOf(text);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at + text.length - 1);
      range.setEnd(node, at + text.length);
      const rect = range.getBoundingClientRect();
      return {x: rect.right - 1, y: rect.top + rect.height / 2};
    }
    throw new Error(`text not found: ${text}`);
  }, {noteId, text});
  await page.mouse.click(point.x, point.y);
  await idle(page);
  await pause(SETTLE_MS);
  assert.deepEqual(await modeState(page), {editing: true, current: noteId}, 'the note is being edited');
}

async function bannerCase(page, noteId) {
  await startEditingAfter(page, noteId, 'Banner note');
  await page.evaluate(async () => {
    const {ErrorHandler} = await import('/static/js/modules/error-handler.js');
    ErrorHandler.showErrorBanner('Something went wrong (test)', 'error', 0, { closable: true });
  });
  await page.waitForSelector('#error-banner.error-banner-visible .error-banner-close', {visible: true});
  // The banner slides in; press its × once it has settled, with a real mouse press.
  await pause(SETTLE_MS);
  const close = await (await page.$('#error-banner .error-banner-close')).boundingBox();
  assert.notEqual(close, null, 'the banner shows its ×');
  await page.mouse.click(close.x + close.width / 2, close.y + close.height / 2);
  await pause(SETTLE_MS);
  await idle(page);
  assert.equal(await page.$('#error-banner.error-banner-visible'), null, 'one press of × closes the banner');
  assert.deepEqual(await modeState(page), {editing: true, current: noteId}, 'the note stays in edit mode');
  await page.keyboard.press('Escape');
  await idle(page);
}

async function zoomCase(page, noteId) {
  await startEditingAfter(page, noteId, 'Zoom note');
  const selector = `.note[data-note-id="${noteId}"] > .note-content img`;
  await page.waitForFunction(selector => {
    const image = document.querySelector(selector);
    return image !== null && image.complete && image.getBoundingClientRect().width > 0;
  }, {}, selector);
  const box = await (await page.$(selector)).boundingBox();
  await page.mouse.click(box.x + box.width * MIDDLE, box.y + box.height * MIDDLE, {button: 'right'});
  await page.waitForSelector('#context-menu.is-visible');
  const item = await page.evaluateHandle(() => [...document.querySelectorAll('#context-menu.is-visible .context-menu-item')]
    .find(node => node.querySelector('.context-menu-item-label').textContent.trim() === 'Zoom Image'));
  assert.notEqual(item.asElement(), null, 'the image menu offers Zoom Image while editing');
  await item.asElement().click();
  await page.waitForSelector('.image-zoom-overlay', {visible: true});
  await idle(page);
  assert.equal((await modeState(page)).editing, false, 'opening Zoom Image saves and leaves the note');
  await pause(SETTLE_MS);
  const zoomClose = await (await page.$('.image-zoom-overlay .image-zoom-close')).boundingBox();
  assert.notEqual(zoomClose, null, 'the zoom shows its ×');
  await page.mouse.click(zoomClose.x + zoomClose.width / 2, zoomClose.y + zoomClose.height / 2);
  await pause(SETTLE_MS);
  await idle(page);
  assert.equal(await page.$('.image-zoom-overlay'), null, 'one press of × closes the zoom');
}

export async function checkFloatingControlsWhileEditing(page) {
  const bannerNoteId = await createNote(page, '<p>Banner note</p>');
  const zoomNoteId = await createNote(page, `<p>Zoom note</p><p><img src="data:image/png;base64,${PNG_BASE64}" alt="dot"></p>`);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await runThenCleanUp('floating controls', async () => {
    // Every case runs, and their assertion failures are reported together.
    const failures = [];
    for (const [label, run] of [['banner', () => bannerCase(page, bannerNoteId)], ['zoom', () => zoomCase(page, zoomNoteId)]]) {
      try {
        await run();
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        failures.push(`${label}: ${error.message}`);
        await page.keyboard.press('Escape');
        await idle(page);
      }
    }
    if (failures.length > 0) throw new assert.AssertionError({message: failures.join('\n')});
  }, async () => {
    await page.evaluate(async ids => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const id of ids) await NotesAPI.deleteNote(id);
    }, [bannerNoteId, zoomNoteId]);
  });
}
