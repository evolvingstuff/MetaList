import assert from 'node:assert/strict';
import { waitForAppIdle } from './browser-app-idle.mjs';

// A dropped .txt, .md, .csv or .json file keeps its pill (labelled by extension) and
// gets its text as the last child of the note holding the pill, rendered by
// @markdown, @csv or @json (docs/ui/references.md, "Dropped text files").

async function idle(page) {
  await waitForAppIdle(page);
  await page.waitForNetworkIdle({idleTime: 300});
}

// A synthetic file drop, as Finder or Explorer sends one, at a point in `selector`.
function drop(page, selector, files, where) {
  return page.evaluate(({selector, files, where}) => {
    const target = document.querySelector(selector);
    const rect = target.getBoundingClientRect();
    const data = new DataTransfer();
    for (const file of files) data.items.add(new File([file.text], file.name, {type: file.type}));
    const x = where === 'end' ? rect.right - 5 : rect.left + rect.width / 2;
    const y = where === 'end' ? rect.bottom - 5 : rect.top + rect.height / 2;
    target.dispatchEvent(new DragEvent('drop', {dataTransfer: data, bubbles: true, cancelable: true, clientX: x, clientY: y}));
  }, {selector, files, where});
}

// Each root note holding a pill: its pills, and its child notes in order.
function filesView(page) {
  return page.evaluate(() => {
    const own = (note, selector) => [...note.querySelectorAll(selector)].filter(
      element => element.closest('.note') === note);
    return [...document.querySelectorAll('.note')]
      .filter(note => note.parentElement.closest('.note') === null)
      .map(note => ({
        id: note.dataset.noteId,
        top: Math.round(note.getBoundingClientRect().top),
        editing: own(note, '.note-content[contenteditable="true"]').length === 1,
        pills: own(note, '.note-file-reference-header').map(header => [
          header.querySelector('.note-file-reference-badge').textContent,
          header.querySelector('.note-file-reference-title').textContent]),
        tooltips: own(note, '.note-file-reference-link').map(link => link.title),
        children: [...document.querySelectorAll('.note')]
          .filter(child => child.parentElement.closest('.note') === note)
          .map(child => ({
            visible: child.getBoundingClientRect().height > 0,
            markdownHeading: own(child, '.meta-markdown h1').map(heading => heading.textContent).join(''),
            csvCells: own(child, '.meta-csv td').map(cell => cell.textContent.trim()),
            json: own(child, '.meta-json:not(.meta-json-error) .meta-json-pre').map(pre => pre.textContent).join(''),
            text: own(child, '.note-content')[0].innerText.trim(),
          })),
      }));
  });
}

// While a note is edited its pills show as raw ![[…]] tokens: find it by id.
function byId(view, noteId) {
  const found = view.find(note => note.id === noteId);
  assert.ok(found, `note ${noteId}`);
  return found;
}

function byFirstPill(view, title) {
  const found = view.find(note => note.pills.length > 0 && note.pills[0][1] === title);
  assert.ok(found, `a note holding ${title}`);
  return found;
}

// A drop is finished when its uploads and preview children are in (while
// editing, a pill shows as its raw ![[…]] token, so wait for the requests).
async function settle(page) {
  await page.waitForNetworkIdle({idleTime: 800, timeout: 15000});
  await idle(page);
}

async function waitForNote(page, title) {
  await page.waitForFunction(title => [...document.querySelectorAll('.note-file-reference-title')]
    .some(element => element.textContent === title), {timeout: 10000}, title);
  await idle(page);
}

async function leaveEditing(page) {
  await page.keyboard.press('Escape');
  await idle(page);
}

export async function checkFileDropPreviews(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  const createdIds = [];
  try {
    // A Markdown file dropped on the list: a new note with an MD pill and its
    // rendered text as an expanded child.
    await drop(page, '#notes-container', [{name: 'readme.md', type: 'text/markdown', text: '# Hello\n\n- one\n- two'}],
      'center');
    await settle(page);
    await leaveEditing(page);
    await waitForNote(page, 'readme.md');
    let markdown = byFirstPill(await filesView(page), 'readme.md');
    createdIds.push(markdown.id);
    assert.deepEqual(markdown.pills, [['.MD', 'readme.md']], 'markdown: the pill says .MD');
    assert.deepEqual(markdown.tooltips, ['Click to download readme.md'], 'markdown: hovering the pill says it downloads');
    assert.equal(markdown.children.length, 1, 'markdown: one preview child');
    assert.equal(markdown.children[0].visible, true, 'markdown: the preview starts expanded');
    assert.equal(markdown.children[0].markdownHeading, 'Hello', 'markdown: the preview renders as Markdown');

    // CSV, text and JSON dropped together: one note, pills in drop order, a child each in drop order.
    await drop(page, '#notes-container', [
      {name: 'data.csv', type: 'text/csv', text: 'name,count\napples,3'},
      {name: 'notes.txt', type: 'text/plain', text: 'First line\n<b>not bold</b>'},
      {name: 'config.json', type: 'application/json', text: '{"name": "apples", "count": 3}'},
    ], 'center');
    await settle(page);
    await leaveEditing(page);
    await waitForNote(page, 'notes.txt');
    const both = byFirstPill(await filesView(page), 'data.csv');
    createdIds.push(both.id);
    assert.deepEqual(both.pills, [['.CSV', 'data.csv'], ['.TXT', 'notes.txt'], ['.JSON', 'config.json']],
      'csv, txt and json: pills by extension');
    assert.equal(both.children.length, 3, 'csv, txt and json: a preview child each');
    assert.deepEqual(both.children[0].csvCells, ['name', 'count', 'apples', '3'], 'csv: the preview is a table');
    assert.equal(both.children[1].text, 'First line\n<b>not bold</b>', 'txt: the preview is the plain text');
    assert.equal(both.children[2].json, '{\n  "name": "apples",\n  "count": 3\n}', 'json: the preview is pretty-printed JSON');

    // A file too large to preview keeps its pill alone and says why.
    await drop(page, '#notes-container', [{name: 'big.txt', type: 'text/plain', text: 'x'.repeat(300 * 1024)}],
      'center');
    await settle(page);
    await leaveEditing(page);
    await waitForNote(page, 'big.txt');
    await page.waitForFunction(() => document.body.innerText.includes('big.txt is too large to preview.'),
      {timeout: 10000});
    const big = byFirstPill(await filesView(page), 'big.txt');
    createdIds.push(big.id);
    assert.deepEqual([big.pills, big.children.length], [[['.TXT', 'big.txt']], 0], 'too large: pill only');

    // Dropped into the note being edited: the pill goes into it, the preview
    // becomes its last child, editing continues, and the note does not move.
    markdown = byFirstPill(await filesView(page), 'readme.md');
    const contentSelector = `.note[data-note-id="${markdown.id}"] .note-content`;
    const box = await page.evaluate(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return {x: rect.right - 20, y: rect.top + rect.height / 2};
    }, contentSelector);
    await page.mouse.click(box.x, box.y);
    await page.waitForFunction(selector => document.querySelector(selector).getAttribute('contenteditable') === 'true',
      {timeout: 5000}, contentSelector);
    // A drop while entering edit mode is still running is refused ("another command is still running").
    await settle(page);
    const topBefore = byId(await filesView(page), markdown.id).top;
    await drop(page, contentSelector, [{name: 'extra.csv', type: 'text/csv', text: 'x,y\n1,2'}], 'end');
    await settle(page);
    const edited = byId(await filesView(page), markdown.id);
    assert.equal(edited.editing, true, 'drop while editing: the note is still being edited');
    assert.equal(edited.top, topBefore, 'drop while editing: the note stays where it was');
    assert.equal(edited.children.length, 2, 'drop while editing: a second child');
    assert.equal(edited.children[0].markdownHeading, 'Hello', 'drop while editing: existing children come first');
    assert.deepEqual(edited.children[1].csvCells, ['x', 'y', '1', '2'], 'drop while editing: the preview is last');
    await leaveEditing(page);
    assert.deepEqual(byFirstPill(await filesView(page), 'readme.md').pills,
      [['.MD', 'readme.md'], ['.CSV', 'extra.csv']], 'drop while editing: the pill is in the note');
  } finally {
    await page.evaluate(async ids => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const id of ids) await NotesAPI.deleteNote(id);
    }, createdIds);
  }
}
