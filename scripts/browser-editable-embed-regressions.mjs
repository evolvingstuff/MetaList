import assert from 'node:assert/strict';

// Editable embeds (docs/ui/references.md), stage 1: a to-do checkbox inside an
// embedded note (![[UUID]]) toggles that note, the source, never the note the
// embed is in. Every copy shows the new status; nothing scrolls and the
// clicked checkbox stays where it was. A note being edited is saved and left
// first, as for any checkbox.

const SETTLE_MS = 400;
// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
const SEARCH_TAG = 'zz-embed-search';
// A host excluded from the search while its parent matches is shown redacted.
const EXCLUDED_TAG = 'zz-embed-hidden';
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

// Notes from a spec: [name, html, tags, parentName | null]. HTML may name
// other notes as ![[name]]; they are created first, in spec order.
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
      await NotesAPI.saveNote(ids[name], html.replace(/!\[\[(\w+)\]\]/g, (_, ref) => `![[${ids[ref]}]]`), tags);
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

// Presses a checkbox inside an embed and returns where it and the page were.
async function pressEmbeddedCheckbox(page, hostId, path) {
  const checkbox = (await embeddedCheckbox(page, hostId, path)).asElement();
  await checkbox.evaluate(node => node.scrollIntoView({block: 'center'}));
  await idle(page);
  const before = await checkbox.evaluate(node => ({top: node.getBoundingClientRect().top, scrollY: window.scrollY}));
  const box = await checkbox.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);  // shockharness: ignore[MAGIC001] reason="the middle of the checkbox"
  await pause(SETTLE_MS);
  await idle(page);
  return before;
}

async function assertNothingMoved(page, hostId, path, before, label) {
  const checkbox = (await embeddedCheckbox(page, hostId, path)).asElement();
  const after = await checkbox.evaluate(node => ({top: node.getBoundingClientRect().top, scrollY: window.scrollY}));
  assert.deepEqual(after, before, `${label}: nothing scrolls and the checkbox stays where it was`);
}

// T1, T2, T4: the embedded note toggles, its copies follow, the host does not.
async function toggleCases(page) {
  const ids = await createNotes(page, [
    ['task', '<p>Task A</p>', '@todo', null],
    ['subtask', '<p>Subtask of A</p>', '@todo', 'task'],
    ['host', '<div>Host line</div><div>![[task]]</div>', '@todo', null],
  ]);
  await reloadApp(page);

  const before = await pressEmbeddedCheckbox(page, ids.host, [ids.task]);
  assert.equal(await embeddedStatus(page, ids.host, [ids.task]), 'done', 'T1: the embedded copy shows the note done');
  assert.equal(await ownStatus(page, ids.task), 'done', 'T1: the source note itself is done');
  assert.equal(await ownStatus(page, ids.host), 'todo', 'T1: the host is not toggled');
  assert.equal(await ownStatus(page, ids.subtask), 'todo', "T1: the source's child is not toggled");
  await assertNothingMoved(page, ids.host, [ids.task], before, 'T1');

  const childBefore = await pressEmbeddedCheckbox(page, ids.host, [ids.task, ids.subtask]);
  assert.equal(await embeddedStatus(page, ids.host, [ids.task, ids.subtask]), 'done', 'T2: the embedded child shows done');
  assert.equal(await ownStatus(page, ids.subtask), 'done', 'T2: the child itself is done');
  assert.equal(await ownStatus(page, ids.task), 'done', 'T2: its parent stays as it was');
  assert.equal(await ownStatus(page, ids.host), 'todo', 'T2: the host is not toggled');
  await assertNothingMoved(page, ids.host, [ids.task, ids.subtask], childBefore, 'T2');

  // Back again: a second press toggles the source back.
  await pressEmbeddedCheckbox(page, ids.host, [ids.task]);
  assert.equal(await ownStatus(page, ids.task), 'todo', 'T1: pressed again, the source note is a to-do again');
  assert.equal(await embeddedStatus(page, ids.host, [ids.task]), 'todo', 'T1: and so is its embedded copy');

  // T4: the host's own checkbox still toggles the host.
  const own = await page.$(ownCheckboxSelector(ids.host));
  const box = await own.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);  // shockharness: ignore[MAGIC001] reason="the middle of the checkbox"
  await pause(SETTLE_MS);
  await idle(page);
  assert.equal(await ownStatus(page, ids.host), 'done', "T4: the host's own checkbox toggles the host");
  assert.equal(await ownStatus(page, ids.task), 'todo', 'T4: the embedded note is untouched');
  await deleteNotes(page, [ids.host, ids.subtask, ids.task]);
}

// T3: editing another note: it is saved and left, then the embedded note toggles.
async function whileEditingCase(page) {
  const ids = await createNotes(page, [
    ['other', '<p>Another note</p>', '', null],
    ['task', '<p>Task A</p>', '@todo', null],
    ['host', '<div>Host line</div><div>![[task]]</div>', '', null],
  ]);
  await reloadApp(page);
  const content = await page.$(`.note[data-note-id="${ids.other}"] > .note-content`);
  const box = await content.boundingBox();
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);  // shockharness: ignore[MAGIC001] reason="near the end of the line, at its middle"
  await idle(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await pressEmbeddedCheckbox(page, ids.host, [ids.task]);
  const state = await page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {editing: mode.isEditing};
  });
  assert.equal(state.editing, false, 'T3: the note being edited is left');
  assert.equal(await ownStatus(page, ids.task), 'done', 'T3: the embedded note toggles');
  await reloadApp(page);
  const saved = await page.$eval(`.note[data-note-id="${ids.other}"] > .note-content`, node => node.textContent);
  assert.equal(saved, 'Another note edited', 'T3: the edited note was saved');
  await deleteNotes(page, [ids.host, ids.task, ids.other]);
}

// T5: an embed inside an embedded note: the innermost note toggles.
async function nestedCase(page) {
  const ids = await createNotes(page, [
    ['deep', '<p>Deep task</p>', '@todo', null],
    ['middle', '<div>Middle note</div><div>![[deep]]</div>', '@todo', null],
    ['host', '<div>Host line</div><div>![[middle]]</div>', '', null],
  ]);
  await reloadApp(page);
  const before = await pressEmbeddedCheckbox(page, ids.host, [ids.middle, ids.deep]);
  assert.equal(await ownStatus(page, ids.deep), 'done', 'T5: the innermost note toggles');
  assert.equal(await ownStatus(page, ids.middle), 'todo', 'T5: the note embedding it does not');
  assert.equal(await embeddedStatus(page, ids.host, [ids.middle, ids.deep]), 'done', 'T5: the nested copy shows done');
  await assertNothingMoved(page, ids.host, [ids.middle, ids.deep], before, 'T5');
  await deleteNotes(page, [ids.host, ids.middle, ids.deep]);
}

// T6: a search-redacted host: nothing toggles.
async function redactedCase(page) {
  const ids = await createNotes(page, [
    ['task', '<p>Task A</p>', '@todo', null],
    ['parent', '<p>Matching parent</p>', SEARCH_TAG, null],
    ['host', '<div>Host line</div><div>![[task]]</div>', EXCLUDED_TAG, 'parent'],
  ]);
  await reloadApp(page);
  await page.click('#search-input');
  await page.keyboard.type(`${SEARCH_TAG} -${EXCLUDED_TAG}`);
  await pause(SETTLE_MS);
  await idle(page);
  await page.keyboard.press('Escape');
  await idle(page);
  const redacted = await page.$eval(`.note[data-note-id="${ids.host}"]`, node => node.classList.contains('search-redacted'));
  assert.equal(redacted, true, 'T6: the host is shown redacted in the search');
  const checkbox = (await embeddedCheckbox(page, ids.host, [ids.task])).asElement();
  if (checkbox !== null) {
    const box = await checkbox.boundingBox();
    if (box !== null) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);  // shockharness: ignore[MAGIC001] reason="the middle of the checkbox"
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
  assert.equal(await ownStatus(page, ids.task), 'todo', 'T6: nothing toggles in a redacted host');
  await deleteNotes(page, [ids.host, ids.parent, ids.task]);
}

export async function checkEditableEmbeds(page) {
  await reloadApp(page);
  await toggleCases(page);
  await whileEditingCase(page);
  await nestedCase(page);
  await redactedCase(page);
  await reloadApp(page);
}
