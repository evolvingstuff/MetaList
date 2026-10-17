import assert from 'node:assert/strict';

import {runThenCleanUp} from './suite-outcome.mjs';

// Paste format guesses (docs/ui/content-formatting.md, "Paste format guesses"):
// CSV-like, Markdown-like and code-like pastes are pasted as plain text and a
// card offers the format ("Apply as Markdown", a few languages for code,
// "Skip"). The card appears just below where the paste ended, moves nothing,
// never takes the keyboard, and closes on Skip, Escape (only the card), typing,
// or leaving edit mode. Apply adds the tag as a certain format does; ⌘Z right
// after removes it with the paste. Certain formats (a fence naming its
// language) are tagged at once, without a card.

const SETTLE_MS = 400;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const MARKDOWN = '# Shopping\n\n- milk\n- eggs\n- bread';
const CSV = 'name,age,city\nAda,36,London\nAlan,41,Wilmslow';
const RUBY = 'def greet(name)\n  puts "Hi #{name}"\nend';
const FENCED_PYTHON = '```python\ndef f(x):\n    return x\n```';

async function idle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return !mode.isLoading && !CommandGate.isBusy();
  });
  await page.waitForNetworkIdle({idleTime: 300});
}

// A new note at the top, shown after a reload.
async function createNote(page, html, tags) {
  const noteId = await page.evaluate(async ({html, tags}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, html, tags);
    return note.id;
  }, {html, tags});
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  return noteId;
}

async function deleteNotes(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

// The page keeps its scroll across reloads: bring the note out from under the search bar first.
async function edit(page, noteId) {
  await page.$eval(`[data-note-id="${noteId}"] > .note-content`, content => content.scrollIntoView({block: 'center'}));
  await pause(200);
  await page.click(`[data-note-id="${noteId}"] > .note-content`);
  await page.waitForFunction(async noteId => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.isEditing && mode.currentNoteId === noteId;
  }, {timeout: 10_000}, noteId);
  await idle(page);
}

async function leaveEditing(page) {
  const isEditing = await page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.isEditing;
  });
  if (!isEditing) return;
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  await idle(page);
}

// A paste at the end of the edited note's text (or into it, if it is empty).
function paste(page, noteId, text, html) {
  return page.evaluate(({noteId, text, html}) => {
    const content = document.querySelector(`[data-note-id="${noteId}"] .note-content`);
    content.focus();
    const range = document.createRange();
    // The caret goes at the end: inside the last line, or in the note itself when it is empty.
    let caretHost = content;
    if (content.lastElementChild !== null) caretHost = content.lastElementChild;
    range.selectNodeContents(caretHost);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const data = new DataTransfer();
    data.setData('text/plain', text);
    if (html !== '') data.setData('text/html', html);
    content.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, {noteId, text, html});
}

function state(page, noteId) {
  return page.evaluate(async noteId => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const note = document.querySelector(`[data-note-id="${noteId}"]`);
    const card = document.querySelector('.paste-format-offer');
    const selection = window.getSelection();
    let caret = null;
    if (selection.rangeCount > 0) {
      const rects = selection.getRangeAt(0).getClientRects();
      if (rects.length > 0) caret = {top: rects[rects.length - 1].top, bottom: rects[rects.length - 1].bottom};
    }
    const cardRect = card === null ? null : card.getBoundingClientRect();
    // While the note is edited its tags are in the tag bar; otherwise on the note.
    let tags = note.dataset.noteTags.trim();
    if (note.querySelector('.note-tag-bar-input') !== null) tags = note.querySelector('.note-tag-bar-input').value.trim();
    return {
      isEditing: mode.isEditing && mode.currentNoteId === noteId,
      text: note.querySelector('.note-content').innerText.replace(/ /g, ' ').trim(),
      tags,
      card: card === null ? null : [...card.querySelectorAll('button, .paste-format-offer-prompt')].map(element => element.textContent),
      cardTop: cardRect === null ? null : cardRect.top,
      cardBottom: cardRect === null ? null : cardRect.bottom,
      caret,
      isContentFocused: note.querySelector('.note-content').contains(document.activeElement),
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight,
    };
  }, noteId);
}

async function clickCardButton(page, label) {
  const buttons = await page.$$('.paste-format-offer button');
  for (const button of buttons) {
    if ((await button.evaluate(element => element.textContent)) === label) {
      await button.click();
      await pause(SETTLE_MS);
      return;
    }
  }
  throw new assert.AssertionError({message: `no "${label}" button on the card`});
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
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
  }
  await pause(SETTLE_MS);
}

// card: the exact buttons expected, or null to only require a card.
async function offeredCase(page, noteId, {pasted, card}) {
  await edit(page, noteId);
  const before = await state(page, noteId);
  await paste(page, noteId, pasted, '');
  await pause(SETTLE_MS);
  const after = await state(page, noteId);
  assert.notEqual(after.card, null, 'a card offers the format');
  if (card !== null) assert.deepEqual(after.card, card, 'the card offers the format');
  assert.equal(after.tags, before.tags, 'nothing is applied before the choice');
  assert.equal(after.isEditing, true);
  assert.equal(after.isContentFocused, true, 'the card does not take the keyboard');
  assert.equal(after.scrollY, before.scrollY, 'nothing scrolls');
  assert(after.caret !== null && after.cardTop >= after.caret.bottom, 'the card sits below where the paste ended');
  return {before, after};
}

async function applyCase(page, ids) {
  const noteId = await createNote(page, '', '');
  ids.push(noteId);
  await offeredCase(page, noteId, {pasted: MARKDOWN, card: ['Apply as Markdown', 'Skip']});
  await clickCardButton(page, 'Apply as Markdown');
  const applied = await state(page, noteId);
  assert.equal(applied.card, null);
  assert.equal(applied.tags, '@markdown', 'Apply adds the tag');
  // Blank lines read back as extra line breaks; the words and their order are what was pasted.
  assert.equal(applied.text.replace(/\n+/g, '\n'), MARKDOWN.replace(/\n+/g, '\n'), 'the text stays as pasted');
  assert.equal(applied.isEditing, true, 'still editing');
  // ⌘Z right after removes the tag with the paste, as for a format tagged at once.
  await undo(page);
  const undone = await state(page, noteId);
  assert.equal(undone.tags, '');
  assert.equal(undone.text, '');
  await leaveEditing(page);
}

async function wrappedApplyCase(page, ids) {
  const noteId = await createNote(page, '<p>My notes so far.</p>', 'groceries');
  ids.push(noteId);
  await offeredCase(page, noteId, {pasted: CSV, card: ['Apply as CSV', 'Skip']});
  await clickCardButton(page, 'Apply as CSV');
  const applied = await state(page, noteId);
  assert.equal(applied.tags, 'groceries ((@csv))', 'into a note with other text the tag is wrapped');
  assert(applied.text.startsWith('My notes so far.'), 'the earlier text is untouched');
  assert(applied.text.includes('((name,age,city'), 'the paste is wrapped');
  assert(applied.text.endsWith('Wilmslow))'));
  await leaveEditing(page);
}

async function codeCase(page, ids) {
  const noteId = await createNote(page, '', '');
  ids.push(noteId);
  // A clear winner is offered alone ("Apply as Ruby"); close languages side by side.
  const {after} = await offeredCase(page, noteId, {pasted: RUBY, card: null});
  assert.equal(after.card.at(-1), 'Skip');
  const rubyButton = after.card.find(label => label === 'Apply as Ruby' || label === 'Ruby');
  assert.notEqual(rubyButton, undefined, `Ruby is offered: ${JSON.stringify(after.card)}`);
  if (rubyButton === 'Ruby') assert.equal(after.card[0], 'Looks like code:');
  await clickCardButton(page, rubyButton);
  assert.equal((await state(page, noteId)).tags, '@code=ruby');
  await leaveEditing(page);
}

async function dismissCases(page, ids) {
  const noteId = await createNote(page, '', '');
  ids.push(noteId);
  // Skip.
  await offeredCase(page, noteId, {pasted: MARKDOWN, card: ['Apply as Markdown', 'Skip']});
  await clickCardButton(page, 'Skip');
  let now = await state(page, noteId);
  assert.equal(now.card, null);
  assert.equal(now.tags, '');
  assert.equal(now.isEditing, true);
  // Escape closes only the card.
  await paste(page, noteId, CSV, '');
  await pause(SETTLE_MS);
  assert.notEqual((await state(page, noteId)).card, null);
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  now = await state(page, noteId);
  assert.equal(now.card, null, 'Escape closes the card');
  assert.equal(now.isEditing, true, 'Escape closes only the card');
  // Scrolling the page yourself closes it.
  await paste(page, noteId, CSV, '');
  await pause(SETTLE_MS);
  assert.notEqual((await state(page, noteId)).card, null);
  await page.mouse.move(300, 300);
  await page.mouse.wheel({deltaY: 120});
  await pause(SETTLE_MS);
  assert.equal((await state(page, noteId)).card, null, 'scrolling with the wheel closes the card');
  // Typing on closes it and the typing goes into the note.
  await paste(page, noteId, CSV, '');
  await pause(SETTLE_MS);
  await page.keyboard.type('x');
  await pause(SETTLE_MS);
  now = await state(page, noteId);
  assert.equal(now.card, null, 'typing closes the card');
  assert(now.text.endsWith('x'), 'the typing reaches the note');
  assert.equal(now.tags, '');
  await leaveEditing(page);
}

async function notOfferedCases(page, ids) {
  // Markdown into a note that is already Markdown, code into code, CSV into CSV.
  for (const [tags, pasted] of [['@markdown', MARKDOWN], ['@code=ruby', RUBY], ['@csv', CSV]]) {
    const noteId = await createNote(page, '<p>Formatted already</p>', tags);
    ids.push(noteId);
    await edit(page, noteId);
    await paste(page, noteId, pasted, '');
    await pause(SETTLE_MS);
    const now = await state(page, noteId);
    assert.equal(now.card, null, `no card into a note tagged ${tags}`);
    assert.equal(now.tags, tags);
    await leaveEditing(page);
  }
  // Formatted text from a page keeps its formatting: no guess.
  const noteId = await createNote(page, '', '');
  ids.push(noteId);
  await edit(page, noteId);
  await paste(page, noteId, MARKDOWN, '<h1>Shopping</h1><ul><li>milk</li><li>eggs</li></ul>');
  await pause(SETTLE_MS);
  assert.equal((await state(page, noteId)).card, null, 'no card for formatted HTML');
  await leaveEditing(page);
}

async function certainFenceCase(page, ids) {
  const noteId = await createNote(page, '', 'scratchpad');
  ids.push(noteId);
  await edit(page, noteId);
  await paste(page, noteId, FENCED_PYTHON, '');
  await pause(SETTLE_MS);
  const now = await state(page, noteId);
  assert.equal(now.card, null, 'a fence naming its language needs no card');
  assert.equal(now.tags, 'scratchpad @markdown', 'it is tagged at once, visible while editing');
  await leaveEditing(page);
}

// Pasting while no note is edited makes a new note at the top; a guess is offered there too.
async function newNoteCase(page, ids) {
  await leaveEditing(page);
  const before = await page.evaluate(() => [...document.querySelectorAll('#notes-container > .note')].map(note => note.dataset.noteId));
  await page.evaluate(text => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.body.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, CSV);
  await page.waitForSelector('.paste-format-offer', {timeout: 10_000});
  await idle(page);
  const noteId = await page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.currentNoteId;
  });
  assert(!before.includes(noteId), 'the paste made a new note');
  ids.push(noteId);
  const offered = await state(page, noteId);
  assert.deepEqual(offered.card, ['Apply as CSV', 'Skip']);
  assert.equal(offered.isEditing, true, 'the new note is being edited');
  assert.equal(offered.tags, '');
  await clickCardButton(page, 'Apply as CSV');
  const applied = await state(page, noteId);
  assert.equal(applied.tags, '@csv', 'Apply tags the new note');
  assert.equal(applied.text.replace(/\n+/g, '\n'), CSV, 'the text is the paste, unwrapped');
  await leaveEditing(page);
}

async function nearBottomCase(page, ids) {
  // A short window puts the end of the paste near its bottom: the card opens above.
  const viewport = page.viewport();
  const noteId = await createNote(page, '<p>Near the bottom</p>', '');
  ids.push(noteId);
  await page.setViewport({...viewport, height: 260});
  try {
    await edit(page, noteId);
    const before = await state(page, noteId);
    await paste(page, noteId, CSV, '');
    await pause(SETTLE_MS);
    const after = await state(page, noteId);
    // Which side it opens on is unit-tested (paste_format_offer.test.mjs); here: it fits the
    // short window and never covers the line where the paste ended.
    assert.notEqual(after.card, null, 'the card is offered');
    assert(after.cardTop >= 0 && after.cardBottom <= after.viewportHeight, 'the card stays in the window');
    assert(after.caret !== null, 'the paste ends at the caret');
    assert(after.cardBottom <= after.caret.top || after.cardTop >= after.caret.bottom, 'the card does not cover the pasted line');
    assert(before.scrollY >= 0);
    await page.keyboard.press('Escape');
    await leaveEditing(page);
  } finally {
    await page.setViewport(viewport);
  }
}

export async function checkPasteFormats(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  const ids = [];
  const failures = [];
  const check = async (name, body) => {
    try {
      await body();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      failures.push(`${name}: ${error.message}`);
      console.error(`paste format case failed: ${name}: ${error.message}`);
      await page.keyboard.press('Escape');
      await pause(300);
      await leaveEditing(page);
    }
  };
  await runThenCleanUp('paste format', async () => {
    await check('apply', () => applyCase(page, ids));
    await check('apply wrapped', () => wrappedApplyCase(page, ids));
    await check('code languages', () => codeCase(page, ids));
    await check('dismiss', () => dismissCases(page, ids));
    await check('not offered', () => notOfferedCases(page, ids));
    await check('certain fence', () => certainFenceCase(page, ids));
    await check('new note', () => newNoteCase(page, ids));
    await check('near the bottom', () => nearBottomCase(page, ids));
    assert.deepEqual(failures, [], `paste format failures:\n${failures.join('\n')}`);
  }, async () => {
    await leaveEditing(page);
    await deleteNotes(page, ids);
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await idle(page);
  });
}
