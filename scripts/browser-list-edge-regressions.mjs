import assert from 'node:assert/strict';

// The up and down arrows (docs/ui/interaction-principles.md, docs/ui/controls.md):
// each goes to its end of the list, the last note's bottom at the bottom of the
// window for the down arrow; with notes unloaded beyond the loaded band the view
// is rebuilt at that end; an arrow is dimmed at its end; a click while editing
// first leaves edit mode, saving the note. Go to Bottom in the background menu
// does what the down arrow does.

const SETTLE_MS = 1200;
// Positions are compared to the pixel; 1px covers sub-pixel rounding only.
const EXACT_PX = 1;
const TALL_TAG = 'edgetallfixture';
const SHORT_TAG = 'edgeshortfixture';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return !mode.isLoading && !CommandGate.isBusy();
  });
  await page.waitForNetworkIdle({idleTime: 300});
}

async function reload(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}

// Roots top to bottom: "Edge 1" … "Edge 160" (one line), "Tall 1" … "Tall 20"
// (three lines, tagged), "Short 1" … "Short 3" (tagged). More roots than the
// loaded band, so the end of the full list starts unloaded.
async function createFixture(page) {
  const specs = [
    ...Array.from({length: 160}, (_, index) => ({html: `<p>Edge ${index + 1}: one line.</p>`, tags: ''})),
    ...Array.from({length: 20}, (_, index) => ({
      html: [1, 2, 3].map(line => `<p>Tall ${index + 1} line ${line}: ordinary sentence text giving the line a realistic width.</p>`).join(''),
      tags: TALL_TAG,
    })),
    ...Array.from({length: 3}, (_, index) => ({html: `<p>Short ${index + 1}: a short note.</p>`, tags: SHORT_TAG})),
  ];
  return page.evaluate(async specs => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    // createNote(null, '') inserts at the top, so create bottom-up.
    for (const spec of specs.reverse()) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, spec.html, spec.tags);
      ids.push(note.id);
    }
    return ids;
  }, specs);
}

async function deleteFixture(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

async function search(page, query) {
  await page.click('#search-input');
  await page.evaluate(() => document.getElementById('search-input').select());
  await page.keyboard.press('Backspace');
  // The search runs as you type (Enter would add a note at the top).
  if (query.length > 0) await page.keyboard.type(query);
  await pause(SETTLE_MS);
  await idle(page);
  await page.keyboard.press('Escape');
  await pause(300);
}

function pageState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const roots = [...document.querySelectorAll('#notes-container > .note')];
    const label = note => note.querySelector(':scope > .note-content').textContent.trim().split(/:| line /)[0];
    return {
      scrollY: window.scrollY,
      maxScrollY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      firstRoot: roots.length > 0 ? label(roots[0]) : null,
      lastRoot: roots.length > 0 ? label(roots[roots.length - 1]) : null,
      upDisabled: document.getElementById('scroll-to-top-button').disabled,
      downDisabled: document.getElementById('scroll-to-bottom-button').disabled,
      isEditing: mode.isEditing,
    };
  });
}

function startScrollSampling(page) {
  return page.evaluate(() => {
    window.__edgeScrolls = [];
    const sample = () => {
      window.__edgeScrolls.push(window.scrollY);
      if (window.__edgeScrolls.length < 120) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function clickArrow(page, which) {
  await page.click(which === 'down' ? '#scroll-to-bottom-button' : '#scroll-to-top-button');
  await idle(page);
  await pause(SETTLE_MS);
}

function assertAtBottom(label, state, lastRoot) {
  assert.ok(Math.abs(state.scrollY - state.maxScrollY) <= EXACT_PX,
    `${label}: the page should be at its bottom (y=${Math.round(state.maxScrollY)}), got y=${Math.round(state.scrollY)}`);
  assert.equal(state.lastRoot, lastRoot, `${label}: the last loaded root should be "${lastRoot}"`);
  assert.equal(state.downDisabled, true, `${label}: the down arrow should be dimmed at the bottom`);
  assert.equal(state.upDisabled, false, `${label}: the up arrow should be available`);
}

function assertAtTop(label, state, firstRoot) {
  assert.equal(state.scrollY, 0, `${label}: the page should be at the top`);
  assert.equal(state.firstRoot, firstRoot, `${label}: the first loaded root should be "${firstRoot}"`);
  assert.equal(state.upDisabled, true, `${label}: the up arrow should be dimmed at the top`);
}

// The end of the full list is not loaded: the view is rebuilt at the end, the
// last note's bottom at the bottom of the window; then the up arrow rebuilds
// it from the first note.
async function unloadedEndsCase(page) {
  await reload(page);
  const start = await pageState(page);
  assert.equal(start.downDisabled, false, 'unloaded end: the down arrow should be available at the top');
  assert.notEqual(start.lastRoot, 'Short 3', 'unloaded end: the end of the list should start unloaded');
  await clickArrow(page, 'down');
  assertAtBottom('down arrow, end unloaded', await pageState(page), 'Short 3');
  await clickArrow(page, 'up');
  assertAtTop('up arrow, start unloaded', await pageState(page), 'Edge 1');
}

// The end is loaded (a search for the twenty tall notes): the page scrolls
// smoothly down to it, never backwards, in about a quarter of a second.
async function loadedEndCase(page) {
  await search(page, TALL_TAG);
  const start = await pageState(page);
  assert.equal(start.lastRoot, 'Tall 20', 'loaded end: the search should load all twenty tall notes');
  assert.ok(start.maxScrollY > 0, 'loaded end: the search should be taller than the window');
  await startScrollSampling(page);
  await clickArrow(page, 'down');
  assertAtBottom('down arrow, end loaded', await pageState(page), 'Tall 20');
  const scrolls = await page.evaluate(() => window.__edgeScrolls);
  const moving = scrolls.filter((y, index) => index === 0 || y !== scrolls[index - 1]);
  assert.ok(moving.length > 2, `down arrow, end loaded: the page should scroll smoothly, got ${moving.length} positions`);
  assert.ok(moving.every((y, index) => index === 0 || y > moving[index - 1]), 'down arrow, end loaded: the scroll should only move down');
}

// A list shorter than the window: both arrows dimmed.
async function shortListCase(page) {
  await search(page, SHORT_TAG);
  const state = await pageState(page);
  assert.equal(state.maxScrollY, 0, 'short list: the three notes should fit in the window');
  assert.equal(state.upDisabled, true, 'short list: the up arrow should be dimmed');
  assert.equal(state.downDisabled, true, 'short list: the down arrow should be dimmed');
}

async function editAtEndOfLine(page, prefix) {
  const point = await page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    const rect = paragraph.getBoundingClientRect();
    return {x: rect.right - 4, y: rect.top + rect.height / 2};
  }, prefix);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.isEditing && !mode.isLoading;
  });
  await pause(400);
  // The click put the caret at the end of the line.
  await page.keyboard.type(' edited');
  await pause(400);
}

async function assertSavedAfterReload(page, label, prefix) {
  await reload(page);
  await search(page, TALL_TAG);
  const saved = await page.evaluate(prefix => [...document.querySelectorAll('#notes-container p')]
    .some(p => p.textContent.trim().startsWith(prefix) && p.textContent.includes(' edited')), prefix);
  assert.equal(saved, true, `${label}: the edit should be saved`);
}

// While editing, either arrow first leaves edit mode (saved), then goes to its end.
async function editingCases(page) {
  await search(page, TALL_TAG);
  await editAtEndOfLine(page, 'Tall 1 line 1:');
  await clickArrow(page, 'down');
  const afterDown = await pageState(page);
  assert.equal(afterDown.isEditing, false, 'editing, down arrow: edit mode should end');
  assertAtBottom('editing, down arrow', afterDown, 'Tall 20');

  await editAtEndOfLine(page, 'Tall 20 line 3:');
  await clickArrow(page, 'up');
  const afterUp = await pageState(page);
  assert.equal(afterUp.isEditing, false, 'editing, up arrow: edit mode should end');
  assertAtTop('editing, up arrow', afterUp, 'Tall 1');

  await assertSavedAfterReload(page, 'editing, down arrow', 'Tall 1 line 1:');
  await assertSavedAfterReload(page, 'editing, up arrow', 'Tall 20 line 3:');
}

// Go to Bottom in the background menu does what the down arrow does.
async function menuGoToBottomCase(page) {
  await search(page, '');
  await reload(page);
  // The empty lane right of the notes column.
  const point = await page.evaluate(() => {
    const column = document.getElementById('notes-container').getBoundingClientRect();
    return {x: Math.round((column.right + window.innerWidth) / 2), y: Math.round(window.innerHeight / 2)};
  });
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await page.waitForSelector('#context-menu.is-visible');
  const item = await page.evaluateHandle(() => [...document.querySelectorAll('#context-menu .context-menu-item')]
    .find(node => node.textContent.trim() === 'Go to Bottom') || null);
  const labels = await page.evaluate(() => [...document.querySelectorAll('#context-menu .context-menu-item')].map(node => node.textContent.trim()));
  assert.notEqual(item.asElement(), null, `menu: the background menu should offer Go to Bottom, got ${labels.join(' | ')}`);
  await item.asElement().click();
  await idle(page);
  await pause(SETTLE_MS);
  assertAtBottom('menu Go to Bottom', await pageState(page), 'Short 3');
}

export async function checkListEdges(page) {
  const ids = await createFixture(page);
  const failures = [];
  let stepError = null;
  const check = async (name, body) => {
    try {
      await body();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      failures.push(`${name}: ${error.message}`);
      await page.keyboard.press('Escape');
      await pause(500);
    }
  };
  try {
    await check('unloaded ends', () => unloadedEndsCase(page));
    await check('loaded end', () => loadedEndCase(page));
    await check('short list', () => shortListCase(page));
    await check('editing', () => editingCases(page));
    await check('menu Go to Bottom', () => menuGoToBottomCase(page));
    assert.deepEqual(failures, [], `list edge failures:\n${failures.join('\n')}`);
  } catch (error) {
    stepError = error;
  }
  try {
    await search(page, '');
    await deleteFixture(page, ids);
    await reload(page);
  } catch (cleanupError) {
    if (stepError === null) throw cleanupError;
    console.error(`list edge cleanup also failed: ${cleanupError.message}`);
  }
  if (stepError !== null) throw stepError;
}
