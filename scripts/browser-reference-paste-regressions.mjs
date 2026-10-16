import assert from 'node:assert/strict';

// Pasting a copied note's reference (docs/ui/controls.md, docs/ui/references.md):
// ⌘C while editing a note (no text selected) remembers that note. A reference
// then pastes where the note itself would (⌘V, ⇧⌘V): ⌘R adds a sibling below
// holding [[UUID]], an embed (or fills an empty note), ⇧⌘R adds a child, and the menu's
// Paste Sibling Reference / Paste Child Reference do the same. Control works
// like ⌘. Keys are sent as a keyboard reports them: with Shift held the letter
// arrives in upper case (Control+Shift+R is 'R').

const SETTLE_MS = 400;
// Clicks this far inside a note's border land on its padding.
const PADDING_PX = 4;
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
// The notes a note links to (references among other content), after a reload.
async function savedLinks(page, noteId) {
  await reloadApp(page);
  return page.evaluate(id => [...document.querySelectorAll(`.note[data-note-id="${id}"] > .note-content .note-reference-link-mode[data-ref-host-note-id="${id}"]`)]
    .map(block => block.dataset.refNoteId), noteId);
}

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

// A click shows the caret where it lands; without one, the note is left as a
// ⌘V paste leaves the note it selects (caret hidden).
async function editTarget(page, targetId, withCaret) {
  await startEditing(page, targetId);
  assert.equal((await modeState(page)).caretHidden, false, 'a click shows the caret');
  if (!withCaret) {
    await page.evaluate(async id => {
      const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
      const {DOMUtils} = await import('/static/js/modules/dom-utils.js');
      mode.markCaretHidden();
      DOMUtils.hideCaret(document.querySelector(`.note[data-note-id="${id}"]`));
    }, targetId);
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
  assert.equal(await noteText(page, newId), `[[${sourceId}]]`, `${label}: the new note holds the reference`);
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
  assert.equal(reference.text, `[[${reference.sourceId}]]`, `${label}: the reference fills the note`);
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
  assert.equal(await noteText(page, newId), `[[${sourceId}]]`, `${label}: the new top note holds the reference`);
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
  assert.equal(await noteText(page, newId), `[[${sourceId}]]`, `${label}: the child holds the reference`);
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

// --- Paste Reference Into Note (M4-M6) --------------------------------------
// While editing a note with a note copied, a right-click in its text offers
// Paste Reference Into Note, last in the Paste group (after the other references): the reference goes where the
// right-click was, on its own line (a line split around it, nothing added on
// an empty line), or replaces text selected before the right-click. The note
// stays in edit mode with the caret after the reference; one ⌘Z removes it.

const HERE_LABEL = 'Paste Reference Into Note';

// A point on the boundary before `index` in the first text of the line that
// starts with `lineStart`, in the note's content.
function boundaryPoint(page, noteId, lineStart, index) {
  return page.evaluate(({noteId, lineStart, index}) => {
    const content = document.querySelector(`.note[data-note-id="${noteId}"] > .note-content`);
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!node.textContent.startsWith(lineStart)) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      return {x: rect.left + 1, y: rect.top + rect.height / 2};  // shockharness: ignore[MAGIC001] reason="just inside the boundary, at the line's vertical middle"
    }
    throw new Error(`no text starting with "${lineStart}"`);
  }, {noteId, lineStart, index});
}

function emptyLinePoint(page, noteId) {
  return page.evaluate(noteId => {
    const line = [...document.querySelectorAll(`.note[data-note-id="${noteId}"] > .note-content > *`)]
      .find(element => element.textContent.trim() === '');
    const rect = line.getBoundingClientRect();
    return {x: rect.left + 1, y: rect.top + rect.height / 2};  // shockharness: ignore[MAGIC001] reason="just inside the line, at its vertical middle"
  }, noteId);
}

async function openMenuAt(page, point) {
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await page.waitForSelector('#context-menu.is-visible');
}

// The labels a right-click at the point offers; none when no menu opens there.
async function offeredAt(page, point) {
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await pause(SETTLE_MS);
  if (await page.$('#context-menu.is-visible') === null) return [];
  const labels = await menuLabels(page);
  await page.keyboard.press('Escape');
  await idle(page);
  return [...labels.top, ...labels.paste];
}

// The items the menu shows, with the Paste submenu's (opened on hover).
async function menuLabels(page) {
  const top = await page.evaluate(() => [...document.querySelectorAll('#context-menu .context-menu-item')]
    .filter(item => item.offsetParent !== null).map(item => item.textContent.trim()));
  const pasteGroup = await page.evaluateHandle(() => [...document.querySelectorAll('#context-menu .context-menu-item')]
    .filter(item => item.offsetParent !== null).find(item => item.textContent.trim() === 'Paste›'));
  const element = pasteGroup.asElement();
  if (element === null) return {top, paste: []};
  await element.hover();
  await page.waitForSelector('#context-submenu.is-visible');
  const paste = await page.evaluate(() => [...document.querySelectorAll('#context-submenu .context-menu-item')]
    .filter(item => item.offsetParent !== null).map(item => item.textContent.trim()));
  return {top, paste};
}

async function chooseOpenMenuItem(page, label) {
  const item = await page.evaluateHandle(label => [...document.querySelectorAll('.context-menu-item')]
    .filter(node => node.offsetParent !== null).find(node => node.textContent.trim().startsWith(label)), label);
  const element = item.asElement();
  assert.notEqual(element, null, `the menu should offer ${label}`);
  await element.click();
  await pause(SETTLE_MS);
  await idle(page);
}

// The note's lines: its block elements' text (innerText would add a blank
// line between paragraphs). A space that starts a line is kept by the browser
// as a no-break space, so it stays visible: read as the space it is.
function contentLines(page, noteId) {
  return page.evaluate(id => [...document.querySelectorAll(`.note[data-note-id="${id}"] > .note-content > *`)]
    .map(element => element.textContent.replaceAll('\u00a0', ' ')), noteId);
}

// The caret, as the text from the note's start up to it.
function textBeforeCaret(page, noteId) {
  return page.evaluate(id => {
    const content = document.querySelector(`.note[data-note-id="${id}"] > .note-content`);
    const selection = window.getSelection();
    if (selection.rangeCount === 0 || !selection.isCollapsed || !content.contains(selection.anchorNode)) return null;
    const range = document.createRange();
    range.selectNodeContents(content);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return range.toString();
  }, noteId);
}

// The editor's own undo/redo, as ⌘Z / ⇧⌘Z (Ctrl elsewhere) run it while
// typing. Headless Chrome on a Mac does not turn ⌘Z into the editing command
// itself, so it is named.
async function editorHistory(page, command) {
  let modifier = 'Control';
  if (process.platform === 'darwin') modifier = 'Meta';
  await page.keyboard.down(modifier);
  if (command === 'redo') await page.keyboard.down('Shift');
  await page.keyboard.press('z', {commands: [command]});
  if (command === 'redo') await page.keyboard.up('Shift');
  await page.keyboard.up(modifier);
  await pause(SETTLE_MS);
}

async function pasteHereCase(page, {label, html, point, select, expected}) {
  const targetId = await createNote(page, html);
  const sourceId = await createNote(page, '<p>The referenced note</p>');
  await reloadApp(page);
  await copyNote(page, 'Meta', sourceId);
  await startEditing(page, targetId);
  const before = await contentLines(page, targetId);
  if (select !== null) {
    await page.evaluate(({id, select}) => {
      const content = document.querySelector(`.note[data-note-id="${id}"] > .note-content`);
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!node.textContent.includes(select)) continue;
        const start = node.textContent.indexOf(select);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + select.length);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        return;
      }
      throw new Error(`no text "${select}" to select`);
    }, {id: targetId, select});
  }
  await openMenuAt(page, await point(targetId));
  const labels = await menuLabels(page);
  assert.deepEqual(labels.paste.slice(-2), ['Paste Child Reference⇧⌘R', HERE_LABEL], `${label}: ${HERE_LABEL} comes last in the Paste group, after the other references (${JSON.stringify(labels)})`);
  await chooseOpenMenuItem(page, HERE_LABEL);

  const token = `[[${sourceId}]]`;
  const lines = expected(token);
  assert.deepEqual(await contentLines(page, targetId), lines, `${label}: the reference goes where the right-click was, on its own line`);
  const state = await modeState(page);
  assert.deepEqual([state.editing, state.current], [true, targetId], `${label}: the note stays in edit mode`);
  const caretText = await textBeforeCaret(page, targetId);
  assert(caretText !== null && caretText.endsWith(token), `${label}: the caret is right after the reference, got "${caretText}"`);

  await editorHistory(page, 'undo');
  assert.deepEqual(await contentLines(page, targetId), before, `${label}: one undo removes it`);
  await editorHistory(page, 'redo');
  assert.deepEqual(await contentLines(page, targetId), lines, `${label}: redo puts it back`);
  await leaveEditing(page);
  assert.deepEqual(await savedLinks(page, targetId), [sourceId], `${label}: saved with the note and shown as a link, among its text`);
  await deleteNotes(page, [targetId, sourceId]);
}

async function pasteHereCases(page) {
  const sentence = '<p>Alpha beta gamma</p><p>Second paragraph</p>';
  await pasteHereCase(page, {
    label: 'right-click mid-line', html: sentence, select: null,
    point: id => boundaryPoint(page, id, 'Alpha beta gamma', 'Alpha beta'.length),
    expected: token => ['Alpha beta', token, ' gamma', 'Second paragraph'],
  });
  await pasteHereCase(page, {
    label: 'right-click inside a word, nothing selected', html: sentence, select: null,
    point: id => boundaryPoint(page, id, 'Alpha beta gamma', 'Alpha be'.length),
    expected: token => ['Alpha be', token, 'ta gamma', 'Second paragraph'],
  });
  await pasteHereCase(page, {
    label: 'right-click on an empty line', html: '<p>First line</p><p><br></p><p>Third line</p>', select: null,
    point: id => emptyLinePoint(page, id),
    expected: token => ['First line', token, 'Third line'],
  });
  await pasteHereCase(page, {
    label: 'right-click inside text selected before', html: sentence, select: 'beta',
    point: id => boundaryPoint(page, id, 'Alpha beta gamma', 'Alpha b'.length),
    expected: token => ['Alpha ', token, ' gamma', 'Second paragraph'],
  });
}

// M6: hidden where there is no spot in the edited note's text to paste at.
async function pasteHereHiddenCases(page) {
  const editedId = await createNote(page, '<p>The edited note</p>');
  const otherId = await createNote(page, '<p>Another note</p>');
  const sourceId = await createNote(page, '<p>The referenced note</p>');
  await reloadApp(page);
  await copyNote(page, 'Meta', sourceId);
  await startEditing(page, editedId);
  const places = [
    ['a note not being edited', () => boundaryPoint(page, otherId, 'Another note', 'An'.length)],
    ["the edited note's padding", () => page.evaluate(({id, padding}) => {
      const box = document.querySelector(`.note[data-note-id="${id}"]`).getBoundingClientRect();
      return {x: box.right - padding, y: box.top + padding};
    }, {id: editedId, padding: PADDING_PX})],
  ];
  for (const [where, point] of places) {
    const offered = await offeredAt(page, await point());
    assert(!offered.includes(HERE_LABEL), `right-click on ${where}: no ${HERE_LABEL} (${JSON.stringify(offered)})`);
    await startEditing(page, editedId);
  }
  // The tag bar has its own menu, without it.
  const tagBar = await page.$('.note.editing .note-tag-bar-input');
  assert.notEqual(tagBar, null, 'the edited note shows its tag bar');
  {
    const box = await tagBar.boundingBox();
    const offered = await offeredAt(page, {x: box.x + box.width - PADDING_PX, y: box.y + box.height / 2});  // shockharness: ignore[MAGIC001] reason="the tag bar's vertical middle"
    assert(!offered.includes(HERE_LABEL), `right-click on the tag bar: no ${HERE_LABEL} (${JSON.stringify(offered)})`);
  }
  // Nothing copied (a reload forgets it): not offered in the text either.
  await reloadApp(page);
  await startEditing(page, editedId);
  const offered = await offeredAt(page, await boundaryPoint(page, editedId, 'The edited note', 'The'.length));
  assert(offered.includes('Copy Note⌘C') && !offered.includes(HERE_LABEL), `nothing copied: the note menu, without ${HERE_LABEL} (${JSON.stringify(offered)})`);
  await leaveEditing(page);
  await deleteNotes(page, [editedId, otherId, sourceId]);
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
  await pasteHereCases(page);
  await pasteHereHiddenCases(page);
  await reloadApp(page);
}
