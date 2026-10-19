import assert from 'node:assert/strict';

import {runThenCleanUp} from './suite-outcome.mjs';
import {waitForPageSettled} from './browser-app-idle.mjs';

// Leaving edit mode keeps your place: the text you were working on (the caret,
// when it is on screen) or reading (the line about a third down the screen)
// stays at the same height once the note renders for viewing, with no visible
// jump. A collapsed note that collapses again stays in view. Clicking another
// note while editing keeps the clicked text under the pointer.

const TOLERANCE_PX = 2;

function paragraphs(label, count) {
  return Array.from({length: count}, (_, index) =>
    `<p>${label} paragraph ${index + 1}: ordinary sentence text giving the line a realistic width.</p>`).join('');
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function createFixture(page) {
  return page.evaluate(async content => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    // createNote(null, '') inserts at the top, so create bottom-up.
    for (const html of content) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, html, '');
      ids.push(note.id);
    }
    return ids;
  }, [
    ...Array.from({length: 12}, (_, index) => paragraphs(`Below ${12 - index}`, 3)),
    paragraphs('Long', 60),
    ...Array.from({length: 12}, (_, index) => paragraphs(`Above ${12 - index}`, 3)),
  ]);
}

async function deleteFixture(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

function describeLine(lineTop) {
  if (lineTop === null) return 'none';
  return String(Math.round(lineTop));
}

// Chrome can replace the page's frame during a reload; Puppeteer then briefly
// reports the old one as detached. Look again on the new frame (only for that
// error; anything else fails as usual).
async function waitForAppReady(page) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.waitForSelector('[data-app-ready="true"]');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (attempt >= 5 || !/detached Frame/.test(error.message)) throw error;
      await pause(300);
      continue;
    }
    return;
  }
}

async function reload(page) {
  await page.reload();
  await waitForAppReady(page);
  await page.waitForNetworkIdle({idleTime: 300});
}

async function setCollapsed(page, noteId, collapsed) {
  await page.evaluate(async ({noteId, collapsed}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    if (collapsed) await NotesAPI.collapseNote(noteId);
    else await NotesAPI.expandNote(noteId);
  }, {noteId, collapsed});
  await reload(page);
}

async function runPaletteCommand(page, query) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('/');
  await page.keyboard.up('Meta');
  await pause(400);
  await page.keyboard.type(query);
  await pause(300);
  await page.keyboard.press('Enter');
  await page.waitForNetworkIdle({idleTime: 300});
}

// Screen Y of the paragraph whose text starts with `prefix` (edit or view DOM).
function paragraphY(page, prefix) {
  return page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    return paragraph ? paragraph.getBoundingClientRect().top : null;
  }, prefix);
}

function layout(page, noteId) {
  return page.evaluate(noteId => {
    const rect = document.querySelector(`[data-note-id="${noteId}"]`).getBoundingClientRect();
    const controls = document.querySelector('.controls').getBoundingClientRect();
    return {noteTop: rect.top, headerBottom: controls.bottom, viewportHeight: window.innerHeight};
  }, noteId);
}

async function scrollParagraphTo(page, prefix, viewportY) {
  const y = await paragraphY(page, prefix);
  assert.notEqual(y, null, `paragraph "${prefix}" not found`);
  await page.evaluate(delta => window.scrollBy(0, delta), y - viewportY);
  await pause(250);
}

async function waitForEditing(page, noteId) {
  await page.waitForFunction(async noteId => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.isEditing && mode.currentNoteId === noteId && !mode.isLoading;
  }, {}, noteId);
  await pause(400);
}

// Click near the start of a paragraph (page.click() would aim at the centre of
// a tall element and scroll to reach it).
async function clickParagraph(page, prefix) {
  const point = await page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    const rect = paragraph.getBoundingClientRect();
    return {x: rect.left + 30, y: rect.top + Math.min(10, rect.height / 2)};
  }, prefix);
  await page.mouse.click(point.x, point.y);
}

// Leaves edit mode with Escape, sampling the tracked paragraph every frame and
// counting decorative overlays (click-through elements added to the page body,
// as the removed position cue was) meanwhile: leaving edit mode must never put
// a highlight over the notes. Mermaid's temporary render boxes are not overlays.
async function exitWithEscape(page, prefix) {
  await page.evaluate(prefix => {
    window.__scrollSamples = [];
    window.__bodyOverlays = 0;
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && getComputedStyle(node).pointerEvents === 'none') window.__bodyOverlays += 1;
        }
      }
    }).observe(document.body, {childList: true});
    const sample = () => {
      const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
      if (paragraph) window.__scrollSamples.push(paragraph.getBoundingClientRect().top);
      if (window.__scrollSamples.length < 120) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, prefix);
  await page.keyboard.press('Escape');
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !mode.isEditing && !mode.isLoading;
  });
  await waitForPageSettled(page);
  return page.evaluate(() => ({samples: window.__scrollSamples, overlays: window.__bodyOverlays}));
}

function assertStayed(label, before, after, samples) {
  assert.notEqual(after, null, `${label}: tracked paragraph missing after leaving edit mode`);
  assert.ok(Math.abs(after - before) <= TOLERANCE_PX,
    `${label}: the text should stay where it was on screen: y=${Math.round(before)} -> ${Math.round(after)}`);
  if (samples) {
    const worst = Math.max(...samples.map(y => Math.abs(y - before)));
    assert.ok(worst <= TOLERANCE_PX,
      `${label}: no frame may show a jump while leaving edit mode (worst frame was ${Math.round(worst)}px off)`);
  }
}

// Move the caret to the end of the note being edited (typing then scrolls there).
function caretToEnd(page, noteId) {
  return page.evaluate(noteId => {
    const content = document.querySelector(`[data-note-id="${noteId}"] .note-content`);
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }, noteId);
}

async function caretVisibleCase(page, longId, label) {
  // Edit at the end of the note; typing scrolls there.
  await scrollParagraphTo(page, 'Long paragraph 1:', 200);
  await clickParagraph(page, 'Long paragraph 1:');
  await waitForEditing(page, longId);
  await caretToEnd(page, longId);
  await page.keyboard.type(' ');
  await pause(400);
  const tracked = 'Long paragraph 60:';
  const before = await paragraphY(page, tracked);
  const {samples, overlays} = await exitWithEscape(page, tracked);
  assertStayed(`${label}, caret on screen`, before, await paragraphY(page, tracked), samples);
  assert.equal(overlays, 0, `${label}: nothing may highlight the note when leaving edit mode`);
}

async function readingLineCase(page, longId, label) {
  await scrollParagraphTo(page, 'Long paragraph 1:', 200);
  await clickParagraph(page, 'Long paragraph 1:');
  await waitForEditing(page, longId);
  // The caret is at the note's end, off screen; read somewhere in the middle.
  const {headerBottom, viewportHeight} = await layout(page, longId);
  const readingLineY = headerBottom + (viewportHeight - headerBottom) / 3;
  await scrollParagraphTo(page, 'Long paragraph 30:', readingLineY - 5);
  const before = await paragraphY(page, 'Long paragraph 30:');
  await exitWithEscape(page, 'Long paragraph 30:');
  assertStayed(`${label}, caret off screen (reading line)`, before, await paragraphY(page, 'Long paragraph 30:'), null);
}

// Late content keeps its space: an inline image arrives with its size, and a
// Mermaid diagram shown again holds its last height while it re-renders.
async function createLateContentFixture(page) {
  return page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    canvas.getContext('2d').fillRect(0, 0, 320, 180);
    const lines = ['```mermaid', 'flowchart TD', 'A[Start] --> B[Middle]', 'B --> C[Finish]', '```', '', 'Text after the diagram.'];
    const mermaid = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(mermaid.id, lines.map(line => `<div>${line}</div>`).join(''), '@markdown');
    const image = await NotesAPI.createNote(null, '');
    const paragraphsHtml = Array.from({length: 8}, (_, index) => `<p>Image paragraph ${index + 1}: text below the picture.</p>`).join('');
    await NotesAPI.saveNote(image.id, `<p><img src="${canvas.toDataURL('image/png')}"></p>${paragraphsHtml}`, '');
    return {imageId: image.id, mermaidId: mermaid.id};
  });
}

async function editAndExit(page, noteId, clickSelector) {
  await page.evaluate(selector => document.querySelector(selector).scrollIntoView({block: 'center'}), clickSelector);
  await pause(250);
  const point = await page.evaluate(selector => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return {x: rect.left + 30, y: rect.top + Math.min(10, rect.height / 2)};
  }, clickSelector);
  await page.mouse.click(point.x, point.y);
  await waitForEditing(page, noteId);
  // The caret lands where the click was; edit at the end of the note.
  await page.evaluate(noteId => {
    const content = document.querySelector(`[data-note-id="${noteId}"] .note-content`);
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }, noteId);
  await page.keyboard.type(' ');
  await pause(400);
  await page.evaluate(() => {
    window.__reservedHeights = [];
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          for (const pre of node.querySelectorAll('pre.meta-mermaid-reserved')) window.__reservedHeights.push(pre.getBoundingClientRect().height);
        }
      }
    }).observe(document.getElementById('notes-container'), {childList: true, subtree: true});
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !mode.isEditing && !mode.isLoading;
  });
  await waitForPageSettled(page);
}

async function lateContentCase(page) {
  const {imageId, mermaidId} = await createLateContentFixture(page);
  try {
    await reload(page);
    const diagramSelector = `[data-note-id="${mermaidId}"] [data-mermaid-state="rendered"]`;
    await page.waitForSelector(diagramSelector);
    const firstHeight = await page.evaluate(selector => document.querySelector(selector).getBoundingClientRect().height, diagramSelector);

    await editAndExit(page, imageId, `[data-note-id="${imageId}"] p:last-of-type`);
    const image = await page.evaluate(noteId => {
      const element = document.querySelector(`[data-note-id="${noteId}"] img`);
      return {width: element.getAttribute('width'), height: element.getAttribute('height')};
    }, imageId);
    assert.deepEqual(image, {width: '320', height: '180'}, 'an inline image renders with its pixel size so its space is reserved');

    await editAndExit(page, mermaidId, `[data-note-id="${mermaidId}"] .note-content`);
    await page.waitForSelector(diagramSelector);
    const reserved = await page.evaluate(() => window.__reservedHeights);
    // The view may be inserted more than once while leaving edit mode; each time
    // the source waits at the diagram's height.
    assert.ok(reserved.length >= 1, 'the Mermaid diagram reserves its last height while it renders again');
    for (const height of reserved) {
      assert.ok(Math.abs(height - firstHeight) <= TOLERANCE_PX,
        `the reserved height matches the rendered diagram: ${Math.round(height)} vs ${Math.round(firstHeight)}`);
    }
  } finally {
    await deleteFixture(page, [imageId, mermaidId]);
  }
}

// A formatted note whose raw text at the reading line does not survive
// rendering (Mermaid source, Markdown syntax): with no text to match, the
// note's top stays put rather than guessing a spot.
async function unmatchedFormatCase(page, ids) {
  const noteId = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const lines = ['# Release checklist', '', '```mermaid', 'flowchart TD',
      ...Array.from({length: 14}, (_, index) => `    S${index}[Step ${index}] --> S${index + 1}[Step ${index + 1}]`), '```', ''];
    for (let index = 1; index <= 30; index += 1) lines.push(`Paragraph ${index} after the diagram, with ordinary text.`, '');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, lines.map(line => `<div>${line}</div>`).join(''), '@markdown');
    return note.id;
  });
  ids.push(noteId);
  await reload(page);
  await page.waitForSelector(`[data-note-id="${noteId}"] [data-mermaid-state="rendered"]`);
  await page.evaluate(noteId => {
    const rect = document.querySelector(`[data-note-id="${noteId}"]`).getBoundingClientRect();
    window.scrollBy(0, rect.top - 150);
  }, noteId);
  await pause(300);
  await editAndExitSetup(page, noteId);
  // Put the reading line on the Mermaid source.
  const {headerBottom, viewportHeight} = await layout(page, noteId);
  const readingLineY = headerBottom + (viewportHeight - headerBottom) / 3;
  const lineY = await page.evaluate(noteId => {
    const line = [...document.querySelectorAll(`[data-note-id="${noteId}"] .note-content div`)].find(div => div.textContent.includes('S6[Step 6]'));
    return line.getBoundingClientRect().top;
  }, noteId);
  await page.evaluate(delta => window.scrollBy(0, delta), lineY - readingLineY + 4);
  await pause(300);
  const before = (await layout(page, noteId)).noteTop;
  const {overlays} = await exitWithEscape(page, 'Paragraph 1 after');
  const after = (await layout(page, noteId)).noteTop;
  assert.equal(overlays, 0, 'unmatched formatted text: nothing may highlight the note when leaving edit mode');
  assert.ok(Math.abs(after - before) <= TOLERANCE_PX,
    `unmatched formatted text: the note's top stays put: y=${Math.round(before)} -> ${Math.round(after)}`);
}

async function editAndExitSetup(page, noteId) {
  const point = await page.evaluate(noteId => {
    const rect = document.querySelector(`[data-note-id="${noteId}"] .note-content`).getBoundingClientRect();
    return {x: rect.left + 30, y: rect.top + 10};
  }, noteId);
  await page.mouse.click(point.x, point.y);
  await waitForEditing(page, noteId);
}

// Mermaid diagrams use a compact layout (tight spacing, small text); the
// release-checklist sample was 1047px tall with Mermaid's defaults. Diagrams
// are never capped or scaled to a size: a large one keeps all its detail.
async function compactMermaidCase(page, ids) {
  const noteId = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const lines = ['```mermaid', 'flowchart TD', '    A[Write the change] --> B[Run unit tests]', '    B --> C{Tests pass?}',
      '    C -- No --> A', '    C -- Yes --> D[Run browser smoke]', '    D --> E{Smoke passes?}', '    E -- No --> A',
      '    E -- Yes --> F[Human testing]', '    F --> G[Commit checkpoint]', '    G --> H[Merge to main]', '```'];
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, lines.map(line => `<div>${line}</div>`).join(''), '@markdown');
    return note.id;
  });
  ids.push(noteId);
  await reload(page);
  const selector = `[data-note-id="${noteId}"] [data-mermaid-state="rendered"]`;
  await page.waitForSelector(selector);
  const {height, fontSize} = await page.evaluate(selector => {
    const diagram = document.querySelector(selector);
    const label = diagram.querySelector('.nodeLabel');
    return {height: diagram.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(label).fontSize)};
  }, selector);
  assert.ok(height <= 700, `the sample flowchart should use the compact layout: ${Math.round(height)}px tall (1047px with defaults)`);
  assert.ok(fontSize <= 14, `Mermaid labels use compact text: ${fontSize}px`);
}

// --- Entering edit mode: the clicked spot stays under the pointer ---------

// Screen Y of the innermost paragraph/line (view or edit DOM) whose text contains `prefix`
// (source lines keep markup such as "- " list markers).
function lineY(page, noteId, prefix) {
  return page.evaluate(({noteId, prefix}) => {
    const candidates = [...document.querySelectorAll(`[data-note-id="${noteId}"] .note-content :is(p, div, li, h1, h2, h3)`)]
      .filter(element => element.textContent.includes(prefix));
    const line = candidates[candidates.length - 1];
    return line ? line.getBoundingClientRect().top : null;
  }, {noteId, prefix});
}

// Click near the start of that line, then wait for edit mode and samples.
async function clickLineToEdit(page, noteId, prefix) {
  const point = await page.evaluate(({noteId, prefix}) => {
    const candidates = [...document.querySelectorAll(`[data-note-id="${noteId}"] .note-content :is(p, div, li, h1, h2, h3)`)]
      .filter(element => element.textContent.includes(prefix));
    const rect = candidates[candidates.length - 1].getBoundingClientRect();
    return {x: rect.left + 20, y: rect.top + Math.min(8, rect.height / 2)};
  }, {noteId, prefix});
  await page.mouse.click(point.x, point.y);
  await waitForEditing(page, noteId);
  await waitForPageSettled(page);
  return point;
}

function caretLineText(page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (selection.rangeCount === 0) return '';
    let node = selection.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    return node.closest('div, p, li').textContent;
  });
}

async function enterEditCase(page, noteId, prefix, label) {
  const before = await lineY(page, noteId, prefix);
  assert.notEqual(before, null, `${label}: "${prefix}" shown before editing`);
  await clickLineToEdit(page, noteId, prefix);
  const after = await lineY(page, noteId, prefix);
  assert.notEqual(after, null, `${label}: "${prefix}" shown while editing`);
  assert.ok(Math.abs(after - before) <= TOLERANCE_PX,
    `${label}: the clicked line should stay under the pointer: y=${Math.round(before)} -> ${Math.round(after)}`);
  const caretLine = await caretLineText(page);
  assert.ok(caretLine.includes(prefix), `${label}: the caret should be on the clicked line, got "${caretLine.slice(0, 40)}"`);
  // Leaving again: the line stays put and nothing highlights the note (even
  // when a diagram above grows back and the page scrolls).
  const {overlays} = await exitWithEscape(page, prefix);
  assert.equal(overlays, 0, `${label}: nothing may highlight the note when leaving edit mode`);
  const back = await lineY(page, noteId, prefix);
  assert.ok(Math.abs(back - before) <= TOLERANCE_PX, `${label}: after Escape the line is back where it was: y=${Math.round(before)} -> ${Math.round(back)}`);
}

async function enterEditCases(page, ids, longId) {
  // Rich text: a paragraph in the middle of a long note.
  await reload(page);
  await scrollParagraphTo(page, 'Long paragraph 30:', 350);
  await enterEditCase(page, longId, 'Long paragraph 30:', 'rich text');

  // Markdown with a Mermaid diagram above the clicked paragraph: the diagram
  // turns back into its (much shorter) source, yet the paragraph stays put.
  const markdownId = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const lines = ['# Release checklist', '', '```mermaid', 'flowchart TD',
      '    A[Write the change] --> B[Run unit tests]', '    B --> C{Tests pass?}', '    C -- No --> A',
      '    C -- Yes --> D[Run browser smoke]', '    D --> E{Smoke passes?}', '    E -- No --> A',
      '    E -- Yes --> F[Human testing]', '    F --> G[Commit checkpoint]', '    G --> H[Merge to main]', '```', '',
      'A paragraph before the list, ending above it.', '', '- A short list item', '- Another list item', '- A final list item', ''];
    for (let index = 1; index <= 30; index += 1) lines.push(`Markdown paragraph ${index} after the diagram.`, '');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, lines.map(line => `<div>${line}</div>`).join(''), '@markdown');
    // Notes above it, so the page can scroll either way around it.
    const fillers = [];
    for (let index = 0; index < 6; index += 1) {
      const filler = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(filler.id, `<p>Filler note ${index} above the Markdown note.</p>`.repeat(3), '');
      fillers.push(filler.id);
    }
    return {id: note.id, fillers};
  }).then(({id, fillers}) => {
    ids.push(...fillers);
    return id;
  });
  ids.push(markdownId);
  await reload(page);
  await page.waitForSelector(`[data-note-id="${markdownId}"] [data-mermaid-state="rendered"]`);
  const target = await lineY(page, markdownId, 'Markdown paragraph 12 after');
  await page.evaluate(delta => window.scrollBy(0, delta), target - 350);
  await pause(300);
  await enterEditCase(page, markdownId, 'Markdown paragraph 12 after', 'markdown below a diagram');

  // List items: the source adds "- " markers around the clicked text.
  for (const item of ['A short list item', 'Another list item', 'A final list item']) {
    await reload(page);
    await page.waitForSelector(`[data-note-id="${markdownId}"] [data-mermaid-state="rendered"]`);
    const itemY = await lineY(page, markdownId, item);
    await page.evaluate(delta => window.scrollBy(0, delta), itemY - 350);
    await pause(300);
    await enterEditCase(page, markdownId, item, `markdown list item "${item}"`);
  }

  // Clicking a box of the diagram: the caret goes to that box's source line,
  // which appears under the pointer; clicking elsewhere in the diagram leaves
  // the note where it is. Either way nothing jumps away from the pointer.
  const labels = await page.evaluate(noteId => [...document.querySelectorAll(
    `[data-note-id="${noteId}"] [data-mermaid-state="rendered"] .nodeLabel`)].map(label => label.textContent), markdownId);
  assert.ok(labels.length >= 5, 'the diagram has labelled boxes to click');
  const diagramFailures = [];
  for (const label of labels) {
    await reload(page);
    await page.waitForSelector(`[data-note-id="${markdownId}"] [data-mermaid-state="rendered"]`);
    const point = await page.evaluate(({noteId, label}) => {
      const element = [...document.querySelectorAll(`[data-note-id="${noteId}"] [data-mermaid-state="rendered"] .nodeLabel`)]
        .find(candidate => candidate.textContent === label);
      element.scrollIntoView({block: 'center'});
      const rect = element.getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    }, {noteId: markdownId, label});
    await pause(300);
    await page.mouse.click(point.x, point.y);
    await waitForEditing(page, markdownId);
    await waitForPageSettled(page);
    const result = await page.evaluate(label => {
      const selection = window.getSelection();
      let node = selection.getRangeAt(0).startContainer;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
      const line = node.closest('div, p');
      return {lineText: line.textContent, lineTop: line.getBoundingClientRect().top, lineBottom: line.getBoundingClientRect().bottom};
    }, label);
    const onLine = result.lineText.includes(label);
    const underPointer = point.y >= result.lineTop - 4 && point.y <= result.lineBottom + 4;
    if (!onLine || !underPointer) {
      diagramFailures.push(`"${label}": caret line "${result.lineText.trim().slice(0, 40)}" at y=${Math.round(result.lineTop)}, click y=${Math.round(point.y)}`);
    }
    await page.keyboard.press('Escape');
    await waitForPageSettled(page);
  }
  assert.deepEqual(diagramFailures, [], `clicking a diagram box should put its source line, with the caret, under the pointer:\n${diagramFailures.join('\n')}`);

  // Clicking empty space in the diagram: the diagram's ```mermaid source line
  // takes the diagram's place (its top), with the caret on it.
  await reload(page);
  await page.waitForSelector(`[data-note-id="${markdownId}"] [data-mermaid-state="rendered"]`);
  await page.evaluate(noteId => {
    window.scrollBy(0, document.querySelector(`[data-note-id="${noteId}"]`).getBoundingClientRect().top - 120);
  }, markdownId);
  await pause(300);
  const diagram = await page.evaluate(noteId => {
    const rect = document.querySelector(`[data-note-id="${noteId}"] [data-mermaid-state="rendered"]`).getBoundingClientRect();
    return {x: rect.left + 20, y: rect.top + 20, top: rect.top};
  }, markdownId);
  await page.mouse.click(diagram.x, diagram.y);
  await waitForEditing(page, markdownId);
  await waitForPageSettled(page);
  const fenceTop = await lineY(page, markdownId, '```mermaid');
  assert.ok(Math.abs(fenceTop - diagram.top) <= 4,
    `clicking empty diagram space: its source should start where the diagram did: y=${Math.round(diagram.top)} -> ${Math.round(fenceTop)}`);
  assert.ok((await caretLineText(page)).includes('```mermaid'), 'clicking empty diagram space: the caret is at the start of its source');
  await page.keyboard.press('Escape');
  await waitForPageSettled(page);
}

// --- Formatted notes: click a rendered spot, then leave again ---------------

const FORMATTED_CASES = [
  {
    label: 'CSV row',
    tags: '@csv',
    lines: ['name,score,notes', ...Array.from({length: 30}, (_, index) => `Row ${index + 1} name,${index * 3},Some note text ${index + 1}`)],
    target: '.meta-csv td', targetText: 'Row 15 name', source: 'Row 15 name',
  },
  {
    label: 'JSON key',
    tags: '@json',
    lines: ['{', ...Array.from({length: 30}, (_, index) => `"key${index + 1}": "value number ${index + 1}"${index < 29 ? ',' : ''}`), '}'],
    target: '.json-key', targetText: '"key15"', source: '"key15"',
  },
  {
    label: 'Markdown table row',
    tags: '@markdown',
    lines: ['Intro paragraph above the table.', '', '| Name | Score |', '|---|---|', ...Array.from({length: 30}, (_, index) => `| Table row ${index + 1} | ${index} |`)],
    target: '.meta-markdown td', targetText: 'Table row 15', source: 'Table row 15',
  },
  {
    label: 'LaTeX formula',
    tags: '@markdown',
    lines: Array.from({length: 20}, (_, index) => [`Paragraph ${index + 1} before formula ${index + 1}.`, `$$\\frac{a_{${index + 1}}}{b}$$`, '']).flat(),
    target: '.meta-latex', targetIndex: 9, source: 'a_{10}',
  },
];

async function formattedClickCase(page, ids, spec) {
  const noteId = await page.evaluate(async ({lines, tags}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, lines.map(line => `<div>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`).join(''), tags);
    const fillers = [];
    for (let index = 0; index < 4; index += 1) {
      const filler = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(filler.id, `<p>Filler note ${index} above the formatted note.</p>`.repeat(3), '');
      fillers.push(filler.id);
    }
    return [note.id, ...fillers];
  }, {lines: spec.lines, tags: spec.tags}).then(created => {
    ids.push(...created);
    return created[0];
  });
  await reload(page);
  const targetBox = () => page.evaluate(({noteId, spec}) => {
    const candidates = [...document.querySelectorAll(`[data-note-id="${noteId}"] ${spec.target}`)];
    const element = typeof spec.targetText === 'string'
      ? candidates.find(candidate => candidate.textContent.trim() === spec.targetText)
      : candidates[spec.targetIndex];
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
  }, {noteId, spec});
  await page.waitForFunction(async ({noteId, spec}) => document.querySelectorAll(`[data-note-id="${noteId}"] ${spec.target}`).length > 0, {}, {noteId, spec});
  let box = await targetBox();
  await page.evaluate(delta => window.scrollBy(0, delta), box.top - 350);
  await pause(300);
  box = await targetBox();
  const point = {x: box.left + Math.min(12, box.width / 2), y: box.top + box.height / 2};
  await page.mouse.click(point.x, point.y);
  await waitForEditing(page, noteId);
  await waitForPageSettled(page);
  const caret = await page.evaluate(() => {
    const selection = window.getSelection();
    let node = selection.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const line = node.closest('div, p');
    const rect = line.getBoundingClientRect();
    return {text: line.textContent, top: rect.top, bottom: rect.bottom};
  });
  const problems = [];
  if (!caret.text.includes(spec.source)) problems.push(`caret on "${caret.text.trim().slice(0, 40)}" instead of the "${spec.source}" source line`);
  if (point.y < caret.top - 4 || point.y > caret.bottom + 4) problems.push(`caret line at y=${Math.round(caret.top)}-${Math.round(caret.bottom)}, click at y=${Math.round(point.y)}`);
  const {overlays} = await exitWithEscape(page, '__none__');
  if (overlays !== 0) problems.push(`${overlays} overlay(s) added while leaving edit mode`);
  const back = await targetBox();
  if (back === null) problems.push('target missing after Escape');
  else if (Math.abs(back.top - box.top) > TOLERANCE_PX) problems.push(`after Escape the spot moved: y=${Math.round(box.top)} -> ${Math.round(back.top)}`);
  return problems.map(problem => `${spec.label}: ${problem}`);
}

async function formattedClickCases(page, ids) {
  const problems = [];
  for (const spec of FORMATTED_CASES) problems.push(...await formattedClickCase(page, ids, spec));
  assert.deepEqual(problems, [], `formatted notes should keep the clicked spot in place both ways:\n${problems.join('\n')}`);
}

function headerBottomOf(page) {
  return page.evaluate(() => document.querySelector('.controls').getBoundingClientRect().bottom);
}

// Drags the note holding the `source` paragraph to `to` (viewport point) with
// the mouse. Returns window.scrollY on every frame until it settles, and the
// drop line's screen position just before release (null for sideways drags).
async function dragNoteTo(page, source, to) {
  const from = await page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    const rect = paragraph.getBoundingClientRect();
    return {x: rect.left + 40, y: rect.top + Math.min(10, rect.height / 2)};
  }, source);
  const headerBottom = await headerBottomOf(page);
  const innerHeight = await page.evaluate(() => window.innerHeight);
  assert.ok(from.y > headerBottom && from.y < innerHeight - 4,
    `drag: "${source}" should be on screen below the search controls (y=${Math.round(from.y)}, window ${innerHeight})`);
  await page.evaluate(() => {
    window.__dragScrolls = [];
    const sample = () => {
      window.__dragScrolls.push(window.scrollY);
      if (window.__dragScrolls.length < 180) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  // A vertical drag (no `to.x`) stays straight, so it is never read as an indent.
  const toX = Object.prototype.hasOwnProperty.call(to, 'x') ? to.x : from.x;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(from.x + (toX - from.x) * step / 12, from.y + (to.y - from.y) * step / 12);
    await pause(16);
  }
  const lineTop = await page.evaluate(() => {
    const line = document.querySelector('.note-drop-line');
    return line === null || line.hidden ? null : line.getBoundingClientRect().top;
  });
  await page.mouse.up();
  await page.waitForNetworkIdle({idleTime: 300});
  await waitForPageSettled(page);
  return {scrolls: await page.evaluate(() => window.__dragScrolls), lineTop};
}

function noteRectOf(page, prefix) {
  return page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    const rect = paragraph.closest('.note').getBoundingClientRect();
    return {top: rect.top, bottom: rect.bottom};
  }, prefix);
}

function assertNoScroll(label, scrolls, scrollBefore) {
  const worst = Math.max(...scrolls.map(y => Math.abs(y - scrollBefore)));
  assert.ok(worst < 1, `${label}: the page should not scroll, but moved up to ${Math.round(worst)}px`);
}

// The drop line sits 1px outside the edge of the note it marks, so a note moved
// up lands with its top 1px below the line, and one moved down with its bottom
// 1px above it: where the user saw it would go.
async function assertLandedOnLine(page, label, source, direction, lineTop) {
  assert.notEqual(lineTop, null, `${label}: a drop line should have shown where the note would land`);
  const rect = await noteRectOf(page, source);
  const edge = direction === 'up' ? rect.top : rect.bottom;
  const expected = direction === 'up' ? lineTop + 1 : lineTop - 1;
  assert.ok(Math.abs(edge - expected) <= TOLERANCE_PX,
    `${label}: the note's ${direction === 'up' ? 'top' : 'bottom'} should land on the drop line (y≈${Math.round(expected)}), got y=${Math.round(edge)}`);
}

async function scrollNoteTopTo(page, prefix, viewportY) {
  const top = (await noteRectOf(page, prefix)).top;
  await page.evaluate(delta => window.scrollBy(0, delta), top - viewportY);
  await pause(400);
}

// Principles 1 and 2 (docs/ui/interaction-principles.md): a dropped note lands
// where the drop line showed, and nothing scrolls. Moving a short note down
// onto a note that runs past the bottom of the window.
async function dragShortNoteDownCase(page) {
  await reload(page);
  const source = 'Above 4 paragraph 1:';
  const target = 'Above 6 paragraph 1:';
  await scrollNoteTopTo(page, target, (await page.evaluate(() => window.innerHeight)) - 50);
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const {scrolls, lineTop} = await dragNoteTo(page, source, {y: await page.evaluate(() => window.innerHeight - 10)});
  assert.ok((await noteRectOf(page, source)).top > (await noteRectOf(page, target)).top, `drag a short note down: "${source}" should have moved below "${target}"`);
  assertNoScroll('drag a short note down', scrolls, scrollBefore);
  await assertLandedOnLine(page, 'drag a short note down', source, 'down', lineTop);
}

// Moving a short note up onto a note in the middle of the window.
async function dragShortNoteUpCase(page) {
  await reload(page);
  // After the drag-down case the order is Above 3, 5, 6, 4, 7…: move Above 4 up two places.
  const source = 'Above 4 paragraph 1:';
  const target = 'Above 5 paragraph 1:';
  await scrollNoteTopTo(page, target, 150);
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const dropY = await page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    const rect = paragraph.getBoundingClientRect();
    return rect.top + rect.height / 2;
  }, target);
  const {scrolls, lineTop} = await dragNoteTo(page, source, {y: dropY});
  const order = await page.evaluate(() => [...document.querySelectorAll('#notes-container p')]
    .map(p => p.textContent.trim().split(' paragraph')[0]).filter((label, index, all) => all.indexOf(label) === index).slice(0, 12).join(', '));
  assert.ok((await noteRectOf(page, source)).top < (await noteRectOf(page, target)).top,
    `drag a short note up: "${source}" should have moved above "${target}" (line at ${describeLine(lineTop)}, drop y=${Math.round(dropY)}; order: ${order})`);
  assertNoScroll('drag a short note up', scrolls, scrollBefore);
  await assertLandedOnLine(page, 'drag a short note up', source, 'up', lineTop);
}

// Moving a tall note (its top already above the screen) down to the bottom
// edge: its bottom lands on the drop line and the page does not scroll, least
// of all to the note's top.
async function dragTallNoteDownCase(page, longId) {
  await setCollapsed(page, longId, false);
  const source = 'Long paragraph 59:';
  const target = 'Below 2 paragraph 1:';
  await scrollParagraphTo(page, 'Long paragraph 60:', Math.round((await page.evaluate(() => window.innerHeight)) * 0.4));
  const dropY = await page.evaluate(() => window.innerHeight - 10);
  assert.ok((await noteRectOf(page, target)).bottom > dropY, `drag a tall note down: "${target}" should run past the bottom of the window`);
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const {scrolls, lineTop} = await dragNoteTo(page, source, {y: dropY});
  assert.ok((await noteRectOf(page, source)).top > (await noteRectOf(page, target)).top, `drag a tall note down: the long note should have moved below "${target}"`);
  assertNoScroll('drag a tall note down', scrolls, scrollBefore);
  await assertLandedOnLine(page, 'drag a tall note down', source, 'down', lineTop);
}

// Principle 3: dropping a note before one whose top is hidden under the sticky
// search controls would land it behind them, out of sight; the page scrolls
// just enough to put it right below them, with the usual gap and no more.
async function dragUnderSearchBarCase(page) {
  await reload(page);
  // After the previous drag cases the order is Above 3, 4, 5, 6…: move Above 6 up two places.
  const source = 'Above 6 paragraph 1:';
  const target = 'Above 4 paragraph 1:';
  const headerBottom = await headerBottomOf(page);
  await scrollNoteTopTo(page, target, headerBottom - 30);
  await dragNoteTo(page, source, {y: headerBottom + 12});
  assert.ok((await noteRectOf(page, source)).top < (await noteRectOf(page, target)).top, `drag under the search bar: "${source}" should have moved above "${target}"`);
  const top = (await noteRectOf(page, source)).top;
  const gap = await page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    return parseFloat(getComputedStyle(paragraph.closest('.note')).marginTop);
  }, source);
  assert.ok(Math.abs(top - (headerBottom + gap)) <= TOLERANCE_PX,
    `drag under the search bar: the moved note should sit right below the search controls (y≈${Math.round(headerBottom + gap)}), got y=${Math.round(top)}`);
}

// Sideways drags (indent, then outdent back) change the note's level in place;
// nothing scrolls.
async function dragSidewaysCase(page) {
  await reload(page);
  const source = 'Above 11 paragraph 1:';
  await scrollNoteTopTo(page, source, 300);
  const {y} = await page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    return {y: paragraph.getBoundingClientRect().top + 8};
  }, source);
  const x = await page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    return paragraph.getBoundingClientRect().left + 40;
  }, source);
  let scrollBefore = await page.evaluate(() => window.scrollY);
  const indent = await dragNoteTo(page, source, {x: x + 120, y});
  const isChild = () => page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    return paragraph.closest('.note').parentElement.closest('.note') !== null;
  }, source);
  assert.equal(await isChild(), true, `drag sideways: "${source}" should have been indented`);
  assertNoScroll('drag sideways to indent', indent.scrolls, scrollBefore);
  scrollBefore = await page.evaluate(() => window.scrollY);
  const outdentFrom = await page.evaluate(prefix => {
    const paragraph = [...document.querySelectorAll('#notes-container p')].find(p => p.textContent.trim().startsWith(prefix));
    const rect = paragraph.getBoundingClientRect();
    return {x: rect.left + 40, y: rect.top + 8};
  }, source);
  const outdent = await dragNoteTo(page, source, {x: outdentFrom.x - 120, y: outdentFrom.y});
  assert.equal(await isChild(), false, `drag sideways: "${source}" should have been outdented back`);
  assertNoScroll('drag sideways to outdent', outdent.scrolls, scrollBefore);
}

async function newNoteAtTopCase(page, ids) {
  await reload(page);
  await page.evaluate(() => window.scrollTo(0, 1500));
  await pause(400);
  await page.mouse.move(400, 400);
  await page.keyboard.press('Enter');
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.isEditing && !mode.isLoading;
  });
  const newId = await page.evaluate(async () => (await import('/static/js/modules/mode-manager/mode-context.js')).ModeContextInstance.currentNoteId);
  ids.push(newId);
  await waitForPageSettled(page);
  const {noteTop, headerBottom} = await layout(page, newId);
  const scrollY = await page.evaluate(() => window.scrollY);
  assert.ok(noteTop >= headerBottom - 1,
    `the new note should be visible below the search controls (y=${Math.round(headerBottom)}), got y=${Math.round(noteTop)} at scrollY=${Math.round(scrollY)}`);
  await page.keyboard.press('Escape');
  await waitForPageSettled(page);
}

export async function checkExitEditScroll(page) {
  const ids = await createFixture(page);
  const longId = ids[12];
  // Run every case and report all failures together.
  const failures = [];
  const check = async (name, body) => {
    try {
      await body();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      failures.push(`${name}: ${error.message}`);
      if (await page.evaluate(async () => (await import('/static/js/modules/mode-manager/mode-context.js')).ModeContextInstance.isEditing)) {
        await page.keyboard.press('Escape');
        await pause(500);
      }
    }
  };
  await runThenCleanUp('exit-edit', async () => {
    // Expanded note: the caret's text, then the reading line, stay put.
    await setCollapsed(page, longId, false);
    await check('expanded, caret', () => caretVisibleCase(page, longId, 'expanded note'));
    await check('expanded, reading line', () => readingLineCase(page, longId, 'expanded note'));

    // Collapsed note with an edit: it is shown collapsed again after saving
    // (edits do not change a note's saved collapse state), so the collapsed row
    // stays in view, just below the search controls when it would be above them.
    // Collapsed note with an edit: it stays expanded on leaving edit mode, so
    // the change stays in view, with the edited line where it was and nothing
    // highlighting it; it is saved expanded (still expanded after a reload).
    await check('collapsed with edit', async () => {
      await setCollapsed(page, longId, true);
      await scrollParagraphTo(page, 'Long paragraph 1:', 300);
      await clickParagraph(page, 'Long paragraph 1:');
      await waitForEditing(page, longId);
      // Type at the end of the clicked line, keeping the paragraph's prefix intact.
      await page.keyboard.press('End');
      await page.keyboard.type(' x');
      await pause(400);
      const before = await paragraphY(page, 'Long paragraph 1:');
      const {samples, overlays} = await exitWithEscape(page, 'Long paragraph 1:');
      assertStayed('collapsed note with an edit', before, await paragraphY(page, 'Long paragraph 1:'), samples);
      assert.equal(overlays, 0, 'collapsed note with an edit: nothing may highlight the note when leaving edit mode');
      const shownCollapsed = () => page.evaluate(id => document.querySelector(`[data-note-id="${id}"]`).classList.contains('collapsed'), longId);
      assert.equal(await shownCollapsed(), false, 'collapsed note with an edit: it should stay expanded after Escape');
      await reload(page);
      assert.equal(await shownCollapsed(), false, 'collapsed note with an edit: it should be saved expanded');
    });

    // Collapsed note opened and closed without scrolling: it simply shows
    // collapsed again where it is, with nothing highlighting it.
    await check('collapsed in place', async () => {
      await setCollapsed(page, longId, true);
      await scrollParagraphTo(page, 'Long paragraph 1:', 300);
      const rowBefore = (await layout(page, longId)).noteTop;
      await clickParagraph(page, 'Long paragraph 1:');
      await waitForEditing(page, longId);
      const {overlays} = await exitWithEscape(page, 'Long paragraph 1:');
      const rowAfter = (await layout(page, longId)).noteTop;
      assert.ok(Math.abs(rowAfter - rowBefore) <= 4, `collapsed in place: the row should stay put: y=${Math.round(rowBefore)} -> ${Math.round(rowAfter)}`);
      assert.equal(overlays, 0, 'collapsed in place: nothing may highlight the note when it collapses again');
    });

    // A collapsed root with child notes (shown while editing) that collapses
    // again: nothing highlights it.
    await check('collapsed with children', async () => {
      const parentId = await page.evaluate(async () => {
        const {NotesAPI} = await import('/static/js/modules/api-client.js');
        const parent = await NotesAPI.createNote(null, '');
        await NotesAPI.saveNote(parent.id, '<p>Parent with children</p>', '');
        for (let index = 3; index >= 1; index -= 1) {
          const child = await NotesAPI.createChild(parent.id, '');
          await NotesAPI.saveNote(child.id, `<p>Child note ${index} with a line of text.</p>`, '');
        }
        await NotesAPI.collapseNote(parent.id);
        return parent.id;
      });
      ids.push(parentId);
      await reload(page);
      await scrollParagraphTo(page, 'Parent with children', 300);
      await clickParagraph(page, 'Parent with children');
      await waitForEditing(page, parentId);
      const {overlays} = await exitWithEscape(page, 'Parent with children');
      assert.equal(overlays, 0, 'collapsed with children: nothing may highlight the note when it collapses again');
    });

    // Collapsed note without an edit: it collapses again; the collapsed row
    // stays in view, just below the search controls when it would be above them.
    await check('collapsed without edit', async () => {
    await setCollapsed(page, longId, true);
    await scrollParagraphTo(page, 'Long paragraph 1:', 200);
    await clickParagraph(page, 'Long paragraph 1:');
    await waitForEditing(page, longId);
    await page.evaluate(() => window.scrollBy(0, 1500));
    await pause(300);
    const {overlays} = await exitWithEscape(page, 'Long paragraph 1:');
    const collapsedLayout = await layout(page, longId);
    assert.equal(overlays, 0, 'collapsed note without an edit: nothing may highlight the note after the view moves');
    assert.ok(Math.abs(collapsedLayout.noteTop - (collapsedLayout.headerBottom + 8)) <= 4,
      `collapsed note without an edit: the collapsed row should sit just below the search controls ` +
      `(y≈${Math.round(collapsedLayout.headerBottom + 8)}), got y=${Math.round(collapsedLayout.noteTop)}`);
    });

    await check('drag a short note down', () => dragShortNoteDownCase(page));
    await check('drag a short note up', () => dragShortNoteUpCase(page));
    await check('drag under the search bar', () => dragUnderSearchBarCase(page));
    await check('drag a tall note down', () => dragTallNoteDownCase(page, longId));
    await check('drag sideways', () => dragSidewaysCase(page));

    // Sorted by content volume: typing changes the note's volume, so saving may
    // re-sort it; the caret's text still stays put.
    await setCollapsed(page, longId, false);
    await runPaletteCommand(page, 'Sort order: Content volume');
    await check('content-volume sort', () => caretVisibleCase(page, longId, 'content-volume sort'));
    await runPaletteCommand(page, 'Sort order: Normal');

    // Clicking another note while editing keeps the clicked text under the pointer.
    await check('click another note', async () => {
    await reload(page);
    await scrollParagraphTo(page, 'Long paragraph 1:', 200);
    await clickParagraph(page, 'Long paragraph 1:');
    await waitForEditing(page, longId);
    await scrollParagraphTo(page, 'Below 1 paragraph 1:', 400);
    const clickedBefore = await paragraphY(page, 'Below 1 paragraph 1:');
    await clickParagraph(page, 'Below 1 paragraph 1:');
    await waitForEditing(page, ids[11]);
    await waitForPageSettled(page);
    assertStayed('clicking another note while editing', clickedBefore, await paragraphY(page, 'Below 1 paragraph 1:'), null);
    await page.keyboard.press('Escape');
    await pause(500);
    });
    await check('late content', () => lateContentCase(page));
    await check('compact mermaid', () => compactMermaidCase(page, ids));
    await check('unmatched formatted text', () => unmatchedFormatCase(page, ids));
    await check('entering edit mode', () => enterEditCases(page, ids, longId));
    await check('formatted notes', () => formattedClickCases(page, ids));
    await check('new note at top', () => newNoteAtTopCase(page, ids));
    assert.deepEqual(failures, [], `exit-edit scroll failures:\n${failures.join('\n')}`);
  }, async () => {
    await waitForAppReady(page);
    await deleteFixture(page, ids);
    await reload(page);
  });
}
