import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Super tags (docs/design/tag-properties.md): tags with values, as a user meets them.
// The search box suggests property names after a tag's colon, searches compare values
// (through implications, with MAX), the tag bar suggests names and saves a super tag
// whole, and a rule over values tags the notes it holds for and shows in the left
// column of Edit Tag Relationships. Each case reports its own failure.

// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;
const NOTES = [
  ['Short run', 'jogging:miles=3'],
  ['Long run', 'jogging:miles=12'],
  ['Bike ride', 'cycling:miles=20'],
  ['Pills', 'drug:dosage=10mg'],
  ['Super tag bar note', 'fruit'],
];
const RULES = ['jogging => exercise', 'cycling => exercise', 'jogging:miles>10 => long-run'];

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
}

async function createFixture(page) {
  return page.evaluate(async (notes, rules) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    const noteIds = [];
    for (const [content, tags] of notes) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, `<p>${content}</p>`, tags);
      noteIds.push(note.id);
    }
    const ruleIds = [];
    for (const text of rules) {
      const response = await fetch('/api2/ontology/rules', {
        method: 'POST', headers: buildSessionHeaders(true), body: JSON.stringify({text}),
      });
      ruleIds.push((await response.json()).id);
    }
    return {noteIds, ruleIds};
  }, NOTES, RULES);
}

// The search box holds `text` (typed by the keyboard), and the view has settled.
async function search(page, text) {
  await page.click('#search-input', {clickCount: 3});
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
  await idle(page);
}

function shownNoteTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('#notes-container [data-note-id]')]
    .filter(note => !note.parentElement.closest('[data-note-id]'))
    .map(note => note.querySelector('.note-content').textContent.trim())
    .sort());
}

function suggestionLabels(page, selector) {
  return page.evaluate(selector => [...document.querySelectorAll(selector)]
    .filter(item => item.offsetParent !== null)
    .map(item => item.textContent.trim()), selector);
}

async function searchSuggestsPropertiesThenCompares(page) {
  await search(page, 'exercise:');
  await page.waitForFunction(() => document.querySelectorAll('.search-suggestion').length > 0);
  assert.deepEqual(await suggestionLabels(page, '.search-suggestion'), ['miles'],
    'after exercise: the box suggests miles, used with jogging and cycling');
  await page.keyboard.press('Enter');
  await page.keyboard.type('>5');
  await idle(page);
  assert.equal(await page.$eval('#search-input', input => input.value), 'exercise:miles>5');
  assert.deepEqual(await shownNoteTexts(page), ['Bike ride', 'Long run'], 'upward: runs and rides over 5 miles');
}

async function maxKeepsTheLargest(page) {
  await search(page, 'jogging:miles=MAX');
  assert.deepEqual(await shownNoteTexts(page), ['Long run'], 'the longest run');
  await search(page, 'drug:dosage>5mg');
  assert.deepEqual(await shownNoteTexts(page), ['Pills'], 'a value with a unit');
}

async function aRuleTagsTheNotesItHoldsFor(page) {
  await search(page, 'long-run');
  assert.deepEqual(await shownNoteTexts(page), ['Long run'], 'jogging:miles>10 => long-run');
}

async function theTagBarSuggestsAndSavesASuperTag(page) {
  await search(page, 'fruit');
  await page.click('#notes-container [data-note-id] .note-content');
  await idle(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('End');
  await page.keyboard.type(' jogging:');
  await page.waitForFunction(() => [...document.querySelectorAll('.note-tag-suggestion')].some(item => item.offsetParent !== null));
  assert.deepEqual(await suggestionLabels(page, '.note-tag-suggestion'), ['miles='], 'the tag bar suggests miles=');
  await page.keyboard.press('Enter');
  await page.keyboard.type('7');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await idle(page);
  await search(page, 'jogging:miles<10');
  assert.deepEqual(await shownNoteTexts(page), ['Short run', 'Super tag bar note'], 'the tag bar saved jogging:miles=7');
}

async function theRuleShowsInItsTagsLeftColumn(page) {
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.openOntologyEditor();
  });
  await page.waitForSelector('#ontology-search-input', {visible: true});
  await page.click('#ontology-search-input');
  await page.keyboard.type('long-run');
  await idle(page);
  await page.keyboard.press('Enter');
  await idle(page);
  const left = await page.evaluate(() => [...document.querySelectorAll('.ontology-atom-value')].map(atom => atom.textContent.trim()));
  assert.deepEqual(left, ['jogging:miles>10'], "the rule is in long-run's left column");
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const modal = document.getElementById('ontology-modal');
    return modal === null || modal.style.display === 'none';
  });
}

export async function checkSuperTags(page) {
  const fixture = await createFixture(page);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await runThenCleanUp('super tags', async () => {
    const failures = [];
    for (const [label, run] of [
      ['search suggestions and a comparison', searchSuggestsPropertiesThenCompares],
      ['MAX and units', maxKeepsTheLargest],
      ['a rule over values', aRuleTagsTheNotesItHoldsFor],
      ['the tag bar', theTagBarSuggestsAndSavesASuperTag],
      ['Edit Tag Relationships', theRuleShowsInItsTagsLeftColumn],
    ]) {
      try {
        await run(page);
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        failures.push(`${label}: ${error.message}`);
      }
    }
    if (failures.length > 0) throw new assert.AssertionError({message: failures.join('\n')});
  }, async () => {
    await page.keyboard.press('Escape');
    await search(page, '');
    await page.evaluate(async ({noteIds, ruleIds}) => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
      for (const id of ruleIds) {
        await fetch(`/api2/ontology/rules/${id}`, {method: 'DELETE', headers: buildSessionHeaders(true)});
      }
      for (const id of noteIds) await NotesAPI.deleteNote(id);
    }, fixture);
  });
}
