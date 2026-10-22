import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';

// Edit tag relationships (app/services/agent/skills/help-ontology.md, "Relationship dialogs"), as reported on 2026-10-22:
// - with no focus tag the columns' + buttons are dimmed and say why, and pressing one
//   does nothing (it used to stop MetaList with a fatal error);
// - a condition's suggestions are tags linked to the focus tag first;
// - a paste into a condition goes in as copied (the dictation cleanup dropped tags not
//   used yet and broke /regexes/), and no tags are suggested inside or right after
//   "quoted text" or a /regex/;
// - "edit" finds the command in the palette (every word of a label finds it);
// - a condition of several parts shows one part per line, held together by a bracket,
//   so it reads as one condition; a long part wraps instead of being cut off.

const SETTLE_MS = 400;
// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
const FOCUS = 'zq-copy-paste';
// zq-ctrl-v is on 3 notes, all copy-paste; zq-keyboard on 5, 2 of them copy-paste;
// zq-journal on 8, none copy-paste, and the most used of these.
const NOTES = [
  ...Array.from({length: 3}, () => `${FOCUS} zq-ctrl-v`),
  ...Array.from({length: 2}, () => `${FOCUS} zq-keyboard`),
  ...Array.from({length: 3}, () => 'zq-keyboard'),
  ...Array.from({length: 8}, () => 'zq-journal'),
];
const ADD_BUTTONS = ['add-left', 'add-middle', 'add-right'];
const PASTED_CONDITION = 'zq-ctrl-v zq-not-used-yet "pasted text" /paste(d)?/';
// Their tags are on no note, so they change no suggestion order.
const GROUPED_PARTS = ['zq-shortcut-key', '"pasted text"', '/paste(d)?/',
  `"${'a long quoted part that must wrap onto more lines instead of being cut off '.repeat(2).trim()}"`];
const RULES = [`(${GROUPED_PARTS.join(' ')}) => ${FOCUS}`, `zq-clipboard-key => ${FOCUS}`];
// A desktop window, where the short parts fit on one line.
const WIDE_VIEWPORT = {width: 1440, height: 900};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await page.waitForNetworkIdle({idleTime: NETWORK_IDLE_MS});
  await pause(SETTLE_MS);
}

function fatalText(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById('fatal-error-overlay');
    return overlay ? overlay.textContent : '';
  });
}

async function createNotes(page) {
  return page.evaluate(async tagBars => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    for (const tags of tagBars) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, '<p>Tag relationships note</p>', tags);
      ids.push(note.id);
    }
    return ids;
  }, NOTES);
}

async function createRules(page) {
  return page.evaluate(async rules => {
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    const ids = [];
    for (const text of rules) {
      const response = await fetch('/api2/ontology/rules', {method: 'POST', headers: buildSessionHeaders(true), body: JSON.stringify({text})});
      if (!response.ok) throw new Error(`creating rule ${text} failed: ${response.status}`);
      ids.push((await response.json()).id);
    }
    return ids;
  }, RULES);
}

async function deleteRules(page, ruleIds) {
  await page.evaluate(async ids => {
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    for (const id of ids) {
      const response = await fetch(`/api2/ontology/rules/${id}`, {method: 'DELETE', headers: buildSessionHeaders(true)});
      if (!response.ok) throw new Error(`deleting rule ${id} failed: ${response.status}`);
    }
  }, ruleIds);
}

async function openEditor(page) {
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.openOntologyEditor();
  });
  await page.waitForSelector('#ontology-search-input', {visible: true});
  await idle(page);
}

function addButtonsDisabled(page) {
  return page.evaluate(actions => actions.map(action => document.querySelector(`[data-action="${action}"]`).disabled), ADD_BUTTONS);
}

async function noFocusCase(page) {
  assert.deepEqual(await addButtonsDisabled(page), [true, true, true], 'without a focus tag the + buttons are dimmed');
  const hints = await page.$$eval('#ontology-left-list .ontology-placeholder, #ontology-right-list .ontology-placeholder',
    nodes => nodes.map(node => node.textContent));
  assert.deepEqual(hints, ['Pick a focus tag first: search for one above', 'Pick a focus tag first: search for one above'],
    'the condition and implied columns say how to get a focus tag');
  await page.click('[data-action="add-left"]');
  await pause(SETTLE_MS);
  const dialogShown = await page.evaluate(() => {
    const input = document.querySelector('#ontology-dialog-input');
    return input !== null && input.offsetParent !== null;
  });
  assert.equal(dialogShown, false, 'pressing a dimmed + opens nothing');
  assert.equal(await fatalText(page), '', 'pressing a dimmed + is no error');
}

async function chooseFocus(page) {
  await page.type('#ontology-search-input', FOCUS);
  await idle(page);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('[data-action="add-left"]').disabled);
  await idle(page);
  assert.deepEqual(await addButtonsDisabled(page), [false, false, false], 'with a focus tag the + buttons act');
}

function conditionRowLayout(page) {
  return page.evaluate(() => {
    const box = element => {
      const rect = element.getBoundingClientRect();
      return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height};
    };
    const middle = element => {
      const rect = element.getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    const rows = [...document.querySelectorAll('#ontology-left-list .ontology-row')];
    const groupedRow = rows.find(row => row.querySelector('.ontology-atom-group') !== null);
    const singleRow = rows.find(row => row.querySelector('.ontology-atom-group') === null);
    const group = groupedRow.querySelector('.ontology-atom-group');
    const bracket = getComputedStyle(group, '::before');
    const parts = [...group.children];
    const singlePart = singleRow.querySelector('.ontology-atom');
    return {
      parts: parts.map(part => ({...box(part), text: part.textContent, clipped: part.scrollWidth > part.clientWidth})),
      group: box(group),
      bracket: {content: bracket.content, top: bracket.top, bottom: bracket.bottom, width: parseFloat(bracket.width),
        borders: [bracket.borderTopWidth, bracket.borderLeftWidth, bracket.borderBottomWidth, bracket.borderRightWidth]},
      groupedActions: box(groupedRow.querySelector('.ontology-row-actions')),
      groupedEditMiddle: middle(groupedRow.querySelector('.ontology-edit')),
      firstPartMiddle: middle(parts[0]),
      single: {parts: singleRow.querySelectorAll('.ontology-atom').length, height: box(singlePart).height,
        middle: middle(singlePart), editMiddle: middle(singleRow.querySelector('.ontology-edit'))},
    };
  });
}

async function groupedConditionCase(page) {
  const layout = await conditionRowLayout(page);
  const {parts, group, bracket, single} = layout;
  assert.equal(parts.length, GROUPED_PARTS.length, 'each part of the condition is its own line');
  const lineHeight = parts[0].height;
  for (const [index, part] of parts.entries()) {
    assert.equal(part.left, parts[0].left, `part ${index} starts where the first part starts`);
    assert.equal(part.clipped, false, `part ${index} is shown whole`);
    if (index > 0) assert.equal(part.top, parts[index - 1].bottom, `part ${index} is the line below part ${index - 1}`);
  }
  for (const index of [1, 2]) assert.equal(parts[index].height, lineHeight, `short part ${index} takes one line, as the tag does`);
  const longPart = parts[GROUPED_PARTS.length - 1];
  assert.ok(longPart.height >= 2 * lineHeight, `the long part wraps onto more lines: ${longPart.height}px for ${lineHeight}px lines`);
  assert.ok(longPart.right <= layout.groupedActions.left, 'the long part stops before the buttons');
  assert.equal(group.top, parts[0].top, 'the bracket starts at the first part');
  assert.equal(group.bottom, longPart.bottom, 'the bracket ends at the last part');
  assert.notEqual(bracket.content, 'none', 'the parts are held together by a bracket');
  assert.deepEqual([bracket.top, bracket.bottom], ['0px', '0px'], 'the bracket spans every part');
  assert.ok(group.left + bracket.width < parts[0].left, 'the bracket is left of the parts');
  assert.deepEqual(bracket.borders.map(width => parseFloat(width) > 0), [true, true, true, false], 'the bracket opens to the right: [');
  assert.equal(layout.groupedEditMiddle, layout.firstPartMiddle, 'the buttons are beside the first part');
  assert.equal(single.parts, 1, 'a one-part condition stays one part');
  assert.equal(single.editMiddle, single.middle, 'a one-part condition keeps its buttons beside it');
}

async function groupedPartFocusCase(page) {
  await page.click('#ontology-left-list .ontology-atom-group [data-tag="zq-shortcut-key"]');
  await page.waitForFunction(() => document.querySelector('#ontology-left-list .ontology-atom-group') === null);
  await idle(page);
  const focused = await page.$$eval('.ontology-focus .ontology-tag', nodes => nodes.map(node => node.textContent.trim()));
  assert.deepEqual(focused, ['zq-shortcut-key'], "clicking a part's tag makes it the focus tag");
}

async function relatedSuggestionsCase(page) {
  await page.click('[data-action="add-left"]');
  await page.waitForSelector('#ontology-dialog-input', {visible: true});
  await page.waitForSelector('.ontology-dialog-suggestion', {visible: true});
  await idle(page);
  const shown = await page.$$eval('.ontology-dialog-suggestion-label', nodes => nodes.map(node => node.textContent));
  const ours = shown.filter(tag => tag.startsWith('zq-'));
  assert.deepEqual(ours.slice(0, 2), ['zq-ctrl-v', 'zq-keyboard'],
    `a condition suggests the tags linked to ${FOCUS} first: ${JSON.stringify(shown)}`);
  assert.ok(!shown.includes(FOCUS), 'the focus tag is not suggested as its own condition');
  assert.ok(shown.indexOf('zq-ctrl-v') < shown.indexOf('zq-journal') || !shown.includes('zq-journal'),
    'a tag that is used more but never with the focus tag comes after the linked ones');
}

async function pasteAsCopiedCase(page) {
  const dictationRequests = [];
  const onRequest = request => {
    if (request.url().includes('/dictation-paste')) dictationRequests.push(request.url());
  };
  page.on('request', onRequest);
  const prevented = await page.evaluate(text => {
    const input = document.querySelector('#ontology-dialog-input');
    input.focus();
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const event = new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true});
    input.dispatchEvent(event);
    return event.defaultPrevented;
  }, PASTED_CONDITION);
  await idle(page);
  page.off('request', onRequest);
  assert.equal(prevented, false, 'a paste into a condition is left to the browser: it goes in as copied');
  assert.deepEqual(dictationRequests, [], 'a paste into a condition is not sent to the dictation cleanup');
  // As the browser leaves it: the pasted text, the caret after the regex. A regex is no
  // tag, so nothing is asked for (it used to ask for tags starting with "?/").
  const tagRequests = [];
  const onTags = request => {
    if (request.url().includes('/ontology/tags')) tagRequests.push(request.url());
  };
  page.on('request', onTags);
  await page.evaluate(text => {
    const input = document.querySelector('#ontology-dialog-input');
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  }, PASTED_CONDITION);
  await idle(page);
  page.off('request', onTags);
  assert.deepEqual(tagRequests, [], 'with the caret after a regex no tags are suggested');
  assert.equal(await fatalText(page), '', 'the pasted condition causes no error');
  await page.click('[data-action="dialog-cancel"]');
  await idle(page);
}

async function paletteEditCase(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const modal = document.getElementById('ontology-modal');
    return modal === null || modal.style.display === 'none';
  });
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.open();
  });
  await page.waitForSelector('#command-palette-input', {visible: true});
  await page.type('#command-palette-input', 'edit');
  await page.waitForSelector('#command-palette-results [data-endpoint-id="action.edit_tag_relationships"]', {visible: true});
  await page.keyboard.press('Escape');
  await idle(page);
}

export async function checkTagRelationships(page) {
  const viewport = page.viewport();
  const ids = await createNotes(page);
  const ruleIds = await createRules(page);
  await runThenCleanUp('tag relationships', async () => {
    await page.setViewport(WIDE_VIEWPORT);
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await idle(page);
    await openEditor(page);
    // Every case runs, and their assertion failures are reported together.
    const failures = [];
    for (const [label, run] of [['no focus tag', noFocusCase], ['choose a focus tag', chooseFocus],
      ['condition of several parts', groupedConditionCase], ['related suggestions', relatedSuggestionsCase],
      ['paste as copied', pasteAsCopiedCase], ["a part's tag focuses it", groupedPartFocusCase],
      ['palette finds "edit"', paletteEditCase]]) {
      try {
        await run(page);
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        failures.push(`${label}: ${error.message}`);
      }
    }
    assert.equal(await fatalText(page), '', 'no fatal error');
    if (failures.length > 0) throw new assert.AssertionError({message: failures.join('\n')});
  }, async () => {
    await page.setViewport(viewport);
    await deleteRules(page, ruleIds);
    await page.evaluate(async ids => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      for (const id of ids) await NotesAPI.deleteNote(id);
    }, ids);
  });
}
