import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// A search's quoted phrases are marked where they occur in the notes list
// (docs/ui/search-semantics.md; interaction principle 5: the user cannot know where the
// phrase occurs in each note). The cases agreed with the user (2026-10-19):
//   1. "zebra" marks every occurrence, in any case, also inside words
//   2. "zebra " marks only where the word ends
//   3. phrases on both sides of OR are all marked
//   4. a tag-only search marks nothing
//   5. a phrase running through formatting is one mark
//   6. a phrase across a line break is one mark, over both lines
//   7. a matching note's children shown with it, and embedded notes, are marked too
//   8. a collapsed note is marked in what it shows
//   9. the note being edited is not marked; leaving edit mode marks it again
//  10. marks follow the search, and go when it is cleared
//  11. nothing moves: marks change no position and no scroll
//  12. full screen and floating windows are not marked
//  13. (colour: CSS)          14. tag-bar comments are marked

const FIXTURE_TAG = 'searchmarkfixture';
const HIGHLIGHT_NAME = 'metalist-search';
const REQUESTS_QUIET_MS = 300;
const PAINT_FRAMES = 2;
const IS_COLLAPSED = true;
const IS_EXPANDED = false;

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
  // Marks are painted on the frame after the list changes.
  await page.evaluate(frames => new Promise(resolve => {
    let left = frames;
    const next = () => {
      left -= 1;
      if (left === 0) resolve();
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }), PAINT_FRAMES);
}

// The search runs as it is typed; Enter on a search already run would add a note.
async function search(page, text) {
  await page.focus('#search-input');
  await page.evaluate(() => document.getElementById('search-input').select());
  await page.keyboard.press('Backspace');
  if (text !== '') await page.keyboard.type(text);
  await page.waitForFunction(async expected => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return ModeContextInstance.getExecutedSearchQuery() === expected;
  }, {}, text);
  await page.evaluate(() => document.getElementById('search-input').blur());
  await idle(page);
}

// Every mark: its note, its text, and whether it lies in the list or in a tag-bar comment.
function marks(page) {
  return page.evaluate(name => {
    if (!CSS.highlights.has(name)) return [];
    const container = document.getElementById('notes-container');
    return [...CSS.highlights.get(name)].map(range => {
      const element = range.startContainer.parentElement;
      return {
        note: element.closest('.note').dataset.noteId,
        text: range.toString(),
        inList: container.contains(range.startContainer) && container.contains(range.endContainer),
        inComment: element.closest('.note-tag--comment') !== null,
      };
    }).sort((a, b) => `${a.note}${a.text}`.localeCompare(`${b.note}${b.text}`));
  }, HIGHLIGHT_NAME);
}

const mark = (note, text) => ({note, text, inList: true, inComment: false});
const sorted = list => [...list].sort((a, b) => `${a.note}${a.text}`.localeCompare(`${b.note}${b.text}`));

async function seed(page) {
  const ids = await page.evaluate(async (tag, isCollapsed, isExpanded) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const make = async (parentId, content, tags) => {
      let note;
      if (parentId === null) note = await NotesAPI.createNote(null, '');
      else note = await NotesAPI.createChild(parentId, '');
      await NotesAPI.saveNote(note.id, content, tags);
      return note.id;
    };
    const ids = {};
    ids.cases = await make(null, '<div>Zebra stripes on zebras</div>', tag);
    ids.edges = await make(null, '<div>zebra zebrafish</div>', tag);
    ids.formatted = await make(null, '<div>a <b>zeb</b>ra crossing</div>', tag);
    ids.lines = await make(null, '<div>giant</div><div>zebra herd</div>', tag);
    ids.parent = await make(null, '<div>okapi parent</div>', tag);
    ids.child = await make(ids.parent, '<div>okapi child</div>', '');
    ids.source = await make(null, '<div>okapi embedded</div>', '');
    ids.host = await make(null, `<div>okapi host</div><div>![[${ids.source}]]</div>`, tag);
    ids.collapsed = await make(null, '<div>zebra first line</div><div>zebra second line</div>', tag);
    ids.comment = await make(null, '<div>plain text</div>', `${tag} /* zebra comment */`);
    await NotesAPI.setCollapsedBulk([ids.cases, ids.edges, ids.formatted, ids.lines, ids.parent, ids.host, ids.comment], isExpanded);
    await NotesAPI.setCollapsedBulk([ids.collapsed], isCollapsed);
    return ids;
  }, FIXTURE_TAG, IS_COLLAPSED, IS_EXPANDED);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  return ids;
}

async function checkPhraseCases(page, ids) {
  await search(page, `${FIXTURE_TAG} "zebra"`);
  assert.deepEqual(await marks(page), sorted([
    mark(ids.cases, 'Zebra'), mark(ids.cases, 'zebra'),
    mark(ids.edges, 'zebra'), mark(ids.edges, 'zebra'),
    mark(ids.formatted, 'zebra'),
    mark(ids.lines, 'zebra'),
    mark(ids.collapsed, 'zebra'),
    {note: ids.comment, text: 'zebra', inList: true, inComment: true},
  ]), '1, 8, 14: every occurrence in any case and inside words; the collapsed note in its first line; the comment');

  await search(page, `${FIXTURE_TAG} "zebra "`);
  assert.deepEqual(await marks(page), sorted([
    mark(ids.cases, 'Zebra'), mark(ids.edges, 'zebra'), mark(ids.formatted, 'zebra'), mark(ids.lines, 'zebra'),
    mark(ids.collapsed, 'zebra'), {note: ids.comment, text: 'zebra', inList: true, inComment: true},
  ]), '2: only where the word ends');

  await search(page, `${FIXTURE_TAG} "zebra crossing"`);
  assert.deepEqual(await marks(page), [mark(ids.formatted, 'zebra crossing')], '5: one mark through the bold part');

  await search(page, `${FIXTURE_TAG} "giant zebra"`);
  const across = await page.evaluate(name => {
    const [range] = [...CSS.highlights.get(name)];
    return {count: CSS.highlights.get(name).size, start: [range.startContainer.data, range.startOffset], end: [range.endContainer.data, range.endOffset]};
  }, HIGHLIGHT_NAME);
  assert.deepEqual(across, {count: 1, start: ['giant', 0], end: ['zebra herd', 5]}, '6: one mark from "giant" to "zebra" on the next line');

  await search(page, `${FIXTURE_TAG} "okapi"`);
  assert.deepEqual(await marks(page), sorted([
    mark(ids.parent, 'okapi'), mark(ids.child, 'okapi'),
    mark(ids.host, 'okapi'), mark(ids.host, 'okapi'),
  ]), '7: the child shown with its parent, and the embedded note inside the host');

  await search(page, `${FIXTURE_TAG} "giant" OR ${FIXTURE_TAG} "crossing"`);
  assert.deepEqual(await marks(page), sorted([mark(ids.lines, 'giant'), mark(ids.formatted, 'crossing')]), '3: both sides of OR');

  await search(page, FIXTURE_TAG);
  assert.deepEqual(await marks(page), [], '4: a tag-only search marks nothing');
}

async function checkEditing(page, ids) {
  await search(page, `${FIXTURE_TAG} "zebra"`);
  await page.click(`[data-note-id="${ids.cases}"] > .note-content`);
  await page.waitForSelector(`.note.editing[data-note-id="${ids.cases}"] .note-tag-bar-input`);
  await idle(page);
  const whileEditing = await marks(page);
  assert.deepEqual(whileEditing.filter(entry => entry.note === ids.cases), [], '9: the edited note is not marked');
  assert(whileEditing.some(entry => entry.note === ids.edges), '9: the other notes stay marked');
  await page.keyboard.press('Escape');
  await page.waitForSelector(`.note.editing[data-note-id="${ids.cases}"]`, {hidden: true});
  await idle(page);
  assert.deepEqual((await marks(page)).filter(entry => entry.note === ids.cases),
    sorted([mark(ids.cases, 'Zebra'), mark(ids.cases, 'zebra')]), '9: leaving edit mode marks it again');
}

function layout(page) {
  return page.evaluate(() => ({
    scrollY: window.scrollY,
    notes: [...document.querySelectorAll('#notes-container .note')].map(note => {
      const {x, y, width, height} = note.getBoundingClientRect();
      return [note.dataset.noteId, x, y, width, height];
    }),
  }));
}

async function setPhrases(page, phrases) {
  await page.evaluate(async phrases => {
    const {setSearchHighlightPhrases} = await import('/static/js/modules/mode-manager/services/search-highlight-service.js');
    setSearchHighlightPhrases(phrases);
  }, phrases);
  await idle(page);
}

async function checkNothingMoves(page) {
  await search(page, `${FIXTURE_TAG} "zebra"`);
  const marked = await layout(page);
  await setPhrases(page, []);
  assert.deepEqual(await marks(page), [], 'the marks are gone');
  assert.deepEqual(await layout(page), marked, '11: removing the marks moves nothing');
  await setPhrases(page, ['zebra']);
  assert.notDeepEqual(await marks(page), [], 'the marks are back');
  assert.deepEqual(await layout(page), marked, '11: adding the marks moves nothing');
}

async function checkFullscreenAndFloating(page, ids) {
  await search(page, `${FIXTURE_TAG} "zebra"`);
  const inList = await marks(page);
  await page.evaluate(async id => {
    const {openNoteFullscreen} = await import('/static/js/modules/mode-manager/services/note-fullscreen-service.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    await CommandGate.run('smoke.search-marks-fullscreen', () => openNoteFullscreen(id));
  }, ids.cases);
  await page.waitForSelector('.note-fullscreen-overlay');
  await idle(page);
  assert.deepEqual(await marks(page), inList, '12: full screen adds no marks');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.note-fullscreen-overlay', {hidden: true});
  const windowId = await page.evaluate(async id => {
    const {openFloatingNote} = await import('/static/js/modules/mode-manager/services/floating-note-service.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return CommandGate.run('smoke.search-marks-floating', () => openFloatingNote(id));
  }, ids.cases);
  await page.waitForFunction(id => {
    const host = document.querySelector(`[data-floating-note-id="${id}"]`);
    return host !== null && host.shadowRoot.textContent.includes('Zebra stripes');
  }, {}, windowId);
  await idle(page);
  assert.deepEqual(await marks(page), inList, '12: a floating window adds no marks');
  await page.evaluate(async () => {
    const {closeAllFloatingNotes} = await import('/static/js/modules/mode-manager/services/floating-note-service.js');
    closeAllFloatingNotes();
  });
}

export async function checkSearchHighlight(page) {
  const ids = await seed(page);
  await runThenCleanUp('search highlight', async () => {
    // Every case runs, and their assertion failures are reported together.
    const failures = [];
    for (const [label, run] of [['phrases', checkPhraseCases], ['editing', checkEditing],
      ['nothing moves', checkNothingMoves], ['full screen and floating', checkFullscreenAndFloating]]) {
      try {
        await run(page, ids);
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        failures.push(`${label}: ${error.message}`);
        await page.reload();
        await page.waitForSelector('[data-app-ready="true"]');
        await idle(page);
      }
    }
    await search(page, `${FIXTURE_TAG} "zebra"`);
    await search(page, '');
    assert.equal(await page.evaluate(name => CSS.highlights.has(name), HIGHLIGHT_NAME), false, '10: clearing the search removes the marks');
    if (failures.length > 0) throw new assert.AssertionError({message: failures.join('\n')});
  }, async () => {});
}
