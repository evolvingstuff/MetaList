import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppIdle } from './browser-app-idle.mjs';

// A rendered diagram is part of its note (docs/ui/excalidraw.md): a single
// click on it edits the note, as a click on the note's text does; a
// double-click opens the diagram editor without the note entering edit mode on
// the way (in edit mode the diagram is only its reference, so a first click
// that started editing would take the diagram away from the second); and a
// press-and-drag that starts on it moves the note.

const SETTLE_MS = 400;
// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
// Opening the editor loads its bundle the first time.
const EDITOR_OPEN_TIMEOUT_MS = 30000;
const DRAG_STEPS = 12;
const DRAG_STEP_MS = 16;
// Past the neighbor note's bottom edge, so the drop lands below it.
const DROP_BELOW_PX = 6;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppIdle(page);
  await page.waitForNetworkIdle({idleTime: NETWORK_IDLE_MS});
  await pause(SETTLE_MS);
}

// Top to bottom: the note holding the diagram, then a neighbor.
async function createNotes(page) {
  return page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const neighbor = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(neighbor.id, '<p>Diagram neighbor</p>', '');
    const host = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(host.id, '<p>Diagram host</p>', '');
    return {hostId: host.id, neighborId: neighbor.id};
  });
}

// Adds an empty diagram to the host note the way Add Excalidraw Diagram does, then leaves edit mode.
async function addDiagram(page, hostId) {
  await page.click(`.note[data-note-id="${hostId}"] > .note-content`);
  await idle(page);
  await page.evaluate(async hostId => {
    const {attachPickedFileToCurrentNote} = await import('/static/js/modules/mode-manager/services/file-reference-service.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    const {EXCALIDRAW_FILENAME, EXCALIDRAW_MIME_TYPE, buildEmptySceneJson} = await import('/static/js/modules/excalidraw/excalidraw-scene.js');
    const file = new File([buildEmptySceneJson()], EXCALIDRAW_FILENAME, {type: EXCALIDRAW_MIME_TYPE});
    await CommandGate.run('test.add_diagram', () => attachPickedFileToCurrentNote(file, hostId));
  }, hostId);
  await idle(page);
  await page.keyboard.press('Escape');
  await idle(page);
}

function diagramSelector(hostId) {
  return `.note[data-note-id="${hostId}"] .note-file-excalidraw-embed[data-file-ref-id]`;
}

async function diagramCenter(page, hostId) {
  const diagram = await page.waitForSelector(diagramSelector(hostId), {visible: true});
  const box = await diagram.boundingBox();
  return {x: box.x + box.width / 2, y: box.y + box.height / 2};
}

// Records, every frame, whether any note was being edited.
async function watchEditing(page) {
  await page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    window.__diagramEditingSeen = false;
    window.__diagramWatching = true;
    const sample = () => {
      if (mode.isEditing) window.__diagramEditingSeen = true;
      if (window.__diagramWatching) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function stopWatchingEditing(page) {
  return page.evaluate(() => {
    window.__diagramWatching = false;
    return window.__diagramEditingSeen;
  });
}

function editState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {editing: mode.isEditing ? mode.currentNoteId : null, scrollY: window.scrollY};
  });
}

async function singleClickCase(page, ids) {
  const center = await diagramCenter(page, ids.hostId);
  const before = await editState(page);
  assert.equal(before.editing, null, 'no note is being edited before the click');
  await page.mouse.click(center.x, center.y);
  await idle(page);
  const after = await editState(page);
  assert.deepEqual(after, {editing: ids.hostId, scrollY: before.scrollY}, 'a single click on the diagram edits its note, and nothing scrolls');
  await page.keyboard.press('Escape');
  await idle(page);
}

async function doubleClickCase(page, ids) {
  const center = await diagramCenter(page, ids.hostId);
  await watchEditing(page);
  await page.mouse.click(center.x, center.y, {clickCount: 2});
  await page.waitForSelector('.excalidraw-editor-overlay', {visible: true, timeout: EDITOR_OPEN_TIMEOUT_MS});
  const editingSeen = await stopWatchingEditing(page);
  assert.equal(editingSeen, false, 'the note never entered edit mode on the way to the diagram editor');
  await page.click('.excalidraw-editor-overlay .excalidraw-editor-done');
  await page.waitForSelector('.excalidraw-editor-overlay', {hidden: true});
  await idle(page);
  if ((await editState(page)).editing !== null) {
    await page.keyboard.press('Escape');
    await idle(page);
  }
}

async function dragCase(page, ids) {
  const center = await diagramCenter(page, ids.hostId);
  const neighborBox = await (await page.$(`.note[data-note-id="${ids.neighborId}"]`)).boundingBox();
  const target = {x: center.x, y: neighborBox.y + neighborBox.height + DROP_BELOW_PX};
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    await page.mouse.move(center.x, center.y + (target.y - center.y) * step / DRAG_STEPS);
    await pause(DRAG_STEP_MS);
  }
  await page.mouse.up();
  await idle(page);
  const order = await page.$$eval('#notes-container > .note[data-note-id]', notes => notes.map(note => note.dataset.noteId));
  assert.ok(order.indexOf(ids.neighborId) < order.indexOf(ids.hostId),
    `a drag that starts on the diagram moves its note below the neighbor: ${JSON.stringify(order)}`);
  assert.equal((await editState(page)).editing, null, 'the drag does not edit the note');
}

export async function checkDiagramClicks(page) {
  const ids = await createNotes(page);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await runThenCleanUp('diagram clicks', async () => {
    await addDiagram(page, ids.hostId);
    // Every case runs, and their assertion failures are reported together.
    const failures = [];
    for (const [label, run] of [['single click', singleClickCase], ['double-click', doubleClickCase], ['drag', dragCase]]) {
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
      for (const id of [ids.hostId, ids.neighborId]) await NotesAPI.deleteNote(id);
    }, ids);
  });
}
