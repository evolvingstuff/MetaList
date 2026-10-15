import assert from 'node:assert/strict';

// Pasting a copied note and its reference (docs/ui/controls.md,
// docs/ui/references.md): ⌘C while editing a note (no text selected)
// remembers that note; ⌘R inserts its embedded reference ![[UUID]] in the
// note being edited; ⇧⌘R and ⇧⌘V add a child note holding the reference or
// the copy. Control works like ⌘. Keys are sent as a keyboard reports them:
// with Shift held, a letter arrives in upper case (Control+Shift+R is 'R').

const SETTLE_MS = 400;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return !mode.isLoading && !CommandGate.isBusy();
  });
  await page.waitForNetworkIdle({idleTime: 300});
}

async function reloadApp(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}

async function createNote(page, content) {
  return page.evaluate(async content => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, content, '');
    return note.id;
  }, content);
}

async function deleteNotes(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

async function startEditing(page, noteId) {
  await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).scrollIntoView({block: 'center'}), noteId);
  const box = await (await page.$(`.note[data-note-id="${noteId}"] > .note-content`)).boundingBox();
  await page.mouse.click(box.x + 10, box.y + box.height / 2);
  await page.waitForFunction(async id => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const content = document.querySelector(`.note[data-note-id="${id}"] > .note-content`);
    return mode.isEditing && mode.currentNoteId === id && content !== null && content.isContentEditable;
  }, {}, noteId);
  await idle(page);
}

// modifier is 'Meta' (⌘) or 'Control'; with Shift, the letter goes in upper case.
async function shortcut(page, modifier, letter, withShift) {
  await page.keyboard.down(modifier);
  if (withShift) {
    await page.keyboard.down('Shift');
    await page.keyboard.press(letter.toUpperCase());
    await page.keyboard.up('Shift');
  } else {
    await page.keyboard.press(letter);
  }
  await page.keyboard.up(modifier);
  await pause(SETTLE_MS);
  await idle(page);
}

function noteText(page, noteId) {
  return page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"] > .note-content`).textContent, noteId);
}

function childrenOf(page, noteId) {
  return page.evaluate(id => [...document.querySelectorAll(`.note[data-note-id="${id}"] > .note-children > .note`)]
    .map(child => ({id: child.dataset.noteId, text: child.querySelector(':scope > .note-content').textContent})), noteId);
}

async function copySource(page, modifier, sourceId) {
  await startEditing(page, sourceId);
  await shortcut(page, modifier, 'c', false);
  const remembered = await page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.clipboardNoteId;
  });
  assert.equal(remembered, sourceId, `${modifier}+C remembers the edited note`);
}

async function inlineReferenceCase(page, modifier) {
  const emptyId = await createNote(page, '');
  const sourceId = await createNote(page, '<p>The referenced note</p>');
  await reloadApp(page);
  await copySource(page, modifier, sourceId);
  await startEditing(page, emptyId);
  await shortcut(page, modifier, 'r', false);
  assert.equal(await noteText(page, emptyId), `![[${sourceId}]]`, `${modifier}+R puts the reference in the empty note`);
  await page.keyboard.press('Escape');
  await idle(page);
  await reloadApp(page);
  const embedded = await page.evaluate(id => [...document.querySelectorAll(`.note[data-note-id="${id}"] .note-embed-node[data-embed-note-id]`)]
    .map(node => node.dataset.embedNoteId), emptyId);
  assert.deepEqual(embedded, [sourceId], `${modifier}+R: the reference is saved and shown embedded`);
  await deleteNotes(page, [emptyId, sourceId]);
}

async function childCase(page, modifier, letter, expectedChildText) {
  const targetId = await createNote(page, '<p>Target note</p>');
  const sourceId = await createNote(page, '<p>The referenced note</p>');
  await reloadApp(page);
  await copySource(page, modifier, sourceId);
  await startEditing(page, targetId);
  await shortcut(page, modifier, letter, true);
  const label = `${modifier}+Shift+${letter.toUpperCase()}`;
  assert.equal(await noteText(page, targetId), 'Target note', `${label} leaves the selected note's text alone`);
  const children = await childrenOf(page, targetId);
  assert.equal(children.length, 1, `${label} adds one child note`);
  assert.equal(children[0].text, expectedChildText(sourceId), `${label}: the child holds the paste`);
  await page.keyboard.press('Escape');
  await idle(page);
  await deleteNotes(page, [children[0].id, targetId, sourceId]);
}

export async function checkReferencePaste(page) {
  await reloadApp(page);
  for (const modifier of ['Meta', 'Control']) {
    await inlineReferenceCase(page, modifier);
    await childCase(page, modifier, 'r', sourceId => `![[${sourceId}]]`);
    await childCase(page, modifier, 'v', () => 'The referenced note');
  }
  await reloadApp(page);
}
