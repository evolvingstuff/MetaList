import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppIdle } from './browser-app-idle.mjs';

// Resizing an image from its menu while its note is edited leaves the caret where the
// user put it (docs/ui/interaction-principles.md, principle 1). The resize replaces the
// note's HTML, so the caret is put back from a saved position; that position counts each
// image, so "right after the image" stays after it (and after the `}` a size adds)
// instead of landing before it (2026-10-21, ShockHarness DOM003). Each case types X
// after the resize: where the X lands is where the caret was.

const SETTLE_MS = 400;
// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
const MIDDLE = 0.5;
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQklEQVR4nO3OQQ0AIAwAsQlDBLKRhQuOR5MK6Jy9vjL5QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF21V9KbVaAsfAAAAAElFTkSuQmCC';
const IMAGE = `<img src="data:image/png;base64,${PNG_BASE64}" alt="dot">`;
const SIZED_TAGS = '{@size=1.25}';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppIdle(page);
  await page.waitForNetworkIdle({idleTime: NETWORK_IDLE_MS});
  await pause(SETTLE_MS);
}

async function createNote(page, html, tags) {
  return page.evaluate(async ({html, tags}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, html, tags);
    return note.id;
  }, {html, tags});
}

async function reloadApp(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}

// Enters edit mode with a click on the note's first text, then places the selection:
// `from` and `to` are [index of the image, 'before' | 'after'] (equal for a caret).
async function editWithSelection(page, noteId, from, to) {
  const point = await page.evaluate(noteId => {
    const content = document.querySelector(`.note[data-note-id="${noteId}"] > .note-content`);
    content.scrollIntoView({block: 'center'});
    const rect = content.getBoundingClientRect();
    return {x: rect.right - 4, y: rect.top + rect.height / 2};
  }, noteId);
  await page.mouse.click(point.x, point.y);
  await idle(page);
  await page.evaluate(({noteId, from, to}) => {
    const content = document.querySelector(`.note[data-note-id="${noteId}"] > .note-content`);
    const images = content.querySelectorAll('img');
    const at = ([index, side]) => {
      const range = document.createRange();
      if (side === 'before') range.setStartBefore(images[index]);
      else range.setStartAfter(images[index]);
      return [range.startContainer, range.startOffset];
    };
    const [anchorNode, anchorOffset] = at(from);
    const [focusNode, focusOffset] = at(to);
    window.getSelection().setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  }, {noteId, from, to});
  await pause(SETTLE_MS);
}

async function resizeFromMenu(page, noteId, imageIndex, choice) {
  const box = await page.evaluate(({noteId, imageIndex}) => {
    const image = document.querySelectorAll(`.note[data-note-id="${noteId}"] > .note-content img`)[imageIndex];
    const rect = image.getBoundingClientRect();
    return {x: rect.left, y: rect.top, width: rect.width, height: rect.height};
  }, {noteId, imageIndex});
  await page.mouse.click(box.x + box.width * MIDDLE, box.y + box.height * MIDDLE, {button: 'right'});
  await page.waitForSelector('#context-menu.is-visible');
  const item = await page.evaluateHandle(choice => [...document.querySelectorAll('#context-menu.is-visible .context-menu-item')]
    .find(node => node.querySelector('.context-menu-item-label').textContent.trim() === choice), choice);
  assert.ok(item.asElement() !== null, `the image menu offers ${choice}`);
  await item.asElement().click();
  await idle(page);
}

// The edited note's content as text, each image written [img].
function contentWithImages(page, noteId) {
  return page.evaluate(noteId => {
    const content = document.querySelector(`.note[data-note-id="${noteId}"] > .note-content`);
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let text = '';
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) text += node.data;
      else if (node.tagName === 'IMG') text += '[img]';
    }
    return text;
  }, noteId);
}

async function typeAfterResize(page, label, {html, tags, from, to, image, choice, expected}) {
  const noteId = await createNote(page, html, tags);
  try {
    await reloadApp(page);
    await editWithSelection(page, noteId, from, to);
    await resizeFromMenu(page, noteId, image, choice);
    await page.keyboard.type('X');
    await pause(SETTLE_MS);
    const actual = await contentWithImages(page, noteId);
    assert.equal(actual, expected, `${label}: X lands where the caret was: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
  } finally {
    await page.keyboard.press('Escape');
    await idle(page);
    await page.evaluate(async noteId => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      await NotesAPI.deleteNote(noteId);
    }, noteId);
  }
}

const AFTER_IMAGE = ['after the image', {html: `<p>Hello ${IMAGE}</p>`, tags: '', from: [0, 'after'], to: [0, 'after'], image: 0}];

const CASES = [
  // 1: right after an image, each resize.
  ['after the image, Make Bigger', {...AFTER_IMAGE[1], choice: 'Make Bigger', expected: 'Hello {[img]}X'}],
  ['after the image, Make Smaller', {...AFTER_IMAGE[1], choice: 'Make Smaller', expected: 'Hello {[img]}X'}],
  ['after a sized image, Reset Size', {
    html: `<p>Hello {${IMAGE}}</p>`, tags: SIZED_TAGS, from: [0, 'after'], to: [0, 'after'], image: 0,
    choice: 'Reset Size', expected: 'Hello [img]X',
  }],
  // 2: right before an image.
  ['before the image, Make Bigger', {
    html: `<p>Hello ${IMAGE}</p>`, tags: '', from: [0, 'before'], to: [0, 'before'], image: 0,
    choice: 'Make Bigger', expected: 'Hello X{[img]}',
  }],
  // 3: between two images, resizing either.
  ['between two images, resizing the first', {
    html: `<p>a ${IMAGE}${IMAGE}</p>`, tags: '', from: [0, 'after'], to: [0, 'after'], image: 0,
    choice: 'Make Bigger', expected: 'a {[img]}X[img]',
  }],
  ['between two images, resizing the second', {
    html: `<p>a ${IMAGE}${IMAGE}</p>`, tags: '', from: [0, 'after'], to: [0, 'after'], image: 1,
    choice: 'Make Bigger', expected: 'a [img]X{[img]}',
  }],
  // 4: an image at the very start, caret after it.
  ['after an image at the start', {
    html: `<p>${IMAGE} tail</p>`, tags: '', from: [0, 'after'], to: [0, 'after'], image: 0,
    choice: 'Make Bigger', expected: '{[img]}X tail',
  }],
  // 5: a selection covering the image: typing replaces the image and its new scope.
  ['a selection covering the image', {
    html: `<p>Hello ${IMAGE}!</p>`, tags: '', from: [0, 'before'], to: [0, 'after'], image: 0,
    choice: 'Make Bigger', expected: 'Hello X!',
  }],
];

export async function checkImageResizeCaret(page) {
  await runThenCleanUp('image resize caret', async () => {
    // Every case runs, and their assertion failures are reported together.
    const failures = [];
    for (const [label, spec] of CASES) {
      try {
        await typeAfterResize(page, label, spec);
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        failures.push(error.message);
      }
    }
    if (failures.length > 0) throw new assert.AssertionError({message: failures.join('\n')});
  }, async () => {});
}
