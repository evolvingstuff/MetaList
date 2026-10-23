import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// A file shown as a link (`.MD pkms_multi_provider_ai_integration.md`) downloads
// only from its badge and its underlined name (docs/ui/references.md). The rest
// of the note's line is the note: a click there edits it and a press-and-drag
// moves it. The link's button used to fill the note's width, so a click an inch
// right of the name downloaded the file (2026-10-21).

const SETTLE_MS = 400;
// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;
// How far right of the name's end "beside the name" is.
const BESIDE_NAME_PX = 40;
// A floating window is narrower: its click goes halfway into the gap after the name, which must be this wide.
const MIN_FLOATING_GAP_PX = 16;
const HALF = 0.5;
const DRAG_STEPS = 12;
const DRAG_STEP_MS = 16;
// Past the neighbor note's bottom edge, so the drop lands below it.
const DROP_BELOW_PX = 6;
const SHORT_NAME = 'pkms_multi_provider_ai_integration.md';
// Long enough to wrap onto a second line in the note.
const LONG_NAME = `${'a_very_long_attachment_name_that_keeps_going_'.repeat(6)}end.md`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
  await pause(SETTLE_MS);
}

// Top to bottom: the note holding the file, then a neighbor.
async function createNotes(page) {
  return page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const neighbor = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(neighbor.id, '<p>File link neighbor</p>', '');
    const host = await NotesAPI.createNote(null, '');
    return {hostId: host.id, neighborId: neighbor.id};
  });
}

// Attaches a Markdown file to the host the way a picked or dropped file is, then leaves edit mode.
async function attachFile(page, hostId, filename) {
  await page.click(`.note[data-note-id="${hostId}"] > .note-content`);
  await idle(page);
  await page.evaluate(async ({hostId, filename}) => {
    const {attachPickedFileToCurrentNote} = await import('/static/js/modules/mode-manager/services/file-reference-service.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    const file = new File(['# Notes\n'], filename, {type: 'text/markdown'});
    await CommandGate.run('test.attach_file', () => attachPickedFileToCurrentNote(file, hostId));
  }, {hostId, filename});
  await idle(page);
  await page.keyboard.press('Escape');
  await idle(page);
}

// The link's parts in the main list, measured from the rendered text: the badge, the
// name's first and last lines, and the note's content box.
async function linkGeometry(page, hostId) {
  await page.waitForSelector(`.note[data-note-id="${hostId}"] .note-file-reference-title`, {visible: true});
  return page.evaluate(hostId => {
    const note = document.querySelector(`.note[data-note-id="${hostId}"]`);
    const title = note.querySelector('.note-file-reference-title');
    const range = document.createRange();
    range.selectNodeContents(title);
    const lines = [...range.getClientRects()].filter(rect => rect.width > 0);
    const box = rect => ({left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom});
    return {
      badge: box(note.querySelector('.note-file-reference-badge').getBoundingClientRect()),
      firstLine: box(lines[0]),
      lastLine: box(lines[lines.length - 1]),
      lineCount: new Set(lines.map(rect => Math.round(rect.top))).size,
      content: box(note.querySelector(':scope > .note-content').getBoundingClientRect()),
    };
  }, hostId);
}

function centerOf(rect) {
  return {x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2};
}

function besideEndOf(line, content) {
  const point = {x: line.right + BESIDE_NAME_PX, y: (line.top + line.bottom) / 2};
  assert.ok(point.x < content.right, `the point beside the name is still inside the note: ${point.x} < ${content.right}`);
  return point;
}

function editState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.isEditing ? mode.currentNoteId : null;
  });
}

// Counts the file downloads the page asks for while `act` runs.
async function downloadsDuring(page, act) {
  let count = 0;
  const onRequest = request => {
    if (/\/api2\/files\/[^/]+\/download/.test(request.url())) count += 1;
  };
  page.on('request', onRequest);
  try {
    await act();
    await idle(page);
  } finally {
    page.off('request', onRequest);
  }
  return count;
}

async function leaveEditing(page) {
  if ((await editState(page)) !== null) {
    await page.keyboard.press('Escape');
    await idle(page);
  }
}

async function clickDownloads(page, point, label) {
  assert.equal(await downloadsDuring(page, () => page.mouse.click(point.x, point.y)), 1, `${label}: downloads the file`);
  assert.equal(await editState(page), null, `${label}: does not edit the note`);
}

async function clickEdits(page, hostId, point, label) {
  assert.equal(await downloadsDuring(page, () => page.mouse.click(point.x, point.y)), 0, `${label}: does not download`);
  assert.equal(await editState(page), hostId, `${label}: edits the note`);
  await leaveEditing(page);
}

async function nameAndBadgeCases(page, ids, where) {
  const geometry = await linkGeometry(page, ids.hostId);
  await clickDownloads(page, centerOf(geometry.firstLine), `${where}, click on the name`);
  await clickDownloads(page, centerOf(geometry.badge), `${where}, click on the badge`);
  await clickEdits(page, ids.hostId, besideEndOf(geometry.firstLine, geometry.content), `${where}, click right of the name`);
}

async function dragBesideNameCase(page, ids) {
  const geometry = await linkGeometry(page, ids.hostId);
  const start = besideEndOf(geometry.firstLine, geometry.content);
  const neighborBox = await (await page.$(`.note[data-note-id="${ids.neighborId}"]`)).boundingBox();
  const targetY = neighborBox.y + neighborBox.height + DROP_BELOW_PX;
  const downloads = await downloadsDuring(page, async () => {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let step = 1; step <= DRAG_STEPS; step += 1) {
      await page.mouse.move(start.x, start.y + (targetY - start.y) * step / DRAG_STEPS);
      await pause(DRAG_STEP_MS);
    }
    await page.mouse.up();
  });
  assert.equal(downloads, 0, 'a drag that starts right of the name does not download');
  const order = await page.$$eval('#notes-container > .note[data-note-id]', notes => notes.map(note => note.dataset.noteId));
  assert.ok(order.indexOf(ids.neighborId) < order.indexOf(ids.hostId),
    `a drag that starts right of the name moves the note below its neighbor: ${JSON.stringify(order)}`);
  assert.equal(await editState(page), null, 'the drag does not edit the note');
}

async function wrappedNameCase(page, ids) {
  const geometry = await linkGeometry(page, ids.hostId);
  assert.ok(geometry.lineCount >= 2, `the long name wraps (${geometry.lineCount} lines)`);
  assert.ok(geometry.lastLine.right + BESIDE_NAME_PX < geometry.firstLine.right,
    'the last line is shorter than the first, leaving room beside it');
  await clickDownloads(page, centerOf(geometry.lastLine), 'wrapped name, click on its last line');
  await clickEdits(page, ids.hostId, besideEndOf(geometry.lastLine, geometry.content), 'wrapped name, click right of its last line');
}

// While its own note is edited, the reference is text and never downloads.
async function editingCase(page, ids) {
  const geometry = await linkGeometry(page, ids.hostId);
  const beside = besideEndOf(geometry.firstLine, geometry.content);
  await page.mouse.click(beside.x, beside.y);
  await idle(page);
  assert.equal(await editState(page), ids.hostId, 'the host is being edited');
  const point = await page.$eval(`.note[data-note-id="${ids.hostId}"] > .note-content`, content => {
    const rect = content.getBoundingClientRect();
    return {x: rect.left + rect.width / 4, y: rect.top + rect.height / 2};
  });
  assert.equal(await downloadsDuring(page, () => page.mouse.click(point.x, point.y)), 0,
    'while its own note is edited, clicking the reference does not download');
  await leaveEditing(page);
}

async function floatingWindowCase(page, ids) {
  await page.evaluate(async hostId => {
    const {openFloatingNote} = await import('/static/js/modules/mode-manager/services/floating-note-service.js');
    await openFloatingNote(hostId);
  }, ids.hostId);
  await page.waitForSelector('.floating-note-window');
  await idle(page);
  const geometry = await page.$eval('.floating-note-window', (host, half) => {
    const title = host.shadowRoot.querySelector('.note-file-reference-title');
    const range = document.createRange();
    range.selectNodeContents(title);
    const line = [...range.getClientRects()].filter(rect => rect.width > 0)[0];
    const content = host.shadowRoot.querySelector('.note-content').getBoundingClientRect();
    return {
      name: {x: (line.left + line.right) * half, y: (line.top + line.bottom) * half},
      beside: {x: line.right + (content.right - line.right) * half, y: (line.top + line.bottom) * half},
      gap: content.right - line.right,
    };
  }, HALF);
  assert.ok(geometry.gap >= MIN_FLOATING_GAP_PX, `the floating window leaves room beside the name: ${JSON.stringify(geometry)}`);
  assert.equal(await downloadsDuring(page, () => page.mouse.click(geometry.name.x, geometry.name.y)), 1,
    'floating window, click on the name: downloads the file');
  assert.equal(await downloadsDuring(page, () => page.mouse.click(geometry.beside.x, geometry.beside.y)), 0,
    'floating window, click right of the name: does not download');
  await page.evaluate(async () => {
    const {closeAllFloatingNotes} = await import('/static/js/modules/mode-manager/services/floating-note-service.js');
    closeAllFloatingNotes();
  });
  await idle(page);
}

// Like the reported note: it has a child and is collapsed.
async function collapse(page, hostId) {
  await page.evaluate(async hostId => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const child = await NotesAPI.createChild(hostId, '');
    await NotesAPI.saveNote(child.id, '<p>File link child</p>', '');
    await NotesAPI.collapseNote(hostId);
  }, hostId);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  assert.ok(await page.$eval(`.note[data-note-id="${hostId}"]`, note => note.classList.contains('collapsed')),
    'the host is collapsed');
}

// Every case runs, and their assertion failures are reported together.
async function runCases(page, cases) {
  const failures = [];
  for (const [label, run] of cases) {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      failures.push(`${label}: ${error.message}`);
      await page.keyboard.press('Escape');
      await idle(page);
    }
  }
  return failures;
}

export async function checkFileLinkClicks(page) {
  const short = await createNotes(page);
  const long = await createNotes(page);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await runThenCleanUp('file link clicks', async () => {
    await attachFile(page, short.hostId, SHORT_NAME);
    await attachFile(page, long.hostId, LONG_NAME);
    const failures = await runCases(page, [
      ['expanded note', () => nameAndBadgeCases(page, short, 'expanded note')],
      ['wrapped name', () => wrappedNameCase(page, long)],
      ['editing', () => editingCase(page, short)],
      ['floating window', () => floatingWindowCase(page, short)],
      ['drag', () => dragBesideNameCase(page, short)],
    ]);
    failures.push(...await runCases(page, [
      ['collapsed note', async () => {
        await collapse(page, short.hostId);
        await nameAndBadgeCases(page, short, 'collapsed note');
      }],
    ]));
    if (failures.length > 0) throw new assert.AssertionError({message: failures.join('\n')});
  }, async () => {
    await page.evaluate(async ids => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const id of ids) await NotesAPI.deleteNote(id);
    }, [short.hostId, short.neighborId, long.hostId, long.neighborId]);
  });
}
