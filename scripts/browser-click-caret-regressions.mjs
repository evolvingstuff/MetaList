import assert from 'node:assert/strict';

// The caret after a click (docs/ui/interaction-principles.md, "Click into a
// note": the clicked spot stays under the pointer, caret there). One click
// opens a note for editing with the caret showing where the click was, so
// typing can start at once: in plain text, in rendered Markdown, from another
// note being edited, on the note's padding (the nearest spot in its text), in
// a collapsed note, and on a second click in the same note. Where nothing was
// clicked in the text (a pasted note, a robot press) the caret stays hidden.

const SETTLE_MS = 400;
// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
// Clicks this far inside the note's corner land on its padding, not its text.
const PADDING_INSET_PX = 4;
// Clicks this far into a line land between its first letters.
const LINE_INSET_PX = 30;
const LINES = ['First line of the note', 'Second line', 'Third line'];
// Enough paragraphs that a collapsed note hides most of them.
const COLLAPSED_NOTE_PARAGRAPHS = 12;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return !mode.isLoading && !CommandGate.isBusy();
  });
  await page.waitForNetworkIdle({idleTime: NETWORK_IDLE_MS});
}

async function reloadApp(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}

async function createNote(page, html, tags) {
  return page.evaluate(async ({html, tags}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, html, tags);
    return note.id;
  }, {html, tags});
}

async function deleteNotes(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

function plainNote(page) {
  return createNote(page, LINES.map(line => `<p>${line}</p>`).join(''), '');
}

function middleY(rect) {
  return rect.top + rect.height / 2;  // shockharness: ignore[MAGIC001] reason="halving: the vertical middle of the box"
}

// A point in the note: a padding corner, or LINE_INSET_PX into one of its lines.
function pointIn(page, noteId, spot) {
  return page.evaluate(({noteId, spot, padding, inset}) => {
    const note = document.querySelector(`.note[data-note-id="${noteId}"]`);
    note.scrollIntoView({block: 'center'});
    const box = note.getBoundingClientRect();
    if (spot === 'top-left padding') return {x: box.left + padding, y: box.top + padding};
    if (spot === 'bottom-right padding') return {x: box.right - padding, y: box.bottom - padding};
    const line = [...note.querySelectorAll(':scope > .note-content p, :scope > .note-content li')]
      .find(element => element.textContent.trim().startsWith(spot));
    const rect = line.getBoundingClientRect();
    const x = rect.left + inset;
    const y = rect.top + rect.height / 2;  // shockharness: ignore[MAGIC001] reason="halving: the vertical middle of the line"
    // The character boundary under the point, as the browser places a caret there.
    const caret = document.caretRangeFromPoint(x, y);
    return {x, y, line: line.textContent, offset: caret.startOffset};
  }, {noteId, spot, padding: PADDING_INSET_PX, inset: LINE_INSET_PX});
}

// The note's lines with X typed at the clicked point of the clicked line.
function withTypedX(lines, point) {
  return lines.map(line => {
    if (line !== point.line) return line;
    return `${line.slice(0, point.offset)}X${line.slice(point.offset)}`;
  });
}

async function clickAt(page, point) {
  await page.mouse.click(point.x, point.y);
  await pause(SETTLE_MS);
  await idle(page);
}

// What the user sees of the caret in the note being edited.
function caretState(page, noteId) {
  return page.evaluate(async noteId => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const content = document.querySelector(`.note[data-note-id="${noteId}"] > .note-content`);
    const selection = window.getSelection();
    let line = '';
    if (selection.rangeCount > 0 && content.contains(selection.anchorNode)) {
      let node = selection.getRangeAt(0).startContainer;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
      line = node.closest('div, p, li').textContent;
    }
    return {
      editing: mode.isEditing && mode.currentNoteId === noteId,
      shown: !mode.isCaretHidden && !content.classList.contains('caret-hidden') && getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)',
      focused: document.activeElement === content,
      collapsedSelection: selection.rangeCount > 0 && selection.isCollapsed,
      line,
    };
  }, noteId);
}

function noteLines(page, noteId) {
  return page.evaluate(id => [...document.querySelectorAll(`.note[data-note-id="${id}"] > .note-content > *`)]
    .map(element => element.textContent), noteId);
}

async function assertCaretShown(page, noteId, label) {
  const state = await caretState(page, noteId);
  assert.deepEqual([state.editing, state.shown, state.focused, state.collapsedSelection], [true, true, true, true],
    `${label}: one click opens the note with the caret showing (${JSON.stringify(state)})`);
  return state;
}

// Typing goes where the caret showed.
async function assertTypingLands(page, noteId, expectedLines, label) {
  await page.keyboard.type('X');
  await pause(SETTLE_MS);
  assert.deepEqual(await noteLines(page, noteId), expectedLines, `${label}: typing lands at the caret`);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await idle(page);
}

// C1: a click in the text of a note not being edited.
async function plainTextCase(page) {
  const label = 'click in the text';
  const noteId = await plainNote(page);
  await reloadApp(page);
  const point = await pointIn(page, noteId, 'Second line');
  await clickAt(page, point);
  assert.equal((await assertCaretShown(page, noteId, label)).line, 'Second line', `${label}: the caret is on the clicked line`);
  await assertTypingLands(page, noteId, withTypedX(LINES, point), label);
  await deleteNotes(page, [noteId]);
}

// C2: a click in rendered Markdown: the caret on the clicked item's source line.
async function markdownCase(page) {
  const label = 'click in rendered Markdown';
  const source = ['# Heading', '', 'A paragraph of Markdown text', '', '- A short list item', '- Another list item'];
  const noteId = await createNote(page, source.map(line => `<div>${line}</div>`).join(''), '@markdown');
  await reloadApp(page);
  await clickAt(page, await pointIn(page, noteId, 'Another list item'));
  await assertCaretShown(page, noteId, label);
  // The source shows as text lines: typing goes into the clicked item's line.
  await page.keyboard.type('X');
  await pause(SETTLE_MS);
  const typedLine = await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"] > .note-content`).innerText
    .split('\n').find(line => line.includes('X')), noteId);
  assert.equal(typedLine.replace('X', ''), '- Another list item', `${label}: typing lands in the clicked item's source line, got "${typedLine}"`);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await idle(page);
  await deleteNotes(page, [noteId]);
}

// C3: a click into another note while one is being edited.
async function switchNotesCase(page) {
  const label = 'click from another note being edited';
  const firstId = await createNote(page, '<p>The note being edited</p>', '');
  const noteId = await plainNote(page);
  await reloadApp(page);
  await clickAt(page, await pointIn(page, firstId, 'The note being edited'));
  const point = await pointIn(page, noteId, 'Third line');
  await clickAt(page, point);
  assert.equal((await assertCaretShown(page, noteId, label)).line, 'Third line', `${label}: the caret is on the clicked line`);
  await assertTypingLands(page, noteId, withTypedX(LINES, point), label);
  await deleteNotes(page, [firstId, noteId]);
}

// C4: a click on the note's padding: the caret at the nearest spot in its text.
async function paddingCase(page, spot, expectedLines) {
  const label = `click on the ${spot}`;
  const noteId = await plainNote(page);
  await reloadApp(page);
  await clickAt(page, await pointIn(page, noteId, spot));
  await assertCaretShown(page, noteId, label);
  await assertTypingLands(page, noteId, expectedLines, label);
  await deleteNotes(page, [noteId]);
}

// B1-B6: a click on a border beside a line puts the caret at the nearest spot
// of that line: its start on the left, its end on the right; above the text,
// at its first line, below it, at its last. In Markdown, too, where the
// rendering drops the source's markers ("- ", "# ").
const MARKDOWN_SOURCE = ['# Heading', '', 'A paragraph of Markdown text', '', '- A short list item', '- Another list item', '', 'Last paragraph here'];

function borderPoint(page, noteId, side, beside) {
  return page.evaluate(({noteId, side, beside, padding, inset}) => {
    const note = document.querySelector(`.note[data-note-id="${noteId}"]`);
    note.scrollIntoView({block: 'center'});
    const box = note.getBoundingClientRect();
    const line = [...note.querySelectorAll(':scope > .note-content :is(p, li)')]
      .find(element => element.textContent.trim().startsWith(beside));
    const rect = line.getBoundingClientRect();
    const middle = rect.top + rect.height / 2;  // shockharness: ignore[MAGIC001] reason="halving: the vertical middle of the line"
    if (side === 'left') return {x: box.left + padding, y: middle};
    if (side === 'right') return {x: box.right - padding, y: middle};
    if (side === 'top') return {x: rect.left + inset, y: box.top + padding};
    return {x: rect.left + inset, y: box.bottom - padding};
  }, {noteId, side, beside, padding: PADDING_INSET_PX, inset: LINE_INSET_PX});
}

async function borderCase(page, {markdown, side, beside, expected}) {
  const label = `${markdown ? 'Markdown' : 'plain'} note, ${side} border beside "${beside}"`;
  let noteId;
  if (markdown) noteId = await createNote(page, MARKDOWN_SOURCE.map(line => `<div>${line}</div>`).join(''), '@markdown');
  else noteId = await plainNote(page);
  await reloadApp(page);
  await clickAt(page, await borderPoint(page, noteId, side, beside));
  await assertCaretShown(page, noteId, label);
  await page.keyboard.type('X');
  await pause(SETTLE_MS);
  const typed = await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"] > .note-content`).innerText
    .split('\n').filter(line => line.includes('X')), noteId);
  assert.deepEqual(typed, [expected], `${label}: typing lands at the nearest spot`);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await idle(page);
  await deleteNotes(page, [noteId]);
}

// C5: a second click in the note being edited moves the caret there.
async function secondClickCase(page) {
  const label = 'second click in the same note';
  const noteId = await plainNote(page);
  await reloadApp(page);
  await clickAt(page, await pointIn(page, noteId, 'First line'));
  const point = await pointIn(page, noteId, 'Third line');
  await clickAt(page, point);
  assert.equal((await assertCaretShown(page, noteId, label)).line, 'Third line', `${label}: the caret moves to the clicked line`);
  await assertTypingLands(page, noteId, withTypedX(LINES, point), label);
  await deleteNotes(page, [noteId]);
}

// C6: a pasted note is selected with no caret: nothing was clicked in it.
async function pastedNoteCase(page) {
  const label = 'a note pasted with ⌘V';
  const sourceId = await createNote(page, '<p>The copied note</p>', '');
  await reloadApp(page);
  await clickAt(page, await pointIn(page, sourceId, 'The copied note'));
  for (const key of ['c', 'v']) {
    await page.keyboard.down('Meta');
    await page.keyboard.press(key);
    await page.keyboard.up('Meta');
    await pause(SETTLE_MS);
    await idle(page);
  }
  const pasted = await page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {id: mode.currentNoteId, hidden: mode.isCaretHidden};
  });
  assert.notEqual(pasted.id, sourceId, `${label}: the pasted copy is selected`);
  assert.equal(pasted.hidden, true, `${label}: the caret stays hidden`);
  await page.keyboard.press('Escape');
  await idle(page);
  await deleteNotes(page, [pasted.id, sourceId]);
}

// C7a: a click in a collapsed note opens it with the caret where the click was.
async function collapsedNoteCase(page) {
  const label = 'click in a collapsed note';
  const lines = Array.from({length: COLLAPSED_NOTE_PARAGRAPHS}, (_, index) => `Collapsed paragraph ${index + 1}`);
  const noteId = await createNote(page, lines.map(line => `<p>${line}</p>`).join(''), '');
  await page.evaluate(async id => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.collapseNote(id);
  }, noteId);
  await reloadApp(page);
  assert(await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).classList.contains('collapsed'), noteId),
    `${label}: the note starts collapsed`);
  const point = await pointIn(page, noteId, 'Collapsed paragraph 1');
  await clickAt(page, point);
  assert.equal((await assertCaretShown(page, noteId, label)).line, 'Collapsed paragraph 1', `${label}: the caret is on the clicked line`);
  await assertTypingLands(page, noteId, withTypedX(lines, point), label);
  await deleteNotes(page, [noteId]);
}

// C7b: pressing a note's robot opens it with the caret hidden: no spot in its
// text was clicked.
async function robotCase(page) {
  const label = 'pressing the robot';
  const noteId = await createNote(page, '<p>A note with proposals</p>', '');
  await page.evaluate(async id => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.addTagProposals(id, {[id]: ['travel']});
  }, noteId);
  await reloadApp(page);
  const robot = await page.$(`.note[data-note-id="${noteId}"] .note-proposal-indicator`);
  assert.notEqual(robot, null, `${label}: the note shows its robot`);
  await robot.click();
  await pause(SETTLE_MS);
  await idle(page);
  const state = await page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {id: mode.currentNoteId, hidden: mode.isCaretHidden};
  });
  assert.deepEqual(state, {id: noteId, hidden: true}, `${label}: the note opens with the caret hidden`);
  await page.keyboard.press('Escape');
  await idle(page);
  await deleteNotes(page, [noteId]);
}

export async function checkClickCaret(page) {
  await reloadApp(page);
  await plainTextCase(page);
  await markdownCase(page);
  await switchNotesCase(page);
  await paddingCase(page, 'top-left padding', ['XFirst line of the note', 'Second line', 'Third line']);
  await paddingCase(page, 'bottom-right padding', ['First line of the note', 'Second line', 'Third lineX']);
  await secondClickCase(page);
  for (const [side, expected] of [['left', '- XA short list item'], ['right', '- A short list itemX'],
    ['top', '# XHeading'], ['bottom', 'Last paragraph hereX']]) {
    await borderCase(page, {markdown: true, side, beside: 'A short list item', expected});
  }
  for (const [side, expected] of [['left', 'XSecond line'], ['right', 'Second lineX'],
    ['top', 'XFirst line of the note'], ['bottom', 'Third lineX']]) {
    await borderCase(page, {markdown: false, side, beside: 'Second line', expected});
  }
  await pastedNoteCase(page);
  await collapsedNoteCase(page);
  await robotCase(page);
  await reloadApp(page);
}
