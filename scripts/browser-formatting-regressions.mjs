import assert from 'node:assert/strict';

async function removeSelectedFormattingFromMenu(page) {
  const point = await page.evaluate(() => {
    const rect = [...window.getSelection().getRangeAt(0).getClientRects()].find(rect => rect.width > 0);
    if (!rect) throw new Error('Selected text must be visible');
    return {x: rect.left + Math.min(3, rect.width / 2), y: rect.top + rect.height / 2};
  });
  await page.mouse.click(point.x, point.y, {button:'right'});
  await page.waitForSelector('.context-menu-item');
  const menuIndex = await page.evaluate(() => {
    const button = [...document.querySelectorAll('.context-menu-item')].find(node => node.textContent.trim() === 'Remove Formatting');
    if (!button) throw new Error('Remove Formatting context-menu action missing');
    return button.dataset.index;
  });
  await page.click(`.context-menu-item[data-index="${menuIndex}"]`);
  await page.waitForNetworkIdle({idleTime:100});
}

async function readTitleTypography(page, noteId) {
  return page.evaluate(noteId => {
    const editor = document.querySelector(`[data-note-id="${noteId}"] > .note-content`);
    const heading = editor.querySelector('h1');
    const at = offset => {
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && offset >= node.length) { offset -= node.length; node = walker.nextNode(); }
      if (!node) throw new Error('Title character missing');
      const style = getComputedStyle(node.parentElement);
      return {size: style.fontSize, weight: style.fontWeight, italic: style.fontStyle};
    };
    const baseline = getComputedStyle(editor);
    return {
      baseline: {size: baseline.fontSize, weight: baseline.fontWeight, italic: baseline.fontStyle},
      before: at(heading.textContent.indexOf('A')),
      selected: at(heading.textContent.indexOf('formatted')),
      after: at(heading.textContent.indexOf('title')),
      text: heading.textContent,
    };
  }, noteId);
}

export async function checkPastedHeadingFormatting(page) {
  const noteId = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const created = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(created.id, '<p>Formatting fixture</p>', '');
    return created.id;
  });
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await page.click(`[data-note-id="${noteId}"] > .note-content`);
  await page.waitForFunction(async () => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return ModeContextInstance.isEditing && !ModeContextInstance.isLoading;
  });
  const html = '<p><strong>Journal metadata</strong></p><h1 style="font-size:36px;font-weight:700">  A <em>formatted</em> <a href="https://example.com/paper">paper title</a>  </h1><h2>Abstract</h2><p><strong>Background:</strong> Unselected text.</p>';
  // Exercise the actual paste handler twice, replacing the editor selection.
  for (let count = 0; count < 2; count += 1) {
    await page.evaluate((noteId, html) => {
      const editor = document.querySelector(`[data-note-id="${noteId}"] > .note-content`);
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/html', html);
      clipboardData.setData('text/plain', 'A formatted paper title');
      editor.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData}));
    }, noteId, html);
    await page.waitForFunction(noteId => document.querySelector(`[data-note-id="${noteId}"] h1`) !== null, {}, noteId);
    await page.waitForNetworkIdle({idleTime:100});
  }
  const before = await page.$eval(`[data-note-id="${noteId}"] > .note-content`, editor => ({
    text: editor.textContent,
    journal: editor.querySelector('p').outerHTML,
    abstract: editor.querySelector('h2').outerHTML,
    body: editor.querySelector('p:last-child').outerHTML,
  }));
  const originalTypography = await readTitleTypography(page, noteId);
  await page.evaluate(noteId => {
    const heading = document.querySelector(`[data-note-id="${noteId}"] h1`);
    const range = document.createRange();
    range.setStart(heading.querySelector('em').firstChild, 0);
    range.setEnd(heading.querySelector('a').firstChild, 'paper'.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, noteId);
  await removeSelectedFormattingFromMenu(page);
  const partial = await readTitleTypography(page, noteId);
  assert.deepEqual(partial.selected, partial.baseline, 'Selected title words must use plain note typography');
  assert.deepEqual(partial.before, originalTypography.before);
  assert.deepEqual(partial.after, originalTypography.after);
  assert.equal(partial.text, originalTypography.text);
  assert.equal(await page.$eval(`[data-note-id="${noteId}"] h1`, heading => heading.querySelectorAll('div,p,br').length), 0, 'Partial removal must not split the title into new lines');
  const partialHtml = await page.$eval(`[data-note-id="${noteId}"] h1`, heading => heading.innerHTML);
  await removeSelectedFormattingFromMenu(page);
  assert.equal(await page.$eval(`[data-note-id="${noteId}"] h1`, heading => heading.innerHTML), partialHtml, 'Repeated removal must not add redundant wrappers');
  const resized = await page.evaluate(noteId => {
    const previous = document.body.getAttribute('data-top-level-note-size');
    document.body.setAttribute('data-top-level-note-size', 'same');
    const editor = document.querySelector(`[data-note-id="${noteId}"] > .note-content`);
    const sizes = {
      plain: getComputedStyle(editor.querySelector('.note-unformatted-text')).fontSize,
      baseline: getComputedStyle(editor).fontSize,
    };
    if (previous === null) document.body.removeAttribute('data-top-level-note-size');
    else document.body.setAttribute('data-top-level-note-size', previous);
    return sizes;
  }, noteId);
  assert.equal(resized.plain, resized.baseline, 'Plain title fragments must follow note-size preferences');
  await page.keyboard.press('Escape');
  await page.waitForNetworkIdle({idleTime:100});
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  const persisted = await readTitleTypography(page, noteId);
  assert.deepEqual(persisted.selected, persisted.baseline);
  assert.deepEqual(persisted.before, originalTypography.before);
  assert.deepEqual(persisted.after, originalTypography.after);
  await page.click(`[data-note-id="${noteId}"] > .note-content`);
  await page.waitForFunction(async () => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return ModeContextInstance.isEditing && !ModeContextInstance.isLoading;
  });
  await page.evaluate(noteId => {
    const heading = document.querySelector(`[data-note-id="${noteId}"] h1`);
    const range = document.createRange();
    range.setStart(heading.firstChild, 2);
    range.setEndBefore(heading.lastChild);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, noteId);
  await removeSelectedFormattingFromMenu(page);
  const after = await page.$eval(`[data-note-id="${noteId}"] > .note-content`, editor => ({
    text: editor.textContent,
    heading: editor.querySelector('h1')?.outerHTML ?? null,
    emphasis: editor.querySelector('em')?.outerHTML ?? null,
    journal: editor.querySelector('p').outerHTML,
    abstract: editor.querySelector('h2').outerHTML,
    body: editor.querySelector('p:last-child').outerHTML,
    link: editor.querySelector('a')?.getAttribute('href'),
  }));
  assert.equal(after.heading, null, 'Selected title must lose heading-level formatting');
  assert.equal(after.emphasis, null);
  assert.equal(after.text, before.text);
  assert.equal(after.journal, before.journal);
  assert.equal(after.abstract, before.abstract);
  assert.equal(after.body, before.body);
  assert.equal(after.link, 'https://example.com/paper');
  await page.keyboard.press('Escape');
  await page.waitForNetworkIdle({idleTime:100});
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  assert.equal(await page.$(`[data-note-id="${noteId}"] h1`), null, 'Heading removal must survive reload');
  assert.equal(await page.$eval(`[data-note-id="${noteId}"] h2`, heading => heading.textContent), 'Abstract');
  console.log('PASS repeated paste, partial/full heading formatting removal, and persistence after reload');

  await page.evaluate(async noteId => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.saveNote(noteId, '<br><p>&nbsp;</p><h1>Spacing title</h1><br><br><br><p><a href="https://example.com/author">Author</a></p><br><br><p>Abstract</p><br><br>', '');
  }, noteId);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await page.click(`[data-note-id="${noteId}"] > .note-content`);
  await page.waitForFunction(async () => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return ModeContextInstance.isEditing && !ModeContextInstance.isLoading;
  });
  await page.evaluate(noteId => {
    const editor = document.querySelector(`[data-note-id="${noteId}"] > .note-content`);
    editor.focus();
    window.getSelection().collapse(editor, 0);
  }, noteId);
  await page.keyboard.down('Meta');
  await page.keyboard.press('u');
  await page.keyboard.up('Meta');
  await page.waitForFunction(async noteId => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !ModeContextInstance.isLoading && !document.querySelector(`[data-note-id="${noteId}"] h1`);
  }, {}, noteId);
  const cleanLines = await page.$eval(`[data-note-id="${noteId}"] > .note-content`, editor => {
    const copy = editor.cloneNode(true);
    for (const link of copy.querySelectorAll('a')) link.replaceWith(document.createTextNode(link.textContent));
    return copy.innerHTML;
  });
  assert.equal(cleanLines, 'Spacing title<br><br>Author<br><br>Abstract');
  assert.equal(await page.$eval(`[data-note-id="${noteId}"] a`, link => link.getAttribute('href')), 'https://example.com/author');
  await page.keyboard.press('Escape');
  await page.waitForNetworkIdle({idleTime:100});
  console.log('PASS Cmd+U trims edge blank lines and caps internal spacing at one blank line');
}
