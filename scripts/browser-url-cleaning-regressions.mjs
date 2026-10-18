import assert from 'node:assert/strict';
import { waitForAppIdle } from './browser-app-idle.mjs';

// Tracking junk removed from pasted URLs (docs/ui/paste-sanitization.md): a
// pasted URL, URLs in pasted prose, and links in pasted HTML lose their
// tracking parameters silently; nothing else changes, undo restores the
// paste as it was on the clipboard, and typed text is never touched.

const SETTLE_MS = 400;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppIdle(page);
  await page.waitForNetworkIdle({idleTime: 300});
}

async function reloadApp(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}

async function createNote(page, content) {
  return page.evaluate(async content => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, content, '');
    return note.id;
  }, content);
}

async function startEditing(page, noteId) {
  await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).scrollIntoView({block: 'center'}), noteId);
  const box = await (await page.$(`.note[data-note-id="${noteId}"] > .note-content`)).boundingBox();
  await page.mouse.click(box.x + 10, box.y + box.height / 2);
  // Editing has started once the note's content is editable (the mode flips first, the editor follows).
  await page.waitForFunction(async id => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const content = document.querySelector(`.note[data-note-id="${id}"] > .note-content`);
    return mode.isEditing && mode.currentNoteId === id && content !== null && content.isContentEditable;
  }, {}, noteId);
}

// A paste at the end of the edited note's text. Resolves to whether MetaList
// took the paste over (a synthetic paste the browser is left to do inserts
// nothing, so only MetaList's own insertions show in the note).
function paste(page, noteId, text, html) {
  return page.evaluate(({noteId, text, html}) => {
    const content = document.querySelector(`[data-note-id="${noteId}"] .note-content`);
    content.focus();
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const data = new DataTransfer();
    data.setData('text/plain', text);
    if (html !== '') data.setData('text/html', html);
    const event = new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true});
    content.dispatchEvent(event);
    return event.defaultPrevented;
  }, {noteId, text, html});
}

// The editor's undo: ⌘Z on a Mac, Ctrl+Z elsewhere. Headless Chrome on a Mac
// does not turn ⌘Z into the editing command itself, so it is named.
async function undo(page) {
  if (process.platform === 'darwin') {
    await page.keyboard.down('Meta');
    await page.keyboard.press('z', {commands: ['undo']});
    await page.keyboard.up('Meta');
  } else {
    await page.keyboard.down('Control');
    await page.keyboard.press('z', {commands: ['undo']});
    await page.keyboard.up('Control');
  }
}

function noteText(page, noteId) {
  return page.evaluate(id => document.querySelector(`[data-note-id="${id}"] .note-content`).textContent, noteId);
}

function noteLinks(page, noteId) {
  return page.evaluate(id => [...document.querySelectorAll(`[data-note-id="${id}"] .note-content a`)].map(a => [a.getAttribute('href'), a.textContent]), noteId);
}

const JUNK = 'https://example.com/article?utm_source=newsletter&utm_medium=email&fbclid=abc';
const CLEAN = 'https://example.com/article';

async function pastedTextCases(page) {
  const noteId = await createNote(page, '<p>Links:</p>');
  await reloadApp(page);
  await startEditing(page, noteId);

  // A bare URL: MetaList inserts the cleaned text itself.
  assert.equal(await paste(page, noteId, JUNK, ''), true);
  await pause(SETTLE_MS);
  assert.equal(await noteText(page, noteId), `Links:${CLEAN}`, 'the tracking parameters are gone');

  // Undo brings back exactly what was on the clipboard.
  await undo(page);
  await pause(SETTLE_MS);
  assert.equal(await noteText(page, noteId), 'Links:', 'the paste is one undo step');

  // Prose with two URLs, Markdown syntax and a trailing full stop.
  await paste(page, noteId, ' See [this](https://a.com/x?utm_campaign=c) and https://www.youtube.com/watch?v=abc&si=tok&t=9s.', '');
  await pause(SETTLE_MS);
  assert.equal(await noteText(page, noteId), 'Links: See [this](https://a.com/x) and https://www.youtube.com/watch?v=abc&t=9s.', 'each URL cleaned in place');

  // Typing is never touched.
  await page.keyboard.type(' https://typed.com/?utm_source=typed');
  await pause(SETTLE_MS);
  assert((await noteText(page, noteId)).endsWith(' https://typed.com/?utm_source=typed'), 'a typed URL keeps its parameters');

  // Nothing to remove: the paste is left to the browser, as before this feature.
  const before = await noteText(page, noteId);
  assert.equal(await paste(page, noteId, ' https://Example.com/a%20b/?q=caf%C3%A9+x&empty=#:~:text=hi', ''), false, 'untouched: not taken over');
  await pause(SETTLE_MS);
  assert.equal(await noteText(page, noteId), before);

  await page.keyboard.press('Escape');
  await idle(page);
  return noteId;
}

async function pastedHtmlCases(page) {
  const noteId = await createNote(page, '<p>Rich:</p>');
  await reloadApp(page);
  await startEditing(page, noteId);

  const amazon = 'https://www.amazon.com/Thing/dp/B0ABCDEFG/ref=sr_1_3?crid=2X&keywords=thing&qid=1&sr=8-3';
  const html = `<meta charset="utf-8"><p>Read <a href="${JUNK}">the article</a> or <a href="${JUNK}">${JUNK}</a>, `
    + `then https://x.com/u/status/1?s=20&amp;t=abc and <a href="${amazon}">buy it</a>.</p>`;
  await paste(page, noteId, 'ignored plain text', html);
  await pause(SETTLE_MS);
  await idle(page);
  assert.deepEqual(await noteLinks(page, noteId), [
    [CLEAN, 'the article'],
    [CLEAN, CLEAN],
    ['https://www.amazon.com/Thing/dp/B0ABCDEFG', 'buy it'],
  ], 'hrefs cleaned; link text only when it is the URL');
  assert((await noteText(page, noteId)).includes('then https://x.com/u/status/1 and'), 'a URL written out in pasted HTML prose');

  await page.keyboard.press('Escape');
  await idle(page);
  return noteId;
}

async function newTopNoteCase(page) {
  // Pasting with no note selected makes a new top note: cleaned the same way.
  await page.evaluate(junk => {
    const data = new DataTransfer();
    data.setData('text/plain', junk);
    document.body.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, JUNK);
  await pause(SETTLE_MS);
  await idle(page);
  const first = await page.evaluate(() => {
    const note = document.querySelector('#notes-container .note');
    return {id: note.dataset.noteId, text: note.querySelector(':scope > .note-content').textContent};
  });
  assert.equal(first.text, CLEAN, 'the new top note holds the cleaned URL');
  await page.keyboard.press('Escape');
  await idle(page);
  return first.id;
}

export async function checkUrlCleaning(page) {
  await reloadApp(page);
  const ids = [await pastedTextCases(page), await pastedHtmlCases(page), await newTopNoteCase(page)];
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
  await reloadApp(page);
}
