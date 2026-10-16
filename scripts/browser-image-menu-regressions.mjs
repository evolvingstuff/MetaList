import assert from 'node:assert/strict';

// Image sizes from the note menu while editing (docs/ui/content-formatting.md,
// docs/ui/interaction-principles.md): right-clicking an image in the note being
// edited offers Make Bigger, Make Smaller and Reset Size. The size tag changes in
// the tag bar (and the image's braces in the text); edit mode, the image's place
// on screen and the caret stay as they were; typing is saved first; ⌘Z undoes
// the size, then the typing.

const SETTLE_MS = 400;
// Quiet network for this long counts as idle.
const NETWORK_IDLE_MS = 300;
// Halfway across or down a box: its middle.
const MIDDLE = 0.5;
// Positions are compared to the pixel; 1px covers sub-pixel rounding only.
const EXACT_PX = 1;
// A 48×48 red PNG.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQklEQVR4nO3OQQ0AIAwAsQlDBLKRhQuOR5MK6Jy9vjL5QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF21V9KbVaAsfAAAAAElFTkSuQmCC';
const IMAGE = `<img src="data:image/png;base64,${PNG_BASE64}" alt="dot">`;
const SIZE_ITEMS = ['Make Bigger', 'Make Smaller', 'Reset Size'];

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

async function createNotes(page, spec) {
  return page.evaluate(async spec => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = {};
    for (const [name] of spec) ids[name] = (await NotesAPI.createNote(null, '')).id;
    for (const [name, html, tags] of spec) await NotesAPI.saveNote(ids[name], html, tags);
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

async function startEditingAtEndOf(page, noteId, text) {
  const point = await page.evaluate(({noteId, text, middle}) => {
    const content = document.querySelector(`.note[data-note-id="${noteId}"] > .note-content`);
    content.scrollIntoView({block: 'center'});
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!node.textContent.includes(text)) continue;
      const at = node.textContent.indexOf(text);
      const range = document.createRange();
      range.setStart(node, at + text.length - 1);
      range.setEnd(node, at + text.length);
      const rect = range.getBoundingClientRect();
      return {x: rect.right - 1, y: rect.top + rect.height * middle};
    }
    throw new Error(`text not found: ${text}`);
  }, {noteId, text, middle: MIDDLE});
  await page.mouse.click(point.x, point.y);
  await idle(page);
  await pause(SETTLE_MS);
}

// Where things are: edit mode, the caret as characters from the editor's start,
// the image's top, the tag bar and the editor's text.
function editState(page, noteId) {
  return page.evaluate(async noteId => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const note = document.querySelector(`.note[data-note-id="${noteId}"]`);
    const content = note.querySelector(':scope > .note-content');
    const image = content.querySelector('img');
    // While the note is edited its tags are in the tag bar; otherwise on the note.
    let tags = note.dataset.noteTags;
    const tagBar = note.querySelector('.note-tag-bar-input');
    if (tagBar !== null) tags = tagBar.value;
    let caret = null;
    const selection = window.getSelection();
    if (selection.rangeCount > 0 && content.contains(selection.anchorNode)) {
      const before = document.createRange();
      before.setStart(content, 0);
      before.setEnd(selection.anchorNode, selection.anchorOffset);
      caret = before.toString().length;
    }
    return {
      editing: mode.isEditing && mode.currentNoteId === noteId,
      caret,
      imageTop: image === null ? null : image.getBoundingClientRect().top,
      tags,
      html: content.innerHTML,
      text: content.textContent,
    };
  }, noteId);
}

async function imageMenu(page, noteId, choice) {
  const selector = `.note[data-note-id="${noteId}"] > .note-content img`;
  await page.waitForFunction(selector => {
    const image = document.querySelector(selector);
    return image !== null && image.complete && image.getBoundingClientRect().width > 0;
  }, {}, selector);
  const box = await (await page.$(selector)).boundingBox();
  await page.mouse.click(box.x + box.width * MIDDLE, box.y + box.height * MIDDLE, {button: 'right'});
  await page.waitForSelector('#context-menu.is-visible');
  const labels = await page.evaluate(() => [...document.querySelectorAll('#context-menu.is-visible .context-menu-item-label')]
    .map(node => node.textContent.trim()));
  if (choice === null) {
    await page.keyboard.press('Escape');
    await pause(SETTLE_MS);
    return labels;
  }
  assert(labels.includes(choice), `the image menu offers ${choice}; it showed ${labels.join(' | ')}`);
  const item = await page.evaluateHandle(choice => [...document.querySelectorAll('#context-menu.is-visible .context-menu-item')]
    .find(node => node.querySelector('.context-menu-item-label').textContent.trim() === choice), choice);
  await item.asElement().click();
  await idle(page);
  await pause(SETTLE_MS);
  return labels;
}

function assertStill(label, before, after) {
  assert.equal(after.editing, true, `${label}: still in edit mode`);
  assert(Math.abs(after.imageTop - before.imageTop) <= EXACT_PX,
    `${label}: the image stays put (top ${before.imageTop} → ${after.imageTop})`);
  assert.equal(after.caret, before.caret, `${label}: the caret keeps its place`);
}

// 1: an image that has a size tag: only the tag's number changes.
async function sizedCase(page) {
  const ids = await createNotes(page, [['sized', `<p>Sized photo {${IMAGE}} caption</p>`, '{@size=0.25}']]);
  await reloadApp(page);
  await startEditingAtEndOf(page, ids.sized, 'Sized photo');
  const before = await editState(page, ids.sized);
  assert.equal(before.editing, true, 'sized: editing');
  for (const [choice, tags] of [['Make Bigger', '{@size=0.5}'], ['Make Smaller', '{@size=0.25}']]) {
    await imageMenu(page, ids.sized, choice);
    const after = await editState(page, ids.sized);
    assert.equal(after.tags, tags, `sized, ${choice}: the tag bar says ${tags}`);
    assert.equal(after.html, before.html, `sized, ${choice}: the text is unchanged`);
    assertStill(`sized, ${choice}`, before, after);
  }
  await deleteNotes(page, [ids.sized]);
}

// 2 and 3: an image without a size tag gets one, with braces; Reset Size removes both.
async function unsizedCase(page) {
  const ids = await createNotes(page, [['plain', `<p>Plain photo ${IMAGE} caption</p>`, '']]);
  await reloadApp(page);
  await startEditingAtEndOf(page, ids.plain, 'Plain photo');
  const before = await editState(page, ids.plain);
  await imageMenu(page, ids.plain, 'Make Bigger');
  const bigger = await editState(page, ids.plain);
  assert.equal(bigger.tags, '{@size=1.25}', 'unsized, Make Bigger: the tag bar gets a size tag');
  assert(bigger.text.startsWith('Plain photo {') && bigger.text.endsWith('} caption'), `unsized: braces around the image: ${bigger.text}`);
  assertStill('unsized, Make Bigger', before, bigger);
  await imageMenu(page, ids.plain, 'Reset Size');
  const reset = await editState(page, ids.plain);
  assert.equal(reset.tags, '', 'Reset Size: the size tag goes');
  assert.equal(reset.text, before.text, 'Reset Size: the braces go');
  assertStill('Reset Size', before, reset);
  await deleteNotes(page, [ids.plain]);
}

// 4 and 5: typing first is kept; ⌘Z undoes the size, then the typing.
async function typingUndoCase(page) {
  const ids = await createNotes(page, [['typed', `<p>Typed photo {${IMAGE}} caption</p>`, '{@size=0.5}']]);
  await reloadApp(page);
  await startEditingAtEndOf(page, ids.typed, 'Typed photo');
  await page.keyboard.type(' now');
  await pause(SETTLE_MS);
  const typed = await editState(page, ids.typed);
  assert(typed.text.startsWith('Typed photo now {'), `typing: ${typed.text}`);
  await imageMenu(page, ids.typed, 'Make Smaller');
  const smaller = await editState(page, ids.typed);
  assert.equal(smaller.tags, '{@size=0.25}', 'typing then Make Smaller: the size changes');
  assert.equal(smaller.text, typed.text, 'typing then Make Smaller: what was typed is kept');
  assertStill('typing then Make Smaller', typed, smaller);
  await page.keyboard.down('Meta');
  await page.keyboard.press('z');
  await page.keyboard.up('Meta');
  await idle(page);
  await pause(SETTLE_MS);
  const undoneSize = await editState(page, ids.typed);
  assert.equal(undoneSize.tags, '{@size=0.5}', '⌘Z: the size first');
  assert.equal(undoneSize.text, typed.text, '⌘Z: the typing stays');
  await page.keyboard.down('Meta');
  await page.keyboard.press('z');
  await page.keyboard.up('Meta');
  await idle(page);
  await pause(SETTLE_MS);
  const undoneTyping = await editState(page, ids.typed);
  assert(undoneTyping.text.startsWith('Typed photo {'), `⌘Z again: the typing goes: ${undoneTyping.text}`);
  await deleteNotes(page, [ids.typed]);
}

// 7: an image in another note: that note's size changes; the edit goes on.
async function otherNoteCase(page) {
  const ids = await createNotes(page, [
    ['edited', '<p>The note being edited</p>', ''],
    ['pictured', `<p>Another photo {${IMAGE}}</p>`, '{@size=0.5}'],
  ]);
  await reloadApp(page);
  await startEditingAtEndOf(page, ids.edited, 'being edited');
  const before = await editState(page, ids.edited);
  await imageMenu(page, ids.pictured, 'Make Bigger');
  const after = await editState(page, ids.edited);
  assert.equal(after.editing, true, 'other note: the edit goes on');
  assert.equal(after.caret, before.caret, 'other note: the caret keeps its place');
  assert.equal((await editState(page, ids.pictured)).tags, '{@size=0.75}', 'other note: its size changes');
  await deleteNotes(page, [ids.edited, ids.pictured]);
}

// 6 and 8: an uploaded image or a diagram shows as its ![[…]] token while
// editing, so it has no image menu there.
async function tokenCase(page) {
  const ids = await page.evaluate(async png => {
    const {NotesAPI, FilesAPI} = await import('/static/js/modules/api-client.js');
    const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
    const uploaded = await FilesAPI.uploadFile(new File([bytes], 'dot.png', {type: 'image/png'}));
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, `<p>Uploaded ![[${uploaded.id}]] here</p>`, '');
    return {uploaded: note.id};
  }, PNG_BASE64);
  await reloadApp(page);
  await startEditingAtEndOf(page, ids.uploaded, 'Uploaded');
  const state = await editState(page, ids.uploaded);
  assert.equal(state.editing, true, 'uploaded: editing');
  assert(state.html.includes('![['), `uploaded: the editor shows the token: ${state.html}`);
  await deleteNotes(page, [ids.uploaded]);
}

// MetaList shows a failure in its red overlay; a case that raised one has failed.
async function assertNoFatalOverlay(page, label) {
  const overlay = await page.evaluate(() => {
    const element = document.getElementById('fatal-error-overlay');
    if (element === null) return null;
    return element.textContent;
  });
  assert.equal(overlay, null, `${label}: MetaList showed a fatal error`);
}

export async function checkImageMenu(page) {
  await reloadApp(page);
  const failures = [];
  for (const imageCase of [sizedCase, unsizedCase, typingUndoCase, otherNoteCase, tokenCase]) {
    try {
      await imageCase(page);
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      failures.push(`${imageCase.name}: ${error.message}`);
      await page.keyboard.press('Escape');
      await reloadApp(page);
    }
    await assertNoFatalOverlay(page, imageCase.name);
  }
  assert.deepEqual(failures, [], `image menu failures:\n${failures.join('\n')}`);
}
