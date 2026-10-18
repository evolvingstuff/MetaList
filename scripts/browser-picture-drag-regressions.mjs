import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppIdle } from './browser-app-idle.mjs';

// A picture is part of its note: a single click on it edits the note, and a
// press-and-drag that starts on it moves, indents or outdents the note exactly
// as one starting on the note's text does. The browser's own image drag (which
// would carry the picture out instead and swallow the note drag) is off for
// pictures in a note being viewed, and left alone while the note is edited.
// Copy Image and Save Image in the picture's menu take a picture out instead.

const SETTLE_MS = 400;
// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
const DRAG_STEPS = 12;
const DRAG_STEP_MS = 16;
// Past the neighbor note's bottom edge, so the drop lands below it.
const DROP_BELOW_PX = 6;
// Far enough right to read as an indent (the commit threshold is 20 px).
const INDENT_PX = 80;
// A 48×48 red PNG, shown at 240 px wide so it is a large target.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQklEQVR4nO3OQQ0AIAwAsQlDBLKRhQuOR5MK6Jy9vjL5QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF21V9KbVaAsfAAAAAElFTkSuQmCC';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppIdle(page);
  await page.waitForNetworkIdle({idleTime: NETWORK_IDLE_MS});
  await pause(SETTLE_MS);
}

// Top to bottom: a parent the picture's note can be indented under, the note with the picture, a neighbor.
async function createNotes(page) {
  return page.evaluate(async png => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = {};
    const specs = [
      ['neighborId', '<p>Picture neighbor</p>'],
      ['hostId', `<p>Picture host</p><p><img src="data:image/png;base64,${png}" alt="red" width="240"></p>`],
      ['parentId', '<p>Picture parent</p>'],
    ];
    // createNote(null, '') inserts at the top, so create bottom-up.
    for (const [key, html] of specs) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, html, '');
      ids[key] = note.id;
    }
    return ids;
  }, PNG_BASE64);
}

function pictureSelector(hostId) {
  return `.note[data-note-id="${hostId}"] > .note-content img`;
}

async function pictureCenter(page, hostId) {
  const selector = pictureSelector(hostId);
  await page.waitForFunction(selector => {
    const image = document.querySelector(selector);
    return image !== null && image.complete && image.getBoundingClientRect().width > 0;
  }, {}, selector);
  const box = await (await page.$(selector)).boundingBox();
  return {x: box.x + box.width / 2, y: box.y + box.height / 2};
}

function noteState(page, ids) {
  return page.evaluate(async ids => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const order = [...document.querySelectorAll('#notes-container > .note[data-note-id]')].map(note => note.dataset.noteId);
    const host = document.querySelector(`.note[data-note-id="${ids.hostId}"]`);
    const parentNote = host.parentElement.closest('.note[data-note-id]');
    return {
      editing: mode.isEditing ? mode.currentNoteId : null,
      rootOrder: order,
      hostParent: parentNote === null ? null : parentNote.dataset.noteId,
    };
  }, ids);
}

// Whether the browser would start its own drag of the picture: a cancelable
// dragstart the page lets through. Dispatched, not performed, so it is the same
// in every browser and in headless runs.
function nativeImageDragAllowed(page, hostId) {
  return page.evaluate(selector => {
    const event = new DragEvent('dragstart', {bubbles: true, cancelable: true});
    document.querySelector(selector).dispatchEvent(event);
    return !event.defaultPrevented;
  }, pictureSelector(hostId));
}

async function dragFrom(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    await page.mouse.move(from.x + (to.x - from.x) * step / DRAG_STEPS, from.y + (to.y - from.y) * step / DRAG_STEPS);
    await pause(DRAG_STEP_MS);
  }
  await page.mouse.up();
  await idle(page);
}

async function viewModeDragOffCase(page, ids) {
  await pictureCenter(page, ids.hostId);
  assert.equal(await nativeImageDragAllowed(page, ids.hostId), false, "viewing the note, the browser's own picture drag is off");
}

async function moveDownCase(page, ids) {
  const from = await pictureCenter(page, ids.hostId);
  const neighborBox = await (await page.$(`.note[data-note-id="${ids.neighborId}"]`)).boundingBox();
  await dragFrom(page, from, {x: from.x, y: neighborBox.y + neighborBox.height + DROP_BELOW_PX});
  const state = await noteState(page, ids);
  assert.ok(state.rootOrder.indexOf(ids.neighborId) < state.rootOrder.indexOf(ids.hostId),
    `a drag from the picture moves its note below the neighbor: ${JSON.stringify(state.rootOrder)}`);
  assert.equal(state.editing, null, 'the drag does not edit the note');
}

// The note starts right under the parent: a drag to the right indents it, then a drag
// to the left outdents it back, both starting on the picture.
async function indentAndOutdentCase(page, ids) {
  const from = await pictureCenter(page, ids.hostId);
  await dragFrom(page, from, {x: from.x + INDENT_PX, y: from.y});
  let state = await noteState(page, ids);
  assert.equal(state.hostParent, ids.parentId, 'a drag to the right from the picture indents its note under the note above');
  assert.equal(state.editing, null, 'the drag does not edit the note');
  const back = await pictureCenter(page, ids.hostId);
  await dragFrom(page, back, {x: back.x - INDENT_PX, y: back.y});
  state = await noteState(page, ids);
  assert.equal(state.hostParent, null, 'a drag to the left from the picture outdents its note again');
  assert.equal(state.editing, null, 'the drag does not edit the note');
}

async function clickCase(page, ids) {
  const center = await pictureCenter(page, ids.hostId);
  await page.mouse.click(center.x, center.y);
  await idle(page);
  assert.equal((await noteState(page, ids)).editing, ids.hostId, 'a single click on the picture edits its note');
  assert.equal(await nativeImageDragAllowed(page, ids.hostId), true, "while the note is edited, the browser's own picture drag is left alone");
  await page.keyboard.press('Escape');
  await idle(page);
}

export async function checkPictureDrag(page) {
  const ids = await createNotes(page);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await runThenCleanUp('picture drag', async () => {
    // Every case runs, and their assertion failures are reported together.
    const failures = [];
    for (const [label, run] of [
      ['view-mode picture drag off', viewModeDragOffCase],
      ['indent and outdent', indentAndOutdentCase],
      ['move down', moveDownCase],
      ['click', clickCase],
    ]) {
      try {
        await run(page, ids);
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
      for (const id of [ids.hostId, ids.neighborId, ids.parentId]) await NotesAPI.deleteNote(id);
    }, ids);
  });
}
