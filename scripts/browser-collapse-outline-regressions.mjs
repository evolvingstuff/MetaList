import assert from 'node:assert/strict';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Toggling a note's collapse arrow only collapses or expands it
// (docs/ui/interaction-principles.md: only the user's action changes the
// screen). The thin outlines of the note and of the note around it keep
// exactly the color they had before the press, on every frame of the
// animation and after it, and the arrow stays visible under the pointer.

const SETTLE_MS = 400;
// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;
// Longer than the collapse animation (140ms) plus its fallback (200ms).
const SAMPLE_MS = 700;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
}

async function reloadApp(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}

// Notes from a spec: [name, html, parentName | null], created in spec order.
async function createNotes(page, spec) {
  return page.evaluate(async spec => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = {};
    for (const [name, html, parent] of spec) {
      let note;
      if (parent === null) note = await NotesAPI.createNote(null, '');
      else note = await NotesAPI.createChild(ids[parent], '');
      ids[name] = note.id;
      await NotesAPI.saveNote(note.id, html, '');
    }
    return ids;
  }, spec);
}

async function deleteNotes(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

function isCollapsed(page, noteId) {
  return page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).classList.contains('collapsed'), noteId);
}

// Points at a note's arrow and waits for the hover outline to settle.
async function pointAtArrow(page, noteId) {
  await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).scrollIntoView({block: 'center'}), noteId);
  await idle(page);
  const box = await (await page.$(`.note[data-note-id="${noteId}"] > .note-collapse-toggle`)).boundingBox();
  const point = {x: box.x + box.width / 2, y: box.y + box.height / 2};
  await page.mouse.move(point.x, point.y);
  await pause(SETTLE_MS);
  return point;
}

// Presses the arrow under the pointer and records, on every frame until the
// animation is over, each watched note's outline color and which note's
// arrow is under the pointer.
async function pressAndSample(page, point, watchedIds) {
  await page.evaluate(({point, watchedIds}) => {
    const samples = [];
    window.__collapseOutlineSamples = samples;
    const tick = () => {
      const outlines = watchedIds.map(id => getComputedStyle(document.querySelector(`.note[data-note-id="${id}"]`)).borderTopColor);
      const under = document.elementFromPoint(point.x, point.y);
      let arrowOf = null;
      if (under !== null && under.closest('.note-collapse-toggle') !== null) {
        arrowOf = under.closest('.note-collapse-toggle').closest('.note').dataset.noteId;
      }
      samples.push({outlines, arrowOf});
      if (window.__collapseOutlineSamples === samples) requestAnimationFrame(tick);
    };
    tick();
  }, {point, watchedIds});
  await page.mouse.down();
  await page.mouse.up();
  await pause(SAMPLE_MS);
  await idle(page);
  return page.evaluate(() => {
    const samples = window.__collapseOutlineSamples;
    window.__collapseOutlineSamples = null;
    return samples;
  });
}

async function assertSteadyToggle(page, {noteId, watchedIds, expectCollapsed, label}) {
  const point = await pointAtArrow(page, noteId);
  const samples = await pressAndSample(page, point, watchedIds);
  assert.equal(await isCollapsed(page, noteId), expectCollapsed, `${label}: the note toggles`);
  const first = samples[0];
  assert.equal(first.arrowOf, noteId, `${label}: the pointer starts on the arrow`);
  const changed = samples.filter(sample => JSON.stringify(sample) !== JSON.stringify(first));
  assert.deepEqual(changed, [], `${label}: every frame keeps the outlines (${watchedIds.join(', ')}) and the arrow under the pointer`);
}

async function setAnimatedTransitions(page, enabled) {
  await page.evaluate(enabled => document.body.classList.toggle('pref-animated-transitions', enabled), enabled);
}

export async function checkCollapseOutlines(page) {
  await reloadApp(page);
  const animated = await page.evaluate(() => document.body.classList.contains('pref-animated-transitions'));
  assert.equal(animated, true, 'animated transitions are on by default');
  const ids = await createNotes(page, [
    ['outer', '<p>Outer note</p>', null],
    ['inner', '<p>Inner note</p>', 'outer'],
    ['innerChild', '<p>Inner child</p>', 'inner'],
  ]);
  await reloadApp(page);
  const watched = [ids.outer, ids.inner];

  await assertSteadyToggle(page, {noteId: ids.inner, watchedIds: watched, expectCollapsed: true, label: 'O1 collapsing a child'});
  await assertSteadyToggle(page, {noteId: ids.inner, watchedIds: watched, expectCollapsed: false, label: 'O2 expanding a child'});
  await assertSteadyToggle(page, {noteId: ids.outer, watchedIds: [ids.outer], expectCollapsed: true, label: 'O3 collapsing a top-level note'});
  await assertSteadyToggle(page, {noteId: ids.outer, watchedIds: [ids.outer], expectCollapsed: false, label: 'O3 expanding a top-level note'});

  await setAnimatedTransitions(page, false);
  await assertSteadyToggle(page, {noteId: ids.inner, watchedIds: watched, expectCollapsed: true, label: 'O5 collapsing without animation'});
  await assertSteadyToggle(page, {noteId: ids.inner, watchedIds: watched, expectCollapsed: false, label: 'O5 expanding without animation'});
  await setAnimatedTransitions(page, true);

  await deleteNotes(page, [ids.innerChild, ids.inner, ids.outer]);
  await reloadApp(page);
}
