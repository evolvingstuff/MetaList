import assert from 'node:assert/strict';

export async function checkTagDoubleClickSelection(page) {
  const noteId = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, 'Double click selection test', 'foo-bar @red alpha_beta a/b.c');
    return note.id;
  });
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await page.click(`[data-note-id="${noteId}"] > .note-content`);
  await page.waitForSelector('.note.editing .note-tag-bar-input');
  await page.waitForFunction(async () => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !ModeContextInstance.isLoading;
  });
  await page.click('.note.editing .note-tag-bar-input');
  await page.waitForFunction(() => document.activeElement.classList.contains('note-tag-bar-input'));
  await checkInput(page, '.note.editing .note-tag-bar-input');
  await page.keyboard.press('Escape');
  await page.click('#search-input');
  await page.keyboard.type('foo-bar @red alpha_beta a/b.c');
  await checkInput(page, '#search-input');
  await page.$eval('#search-input', input => { input.focus(); input.select(); });
  await page.keyboard.press('Backspace');
  await page.waitForFunction(async () => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return document.getElementById('search-input').value === ''
      && ModeContextInstance.getExecutedSearchQuery() === '' && !ModeContextInstance.isLoading;
  });
  await page.keyboard.press('Escape');
  console.log('PASS native double-click selects complete tags in search and tag bar');
}

async function checkInput(page, selector) {
  for (const [tag, characterOffset] of [['foo-bar', 1], ['foo-bar', 5], ['@red', 0], ['@red', 2], ['alpha_beta', 7], ['a/b.c', 3]]) {
    const point = await page.$eval(selector, (input, tag, characterOffset) => {
      input.focus();
      input.scrollLeft = 0;
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.font = style.font;
      const index = input.value.indexOf(tag) + characterOffset;
      const width = context.measureText(input.value.slice(0, index)).width;
      const characterWidth = context.measureText(input.value[index]).width;
      const bounds = input.getBoundingClientRect();
      return {x:bounds.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) + width + characterWidth / 2,
        y:bounds.top + bounds.height / 2, value:input.value};
    }, tag, characterOffset);
    await page.mouse.click(point.x, point.y, {count:2});
    assert.deepEqual(await page.$eval(selector, input => ({
      selection:input.value.slice(input.selectionStart, input.selectionEnd), value:input.value,
    })), {selection:tag, value:point.value});
  }
}
