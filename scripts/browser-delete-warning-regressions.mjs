import assert from 'node:assert/strict';

// Deleting or cutting a note other notes reference (docs/ui/references.md):
// MetaList asks first, saying how many notes would have broken references
// (references to the note or to any note under it, from outside it). A note
// being edited is saved and left before the dialog shows (interaction
// principle 6). Cancel leaves the note in place; Delete or Cut goes ahead as
// before, and one undo brings the note back. An unreferenced note is deleted
// or cut at once, as before.

const SETTLE_MS = 400;
// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
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

// Notes from a spec: [name, html, parentName | null]; HTML may name other
// notes as ![[name]] or [[name]].
async function createNotes(page, spec) {
  return page.evaluate(async spec => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = {};
    for (const [name, , parent] of spec) {
      let note;
      if (parent === null) note = await NotesAPI.createNote(null, '');
      else note = await NotesAPI.createChild(ids[parent], '');
      ids[name] = note.id;
    }
    for (const [name, html] of spec) {
      await NotesAPI.saveNote(ids[name], html.replace(/\[\[(\w+)\]\]/g, (_, ref) => `[[${ids[ref]}]]`), '');
    }
    return ids;
  }, spec);
}

async function deleteNotes(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) {
      if (document.querySelector(`.note[data-note-id="${id}"]`) !== null) await NotesAPI.deleteNote(id);
    }
  }, ids);
}

function noteShown(page, noteId) {
  return page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`) !== null, noteId);
}

function modeState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {editing: mode.isEditing, current: mode.currentNoteId, clipboardMode: mode.clipboardMode};
  });
}

// The warning, when it shows: its eyebrow, title, text and buttons.
function dialog(page) {
  return page.evaluate(() => {
    const modal = document.getElementById('confirmation-modal');
    if (modal === null || modal.style.display === 'none') return null;
    return {
      eyebrow: modal.querySelector('.prioritize-modal-eyebrow').textContent,
      title: modal.querySelector('h3').textContent,
      text: modal.querySelector('.alphabetize-root-notes-warning p').textContent,
      buttons: [...modal.querySelectorAll('.form-actions button')].map(button => button.textContent.trim()),
    };
  });
}

async function answer(page, button) {
  await page.click(button === 'cancel' ? '#confirmation-cancel-btn' : '#confirmation-submit-btn');
  await pause(SETTLE_MS);
  await idle(page);
}

async function startEditing(page, noteId) {
  await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).scrollIntoView({block: 'center'}), noteId);
  const box = await (await page.$(`.note[data-note-id="${noteId}"] > .note-content`)).boundingBox();
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);  // shockharness: ignore[MAGIC001] reason="near the end of the line, at its middle"
  await idle(page);
  const state = await modeState(page);
  assert.deepEqual([state.editing, state.current], [true, noteId], `editing ${noteId}`);
}

async function shortcut(page, key) {
  await page.keyboard.down('Meta');
  await page.keyboard.press(key);
  await page.keyboard.up('Meta');
  await pause(SETTLE_MS);
  await idle(page);
}

async function menuDelete(page, noteId) {
  const box = await (await page.$(`.note[data-note-id="${noteId}"] > .note-content`)).boundingBox();
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2, {button: 'right'});  // shockharness: ignore[MAGIC001] reason="near the end of the line, at its middle"
  await page.waitForSelector('#context-menu.is-visible');
  const item = await page.evaluateHandle(() => [...document.querySelectorAll('.context-menu-item')]
    .filter(node => node.offsetParent !== null).find(node => node.textContent.trim().startsWith('Delete Note')));
  const element = item.asElement();
  assert.notEqual(element, null, 'the menu offers Delete Note');
  await element.click();
  await pause(SETTLE_MS);
  await idle(page);
}

function expectedWarning(count, verb) {
  const notes = count === 1 ? '1 other note references' : `${count} other notes reference`;
  return {
    eyebrow: `${verb} note`,
    title: `${notes} this note`,
    text: `${verb} it anyway? Their references will show as missing.`,
    buttons: ['Cancel', verb],
  };
}

// D1 (menu, not editing): asked first; Cancel keeps it; Delete deletes; undo restores.
async function menuDeleteCase(page) {
  const ids = await createNotes(page, [
    ['source', '<p>The source note</p>', null],
    ['embedding', '<div>Embeds it</div><div>![[source]]</div>', null],
    ['linking', '<div>Links it: [[source]]</div>', null],
  ]);
  await reloadApp(page);
  await menuDelete(page, ids.source);
  const referring = [ids.embedding, ids.linking].length;
  assert.deepEqual(await dialog(page), expectedWarning(referring, 'Delete'), 'D1 menu: the warning counts the two referring notes');
  await answer(page, 'cancel');
  assert.equal(await dialog(page), null, 'D1 menu: Cancel closes the warning');
  assert.equal(await noteShown(page, ids.source), true, 'D1 menu: Cancel keeps the note');

  await menuDelete(page, ids.source);
  await answer(page, 'confirm');
  assert.equal(await noteShown(page, ids.source), false, 'D1 menu: Delete deletes it');
  await shortcut(page, 'z');
  assert.equal(await noteShown(page, ids.source), true, 'D1 menu: one undo brings it back');
  const embedded = await page.evaluate(({host, source}) => document.querySelector(
    `.note[data-note-id="${host}"] .note-embed-node[data-embed-note-id="${source}"]`) !== null, {host: ids.embedding, source: ids.source});
  assert.equal(embedded, true, 'D1 menu: its references work again');
  await deleteNotes(page, [ids.embedding, ids.linking, ids.source]);
}

// D1 (⌘⌫ while editing): saved and left first; Cancel keeps it. (The trash-can
// button asks the same way but is not in the page: index.html comments it out.)
async function editingDeleteCase(page) {
  const ids = await createNotes(page, [
    ['source', '<p>The source note</p>', null],
    ['linking', '<div>Links it: [[source]]</div>', null],
  ]);
  await reloadApp(page);
  await startEditing(page, ids.source);
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await shortcut(page, 'Backspace');
  const label = 'D1 ⌘⌫';
  assert.deepEqual(await dialog(page), expectedWarning(1, 'Delete'), `${label}: the warning counts the referring note`);
  assert.equal((await modeState(page)).editing, false, `${label}: edit mode ends as the warning shows`);
  await answer(page, 'cancel');
  assert.equal(await noteShown(page, ids.source), true, `${label}: Cancel keeps the note`);
  // Its text, without the ↖ backlinks button a referenced note shows.
  const savedText = await page.$eval(`.note[data-note-id="${ids.source}"] > .note-content`, node => {
    const copy = node.cloneNode(true);
    for (const button of copy.querySelectorAll('.note-backlinks-link')) button.remove();
    return copy.textContent;
  });
  assert.equal(savedText, 'The source note edited', `${label}: what was typed is saved`);
  assert.equal((await modeState(page)).editing, false, `${label}: Cancel leaves it out of edit mode`);

  await startEditing(page, ids.source);
  await shortcut(page, 'Backspace');
  await answer(page, 'confirm');
  assert.equal(await noteShown(page, ids.source), false, `${label}: Delete deletes it`);
  await deleteNotes(page, [ids.linking]);
}

// D1b (⌘X): the same, with Cut; nothing is copied unless confirmed.
async function cutCase(page) {
  const ids = await createNotes(page, [
    ['source', '<p>The source note</p>', null],
    ['linking', '<div>Links it: [[source]]</div>', null],
  ]);
  await reloadApp(page);
  await startEditing(page, ids.source);
  const clipboardBefore = (await modeState(page)).clipboardMode;
  await shortcut(page, 'x');
  assert.deepEqual(await dialog(page), expectedWarning(1, 'Cut'), 'D1b: the warning asks before cutting');
  await answer(page, 'cancel');
  assert.equal(await noteShown(page, ids.source), true, 'D1b: Cancel keeps the note');
  assert.equal((await modeState(page)).clipboardMode, clipboardBefore, 'D1b: Cancel copies nothing');

  await startEditing(page, ids.source);
  await shortcut(page, 'x');
  await answer(page, 'confirm');
  assert.equal(await noteShown(page, ids.source), false, 'D1b: Cut removes it');
  assert.equal((await modeState(page)).clipboardMode, 'note', 'D1b: and copies it, ready to paste');
  await deleteNotes(page, [ids.linking]);
}

// D2: a reference to a child counts; one from inside the subtree does not.
async function childReferencedCase(page) {
  const ids = await createNotes(page, [
    ['parent', '<div>The parent</div><div>![[child]]</div>', null],
    ['child', '<p>Its child</p>', 'parent'],
    ['outside', '<div>Links the child: [[child]]</div>', null],
  ]);
  await reloadApp(page);
  await menuDelete(page, ids.parent);
  assert.deepEqual(await dialog(page), expectedWarning(1, 'Delete'), 'D2: only the reference from outside counts');
  await answer(page, 'cancel');
  await deleteNotes(page, [ids.outside, ids.parent]);
}

// D3: an unreferenced note is deleted, or cut, at once.
async function unreferencedCase(page) {
  const ids = await createNotes(page, [
    ['plain', '<p>Nobody references this</p>', null],
    ['cut', '<p>Nor this</p>', null],
  ]);
  await reloadApp(page);
  await startEditing(page, ids.plain);
  await shortcut(page, 'Backspace');
  assert.equal(await dialog(page), null, 'D3: no warning');
  assert.equal(await noteShown(page, ids.plain), false, 'D3: deleted at once');
  await startEditing(page, ids.cut);
  await shortcut(page, 'x');
  assert.equal(await dialog(page), null, 'D3: no warning for a cut either');
  assert.equal(await noteShown(page, ids.cut), false, 'D3: cut at once');
}

export async function checkDeleteWarning(page) {
  await reloadApp(page);
  await unreferencedCase(page);
  await menuDeleteCase(page);
  await editingDeleteCase(page);
  await cutCase(page);
  await childReferencedCase(page);
  await reloadApp(page);
}
