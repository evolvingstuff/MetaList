import assert from 'node:assert/strict';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;

// Suggest Tags with AI (docs/ui/tag-bar.md, docs/ui/interaction-principles.md):
// the edited note's right-click menu, and a right-click past the tags in its
// tag bar, offer it only when an AI is set up and the privacy settings let the
// AI see the note as edited (unsaved tags included), and not while a request
// for the note runs. Choosing it keeps the edit, the caret and the text (or
// the tag bar's focus and caret). "Asking the AI…" floats on a card above the
// tag bar and never takes space in the note; the note's top and the page stay
// put and typing goes on. The proposals then appear under the tag bar, tags
// already in use first and new tags (with a "new" badge) on the right. Nothing
// new says so on the card until the next key or click; a failure shows a
// banner; leaving edit mode while it asks still adds the proposals, counted by
// the robot. When the tag bar floats at the window's bottom (a long note) the
// proposals float under it. Right-click never shows the browser's own menu.
// The AI's answer is stubbed: no request reaches a provider.

const SETTLE_MS = 400;
const ITEM = 'Suggest Tags with AI';
const TEST_KEY = 'sk-test-0123456789abcdefghijklmnop';
const PRIVATE_TAG = 'zorb-private';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
}

const LONG_TEXT = Array.from({length: 60}, (_, index) => `<p>Line ${index + 1} of a long note about Kyoto.</p>`).join('');

// Top to bottom: one note per case, notes giving "kyoto" its use, then filler.
async function createFixture(page) {
  const specs = [
    {html: '<p>Temples in Kyoto and a ryokan near Gion.</p>', tags: 'travel'},
    {html: '<p>Kyoto again, already tagged.</p>', tags: 'kyoto'},
    {html: '<p>A note the AI fails on.</p>', tags: ''},
    {html: '<p>A note left while the AI works.</p>', tags: ''},
    {html: '<p>A private-looking note.</p>', tags: ''},
    {html: '<p>Tagged from the tag bar.</p>', tags: 'travel'},
    {html: LONG_TEXT, tags: 'travel'},
    {html: '<p>Accepted from the note menu.</p>', tags: 'travel'},
    {html: '<p>Accepted after using the tag bar.</p>', tags: 'travel'},
    {html: '<p>Gion in the evening.</p>', tags: 'kyoto japan'},
    ...Array.from({length: 6}, (_, index) => ({html: `<p>Filler ${index + 1}.</p>`, tags: ''})),
  ];
  const ids = await page.evaluate(async specs => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    // createNote(null, '') inserts at the top, so create bottom-up.
    for (const spec of [...specs].reverse()) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, spec.html, spec.tags);
      ids.unshift(note.id);
    }
    return ids;
  }, specs);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  return {trip: ids[0], tagged: ids[1], failing: ids[2], leaving: ids[3], privateNote: ids[4],
    fromTagBar: ids[5], long: ids[6], acceptFromMenu: ids[7], acceptFromTagBar: ids[8], all: ids};
}

async function deleteFixture(page, ids) {
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of ids) await NotesAPI.deleteNote(id);
  }, ids);
}

// The suggestion request streams the lines the test sends, until it ends it.
async function stubSuggestionRequests(page) {
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    window.aiNoteTagTest = {requests: [], stream: null, originalFetch};
    window.fetch = async (url, options) => {
      const path = new URL(url, location.href).pathname;
      const match = /^\/api2\/ai\/notes\/([^/]+)\/tag-suggestions$/.exec(path);
      if (match) {
        window.aiNoteTagTest.requests.push({path, noteId: match[1], body: JSON.parse(options.body)});
        const body = new ReadableStream({start(controller) { window.aiNoteTagTest.stream = controller; }});
        return new Response(body, {headers: {'Content-Type': 'application/x-ndjson'}});
      }
      return originalFetch(url, options);
    };
  });
}

// One line of the stream; {type: 'tags', tags} is shorthand for proposals for the asking note.
async function sendSuggestionLine(page, line) {
  await page.waitForFunction(() => window.aiNoteTagTest.stream !== null);
  await page.evaluate(line => {
    const test = window.aiNoteTagTest;
    let event = line;
    if (line.type === 'tags') {
      const noteId = test.requests.at(-1).noteId;
      event = {type: 'proposals', proposals: line.tags.length > 0 ? {[noteId]: line.tags} : {}};
    }
    test.stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
  }, line);
  await pause(SETTLE_MS);
}

async function answerSuggestionRequest(page, line) {
  await sendSuggestionLine(page, line);
  await page.evaluate(() => {
    window.aiNoteTagTest.stream.close();
    window.aiNoteTagTest.stream = null;
  });
  await pause(SETTLE_MS);
  await idle(page);
}

function screenState(page, noteId) {
  return page.evaluate(async noteId => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const note = document.querySelector(`.note[data-note-id="${noteId}"]`);
    const row = note.querySelector(':scope > .note-tag-proposals');
    const tagBar = note.querySelector(':scope > .note-tag-bar');
    const input = tagBar === null ? null : tagBar.querySelector('.note-tag-bar-input');
    const card = tagBar === null ? null : tagBar.querySelector(':scope > .note-tag-bar-ai-status');
    const selection = window.getSelection();
    const indicator = note.querySelector(':scope > .note-proposal-indicator');
    const banner = document.querySelector('#error-banner .error-banner-message');
    const rect = element => {
      const box = element.getBoundingClientRect();
      return {top: box.top, bottom: box.bottom, height: box.height};
    };
    return {
      editingNoteId: mode.isEditing ? mode.currentNoteId : null,
      noteTop: note.getBoundingClientRect().top,
      noteBottom: note.getBoundingClientRect().bottom,
      scrollY: window.scrollY,
      windowHeight: window.innerHeight,
      text: note.querySelector(':scope > .note-content').textContent,
      caret: (() => {
        // Where the caret is in the note's text (a save may rebuild the text's
        // nodes, so not which node it is in), and whether it is collapsed.
        if (selection.rangeCount === 0) return null;
        const content = note.querySelector(':scope > .note-content');
        const range = selection.getRangeAt(0);
        if (!content.contains(range.startContainer)) return 'outside the note';
        const before = document.createRange();
        before.setStart(content, 0);
        before.setEnd(range.startContainer, range.startOffset);
        return {offset: before.toString().length, isCollapsed: range.collapsed};
      })(),
      tagBar: tagBar === null ? null : {
        ...rect(tagBar), value: input.value, caret: [input.selectionStart, input.selectionEnd],
        isFocused: document.activeElement === input,
      },
      card: card === null ? null : card.textContent,
      cardIsAboveTagBar: card === null ? null : card.getBoundingClientRect().bottom <= tagBar.getBoundingClientRect().top,
      rowBox: row === null ? null : rect(row),
      row: row === null ? null : [...row.children].map(part => {
        const badge = part.querySelector('.note-tag-proposal-new');
        return badge === null ? part.querySelector('.note-tag-proposal-label').textContent
          : `${part.querySelector('.note-tag-proposal-label').textContent} [new]`;
      }),
      robot: indicator === null ? null : indicator.textContent,
      banner: banner === null ? null : banner.textContent,
    };
  }, noteId);
}

async function startEditing(page, noteId) {
  await page.click(`[data-note-id="${noteId}"] > .note-content`);
  await page.waitForSelector(`.note.editing[data-note-id="${noteId}"] .note-tag-bar-input`);
  await idle(page);
}

async function leaveEditing(page) {
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  await idle(page);
  assert.equal(await page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.isEditing;
  }), false, 'could not leave edit mode');
}

function menuLabels(page) {
  return page.$$eval('.context-menu.is-visible:not(.context-menu-submenu) .context-menu-item-label',
    labels => labels.map(label => label.textContent));
}

// Right-click the edited note's text and read the menu's item labels.
async function openNoteMenu(page, noteId) {
  const box = await (await page.$(`[data-note-id="${noteId}"] > .note-content`)).boundingBox();
  await page.mouse.click(box.x + box.width - 20, box.y + Math.min(box.height / 2, 12), {button: 'right'});
  await page.waitForSelector('.context-menu.is-visible', {timeout: 5_000});
  await pause(SETTLE_MS);
  return menuLabels(page);
}

// Right-click in the edited note's tag bar, near its right end (past the tags).
async function rightClickTagBarEnd(page, noteId) {
  const box = await (await page.$(`.note.editing[data-note-id="${noteId}"] .note-tag-bar-input`)).boundingBox();
  await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2, {button: 'right'});
  await pause(SETTLE_MS);
  await idle(page);
}

async function placeCaretAtTextEnd(page, noteId) {
  await page.evaluate(id => {
    const content = document.querySelector(`[data-note-id="${id}"] > .note-content`);
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }, noteId);
}

async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  assert.equal(await page.$('.context-menu.is-visible'), null, 'Escape closes the menu');
}

// Suggest Tags with AI; for a note with children, then the submenu's entry `choice`.
async function chooseItem(page, choice) {
  const items = await page.$$('.context-menu.is-visible:not(.context-menu-submenu) .context-menu-item');
  for (const item of items) {
    if (await item.$eval('.context-menu-item-label', label => label.textContent) === ITEM) {
      assert.equal(await item.$eval('.context-menu-item-icon', icon => icon.textContent), '🤖', 'the robot icon');
      await item.click();
      await pause(SETTLE_MS);
      if (choice !== undefined) {
        const entries = await page.$$('.context-menu-submenu.is-visible .context-menu-item');
        const labels = [];
        for (const entry of entries) labels.push(await entry.$eval('.context-menu-item-label', label => label.textContent));
        assert.deepEqual(labels, ['This Note', 'This Note and Its Children'], 'a note with children: a submenu');
        await entries[labels.indexOf(choice)].click();
        await pause(SETTLE_MS);
      }
      return;
    }
  }
  throw new Error(`${ITEM} is not in the menu`);
}

async function setTestKey(page, isSet) {
  await page.evaluate(async ({isSet, key}) => {
    const api = await import('/static/js/modules/ai-chat/ai-chat-api.js');
    if (isSet) await api.saveOpenAiCredential(key);
    else await api.clearOpenAiCredential();
  }, {isSet, key: TEST_KEY});
}

async function setPrivacyBlacklist(page, tags) {
  await page.evaluate(async tags => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.applyPreference('pref.ai.cloud_privacy_policy', JSON.stringify({
      blacklist_phrases: [], blacklist_tags: tags, whitelist_phrases: [], whitelist_tags: [],
    }));
  }, tags);
}

async function typeInTagBar(page, text) {
  await page.click('.note.editing .note-tag-bar-input');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await page.keyboard.type(text);
  await pause(SETTLE_MS);
}

// Records, after every handler, whether the browser's own menu was prevented.
async function watchBrowserMenu(page) {
  await page.evaluate(() => {
    window.browserMenuTest = {shown: []};
    window.addEventListener('contextmenu', event => {
      if (!event.defaultPrevented) window.browserMenuTest.shown.push(event.target.className);
    });
  });
}

async function noKeyCase(page, ids) {
  await startEditing(page, ids.trip);
  const labels = await openNoteMenu(page, ids.trip);
  assert(labels.includes('Remove Formatting'), `the edited note's menu opens: ${JSON.stringify(labels)}`);
  assert(!labels.includes(ITEM), 'no AI set up: the item is hidden');
  await closeMenu(page);
  // Past the tags with no AI: nothing opens, and not the browser's menu either.
  await rightClickTagBarEnd(page, ids.trip);
  assert.equal(await page.$('.context-menu.is-visible'), null, 'no AI: nothing opens in the tag bar');
  await leaveEditing(page);
}

async function privacyCase(page, ids) {
  await setPrivacyBlacklist(page, [PRIVATE_TAG]);
  await startEditing(page, ids.privateNote);
  assert((await openNoteMenu(page, ids.privateNote)).includes(ITEM), 'an AI is set up and may see the note');
  await closeMenu(page);
  // Typed in the tag bar, not saved: the AI may no longer see the note.
  await typeInTagBar(page, PRIVATE_TAG);
  assert(!(await openNoteMenu(page, ids.privateNote)).includes(ITEM), 'a blacklisted tag typed in the tag bar hides the item');
  await closeMenu(page);
  await rightClickTagBarEnd(page, ids.privateNote);
  assert.equal(await page.$('.context-menu.is-visible'), null, 'hidden from the AI: nothing opens in the tag bar');
  // Clear the tag bar itself (the note menu's right-click moved focus to the text).
  await page.$eval('.note.editing .note-tag-bar-input', input => { input.focus(); input.select(); });
  await page.keyboard.press('Backspace');
  await pause(SETTLE_MS);
  assert.equal(await page.$eval('.note.editing .note-tag-bar-input', input => input.value.trim()), '');
  assert((await openNoteMenu(page, ids.privateNote)).includes(ITEM), 'removing the tag brings it back');
  await closeMenu(page);
  await leaveEditing(page);
  await setPrivacyBlacklist(page, []);
}

async function suggestCase(page, ids) {
  await startEditing(page, ids.trip);
  await openNoteMenu(page, ids.trip);
  const before = await screenState(page, ids.trip);
  assert.equal(before.row, null, 'the note has no proposals yet');
  await chooseItem(page);

  const asking = await screenState(page, ids.trip);
  assert.equal(asking.card, 'Asking the AI…', 'the status floats on a card');
  assert.equal(asking.cardIsAboveTagBar, true, 'above the tag bar');
  assert.equal(asking.row, null, 'nothing is written into the note');
  assert.equal(asking.tagBar.bottom, before.tagBar.bottom, 'the tag bar does not move');
  assert.equal(asking.noteBottom, before.noteBottom, 'the note does not grow');
  assert.equal(asking.editingNoteId, ids.trip, 'still editing');
  assert.equal(asking.noteTop, before.noteTop, "the note's top stays put");
  assert.equal(asking.scrollY, before.scrollY, 'nothing scrolls');
  assert.deepEqual(asking.caret, before.caret, 'the caret stays');
  const [request] = await page.evaluate(() => window.aiNoteTagTest.requests);
  assert.equal(request.path, `/api2/ai/notes/${ids.trip}/tag-suggestions`);
  assert.deepEqual(Object.keys(request.body).sort(),
    ['include_children', 'is_untagged_view', 'model', 'provider', 'search', 'tab_id', 'thinking_level']);
  assert.equal(request.body.include_children, false);

  // While it asks: the item is hidden, and typing goes on.
  assert(!(await openNoteMenu(page, ids.trip)).includes(ITEM), 'hidden while a request for the note runs');
  await closeMenu(page);
  await placeCaretAtTextEnd(page, ids.trip);
  await page.keyboard.type(' Zen gardens.');
  const typed = await screenState(page, ids.trip);
  assert(typed.text.endsWith('Zen gardens.'), `typing goes on: ${typed.text}`);
  assert.equal(typed.card, 'Asking the AI…', 'typing keeps the card while it asks');

  await answerSuggestionRequest(page, {type: 'tags', tags: ['zen-gardens', 'kyoto', 'temples']});
  const after = await screenState(page, ids.trip);
  assert.deepEqual(after.row, ['kyoto', 'zen-gardens [new]', 'temples [new]'], 'in-use tags first, new ones on the right');
  assert.equal(after.card, null, 'the card goes');
  assert.equal(after.editingNoteId, ids.trip, 'still editing');
  assert.equal(after.noteTop, before.noteTop, "the note's top stays put");
  assert.equal(after.scrollY, before.scrollY, 'nothing scrolls');
  assert.equal(after.text, typed.text, 'the typed text stays');
  assert.deepEqual(after.caret, typed.caret, 'the caret stays');
  assert.equal(after.banner, null);
  await leaveEditing(page);
}

async function nothingNewCase(page, ids) {
  await startEditing(page, ids.tagged);
  await openNoteMenu(page, ids.tagged);
  const before = await screenState(page, ids.tagged);
  await chooseItem(page);
  await answerSuggestionRequest(page, {type: 'tags', tags: ['Kyoto']});
  const after = await screenState(page, ids.tagged);
  assert.equal(after.card, 'No new tags to suggest', 'says it had nothing new');
  assert.equal(after.row, null);
  assert.equal(after.noteTop, before.noteTop, "the note's top stays put");
  assert.equal(after.scrollY, before.scrollY, 'nothing scrolls');
  await page.keyboard.press('Shift');
  assert.equal((await screenState(page, ids.tagged)).card, 'No new tags to suggest', 'a bare Shift keeps it');
  await page.keyboard.press('End');
  assert.equal((await screenState(page, ids.tagged)).card, null, 'the next key dismisses it');
  assert.equal((await screenState(page, ids.tagged)).editingNoteId, ids.tagged, 'and editing goes on');
  await leaveEditing(page);
}

async function failureCase(page, ids) {
  await startEditing(page, ids.failing);
  await openNoteMenu(page, ids.failing);
  const before = await screenState(page, ids.failing);
  await chooseItem(page);
  await answerSuggestionRequest(page, {type: 'failed', message: 'OpenAI API request failed: connection reset'});
  const after = await screenState(page, ids.failing);
  assert.equal(after.banner, "The AI couldn't suggest tags: OpenAI API request failed: connection reset", 'a banner says why');
  assert.equal(after.card, null, 'the card goes');
  assert.equal(after.row, null);
  assert.equal(after.editingNoteId, ids.failing, 'still editing');
  assert.equal(after.noteTop, before.noteTop, "the note's top stays put");
  await leaveEditing(page);
}

async function leaveWhileAskingCase(page, ids) {
  await startEditing(page, ids.leaving);
  await openNoteMenu(page, ids.leaving);
  await chooseItem(page);
  await leaveEditing(page);
  const left = await screenState(page, ids.leaving);
  assert.equal(left.card, null, 'the card goes with the tag bar');
  await answerSuggestionRequest(page, {type: 'tags', tags: ['kyoto', 'notes-left']});
  const after = await screenState(page, ids.leaving);
  assert.equal(after.editingNoteId, null, 'not editing again');
  assert.equal(after.robot, '🤖 2', 'the proposals were added and counted');
  assert.equal(after.scrollY, left.scrollY, 'nothing scrolls');
  assert.equal(after.noteTop, left.noteTop, 'the note stays put');
  await startEditing(page, ids.leaving);
  assert.deepEqual((await screenState(page, ids.leaving)).row, ['kyoto', 'notes-left [new]']);
  await leaveEditing(page);
}

function savedTags(page, noteId) {
  return page.$eval(`.note[data-note-id="${noteId}"]`, note => note.dataset.noteTags);
}

async function acceptFromNoteMenuCase(page, ids) {
  await startEditing(page, ids.acceptFromMenu);
  await openNoteMenu(page, ids.acceptFromMenu);
  await chooseItem(page);
  await answerSuggestionRequest(page, {type: 'tags', tags: ['kyoto', 'menu-accepted']});
  assert.deepEqual((await screenState(page, ids.acceptFromMenu)).row, ['kyoto', 'menu-accepted [new]']);
  // Typed in the text first: + saves it (this once failed: the save was never imported).
  await placeCaretAtTextEnd(page, ids.acceptFromMenu);
  await page.keyboard.type(' More text.');
  const typed = await screenState(page, ids.acceptFromMenu);
  await acceptSuggestionKeepingEdit(page, ids.acceptFromMenu, 'kyoto', typed, ['menu-accepted [new]']);
}

// remaining: the proposals left in the row once the tag is accepted.
async function acceptSuggestionKeepingEdit(page, noteId, tag, typed, remaining) {
  await page.click(`.note.editing[data-note-id="${noteId}"] .note-tag-proposal-accept[data-proposal="${tag}"]`);
  await pause(SETTLE_MS);
  await idle(page);
  const accepted = await screenState(page, noteId);
  assert(accepted.tagBar.value.split(/\s+/u).includes(tag), `+ puts ${tag} in the tag bar: ${JSON.stringify(accepted.tagBar.value)}`);
  assert.deepEqual(accepted.row, remaining, `${tag} leaves the proposals and the others stay`);
  assert.equal(accepted.text, typed.text, 'the typed text stays');
  assert.deepEqual(accepted.caret, typed.caret, 'the caret stays');
  await leaveEditing(page);
  assert((await savedTags(page, noteId)).split(/\s+/u).includes(tag), `${tag} stays on the note after editing`);
}

// A click in the tag bar leaves a trailing space, and tags typed there are saved
// before the AI is asked: neither may stop + from showing the accepted tag. In
// the tag bar, + puts the caret right after the new (last) tag, scrolled into
// view when the tags are wider than the bar.
const TYPED_TAGS = 'typed-tag alpha-long-tag-name beta-long-tag-name gamma-long-tag-name delta-long-tag-name epsilon-long-tag-name';

async function acceptFromTagBarCase(page, ids) {
  const inputSelector = `.note.editing[data-note-id="${ids.acceptFromTagBar}"] .note-tag-bar-input`;
  await startEditing(page, ids.acceptFromTagBar);
  await page.click(inputSelector);
  await pause(SETTLE_MS);
  await rightClickTagBarEnd(page, ids.acceptFromTagBar);
  await chooseItem(page);
  // While the AI works: tags typed in the tag bar, wider than the bar.
  await page.keyboard.press('End');
  await page.keyboard.type(TYPED_TAGS);
  await pause(SETTLE_MS);
  // Back to the start, so the caret moving is the change under test.
  await page.keyboard.press('Home');
  assert.equal(await page.$eval(inputSelector, input => input.scrollWidth > input.clientWidth), true, 'the tags are wider than the bar');
  await answerSuggestionRequest(page, {type: 'tags', tags: ['kyoto', 'bar-accepted']});
  assert.deepEqual((await screenState(page, ids.acceptFromTagBar)).row, ['kyoto', 'bar-accepted [new]']);
  await page.click(`${inputSelector.replace(' .note-tag-bar-input', '')} .note-tag-proposal-accept[data-proposal="bar-accepted"]`);
  await pause(SETTLE_MS);
  await idle(page);
  const accepted = await page.$eval(inputSelector, input => ({
    value: input.value, caret: [input.selectionStart, input.selectionEnd], isFocused: document.activeElement === input,
    showsEnd: input.scrollLeft + input.clientWidth >= input.scrollWidth - 1,
  }));
  assert.equal(accepted.value.trimEnd(), `travel ${TYPED_TAGS} bar-accepted`, '+ adds the tag at the end');
  const end = accepted.value.trimEnd().length;
  assert.deepEqual(accepted.caret, [end, end], 'the caret goes right after the new tag');
  assert.equal(accepted.isFocused, true, 'the tag bar keeps focus');
  assert.equal(accepted.showsEnd, true, 'the end of the tag bar is in view');
  await leaveEditing(page);
  assert.equal(await savedTags(page, ids.acceptFromTagBar), `travel ${TYPED_TAGS} bar-accepted`, 'the typed tags stay too');
}

// With its children: progress on the card, proposals on each note, one undo step.
async function withChildrenCase(page) {
  const family = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const parent = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(parent.id, '<p>Kyoto itinerary</p>', 'travel');
    const first = await NotesAPI.createChild(parent.id, '');
    await NotesAPI.saveNote(first.id, '<p>Temples on day one</p>', '');
    const second = await NotesAPI.createSibling(first.id, '');
    await NotesAPI.saveNote(second.id, '<p>Ramen on day two</p>', '');
    return {parent: parent.id, first: first.id, second: second.id};
  });
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  await stubSuggestionRequests(page);
  await startEditing(page, family.parent);
  await openNoteMenu(page, family.parent);
  const before = await screenState(page, family.parent);
  await chooseItem(page, 'This Note and Its Children');
  const [request] = (await page.evaluate(() => window.aiNoteTagTest.requests)).slice(-1);
  assert.equal(request.body.include_children, true);

  await sendSuggestionLine(page, {type: 'progress', completed: 0, total: 2});
  assert.equal((await screenState(page, family.parent)).card, 'Asking the AI… 1 of 2');
  await sendSuggestionLine(page, {type: 'progress', completed: 1, total: 2});
  assert.equal((await screenState(page, family.parent)).card, 'Asking the AI… 2 of 2');
  await sendSuggestionLine(page, {type: 'progress', completed: 2, total: 2});
  await answerSuggestionRequest(page, {type: 'proposals', proposals: {
    [family.parent]: ['kyoto'], [family.first]: ['temples', 'kyoto'], [family.second]: ['ramen'],
  }});
  const after = await screenState(page, family.parent);
  assert.deepEqual(after.row, ['kyoto'], "the edited note's own proposals under its tag bar");
  assert.equal(after.card, null);
  assert.equal(after.noteTop, before.noteTop, 'the note stays put');
  assert.equal(after.scrollY, before.scrollY, 'nothing scrolls');
  assert.equal((await screenState(page, family.first)).robot, '🤖 2', 'children show their robots');
  assert.equal((await screenState(page, family.second)).robot, '🤖 1');
  await leaveEditing(page);

  // One undo (⌘Z outside edit mode) takes them all back.
  await page.keyboard.down('Meta');
  await page.keyboard.press('z');
  await page.keyboard.up('Meta');
  await pause(SETTLE_MS);
  await idle(page);
  for (const id of [family.parent, family.first, family.second]) {
    assert.equal((await screenState(page, id)).robot, null, 'one undo removes every added proposal');
  }
  await page.evaluate(async id => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.deleteNote(id);
  }, family.parent);
}

async function tagBarCase(page, ids) {
  const inputSelector = `.note.editing[data-note-id="${ids.fromTagBar}"] .note-tag-bar-input`;
  await startEditing(page, ids.fromTagBar);
  await page.$eval(inputSelector, input => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  await pause(SETTLE_MS);

  // On a tag's letters: its own menu, as before.
  const tagPoint = await page.$eval(inputSelector, input => {
    const style = getComputedStyle(input);
    const box = input.getBoundingClientRect();
    return {x: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) + 8, y: box.top + box.height / 2};
  });
  await page.mouse.click(tagPoint.x, tagPoint.y, {button: 'right'});
  await page.waitForSelector('.context-menu.is-visible', {timeout: 5_000});
  await pause(SETTLE_MS);
  assert.deepEqual(await menuLabels(page), ['Edit Tag Relationships'], "a tag's letters open its tag menu");
  await closeMenu(page);

  // Past the tags: the tag bar's menu, and the tag bar stays as it was.
  await page.$eval(inputSelector, input => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  await pause(SETTLE_MS);
  const ready = await screenState(page, ids.fromTagBar);
  assert.equal(ready.tagBar.isFocused, true);
  await rightClickTagBarEnd(page, ids.fromTagBar);
  assert.deepEqual(await menuLabels(page), [ITEM], 'past the tags: Suggest Tags with AI');
  const menuOpen = await screenState(page, ids.fromTagBar);
  assert.deepEqual(menuOpen.tagBar, ready.tagBar, 'the tag bar keeps its text, caret and focus');
  await closeMenu(page);
  const closed = await screenState(page, ids.fromTagBar);
  assert.deepEqual(closed.tagBar, ready.tagBar, 'Escape closes only the menu');
  assert.equal(closed.editingNoteId, ids.fromTagBar);

  await rightClickTagBarEnd(page, ids.fromTagBar);
  await chooseItem(page);
  const asking = await screenState(page, ids.fromTagBar);
  assert.equal(asking.card, 'Asking the AI…');
  assert.deepEqual(asking.tagBar, ready.tagBar, 'choosing it keeps the tag bar as it was');
  await page.keyboard.type(' gion');
  await answerSuggestionRequest(page, {type: 'tags', tags: ['kyoto']});
  const after = await screenState(page, ids.fromTagBar);
  assert.deepEqual(after.row, ['kyoto']);
  assert.equal(after.tagBar.isFocused, true, 'the tag bar keeps focus');
  assert(after.tagBar.value.trimEnd().endsWith('gion'), `typing in the tag bar goes on: ${after.tagBar.value}`);
  await leaveEditing(page);
}

// Distances in CSS pixels to the hundredth: Firefox lays out in 1/60 px, so an
// exact 15 can read 14.99998. A real misplacement is whole pixels.
const px = value => Math.round(value * 100) / 100;

// The proposals float under the tag bar while it floats at the window's bottom.
async function floatingCase(page, ids) {
  // Into the long note near its top, so its end (and tag bar) lie far below the window.
  await page.evaluate(id => document.querySelector(`[data-note-id="${id}"]`).scrollIntoView({block: 'center'}), ids.long);
  await pause(SETTLE_MS);
  await page.evaluate(id => window.scrollBy(0, document.querySelector(`[data-note-id="${id}"]`).getBoundingClientRect().top - 200), ids.long);
  await pause(SETTLE_MS);
  const line = await (await page.$(`[data-note-id="${ids.long}"] > .note-content p:nth-child(3)`)).boundingBox();
  await page.mouse.click(line.x + 20, line.y + line.height / 2);
  await page.waitForSelector(`.note.editing[data-note-id="${ids.long}"] .note-tag-bar-input`);
  await idle(page);
  const alone = await screenState(page, ids.long);
  assert(alone.noteBottom > alone.windowHeight + 200, 'the note runs well past the window');
  const aloneGap = px(alone.windowHeight - alone.tagBar.bottom);
  assert(aloneGap > 0 && aloneGap < 40, `the tag bar floats at the window's bottom (${aloneGap}px up)`);

  await openNoteMenu(page, ids.long);
  await chooseItem(page);
  const asking = await screenState(page, ids.long);
  assert.equal(asking.card, 'Asking the AI…');
  assert.equal(asking.tagBar.bottom, alone.tagBar.bottom, 'the card does not move the floating tag bar');
  // Many long tags: the row wraps to two lines.
  const many = ['temple-gardens', 'ryokan-stays', 'cherry-blossoms', 'gion-evenings', 'bamboo-groves',
    'tea-ceremonies', 'kiyomizu-dera', 'philosophers-path', 'nishiki-market', 'arashiyama-hikes'];
  await answerSuggestionRequest(page, {type: 'tags', tags: many});
  const wrapped = await screenState(page, ids.long);
  assert.deepEqual(wrapped.caret, asking.caret, 'the proposals arriving leave the caret where it was');
  assert.equal(wrapped.scrollY, alone.scrollY, 'nothing scrolls');
  assert.equal(wrapped.noteTop, alone.noteTop, 'the note stays put');
  assert(wrapped.rowBox.height > 2 * 18, `the row wraps (${wrapped.rowBox.height}px)`);
  assert.equal(px(wrapped.windowHeight - wrapped.rowBox.bottom), aloneGap, "the row takes the tag bar's place at the bottom");
  // Exactly the gap they have in place (checked at the note's end below).
  const gap = px(wrapped.rowBox.top - wrapped.tagBar.bottom);
  assert(gap > 0 && gap < 6, `the tag bar sits right above the row (${gap}px)`);

  // Reject proposals until one line is left: the tag bar comes down with the row.
  for (let index = 0; index < 6; index += 1) {
    await page.click(`.note.editing[data-note-id="${ids.long}"] .note-tag-proposal-reject`);
    await pause(SETTLE_MS);
    await idle(page);
  }
  const oneLine = await screenState(page, ids.long);
  assert(oneLine.rowBox.height < wrapped.rowBox.height, 'the row is one line now');
  assert.equal(px(oneLine.windowHeight - oneLine.rowBox.bottom), aloneGap, 'the row stays at the bottom');
  assert.equal(px(oneLine.rowBox.top - oneLine.tagBar.bottom), gap, 'the tag bar stays attached');
  assert.equal(oneLine.scrollY, alone.scrollY, 'nothing scrolls');
  assert.equal(oneLine.noteTop, alone.noteTop, 'the note text does not move');
  assert.deepEqual(oneLine.caret, wrapped.caret, 'pressing − leaves the caret where it was');

  // At the note's end both sit in place, with the same gap.
  const scrolledBy = await page.evaluate(id => {
    const distance = document.querySelector(`[data-note-id="${id}"]`).getBoundingClientRect().bottom - window.innerHeight + 120;
    window.scrollBy(0, distance);
    return distance;
  }, ids.long);
  await pause(SETTLE_MS);
  const atEnd = await screenState(page, ids.long);
  assert(px(atEnd.windowHeight - atEnd.rowBox.bottom) > aloneGap, 'no longer floating');
  assert.equal(px(atEnd.rowBox.top - atEnd.tagBar.bottom), gap, 'in place, the same gap');
  await page.evaluate(distance => window.scrollBy(0, -distance), scrolledBy);
  await pause(SETTLE_MS);

  // The last proposals go: the tag bar returns to the bottom on its own.
  for (let index = 0; index < 4; index += 1) {
    await page.click(`.note.editing[data-note-id="${ids.long}"] .note-tag-proposal-reject`);
    await pause(SETTLE_MS);
    await idle(page);
  }
  const done = await screenState(page, ids.long);
  assert.equal(done.row, null);
  assert.equal(px(done.windowHeight - done.tagBar.bottom), aloneGap, 'the tag bar is back at the bottom');
  await leaveEditing(page);
}

// Wherever the user right-clicks in MetaList, the browser's own menu never shows.
async function noBrowserMenuCase(page, ids) {
  await watchBrowserMenu(page);
  const search = await (await page.$('#search-input')).boundingBox();
  const windowSize = await page.evaluate(() => ({width: window.innerWidth, height: window.innerHeight}));
  // The search box past its text, the window's left edge, and a note's text.
  const points = [
    {x: search.x + search.width - 20, y: search.y + search.height / 2},
    {x: 4, y: windowSize.height / 2},
    {x: windowSize.width / 2, y: windowSize.height / 2},
  ];
  for (const point of points) {
    await page.mouse.click(point.x, point.y, {button: 'right'});
    await pause(SETTLE_MS);
    await page.keyboard.press('Escape');
    await pause(SETTLE_MS);
  }
  await startEditing(page, ids.trip);
  await rightClickTagBarEnd(page, ids.trip);
  await page.keyboard.press('Escape');
  await leaveEditing(page);
  assert.deepEqual(await page.evaluate(() => window.browserMenuTest.shown), [], 'the browser menu never shows');
}

export async function checkAiNoteTagSuggestions(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
  const ids = await createFixture(page);
  await noKeyCase(page, ids);
  await setTestKey(page, true);
  await stubSuggestionRequests(page);
  await privacyCase(page, ids);
  await suggestCase(page, ids);
  await nothingNewCase(page, ids);
  await failureCase(page, ids);
  await leaveWhileAskingCase(page, ids);
  await withChildrenCase(page);
  await acceptFromNoteMenuCase(page, ids);
  await acceptFromTagBarCase(page, ids);
  await tagBarCase(page, ids);
  await floatingCase(page, ids);
  await noBrowserMenuCase(page, ids);
  await page.evaluate(() => { window.fetch = window.aiNoteTagTest.originalFetch; });
  await setTestKey(page, false);
  await deleteFixture(page, ids.all);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}
