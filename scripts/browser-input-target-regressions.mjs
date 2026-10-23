import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Typing reaches only the note being edited. A note is editable only while it
// is edited, so typing into another one is a bug the input handler reports
// loudly. These cases type right after a note is clicked, both from no note
// being edited and while another note is: every keystroke lands in the clicked
// note, no input event reaches a note that is not being edited, and nothing
// errors. (Keys pressed within about 20 ms of the click, faster than anyone
// types, arrive before the note is editable and are not typed anywhere.)

const SETTLE_MS = 400;
// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;
const ROUNDS = 4;
const TYPED = 'qz';
// From the click to the first key: quicker than a person, slower than the 20 ms above.
const CLICK_TO_TYPING_MS = 50;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
}

async function createNotes(page) {
  return page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    for (const label of ['second', 'first']) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, `<p>Input target ${label} note</p>`, '');
      ids.unshift(note.id);
    }
    return ids;
  });
}

// Click at the end of the note's text and type at once.
async function clickAndType(page, noteId) {
  const point = await page.evaluate(noteId => {
    const content = document.querySelector(`.note[data-note-id="${noteId}"] > .note-content`);
    content.scrollIntoView({block: 'center'});
    const range = document.createRange();
    range.selectNodeContents(content);
    const rect = range.getBoundingClientRect();
    return {x: rect.right - 1, y: rect.top + rect.height / 2};
  }, noteId);
  await page.mouse.click(point.x, point.y);
  await pause(CLICK_TO_TYPING_MS);
  await page.keyboard.type(TYPED);
  await idle(page);
  await pause(SETTLE_MS);
}

function noteState(page, ids) {
  return page.evaluate(async ids => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {
      editing: mode.isEditing ? mode.currentNoteId : null,
      inputsOutsideTheEditedNote: window.inputTargetProbe.outside,
      texts: ids.map(id => document.querySelector(`.note[data-note-id="${id}"] > .note-content`).textContent.trim()),
    };
  }, ids);
}

export async function checkInputTarget(page) {
  const ids = await createNotes(page);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  // Counts input events that reach a note other than the one being edited.
  await page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    window.inputTargetProbe = {outside: 0};
    document.addEventListener('input', event => {
      if (!(event.target instanceof Element) || event.target.closest('.note-content') === null) return;
      const noteId = event.target.closest('.note').dataset.noteId;
      if (!mode.isEditing || mode.currentNoteId !== noteId) window.inputTargetProbe.outside += 1;
    }, true);
  });
  await runThenCleanUp('input target', async () => {
    const expected = ['Input target first note', 'Input target second note'];
    for (let round = 1; round <= ROUNDS; round += 1) {
      // From no note being edited.
      await clickAndType(page, ids[0]);
      expected[0] += TYPED;
      assert.deepEqual(await noteState(page, ids), {editing: ids[0], inputsOutsideTheEditedNote: 0, texts: expected},
        `round ${round}: typing at once lands in the clicked note`);
      // While the other note is being edited.
      await clickAndType(page, ids[1]);
      expected[1] += TYPED;
      assert.deepEqual(await noteState(page, ids), {editing: ids[1], inputsOutsideTheEditedNote: 0, texts: expected},
        `round ${round}: typing at once after switching lands in the newly clicked note`);
      await page.keyboard.press('Escape');
      await idle(page);
    }
  }, async () => {
    await page.evaluate(async ids => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const id of ids) await NotesAPI.deleteNote(id);
    }, ids);
  });
}
