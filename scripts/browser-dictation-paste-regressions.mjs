import assert from 'node:assert/strict';

// Dictated text (for example from Superwhisper) pasted into the search bar or
// the tag bar becomes the user's existing tags; one undo brings back exactly
// what was pasted (docs/ui/dictation-paste.md).

// Long enough for a paste and the save it starts to finish.
const PASTE_SETTLE_MS = 400;
const DICTATED = 'Neural network, neural network. Neural-Dash Network.';

async function idle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !mode.isLoading;
  });
  await page.waitForNetworkIdle({idleTime: 300});
}

// Synthetic paste of plain text into the focused element.
function paste(page, selector, text) {
  return page.evaluate(({selector, text}) => {
    const input = document.querySelector(selector);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    const data = new DataTransfer();
    data.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, {selector, text});
}

function valueOf(page, selector) {
  return page.evaluate(selector => document.querySelector(selector).value, selector);
}

const VALUE_WAIT_MS = 5000;
const VALUE_POLL_MS = 50;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Waits for the field to hold the value, then asserts it: a miss reports the
// value the field actually has.
async function waitForValue(page, selector, expected, label) {
  const deadline = Date.now() + VALUE_WAIT_MS;
  while (Date.now() < deadline && await valueOf(page, selector) !== expected) await pause(VALUE_POLL_MS);
  assert.equal(await valueOf(page, selector), expected, label);
}

// The browser's own undo for the focused field (what Cmd/Ctrl+Z runs there;
// synthetic shortcuts do not reach native editing commands on macOS).
function undo(page) {
  return page.evaluate(() => {
    if (!document.execCommand('undo')) throw new Error('undo was refused');
  });
}

// The real Cmd/Ctrl+Z shortcut: MetaList's own handler sees it and the browser
// runs its native undo (on macOS synthetic keys need the editing command).
async function undoShortcut(page) {
  if (process.platform === 'darwin') {
    await page.keyboard.down('Meta');
    await page.keyboard.down('z', {commands: ['undo']});
    await page.keyboard.up('z');
    await page.keyboard.up('Meta');
    return;
  }
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
}

function noteText(page, noteId) {
  return page.evaluate(noteId => document.querySelector(`[data-note-id="${noteId}"] .note-content`).textContent, noteId);
}

// Synthetic paste into the note's content at the end of its text.
function pasteIntoNote(page, noteId, text) {
  return page.evaluate(({noteId, text}) => {
    const content = document.querySelector(`[data-note-id="${noteId}"] .note-content`);
    content.focus();
    const range = document.createRange();
    range.selectNodeContents(content.lastElementChild);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const data = new DataTransfer();
    data.setData('text/plain', text);
    content.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, {noteId, text});
}

function fatalText(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById('fatal-error-overlay');
    return overlay ? overlay.textContent : '';
  });
}

// The ids of the notes shown, in order.
function shownNoteIds(page) {
  return page.evaluate(() => [...document.querySelectorAll('.note[data-note-id]')].map(note => note.dataset.noteId));
}

async function startEditing(page, noteId) {
  const box = await (await page.$(`.note[data-note-id="${noteId}"] > .note-content`)).boundingBox();
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);  // shockharness: ignore[MAGIC001] reason="near the end of the line, at its middle"
  await idle(page);
  await page.keyboard.press('End');
}

// D7: a dictation app (Superwhisper) puts its words on the clipboard and sends
// ⌘V, as if the user pressed it. After a note was copied with ⌘C, and with no
// window switch in between, the paste is the dictated words: what is on the
// clipboard decides, never MetaList's memory of the last copy.
async function dictationAfterNoteCopyCase(page) {
  const words = 'Words the dictation app typed';
  await page.browserContext().overridePermissions(new URL(page.url()).origin,
    ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const ids = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const target = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(target.id, '<div>Dictating into this note</div>', '');
    const copied = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(copied.id, '<div>A note copied with Cmd+C</div>', '');
    return {target: target.id, copied: copied.id};
  });
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  try {
    await startEditing(page, ids.copied);
    await page.keyboard.down('Meta');
    await page.keyboard.press('c');
    await page.keyboard.up('Meta');
    await idle(page);
    const clipboardMode = await page.evaluate(async () => (await import('/static/js/modules/mode-manager/mode-context.js')).ModeContextInstance.clipboardMode);
    assert.equal(clipboardMode, 'note', 'D7: Cmd+C copied the note');
    await page.keyboard.press('Escape');
    await idle(page);

    await startEditing(page, ids.target);
    const notesBefore = await shownNoteIds(page);
    // The dictation app writes its words to the clipboard, outside MetaList.
    await page.evaluate(text => navigator.clipboard.writeText(text), words);
    await page.keyboard.down('Meta');
    await page.keyboard.press('v', {commands: ['paste']});
    await page.keyboard.up('Meta');
    await new Promise(resolve => setTimeout(resolve, PASTE_SETTLE_MS));
    await idle(page);
    assert.deepEqual(await shownNoteIds(page), notesBefore, 'D7: no copy of the copied note appears');
    assert.equal(await noteText(page, ids.target), `Dictating into this note${words}`, 'D7: the dictated words go into the note being edited');

    // The same in the tag bar: dictating "at heading" gives the tag, not a copy.
    await page.keyboard.press('Tab');
    const tagBar = `[data-note-id="${ids.target}"] .note-tag-bar-input`;
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, tagBar);
    await page.evaluate(text => navigator.clipboard.writeText(text), 'At heading.');
    await page.keyboard.down('Meta');
    await page.keyboard.press('v', {commands: ['paste']});
    await page.keyboard.up('Meta');
    await new Promise(resolve => setTimeout(resolve, PASTE_SETTLE_MS));
    await idle(page);
    assert.deepEqual(await shownNoteIds(page), notesBefore, 'D7 tag bar: no copy of the copied note appears');
    await waitForValue(page, tagBar, '@heading', 'D7 tag bar: the dictated words become the tag');
    await page.keyboard.press('Escape');
    await idle(page);
  } finally {
    await page.evaluate(async ids => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const note of [...document.querySelectorAll('.note[data-note-id]')]) {
        const text = note.textContent;
        if (text.includes('A note copied with Cmd+C') && note.dataset.noteId !== ids.copied) await NotesAPI.deleteNote(note.dataset.noteId);
      }
      await NotesAPI.deleteNote(ids.target);
      await NotesAPI.deleteNote(ids.copied);
    }, ids);
  }
}

export async function checkDictationPaste(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  const noteId = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, '<p>Dictation paste fixture</p>', 'neural-network python');
    return note.id;
  });
  // A plain "bold" tag (as typos leave behind) must not stop "at ... bold" from
  // giving the meta tag @bold.
  const plainBoldNoteId = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, '<p>Plain bold tag fixture</p>', 'bold');
    return note.id;
  });
  try {
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await idle(page);

    // Search bar: the dictated phrase becomes the existing tag, and searches.
    await paste(page, '#search-input', DICTATED);
    await waitForValue(page, '#search-input', 'neural-network', 'search paste: dictated text becomes the existing tag');
    await idle(page);
    // One undo brings back exactly what was pasted.
    await undo(page);
    await waitForValue(page, '#search-input', DICTATED, 'search paste: one undo restores the pasted text');
    await page.evaluate(() => {
      const input = document.getElementById('search-input');
      input.select();
    });
    await page.keyboard.press('Backspace');
    await idle(page);

    // The spoken exclusion before a quoted phrase excludes that text.
    await paste(page, '#search-input', 'Neural network minus quote attention end quote');
    await waitForValue(page, '#search-input', 'neural-network -"attention"', 'search paste: minus before a quoted phrase excludes it');
    await page.evaluate(() => document.getElementById('search-input').select());
    await page.keyboard.press('Backspace');
    await idle(page);
    // What Superwhisper types for "at green at bold" (it drops the repeated "at").
    await paste(page, '#search-input', 'At green, bold.');
    await waitForValue(page, '#search-input', '@green @bold', 'search paste: Superwhisper\'s "At green, bold." gives two meta tags');
    await page.evaluate(() => document.getElementById('search-input').select());
    await page.keyboard.press('Backspace');
    await idle(page);
    // What Superwhisper actually types for "neural network minus quote attention
    // end quote": an em dash for "minus", quote marks, and a leftover "end quote".
    await paste(page, '#search-input', 'Neural network\u2014"attention"\u2014end quote.');
    await waitForValue(page, '#search-input', 'neural-network -"attention"', 'search paste: Superwhisper\'s em dash before a quote excludes it');
    await page.evaluate(() => document.getElementById('search-input').select());
    await page.keyboard.press('Backspace');
    await idle(page);

    // After an opening quote, a paste is text to find: inserted as copied.
    await page.focus('#search-input');
    await page.keyboard.type('"');
    await idle(page);
    await paste(page, '#search-input', 'This is a test');
    await waitForValue(page, '#search-input', '"This is a test', 'search paste: after an opening quote, text goes in as copied');
    await page.keyboard.type('"');
    await idle(page);
    await waitForValue(page, '#search-input', '"This is a test"', 'search paste: the quoted paste can be closed');
    await page.evaluate(() => document.getElementById('search-input').select());
    await page.keyboard.press('Backspace');
    await idle(page);
    await page.keyboard.type('"');
    await idle(page);
    await paste(page, '#search-input', 'youtube.com/watch?v=abc');
    await waitForValue(page, '#search-input', '"youtube.com/watch?v=abc', 'search paste: a URL fragment after an opening quote goes in as copied');
    await page.evaluate(() => document.getElementById('search-input').select());
    await page.keyboard.press('Backspace');
    await idle(page);

    // Tag bar: known tags are not added again, unknown words become new tags.
    const point = await page.evaluate(noteId => {
      const rect = document.querySelector(`[data-note-id="${noteId}"] .note-content p`).getBoundingClientRect();
      return {x: rect.left + 30, y: rect.top + Math.min(10, rect.height / 2)};
    }, noteId);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(async noteId => {
      const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
      return mode.isEditing && mode.currentNoteId === noteId && !mode.isLoading;
    }, {timeout: 10000}, noteId);
    await page.waitForSelector(`[data-note-id="${noteId}"] .note-tag-bar-input`, {visible: true});
    const tagBar = `[data-note-id="${noteId}"] .note-tag-bar-input`;
    await paste(page, tagBar, 'Neural network, transformers.');
    await waitForValue(page, tagBar, 'neural-network python transformers', 'tag bar paste: known tags kept once, a new word becomes a tag');
    await undo(page);
    // The tag bar's live clean-up drops the comma, as it does when typing one.
    await waitForValue(page, tagBar, 'neural-network python Neural network transformers.', 'tag bar paste: one undo restores the pasted text');
    // Superwhisper's "At green, bold." in the tag bar.
    await page.evaluate(selector => {
      const input = document.querySelector(selector);
      input.value = 'neural-network python';
      input.dispatchEvent(new Event('input', {bubbles: true}));
    }, tagBar);
    await paste(page, tagBar, 'At green, bold.');
    await waitForValue(page, tagBar, 'neural-network python @green @bold', 'tag bar paste: Superwhisper\'s "At green, bold." gives two meta tags');
    // Back to the original tags for the next part (as if typed).
    await page.evaluate(selector => {
      const input = document.querySelector(selector);
      input.value = 'neural-network python';
      input.dispatchEvent(new Event('input', {bubbles: true}));
    }, tagBar);

    // Note content: the text before "start tags" goes into the note, the words
    // after it into the tag bar; one undo removes both.
    const textBefore = await noteText(page, noteId);
    await pasteIntoNote(page, noteId, ' More text. Start tags. GPT, transformer.');
    await waitForValue(page, tagBar, 'neural-network python GPT transformer', 'note paste: the words after the tag phrase become tags');
    assert.equal(await noteText(page, noteId), `${textBefore} More text.`, 'note paste: the text before the tag phrase goes into the note');
    await page.focus(`[data-note-id="${noteId}"] .note-content`);
    await undoShortcut(page);
    await waitForValue(page, tagBar, 'neural-network python', 'note paste: one undo removes the added tags');
    assert.equal(await noteText(page, noteId), textBefore, 'note paste: the same undo removes the pasted text');
    // Only tags: the note's text is untouched and one undo removes the tags.
    await pasteIntoNote(page, noteId, 'Start tags LLM');
    await waitForValue(page, tagBar, 'neural-network python LLM', 'note paste: only tags');
    assert.equal(await noteText(page, noteId), textBefore, 'note paste: no text added when only tags were dictated');
    await undoShortcut(page);
    await waitForValue(page, tagBar, 'neural-network python', 'note paste: undo removes tags pasted alone');
    assert.equal(await noteText(page, noteId), textBefore, 'note paste: undoing tags pasted alone leaves the text');
    await page.keyboard.press('Escape');
    await idle(page);

    // One-tag fields: Edit Tag Relationships' search box and its "Implied tag"
    // field take the whole paste as one existing tag.
    await page.evaluate(async () => {
      const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
      await CommandPalette.openOntologyEditor();
    });
    await page.waitForSelector('#ontology-search-input', {visible: true});
    await paste(page, '#ontology-search-input', 'Python.');
    await waitForValue(page, '#ontology-search-input', 'python', 'tag relationships search: a dictated tag becomes the tag');
    await page.focus('#ontology-search-input');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-action="add-right"]', {visible: true});
    await page.click('[data-action="add-right"]');
    await page.waitForSelector('#ontology-dialog-input', {visible: true});
    await paste(page, '#ontology-dialog-input', 'Neural network.');
    await waitForValue(page, '#ontology-dialog-input', 'neural-network', 'implied tag: a dictated phrase becomes one existing tag');
    await page.click('[data-action="dialog-cancel"]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const modal = document.getElementById('ontology-modal');
      return modal === null || modal.style.display === 'none';
    });
    assert.equal(await fatalText(page), '', 'dictation paste: no fatal error');
  } finally {
    await page.evaluate(async ids => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const id of ids) await NotesAPI.deleteNote(id);
    }, [noteId, plainBoldNoteId]);
  }
  await dictationAfterNoteCopyCase(page);
}
