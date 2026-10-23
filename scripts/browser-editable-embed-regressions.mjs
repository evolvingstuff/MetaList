import assert from 'node:assert/strict';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Embeds (docs/ui/references.md): a note whose only content is a reference,
// [[UUID]], shows its source in place. An embed is a window onto its source:
// it changes how the source is shown, never what it says. A to-do checkbox
// inside an embed shows the note's status but is not a control: pressing it
// does nothing at all (no toggle, no edit mode, nothing moves, a note being
// edited stays edited). The holder's own checkbox still toggles the holder.
// The holder folds as its source does (collapse below), and each note inside
// an embed has its own arrow, which folds that note everywhere.

const SETTLE_MS = 400;
// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;
const SEARCH_TAG = 'zz-embed-search';
// A host excluded from the search while its parent matches is shown redacted.
const EXCLUDED_TAG = 'zz-embed-hidden';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
}

async function reloadApp(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}

// Notes from a spec: [name, html, tags, parentName | null]. HTML may name
// other notes as [[name]] (a note that is only that embeds it); notes are
// created first, in spec order.
async function createNotes(page, spec) {
  return page.evaluate(async spec => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = {};
    for (const [name, , , parent] of spec) {
      let note;
      if (parent === null) note = await NotesAPI.createNote(null, '');
      else note = await NotesAPI.createChild(ids[parent], '');
      ids[name] = note.id;
    }
    for (const [name, html, tags] of spec) {
      await NotesAPI.saveNote(ids[name], html.replace(/\[\[(\w+)\]\]/g, (_, ref) => `[[${ids[ref]}]]`), tags);
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

// The checkbox of a note's own content (not of a note it embeds), in the main tree.
function ownCheckboxSelector(noteId) {
  return `.note[data-note-id="${noteId}"] > .note-content .meta-status-toggle`;
}

// What a note's own checkbox shows in the main tree.
function ownStatus(page, noteId) {
  return page.evaluate(id => {
    const toggles = [...document.querySelectorAll(`.note[data-note-id="${id}"] > .note-content .meta-status-toggle`)]
      .filter(toggle => toggle.closest('.note-reference-block') === null);
    if (toggles.length !== 1) throw new Error(`expected one own checkbox in ${id}, found ${toggles.length}`);
    return toggles[0].dataset.status;
  }, noteId);
}

// What an embedded note's checkbox shows inside the embed in `hostId`
// (`path` lists the embedded notes from the host's embed inwards).
function embeddedCheckbox(page, hostId, path) {
  return page.evaluateHandle(({hostId, path}) => {
    let scope = document.querySelector(`.note[data-note-id="${hostId}"] > .note-content`);
    for (const id of path) {
      scope = scope.querySelector(`.note-embed-node[data-embed-note-id="${id}"]`);
      if (scope === null) throw new Error(`no embedded ${id}`);
    }
    return scope.querySelector(':scope > .note-embed-body > .note-embed-content .meta-status-toggle');
  }, {hostId, path});
}

async function embeddedStatus(page, hostId, path) {
  const checkbox = (await embeddedCheckbox(page, hostId, path)).asElement();
  assert.notEqual(checkbox, null, `the embed in ${hostId} shows the checkbox of ${path[path.length - 1]}`);
  return checkbox.evaluate(node => node.dataset.status);
}

// Presses a checkbox inside an embed; returns where it and the page were.
async function pressEmbeddedCheckbox(page, hostId, path) {
  const checkbox = (await embeddedCheckbox(page, hostId, path)).asElement();
  await checkbox.evaluate(node => node.scrollIntoView({block: 'center'}));
  await idle(page);
  const before = await checkbox.evaluate(node => ({top: node.getBoundingClientRect().top, scrollY: window.scrollY}));
  const box = await checkbox.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await pause(SETTLE_MS);
  await idle(page);
  return before;
}

async function assertNothingMoved(page, hostId, path, before, label) {
  const checkbox = (await embeddedCheckbox(page, hostId, path)).asElement();
  const after = await checkbox.evaluate(node => ({top: node.getBoundingClientRect().top, scrollY: window.scrollY}));
  assert.deepEqual(after, before, `${label}: nothing scrolls and the checkbox stays where it was`);
}

function modeState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {editing: mode.isEditing, current: mode.currentNoteId};
  });
}

async function leaveEditMode(page) {
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  await idle(page);
}

// N1, N3, N4: pressing an embedded checkbox does nothing; it does not look
// pressable. N5: the host's own checkbox still toggles the host.
async function checkboxCases(page) {
  const ids = await createNotes(page, [
    ['task', '<p>Task A</p>', '@todo', null],
    ['subtask', '<p>Subtask of A</p>', '@todo', 'task'],
    ['host', '<div>[[task]]</div>', '@todo', null],
  ]);
  await reloadApp(page);
  assert.equal(await embeddedStatus(page, ids.host, [ids.task]), 'todo', "N4: the embed shows the note's status");

  const checkbox = (await embeddedCheckbox(page, ids.host, [ids.task])).asElement();
  const box = await checkbox.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const look = await checkbox.evaluate(node => ({cursor: getComputedStyle(node).cursor, background: getComputedStyle(node).backgroundColor}));
  assert.deepEqual(look, {cursor: 'default', background: 'rgba(0, 0, 0, 0)'}, 'N4: under the pointer it does not look pressable');

  for (const [path, label] of [[[ids.task], 'N1'], [[ids.task, ids.subtask], 'N3 child']]) {
    const before = await pressEmbeddedCheckbox(page, ids.host, path);
    assert.equal((await modeState(page)).editing, false, `${label}: nothing enters edit mode`);
    assert.equal(await ownStatus(page, ids.task), 'todo', `${label}: the embedded note is not toggled`);
    assert.equal(await ownStatus(page, ids.subtask), 'todo', `${label}: nor its child`);
    assert.equal(await ownStatus(page, ids.host), 'todo', `${label}: nor the host`);
    await assertNothingMoved(page, ids.host, path, before, label);
  }

  const own = await page.$(ownCheckboxSelector(ids.host));
  const ownBox = await own.boundingBox();
  await page.mouse.click(ownBox.x + ownBox.width / 2, ownBox.y + ownBox.height / 2);
  await pause(SETTLE_MS);
  await idle(page);
  assert.equal(await ownStatus(page, ids.host), 'done', "N5: the host's own checkbox toggles the host");
  assert.equal(await ownStatus(page, ids.task), 'todo', 'N5: the embedded note is untouched');
  await deleteNotes(page, [ids.host, ids.subtask, ids.task]);
}

// N2: editing another note: it stays edited, the caret where it was.
async function whileEditingCase(page) {
  const ids = await createNotes(page, [
    ['other', '<p>Another note</p>', '', null],
    ['task', '<p>Task A</p>', '@todo', null],
    ['host', '<div>[[task]]</div>', '', null],
  ]);
  await reloadApp(page);
  const content = await page.$(`.note[data-note-id="${ids.other}"] > .note-content`);
  const box = await content.boundingBox();
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
  await idle(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await pressEmbeddedCheckbox(page, ids.host, [ids.task]);
  assert.deepEqual(await modeState(page), {editing: true, current: ids.other}, 'N2: the note being edited stays edited');
  await page.keyboard.type(' more');
  await leaveEditMode(page);
  assert.equal(await ownStatus(page, ids.task), 'todo', 'N2: the embedded note is not toggled');
  await reloadApp(page);
  const saved = await page.$eval(`.note[data-note-id="${ids.other}"] > .note-content`, node => node.textContent);
  assert.equal(saved, 'Another note edited more', 'N2: typing goes on where the caret was');
  await deleteNotes(page, [ids.host, ids.task, ids.other]);
}

// N3 nested: an embed inside an embedded note: nothing happens.
async function nestedCase(page) {
  const ids = await createNotes(page, [
    ['deep', '<p>Deep task</p>', '@todo', null],
    ['middle', '<div>Middle note</div>', '@todo', null],
    // The middle note's child is only a reference: an embed inside the embed.
    ['deepHolder', '<div>[[deep]]</div>', '', 'middle'],
    ['host', '<div>[[middle]]</div>', '', null],
  ]);
  await reloadApp(page);
  const before = await pressEmbeddedCheckbox(page, ids.host, [ids.middle, ids.deepHolder, ids.deep]);
  assert.equal((await modeState(page)).editing, false, 'N3 nested: nothing enters edit mode');
  assert.equal(await ownStatus(page, ids.deep), 'todo', 'N3 nested: the innermost note is not toggled');
  assert.equal(await ownStatus(page, ids.middle), 'todo', 'N3 nested: nor the note embedding it');
  await assertNothingMoved(page, ids.host, [ids.middle, ids.deepHolder, ids.deep], before, 'N3 nested');
  await deleteNotes(page, [ids.host, ids.deepHolder, ids.middle, ids.deep]);
}

// N6: a search-redacted host: nothing toggles.
async function redactedCase(page) {
  const ids = await createNotes(page, [
    ['task', '<p>Task A</p>', '@todo', null],
    ['parent', '<p>Matching parent</p>', SEARCH_TAG, null],
    ['host', '<div>[[task]]</div>', EXCLUDED_TAG, 'parent'],
  ]);
  await reloadApp(page);
  await page.click('#search-input');
  await page.keyboard.type(`${SEARCH_TAG} -${EXCLUDED_TAG}`);
  await pause(SETTLE_MS);
  await idle(page);
  await page.keyboard.press('Escape');
  await idle(page);
  const redacted = await page.$eval(`.note[data-note-id="${ids.host}"]`, node => node.classList.contains('search-redacted'));
  assert.equal(redacted, true, 'N6: the host is shown redacted in the search');
  const checkbox = (await embeddedCheckbox(page, ids.host, [ids.task])).asElement();
  if (checkbox !== null) {
    const box = await checkbox.boundingBox();
    if (box !== null) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await pause(SETTLE_MS);
      await idle(page);
    }
  }
  await page.click('#search-input');
  await page.evaluate(() => document.getElementById('search-input').select());
  await page.keyboard.press('Backspace');
  await pause(SETTLE_MS);
  await idle(page);
  await page.keyboard.press('Escape');
  await idle(page);
  assert.equal(await ownStatus(page, ids.task), 'todo', 'N6: nothing toggles in a redacted host');
  await deleteNotes(page, [ids.host, ids.parent, ids.task]);
}

// --- Collapse ----------------------------------------------------------
// A note holding an embed folds as its source does: its arrow collapses or
// expands the source everywhere, and its own children fold with it; when the
// source is folded anywhere, the note shows folded. Each note inside the embed
// shows the collapse saved for it, with an arrow that folds that note
// everywhere. An arrow stays under the pointer and nothing scrolls. Links,
// full screen and floating windows show no embed arrows.

// The arrow of a note inside an embed.
function embeddedArrow(page, hostId, path) {
  return page.evaluateHandle(({hostId, path}) => {
    let scope = document.querySelector(`.note[data-note-id="${hostId}"] > .note-content`);
    for (const id of path) {
      scope = scope.querySelector(`.note-embed-node[data-embed-note-id="${id}"]`);
      if (scope === null) return null;
    }
    return scope.querySelector(':scope > .note-embed-body > .note-embed-collapse-toggle');
  }, {hostId, path});
}

// What an embed shows of a note: its arrow (null, 'expanded', 'collapsed') and
// the notes shown under it.
function embeddedView(page, hostId, path) {
  return page.evaluate(({hostId, path}) => {
    let scope = document.querySelector(`.note[data-note-id="${hostId}"] > .note-content`);
    for (const id of path) {
      scope = scope.querySelector(`.note-embed-node[data-embed-note-id="${id}"]`);
      if (scope === null) return null;
    }
    const arrow = scope.querySelector(':scope > .note-embed-body > .note-embed-collapse-toggle');
    let state = null;
    if (arrow !== null) state = arrow.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed';
    const children = [...scope.querySelectorAll(':scope > .note-embed-body > .note-embed-children > .note-embed-node')]
      .map(node => node.dataset.embedNoteId);
    return {arrow: state, children};
  }, {hostId, path});
}

function mainTreeCollapsed(page, noteId) {
  return page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).classList.contains('collapsed'), noteId);
}

// What a note holding an embed shows: folded or not, the source's notes shown
// in it, and its own children shown under it.
function holderView(page, hostId) {
  return page.evaluate(id => {
    const note = document.querySelector(`.note[data-note-id="${id}"]`);
    const root = note.querySelector(':scope > .note-content .note-embed-root');
    let shown = [];
    if (root !== null) {
      shown = [...root.querySelectorAll(':scope > .note-embed-body > .note-embed-children > .note-embed-node')].map(node => node.dataset.embedNoteId);
    }
    const own = [...note.querySelectorAll(':scope > .note-children > .note')].filter(child => child.offsetParent !== null)
      .map(child => child.dataset.noteId);
    return {collapsed: note.classList.contains('collapsed'), shown, own};
  }, hostId);
}

// Presses an arrow and returns where it and the page were before and after.
async function pressArrow(page, findArrow) {
  const arrow = (await findArrow()).asElement();
  assert.notEqual(arrow, null, 'the arrow is shown');
  await arrow.evaluate(node => node.scrollIntoView({block: 'center'}));
  await idle(page);
  const before = await arrow.evaluate(node => ({top: node.getBoundingClientRect().top, scrollY: window.scrollY}));
  const box = await arrow.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await pause(SETTLE_MS);
  await idle(page);
  const after = await (await findArrow()).asElement()
    .evaluate(node => ({top: node.getBoundingClientRect().top, scrollY: window.scrollY}));
  return {before, after};
}

function pressEmbeddedArrow(page, hostId, path) {
  return pressArrow(page, () => embeddedArrow(page, hostId, path));
}

function pressHolderArrow(page, hostId) {
  return pressArrow(page, () => page.evaluateHandle(id => document.querySelector(`.note[data-note-id="${id}"] > .note-collapse-toggle`), hostId));
}

async function setCollapsed(page, noteId, collapsed) {
  await page.evaluate(async ({noteId, collapsed}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    if (collapsed) await NotesAPI.collapseNote(noteId);
    else await NotesAPI.expandNote(noteId);
  }, {noteId, collapsed});
}

async function collapseFixture(page) {
  return createNotes(page, [
    ['source', '<div>Source note</div>', '', null],
    ['child', '<div>Child one</div>', '', 'source'],
    ['grandchild', '<div>Grandchild</div>', '', 'child'],
    ['second', '<div>Child two</div>', '', 'source'],
    ['host', '<div>[[source]]</div>', '', null],
    ['own', '<div>Its own child</div>', '', 'host'],
  ]);
}

function deleteCollapseFixture(page, ids) {
  return deleteNotes(page, [ids.own, ids.host, ids.grandchild, ids.child, ids.second, ids.source]);
}

// F1, F2: the embed shows each note's saved state, arrows where they can collapse.
async function savedStateCases(page) {
  const ids = await collapseFixture(page);
  for (const id of [ids.source, ids.child, ids.host]) await setCollapsed(page, id, false);
  await reloadApp(page);
  const treeOrder = await page.evaluate(id => [...document.querySelectorAll(`.note[data-note-id="${id}"] > .note-children > .note`)]
    .map(note => note.dataset.noteId), ids.source);
  assert.deepEqual(new Set(treeOrder), new Set([ids.child, ids.second]), 'F1: the main tree shows both children');
  assert.deepEqual(await holderView(page, ids.host), {collapsed: false, shown: treeOrder, own: [ids.own]},
    "F1: the holder shows the source's children, in order, then its own child");
  assert.deepEqual(await embeddedView(page, ids.host, [ids.source, ids.child]), {arrow: 'expanded', children: [ids.grandchild]},
    'F1: an expanded child shows its own child, with an arrow');
  assert.deepEqual(await embeddedView(page, ids.host, [ids.source, ids.second]), {arrow: null, children: []},
    'F1: a one-line note without children has no arrow');

  await setCollapsed(page, ids.child, true);
  await reloadApp(page);
  assert.deepEqual(await embeddedView(page, ids.host, [ids.source, ids.child]), {arrow: 'collapsed', children: []},
    'F2: a note saved collapsed shows collapsed in the embed, its child hidden');
  assert.equal(await mainTreeCollapsed(page, ids.child), true, 'F2: as the original does');
  await deleteCollapseFixture(page, ids);
}

// F3, F4, F5: the holder's arrow folds the source everywhere and its own
// children with it; the holder folds when the source is folded elsewhere.
async function holderFoldsAsSourceCases(page) {
  const ids = await collapseFixture(page);
  for (const id of [ids.source, ids.host]) await setCollapsed(page, id, false);
  await reloadApp(page);

  let moved = await pressHolderArrow(page, ids.host);
  assert.deepEqual(await holderView(page, ids.host), {collapsed: true, shown: [], own: []}, 'F3: the holder folds, its own child too');
  assert.equal(await mainTreeCollapsed(page, ids.source), true, 'F3: and the source folds in the main tree');
  assert.deepEqual(moved.after, moved.before, 'F3: the arrow stays under the pointer and nothing scrolls');
  await reloadApp(page);
  assert.equal(await mainTreeCollapsed(page, ids.source), true, 'F3: saved: still folded after a reload');

  moved = await pressHolderArrow(page, ids.host);
  assert.equal((await holderView(page, ids.host)).collapsed, false, 'F4: unfolded, the holder shows the source again');
  assert.equal((await holderView(page, ids.host)).own.length, 1, "F4: and its own child");
  assert.equal(await mainTreeCollapsed(page, ids.source), false, 'F4: the source unfolds in the main tree');
  assert.deepEqual(moved.after, moved.before, 'F4: the arrow stays under the pointer and nothing scrolls');

  await pressArrow(page, () => page.evaluateHandle(id => document.querySelector(`.note[data-note-id="${id}"] > .note-collapse-toggle`), ids.source));
  assert.equal((await holderView(page, ids.host)).collapsed, true, "F5: folding the source itself folds the holder");
  await setCollapsed(page, ids.source, false);
  await deleteCollapseFixture(page, ids);
}

// F6: one undo after the holder's arrow brings both back.
async function holderUndoCase(page) {
  const ids = await collapseFixture(page);
  for (const id of [ids.source, ids.host]) await setCollapsed(page, id, false);
  await reloadApp(page);
  await pressHolderArrow(page, ids.host);
  await page.keyboard.down('Meta');
  await page.keyboard.press('z');
  await page.keyboard.up('Meta');
  await pause(SETTLE_MS);
  await idle(page);
  assert.equal((await holderView(page, ids.host)).collapsed, false, 'F6: undone, the holder is unfolded');
  assert.equal(await mainTreeCollapsed(page, ids.source), false, 'F6: and so is the source');
  await deleteCollapseFixture(page, ids);
}

// F7: an arrow inside the embed folds that note everywhere.
async function embeddedArrowCases(page) {
  const ids = await collapseFixture(page);
  for (const id of [ids.source, ids.child, ids.host]) await setCollapsed(page, id, false);
  await reloadApp(page);

  let moved = await pressEmbeddedArrow(page, ids.host, [ids.source, ids.child]);
  assert.deepEqual(await embeddedView(page, ids.host, [ids.source, ids.child]), {arrow: 'collapsed', children: []}, 'F7: folded in the embed');
  assert.equal(await mainTreeCollapsed(page, ids.child), true, 'F7: and in the main tree');
  assert.deepEqual(moved.after, moved.before, 'F7: the arrow stays under the pointer and nothing scrolls');

  moved = await pressEmbeddedArrow(page, ids.host, [ids.source, ids.child]);
  assert.deepEqual(await embeddedView(page, ids.host, [ids.source, ids.child]), {arrow: 'expanded', children: [ids.grandchild]}, 'F7: unfolded in the embed');
  assert.equal(await mainTreeCollapsed(page, ids.child), false, 'F7: and in the main tree');
  assert.deepEqual(moved.after, moved.before, 'F7: the arrow stays under the pointer and nothing scrolls');
  await deleteCollapseFixture(page, ids);
}

// F8: editing another note: saved and left first, then the note folds.
async function arrowWhileEditingCase(page) {
  const ids = await collapseFixture(page);
  const other = await createNotes(page, [['other', '<div>Another note</div>', '', null]]);
  for (const id of [ids.source, ids.child, ids.host]) await setCollapsed(page, id, false);
  await reloadApp(page);
  const content = await page.$(`.note[data-note-id="${other.other}"] > .note-content`);
  const box = await content.boundingBox();
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
  await idle(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await pressEmbeddedArrow(page, ids.host, [ids.source, ids.child]);
  assert.equal((await modeState(page)).editing, false, 'F8: the note being edited is left');
  assert.equal(await mainTreeCollapsed(page, ids.child), true, 'F8: the embedded note folds');
  await reloadApp(page);
  assert.equal(await page.$eval(`.note[data-note-id="${other.other}"] > .note-content`, node => node.textContent), 'Another note edited',
    'F8: what was typed is saved');
  await deleteNotes(page, [other.other]);
  await deleteCollapseFixture(page, ids);
}

// F9: no embed arrows in links, full screen or floating windows.
async function noArrowCases(page) {
  const ids = await collapseFixture(page);
  const more = await createNotes(page, [['linker', '<div>Links: [[source]]</div>', '', null]]);
  for (const id of [ids.source, ids.host]) await setCollapsed(page, id, false);
  await reloadApp(page);
  const arrowsIn = id => page.evaluate(id => [...document.querySelectorAll(`.note[data-note-id="${id}"] .note-embed-collapse-toggle`)]
    .filter(arrow => arrow.offsetParent !== null).length, id);
  assert.equal(await arrowsIn(more.linker), 0, 'F9: a link shows no arrows');

  await page.evaluate(async id => {
    const {openNoteFullscreen} = await import('/static/js/modules/mode-manager/services/note-fullscreen-service.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    await CommandGate.run('test.fullscreen', () => openNoteFullscreen(id));
  }, ids.host);
  await idle(page);
  const fullscreenArrows = await page.evaluate(() => [...document.querySelectorAll('.note-fullscreen-overlay .note-embed-collapse-toggle')]
    .filter(arrow => arrow.offsetParent !== null).length);
  assert.equal(fullscreenArrows, 0, 'F9: full screen shows no embed arrows');
  await page.keyboard.press('Escape');
  await idle(page);

  await page.evaluate(async id => {
    const {openFloatingNote} = await import('/static/js/modules/mode-manager/services/floating-note-service.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    await CommandGate.run('test.floating', () => openFloatingNote(id));
  }, ids.host);
  await idle(page);
  const floatingArrows = await page.evaluate(() => [...document.querySelectorAll('.floating-note-window')]
    .flatMap(host => [...host.shadowRoot.querySelectorAll('.note-embed-collapse-toggle')])
    .filter(arrow => arrow.getBoundingClientRect().width > 0).length);
  assert.equal(floatingArrows, 0, 'F9: floating windows show no embed arrows');
  await page.evaluate(async () => {
    const {closeAllFloatingNotes} = await import('/static/js/modules/mode-manager/services/floating-note-service.js');
    closeAllFloatingNotes();
  });
  await deleteNotes(page, [more.linker]);
  await deleteCollapseFixture(page, ids);
}

// --- Shading -------------------------------------------------------------
// An embed is tinted grey (main.css --embed-tint-1..3), a shade deeper for each embed
// inside an embed (to the third). A holder's own children take the tint of the level around it.

const TINTS = {
  light: ['rgb(228, 231, 235)', 'rgb(213, 218, 222)', 'rgb(198, 204, 210)'],
  dark: ['rgb(32, 34, 36)', 'rgb(42, 45, 48)', 'rgb(53, 57, 61)'],
};

async function inTheme(page, theme, check) {
  const original = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
  await check();
  await page.evaluate(original => {
    if (original === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', original);
  }, original);
}

async function shadingCases(page) {
  const ids = await createNotes(page, [
    ['third', '<div>Third level</div>', '', null],
    ['second', '<div>Second level</div>', '', null],
    ['thirdHolder', '<div>[[third]]</div>', '', 'second'],
    ['first', '<div>First level</div>', '', null],
    ['secondHolder', '<div>[[second]]</div>', '', 'first'],
    ['ownOfSecondHolder', '<div>Belongs to the first level</div>', '', 'secondHolder'],
    ['host', '<div>[[first]]</div>', '', null],
  ]);
  await reloadApp(page);
  for (const theme of ['light', 'dark']) {
    await inTheme(page, theme, async () => {
      const shades = await page.evaluate(ids => {
        const note = document.querySelector(`.note[data-note-id="${ids.host}"]`);
        const node = id => note.querySelector(`.note-embed-node[data-embed-note-id="${id}"]`);
        return [note, node(ids.secondHolder), node(ids.thirdHolder), node(ids.ownOfSecondHolder)]
          .map(element => getComputedStyle(element).backgroundColor);
      }, ids);
      assert.deepEqual(shades, [...TINTS[theme], TINTS[theme][0]],
        `S1 ${theme}: each embed a shade deeper; a holder's own child takes the level around it`);
    });
  }
  await deleteNotes(page, [ids.host, ids.ownOfSecondHolder, ids.secondHolder, ids.first, ids.thirdHolder, ids.second, ids.third]);
}

export async function checkEditableEmbeds(page) {
  await reloadApp(page);
  await checkboxCases(page);
  await whileEditingCase(page);
  await nestedCase(page);
  await redactedCase(page);
  await savedStateCases(page);
  await holderFoldsAsSourceCases(page);
  await holderUndoCase(page);
  await embeddedArrowCases(page);
  await arrowWhileEditingCase(page);
  await noArrowCases(page);
  await shadingCases(page);
  await reloadApp(page);
}
