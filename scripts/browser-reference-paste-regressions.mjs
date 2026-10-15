import assert from 'node:assert/strict';

// Pasting a copied note's reference (docs/ui/controls.md, docs/ui/references.md):
// ⌘C while editing a note (no text selected) remembers that note. A reference
// then pastes where the note itself would (⌘V, ⇧⌘V): ⌘R adds a sibling below
// holding ![[UUID]] (or fills an empty note), ⇧⌘R adds a child, and the menu's
// Paste Sibling Reference / Paste Child Reference do the same. Control works
// like ⌘. Keys are sent as a keyboard reports them: with Shift held the letter
// arrives in upper case (Control+Shift+R is 'R').

const SETTLE_MS = 400;
// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
// Typing into the command palette, and a submenu opening on hover.
const PALETTE_OPEN_MS = 400;
const PALETTE_FILTER_MS = 300;
const SUBMENU_OPEN_MS = 400;
// Clicks land this far inside the note's text: near its start for a caret,
// near its end for the menu (clear of the text's start).
const CLICK_INSET_PX = 10;
const MENU_CLICK_INSET_PX = 20;
const BLOCKED_MESSAGE = 'sort order';
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

async function createNote(page, content) {
  return page.evaluate(async content => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, content, '');
    return note.id;
  }, content);
}

async function createChild(page, parentId, content) {
  return page.evaluate(async ({parentId, content}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createChild(parentId, '');
    await NotesAPI.saveNote(note.id, content, '');
    return note.id;
  }, {parentId, content});
}

async function deleteNotes(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

function middleY(box) {
  return box.y + box.height / 2;  // shockharness: ignore[MAGIC001] reason="halving: the vertical middle of the box"
}

async function startEditing(page, noteId) {
  await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).scrollIntoView({block: 'center'}), noteId);
  const box = await (await page.$(`.note[data-note-id="${noteId}"] > .note-content`)).boundingBox();
  await page.mouse.click(box.x + CLICK_INSET_PX, middleY(box));
  await page.waitForFunction(async id => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const content = document.querySelector(`.note[data-note-id="${id}"] > .note-content`);
    return mode.isEditing && mode.currentNoteId === id && content !== null && content.isContentEditable;
  }, {}, noteId);
  await idle(page);
}

async function leaveEditing(page) {
  await page.keyboard.press('Escape');
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

function modeState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {editing: mode.isEditing, current: mode.currentNoteId, caretHidden: mode.isCaretHidden,
      copied: mode.clipboardNoteId, rootCountTotal: mode.rootCountTotal};
  });
}

function noteText(page, noteId) {
  return page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"] > .note-content`).textContent, noteId);
}

function rootOrder(page) {
  return page.evaluate(() => [...document.querySelectorAll('#notes-container > .note')].map(note => note.dataset.noteId));
}

function childrenOf(page, noteId) {
  return page.evaluate(id => [...document.querySelectorAll(`.note[data-note-id="${id}"] > .note-children > .note`)]
    .map(child => child.dataset.noteId), noteId);
}

// The note's saved text, as a reload shows it: the reference renders embedded.
async function savedEmbeds(page, noteId) {
  await reloadApp(page);
  return page.evaluate(id => [...document.querySelectorAll(`.note[data-note-id="${id}"] > .note-content .note-embed-node[data-embed-note-id]`)]
    .map(node => node.dataset.embedNoteId), noteId);
}

function bannerText(page) {
  return page.evaluate(() => {
    const message = document.querySelector('#error-banner .error-banner-message');
    return message ? message.textContent : '';
  });
}

async function runPaletteCommand(page, query) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('/');
  await page.keyboard.up('Meta');
  await pause(PALETTE_OPEN_MS);
  await page.keyboard.type(query);
  await pause(PALETTE_FILTER_MS);
  await page.keyboard.press('Enter');
  await idle(page);
  await pause(PALETTE_FILTER_MS);
}

async function copyNote(page, modifier, sourceId) {
  await startEditing(page, sourceId);
  await shortcut(page, modifier, 'c', false);
  assert.equal((await modeState(page)).copied, sourceId, `${modifier}+C remembers the edited note`);
}

// A first click into a note selects it with the caret hidden (as ⌘V leaves a
// pasted note); a second click shows the caret there.
async function editTarget(page, targetId, withCaret) {
  await startEditing(page, targetId);
  assert.equal((await modeState(page)).caretHidden, true, 'a first click selects the note, caret hidden');
  if (withCaret) {
    const box = await (await page.$(`.note[data-note-id="${targetId}"] > .note-content`)).boundingBox();
    await page.mouse.click(box.x + CLICK_INSET_PX, middleY(box));
    await idle(page);
    assert.equal((await modeState(page)).caretHidden, false, 'a second click shows the caret');
  }
}

async function chooseMenuItem(page, noteId, label) {
  const box = await (await page.$(`.note[data-note-id="${noteId}"] > .note-content`)).boundingBox();
  await page.mouse.click(box.x + box.width - MENU_CLICK_INSET_PX, middleY(box), {button: 'right'});
  await page.waitForSelector('#context-menu.is-visible');
  // The Paste submenu opens beside the menu, outside #context-menu.
  const find = label => page.evaluateHandle(label => [...document.querySelectorAll('.context-menu-item')]
    .filter(item => item.offsetParent !== null).find(item => item.textContent.trim().startsWith(label)), label);
  const pasteGroup = (await find('Paste')).asElement();
  if (pasteGroup !== null && (await pasteGroup.evaluate(node => node.textContent.trim())).startsWith('Paste›')) {
    await pasteGroup.hover();
    await pause(SUBMENU_OPEN_MS);
  }
  const item = (await find(label)).asElement();
  assert.notEqual(item, null, `the menu should offer ${label}`);
  await item.click();
  await pause(SETTLE_MS);
  await idle(page);
}

// K1 / M2: a sibling right below the note, holding the reference, saved and
// selected with no caret; one ⌘Z removes it.
async function siblingCase(page, {modifier, withCaret, viaMenu}) {
  const label = `${viaMenu ? 'Paste Sibling Reference' : `${modifier}+R`}, ${withCaret ? 'caret' : 'no caret'}`;
  const targetId = await createNote(page, '<p>Target note</p>');
  const sourceId = await createNote(page, '<p>The referenced note</p>');
  await reloadApp(page);
  await copyNote(page, modifier, sourceId);
  await editTarget(page, targetId, withCaret);
  const rootsBefore = await rootOrder(page);
  if (viaMenu) await chooseMenuItem(page, targetId, 'Paste Sibling Reference');
  else await shortcut(page, modifier, 'r', false);

  assert.equal(await noteText(page, targetId), 'Target note', `${label}: the note's own text is unchanged`);
  const roots = await rootOrder(page);
  assert.equal(roots.length, rootsBefore.length + 1, `${label}: one note is added`);
  const newId = roots[roots.indexOf(targetId) + 1];
  assert(!rootsBefore.includes(newId), `${label}: the new note sits right below the note`);
  assert.equal(await noteText(page, newId), `![[${sourceId}]]`, `${label}: the new note holds the reference`);
  const state = await modeState(page);
  assert.deepEqual([state.editing, state.current, state.caretHidden], [true, newId, true], `${label}: the new note is selected, with no caret`);

  await shortcut(page, modifier, 'z', false);
  assert.deepEqual(await rootOrder(page), rootsBefore, `${label}: one undo removes it`);
  await shortcut(page, modifier, 'z', true);
  assert.deepEqual(await savedEmbeds(page, newId), [sourceId], `${label}: redone, the reference is saved and shown embedded`);
  await deleteNotes(page, [newId, targetId, sourceId]);
}

// K2: an empty note with no children is filled, not given a sibling, and is
// left as ⌘V leaves the empty note it fills.
async function emptyNoteFill(page, modifier, letter) {
  const emptyId = await createNote(page, '');
  const sourceId = await createNote(page, '<p>The referenced note</p>');
  await reloadApp(page);
  await copyNote(page, modifier, sourceId);
  await editTarget(page, emptyId, false);
  const rootsBefore = await rootOrder(page);
  await shortcut(page, modifier, letter, false);
  const result = {roots: await rootOrder(page), text: await noteText(page, emptyId), state: await modeState(page)};
  await leaveEditing(page);
  const embeds = await savedEmbeds(page, emptyId);
  await deleteNotes(page, [emptyId, sourceId]);
  return {...result, rootsBefore, emptyId, sourceId, embeds};
}

async function emptyNoteCase(page, modifier) {
  const label = `${modifier}+R on an empty note`;
  const paste = await emptyNoteFill(page, modifier, 'v');
  assert.equal(paste.text, 'The referenced note', `${modifier}+V fills an empty note (the rule ⌘R follows)`);
  const reference = await emptyNoteFill(page, modifier, 'r');
  assert.deepEqual(reference.roots, reference.rootsBefore, `${label}: no note is added`);
  assert.equal(reference.text, `![[${reference.sourceId}]]`, `${label}: the reference fills the note`);
  const left = state => [state.editing, state.current === null, state.caretHidden];
  assert.deepEqual([reference.state.current, ...left(reference.state)], [reference.emptyId, ...left(paste.state)],
    `${label}: the note is left as ${modifier}+V leaves it (V: ${JSON.stringify(paste.state)})`);
  assert.deepEqual(reference.embeds, [reference.sourceId], `${label}: saved`);
}

// K3: not editing, a new top note holds the reference.
async function topNoteCase(page, modifier) {
  const label = `${modifier}+R with no note selected`;
  const sourceId = await createNote(page, '<p>The referenced note</p>');
  await reloadApp(page);
  await copyNote(page, modifier, sourceId);
  await leaveEditing(page);
  const rootsBefore = await rootOrder(page);
  await shortcut(page, modifier, 'r', false);
  const roots = await rootOrder(page);
  assert.equal(roots.length, rootsBefore.length + 1, `${label}: one note is added`);
  const newId = roots[0];
  assert.equal(await noteText(page, newId), `![[${sourceId}]]`, `${label}: the new top note holds the reference`);
  assert.deepEqual(await savedEmbeds(page, newId), [sourceId], `${label}: saved`);
  await deleteNotes(page, [newId, sourceId]);
}

// K4 / M3: a first child, holding the reference, saved and selected with no
// caret (where ⇧⌘V puts its child).
async function childCase(page, {modifier, withCaret, viaMenu}) {
  const label = `${viaMenu ? 'Paste Child Reference' : `${modifier}+Shift+R`}, ${withCaret ? 'caret' : 'no caret'}`;
  const targetId = await createNote(page, '<p>Target note</p>');
  const existingChildId = await createChild(page, targetId, '<p>Existing child</p>');
  const sourceId = await createNote(page, '<p>The referenced note</p>');
  await reloadApp(page);
  await copyNote(page, modifier, sourceId);
  await editTarget(page, targetId, withCaret);
  if (viaMenu) await chooseMenuItem(page, targetId, 'Paste Child Reference');
  else await shortcut(page, modifier, 'r', true);

  assert.equal(await noteText(page, targetId), 'Target note', `${label}: the note's own text is unchanged`);
  const children = await childrenOf(page, targetId);
  assert.deepEqual(children.slice(1), [existingChildId], `${label}: one child is added`);
  assert.equal(children[1], existingChildId, `${label}: the new child comes first, as with ⇧⌘V`);
  const newId = children[0];
  assert.equal(await noteText(page, newId), `![[${sourceId}]]`, `${label}: the child holds the reference`);
  const state = await modeState(page);
  assert.deepEqual([state.editing, state.current, state.caretHidden], [true, newId, true], `${label}: the child is selected, with no caret`);
  assert.deepEqual(await savedEmbeds(page, newId), [sourceId], `${label}: saved`);
  await deleteNotes(page, [newId, existingChildId, targetId, sourceId]);
}

// ⇧⌘V, for comparison: the copy lands where ⇧⌘R puts its reference.
async function childPasteCase(page, modifier) {
  const label = `${modifier}+Shift+V`;
  const targetId = await createNote(page, '<p>Target note</p>');
  const sourceId = await createNote(page, '<p>The referenced note</p>');
  await reloadApp(page);
  await copyNote(page, modifier, sourceId);
  await editTarget(page, targetId, true);
  await shortcut(page, modifier, 'v', true);
  assert.equal(await noteText(page, targetId), 'Target note', `${label}: the note's own text is unchanged`);
  const children = await childrenOf(page, targetId);
  assert.equal(children.length, 1, `${label}: one child is added`);
  assert.equal(await noteText(page, children[0]), 'The referenced note', `${label}: the child is the copy`);
  await leaveEditing(page);
  await deleteNotes(page, [children[0], targetId, sourceId]);
}

// K5: ⇧⌘R with nothing selected does nothing.
async function childWithoutSelectionCase(page, modifier) {
  const label = `${modifier}+Shift+R with no note selected`;
  const sourceId = await createNote(page, '<p>The referenced note</p>');
  await reloadApp(page);
  await copyNote(page, modifier, sourceId);
  await leaveEditing(page);
  const rootsBefore = await rootOrder(page);
  await shortcut(page, modifier, 'r', true);
  assert.deepEqual(await rootOrder(page), rootsBefore, `${label}: nothing is added`);
  assert.equal((await modeState(page)).editing, false, `${label}: nothing is selected`);
  await deleteNotes(page, [sourceId]);
}

// K6: where the sort order blocks new root notes, ⌘R says so, like ⌘V.
async function blockedRootCase(page, modifier) {
  const label = `${modifier}+R in a content-volume tab`;
  const targetId = await createNote(page, '<p>Target note</p>');
  const sourceId = await createNote(page, '<p>The referenced note</p>');
  await reloadApp(page);
  await copyNote(page, modifier, sourceId);
  await leaveEditing(page);
  await runPaletteCommand(page, 'Sort order: Content volume');
  await editTarget(page, targetId, true);
  const {rootCountTotal} = await modeState(page);
  await shortcut(page, modifier, 'r', false);
  const banner = await bannerText(page);
  assert(banner.toLowerCase().includes(BLOCKED_MESSAGE), `${label}: a banner explains the block, got "${banner}"`);
  assert.equal((await modeState(page)).rootCountTotal, rootCountTotal, `${label}: no root note is created`);
  assert.equal(await noteText(page, targetId), 'Target note', `${label}: the note's own text is unchanged`);
  await leaveEditing(page);
  await runPaletteCommand(page, 'Sort order: Normal');
  await deleteNotes(page, [targetId, sourceId]);
}

// K7: nothing copied (a reload forgets the copied note): nothing happens,
// and the browser's own ⌘R / ⇧⌘R (reload) does not run either.
async function nothingCopiedCase(page, modifier) {
  const targetId = await createNote(page, '<p>Target note</p>');
  await reloadApp(page);
  assert.equal((await modeState(page)).copied, null, 'a reload forgets the copied note');
  await page.evaluate(() => { window.__referencePasteMarker = true; });
  await editTarget(page, targetId, true);
  const rootsBefore = await rootOrder(page);
  for (const withShift of [false, true]) {
    const label = `${modifier}+${withShift ? 'Shift+' : ''}R with no note copied`;
    await shortcut(page, modifier, 'r', withShift);
    assert.equal(await page.evaluate(() => window.__referencePasteMarker === true), true, `${label}: the page is not reloaded`);
    assert.deepEqual(await rootOrder(page), rootsBefore, `${label}: nothing is added`);
    assert.deepEqual(await childrenOf(page, targetId), [], `${label}: no child is added`);
    assert.equal(await noteText(page, targetId), 'Target note', `${label}: the note's text is unchanged`);
  }
  await leaveEditing(page);
  await deleteNotes(page, [targetId]);
}

export async function checkReferencePaste(page) {
  await reloadApp(page);
  for (const modifier of ['Meta', 'Control']) {
    for (const withCaret of [true, false]) {
      await siblingCase(page, {modifier, withCaret, viaMenu: false});
      await childCase(page, {modifier, withCaret, viaMenu: false});
    }
    await emptyNoteCase(page, modifier);
    await topNoteCase(page, modifier);
    await childPasteCase(page, modifier);
    await childWithoutSelectionCase(page, modifier);
    await blockedRootCase(page, modifier);
    await nothingCopiedCase(page, modifier);
  }
  await siblingCase(page, {modifier: 'Meta', withCaret: true, viaMenu: true});
  await childCase(page, {modifier: 'Meta', withCaret: true, viaMenu: true});
  await reloadApp(page);
}
