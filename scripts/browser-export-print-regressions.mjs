import assert from 'node:assert/strict';

// Export and Print (docs/ui/controls.md): an exported file starts collapsed
// and expanded as MetaList shows its notes, embeds too, and its arrows collapse
// a note to its first line, hiding its children, as in MetaList; printing
// shows every note, without arrows. Print opens a title step
// (a smart default, selected), then the browser's print dialog on the same
// document, light and without arrows, carrying the title. Passwords are
// hidden unless the user includes them in that dialog (an export asks only
// when it has some), and a downloaded file copies on click like MetaList. The
// browser's own
// print dialog is not shown here: the test stands in for it (headless Firefox
// would stop running the page's scripts after print()).

const SETTLE_MS = 400;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return !mode.isLoading && !CommandGate.isBusy();
  });
  await page.waitForNetworkIdle({idleTime: 300});
}

async function reloadApp(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}

// A trip with two days, a password and a username; collapsed in MetaList, as
// an exported file starts.
async function createTrip(page) {
  return page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const trip = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(trip.id, '<p>Kyoto trip</p><p>Second line of the plan</p>', 'travel');
    const day1 = await NotesAPI.createChild(trip.id, '');
    await NotesAPI.saveNote(day1.id, '<p>Day one temples</p>', '');
    const day2 = await NotesAPI.createSibling(day1.id, '');
    await NotesAPI.saveNote(day2.id, '<p>Day two ramen</p>', '');
    const wifi = await NotesAPI.createSibling(day2.id, '');
    await NotesAPI.saveNote(wifi.id, '<p>hunter22</p>', '@password');
    const guest = await NotesAPI.createSibling(wifi.id, '');
    await NotesAPI.saveNote(guest.id, '<p>kyoto-guest</p>', '@username');
    await NotesAPI.setCollapsedSubtree(trip.id, true);
    return {trip: trip.id, day1: day1.id, day2: day2.id, wifi: wifi.id, guest: guest.id};
  });
}

async function exportedFileCase(browser, page, ids) {
  const htmlText = await page.evaluate(async id => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const {blob} = await NotesAPI.exportCurrentViewAsHtml('light', {noteId: id, includeCredentials: false, title: ''});
    return blob.text();
  }, ids.trip);
  const file = await browser.newPage();
  try {
    await file.setContent(htmlText, {waitUntil: 'load'});
    const state = () => file.evaluate(ids => {
      const shown = id => {
        const note = document.getElementById(`note-${id}`);
        return note !== null && note.getBoundingClientRect().height > 0;
      };
      const trip = document.getElementById(`note-${ids.trip}`);
      const toggle = trip.querySelector(':scope > .note-collapse-toggle');
      const visibleText = [...trip.querySelectorAll(':scope > .note-content')]
        .filter(content => getComputedStyle(content).display !== 'none').map(content => content.textContent.trim());
      return {
        day1: shown(ids.day1), day2: shown(ids.day2), text: visibleText,
        expanded: toggle.getAttribute('aria-expanded'),
        toggleShown: getComputedStyle(toggle).display !== 'none',
        leafHasToggle: document.querySelector(`#note-${ids.day1} > .note-collapse-toggle`) !== null,
      };
    }, ids);

    const start = await state();
    assert.deepEqual({...start, text: start.text.length}, {
      day1: false, day2: false, text: 1, expanded: 'false', toggleShown: true, leafHasToggle: false,
    }, 'starts collapsed, as in MetaList; a short note without children has no arrow');
    assert(start.text[0].includes('Kyoto trip') && !start.text[0].includes('Second line'), `only the first line: ${start.text[0]}`);

    await file.click(`#note-${ids.trip} > .note-collapse-toggle`);
    const expanded = await state();
    assert.deepEqual([expanded.expanded, expanded.day1, expanded.day2], ['true', true, true], 'clicking expands it');
    assert.equal(expanded.text.length, 1);
    assert(expanded.text[0].includes('Second line'), 'the whole text shows');

    await file.click(`#note-${ids.trip} > .note-collapse-toggle`);
    const collapsed = await state();
    assert.deepEqual([collapsed.expanded, collapsed.day1, collapsed.day2], ['false', false, false], 'clicking again collapses it');
    await file.click(`#note-${ids.trip} > .note-collapse-toggle`);

    // Collapsing or expanding moves nothing sideways, though the page stops or
    // starts scrolling (the scrollbar's place is kept, as in MetaList). Only
    // Firefox draws scrollbars headless (Chrome under Puppeteer hides them), so
    // only it shows the shift; both check the place is kept.
    await file.setViewport({width: 900, height: 220});
    const place = () => file.evaluate(id => ({
      left: document.getElementById(`note-${id}`).getBoundingClientRect().left,
      scrolls: document.documentElement.scrollHeight > window.innerHeight,
      gutter: getComputedStyle(document.documentElement).scrollbarGutter,
    }), ids.trip);
    const open = await place();
    await file.click(`#note-${ids.trip} > .note-collapse-toggle`);
    const shut = await place();
    await file.click(`#note-${ids.trip} > .note-collapse-toggle`);
    const reopened = await place();
    assert.deepEqual([open.scrolls, shut.scrolls], [true, false], 'the page scrolls only while expanded');
    assert.deepEqual([shut.left, reopened.left], [open.left, open.left], 'nothing moves sideways');
    assert.equal(open.gutter, 'stable', "the scrollbar's place is kept");

    // Paper's rules, applied to the screen too (Firefox has no media emulation).
    await file.evaluate(() => {
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSMediaRule && rule.media.mediaText.includes('print')) rule.media.appendMedium('screen');
        }
      }
    });
    assert.equal((await state()).toggleShown, false, 'no arrows on paper');
  } finally {
    await file.close();
  }
}

function optionsState(page) {
  return page.evaluate(() => {
    const frame = document.querySelector('iframe.print-frame');
    const dialog = document.getElementById('export-options-modal');
    const input = document.getElementById('export-title-input');
    const choice = document.querySelector('#export-options-modal .export-password-toggle');
    const include = document.getElementById('export-passwords-include');
    const warning = document.querySelector('#export-options-modal .export-password-warning');
    const content = document.querySelector('#export-options-modal .modal-content');
    return {
      dialogOpen: dialog !== null && dialog.style.display !== 'none',
      title: input === null ? null : input.value,
      selected: input === null ? null : [input.selectionStart, input.selectionEnd],
      passwords: choice === null ? null : choice.textContent,
      included: include === null ? null : include.checked,
      // The box, and how far its words sit from it: beside it, not stretched apart.
      toggle: include === null ? null : (({width}, words) => ({width, gap: Math.round(words.left - include.getBoundingClientRect().right)}))(
        include.getBoundingClientRect(), include.nextElementSibling.getBoundingClientRect()),
      focused: document.activeElement === null ? null : document.activeElement.id,
      warningShown: warning === null ? null : getComputedStyle(warning).visibility === 'visible',
      box: content === null ? null : (({top, height}) => ({top, height}))(content.getBoundingClientRect()),
      aiButton: (button => button === null ? null : {
        disabled: button.disabled, asking: button.classList.contains('is-asking'), width: button.getBoundingClientRect().width,
      })(document.getElementById('export-title-ai-btn')),
      aiNote: (note => note === null ? null : note.textContent)(document.querySelector('#export-options-modal .export-title-ai-note')),
      aiFailure: (card => card === null || card.hidden ? null : card.textContent)(document.getElementById('export-title-ai-failure')),
      submit: document.getElementById('export-options-submit-btn') === null ? null : document.getElementById('export-options-submit-btn').textContent,
      frame: frame === null ? null : frame.srcdoc,
      documentTitle: document.title,
    };
  });
}

async function openNoteMenu(page, noteId) {
  await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).scrollIntoView({block: 'center'}), noteId);
  const box = await (await page.$(`.note[data-note-id="${noteId}"] > .note-content`)).boundingBox();
  await page.mouse.click(box.x + 10, box.y + box.height / 2, {button: 'right'});
  await pause(SETTLE_MS);
}

// Downloads are caught, not saved: the files an export hands the browser, and their names.
async function catchDownloads(page) {
  await page.evaluate(() => {
    window.caughtDownloads = [];
    window.caughtNames = [];
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      window.caughtDownloads.push(blob);
      return createObjectURL(blob);
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download === '') click.call(this);
      else window.caughtNames.push(this.download);
    };
  });
}

function caughtDownloads(page) {
  return page.evaluate(() => Promise.all(window.caughtDownloads.map(blob => blob.text())));
}

const MASK = '\u2022'.repeat(8);

const caughtNames = page => page.evaluate(() => window.caughtNames);

async function exportPasswordsCase(browser, page, ids) {
  await catchDownloads(page);
  // Without passwords: the title only, the note's first line, named after it.
  await page.evaluate(async id => {
    const {exportNotes} = await import('/static/js/modules/mode-manager/services/export-service.js');
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    window.exporting = exportNotes(id, CommandPalette.getAiSettings());
  }, ids.day1);
  await pause(SETTLE_MS);
  const plain = await optionsState(page);
  assert.deepEqual([plain.dialogOpen, plain.title, plain.selected, plain.focused, plain.passwords, plain.submit],
    [true, 'Day one temples', [0, 'Day one temples'.length], 'export-title-input', null, 'Export'], 'a title, selected; nothing about passwords');
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.exporting);
  await idle(page);
  let files = await caughtDownloads(page);
  assert.equal(files.length, 1);
  assert(files[0].includes('<title>Day one temples</title>'), 'it names the tab');
  assert(!files[0].includes('class="html-export-title"'), 'no heading repeating the note');
  assert.deepEqual(await caughtNames(page), ['Day one temples.html'], 'named after its title');

  // With one, the dialog asks too; Include Unredacted Passwords is unchecked, and Enter keeps them hidden.
  await openNoteMenu(page, ids.trip);
  await chooseFromMenu(page, ['Export', 'Note as HTML']);
  const asked = await optionsState(page);
  assert.deepEqual({...asked, box: null}, {
    dialogOpen: true, title: 'Kyoto trip', selected: [0, 'Kyoto trip'.length], passwords: 'Include Unredacted Usernames and Passwords', included: false,
    toggle: {width: 18, gap: 8}, focused: 'export-title-input', warningShown: false, box: null, aiButton: null, aiNote: null, aiFailure: null,
    submit: 'Export', frame: null, documentTitle: asked.documentTitle,
  }, 'the title, and Include Unredacted Usernames and Passwords unchecked, its box beside its words; no AI is set up here');
  await page.keyboard.press('Enter');
  await pause(SETTLE_MS);
  await idle(page);
  files = await caughtDownloads(page);
  assert.equal(files.length, 2);
  assert(!files[1].includes('hunter22') && files[1].includes(`data-redacted="true" data-copy-value="${MASK}">${MASK}<`), 'hidden, its length too');
  assert(!files[1].includes('kyoto-guest'), 'the username too');

  // The checkbox says what it includes: usernames or passwords alone, or both (above).
  for (const [id, label] of [[ids.guest, 'Include Unredacted Usernames'], [ids.wifi, 'Include Unredacted Passwords']]) {
    await page.evaluate(async id => {
      const {exportNotes} = await import('/static/js/modules/mode-manager/services/export-service.js');
      const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
      window.exporting = exportNotes(id, CommandPalette.getAiSettings());
    }, id);
    await pause(SETTLE_MS);
    assert.equal((await optionsState(page)).passwords, label);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.exporting);
  }

  // Escape exports nothing.
  await openNoteMenu(page, ids.trip);
  await chooseFromMenu(page, ['Export', 'Note as HTML']);
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  assert.equal((await caughtDownloads(page)).length, 2, 'cancelled');

  // Include: the warning shows in the place kept for it, and nothing moves.
  await openNoteMenu(page, ids.trip);
  await chooseFromMenu(page, ['Export', 'Note as HTML']);
  const before = await optionsState(page);
  await page.click('#export-passwords-include');
  const including = await optionsState(page);
  assert.deepEqual([including.included, including.warningShown], [true, true]);
  assert.deepEqual(including.box, before.box, 'the dialog does not move or grow');
  await page.click('#export-options-submit-btn');
  await pause(SETTLE_MS);
  await idle(page);
  files = await caughtDownloads(page);
  assert.equal(files.length, 3);
  assert(files[2].includes('data-copy-value="hunter22">hunter22<'), 'included');
  await copyCase(browser, files[2], files[1]);
}

// In a downloaded file, a click copies a username or an included password, as
// in MetaList; a hidden one copies nothing.
async function copyCase(browser, includedFile, hiddenFile) {
  const file = await browser.newPage();
  try {
    const copies = async (htmlText, selector) => {
      await file.setContent(htmlText, {waitUntil: 'load'});
      await file.evaluate(() => {
        window.copied = [];
        Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
          writeText: text => { window.copied.push(text); return Promise.resolve(); },
        }});
      });
      // The trip starts collapsed, as in MetaList: open it to reach its credentials.
      await file.click('#notes-container > .note > .note-collapse-toggle');
      await file.click(selector);
      await pause(50);
      return file.evaluate(selector => ({
        copied: window.copied,
        flashed: document.querySelector(selector).classList.contains('meta-credential-copied'),
        blurred: getComputedStyle(document.querySelector(selector)).filter !== 'none',
      }), selector);
    };
    const password = '.meta-credential-password .meta-credential-value';
    const username = '.meta-credential-username .meta-credential-value';
    assert.deepEqual(await copies(includedFile, password), {copied: ['hunter22'], flashed: true, blurred: false}, 'readable, and copied');
    assert.deepEqual((await copies(includedFile, username)).copied, ['kyoto-guest']);
    assert.deepEqual((await copies(hiddenFile, password)).copied, [], 'a hidden password is not there to copy');
    assert.deepEqual((await copies(hiddenFile, username)).copied, [], 'nor a hidden username');
  } finally {
    await file.close();
  }
}

async function chooseFromMenu(page, path) {
  for (const label of path) {
    const items = await page.$$('.context-menu.is-visible .context-menu-item');
    let found = null;
    for (const item of items) {
      if (await item.$eval('.context-menu-item-label', node => node.textContent) === label) found = item;
    }
    assert(found !== null, `${label} is not in the menu`);
    await found.click();
    await pause(SETTLE_MS);
  }
  await idle(page);
}

async function printNoteCase(page, ids) {
  const appTitle = await page.title();
  await openNoteMenu(page, ids.trip);
  await chooseFromMenu(page, ['Print', 'Note']);
  const asked = await optionsState(page);
  assert.equal(asked.dialogOpen, true, 'a title step first');
  assert.equal(asked.title, 'Kyoto trip', "the default is the note's first line");
  assert.deepEqual(asked.selected, [0, 'Kyoto trip'.length], 'selected, so typing replaces it');
  assert.deepEqual([asked.passwords, asked.included], ['Include Unredacted Usernames and Passwords', false], 'the credentials choice, in the same step');
  assert.deepEqual([asked.aiButton, asked.aiNote], [null, null], 'no AI is set up here: no button, nothing said');
  assert.equal(asked.frame, null, 'nothing prints yet');

  await page.keyboard.type('Spring in Kyoto');
  await page.keyboard.press('Enter');
  await pause(SETTLE_MS);
  await idle(page);
  const printing = await optionsState(page);
  assert.equal(printing.dialogOpen, false);
  assert(printing.frame !== null, 'the document is printed from a frame');
  // Nothing in the printed document can run: no allow-scripts. The page still reaches
  // the frame (to print it) and Chrome only prints a sandboxed frame with allow-modals.
  assert.equal(await page.evaluate(() => document.querySelector('iframe.print-frame').getAttribute('sandbox')),
    'allow-same-origin allow-modals', 'the print frame is sandboxed');
  assert(printing.frame.includes('<h1 class="html-export-title">Spring in Kyoto</h1>'), 'the title heads the page');
  assert(printing.frame.includes('<title>Spring in Kyoto</title>'));
  assert(printing.frame.includes('data-theme="light"'), 'always light on paper');
  assert(!printing.frame.includes('class="note-collapse-toggle"') && !printing.frame.includes('<script>'), 'no arrows, no script');
  assert(printing.frame.includes('Day two ramen'), 'with its children, expanded');
  assert(!printing.frame.includes('hunter22') && printing.frame.includes(MASK), 'passwords hidden');
  assert.equal(printing.documentTitle, 'Spring in Kyoto', 'browsers name the PDF after the title');
  assert.deepEqual(await page.evaluate(() => window.printDialogs), ['Spring in Kyoto'], "the browser's print dialog opens once, on the document");
  assert.equal(await page.evaluate(async () => {
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return CommandGate.isBusy();
  }), false, 'MetaList is not busy while the dialog is open');

  // The browser's dialog closes.
  await page.evaluate(() => document.querySelector('iframe.print-frame').contentWindow.dispatchEvent(new Event('afterprint')));
  const done = await optionsState(page);
  assert.equal(done.frame, null, 'the frame goes');
  assert.equal(done.documentTitle, appTitle, "MetaList's title comes back");
}

// Stands in for the AI: Suggest with AI's two requests answer as the test says,
// when it says, and see Stop.
async function standInForTheAi(page, availability) {
  await page.evaluate(availability => {
    if (window.realFetch === undefined) window.realFetch = window.fetch;
    window.aiTitle = {availability, requests: []};
    window.fetch = (input, init) => {
      const url = String(input);
      if (url.endsWith('/export-title/availability')) {
        return Promise.resolve(new Response(JSON.stringify({availability: window.aiTitle.availability}), {
          status: 200, headers: {'content-type': 'application/json'},
        }));
      }
      if (url.endsWith('/export-title')) {
        const request = {body: JSON.parse(init.body), stopped: false};
        window.aiTitle.requests.push(request);
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            request.stopped = true;
            reject(new DOMException('Stopped', 'AbortError'));
          });
          request.answer = line => resolve(new Response(JSON.stringify(line) + '\n', {
            status: 200, headers: {'content-type': 'application/x-ndjson'},
          }));
        });
      }
      return window.realFetch(input, init);
    };
  }, availability);
}

const aiRequests = page => page.evaluate(() => window.aiTitle.requests.map(({body, stopped}) => ({previous: body.previous_titles, exported: body.exported, stopped})));

async function answerAi(page, line) {
  await page.evaluate(line => window.aiTitle.requests.at(-1).answer(line), line);
  await pause(SETTLE_MS);
}

async function openPrintDialog(page, ids) {
  await openNoteMenu(page, ids.trip);
  await chooseFromMenu(page, ['Print', 'Note']);
}

async function aiTitleCase(page, ids) {
  // Only pressing the button asks; it says what it cannot send.
  await standInForTheAi(page, 'partial');
  await openPrintDialog(page, ids);
  const opened = await optionsState(page);
  assert.deepEqual([opened.title, opened.aiButton.disabled, opened.aiButton.asking, opened.aiNote],
    ['Kyoto trip', false, false, 'Private notes are not sent to the AI.'], "MetaList's default, and a button");
  assert.deepEqual(await aiRequests(page), [], 'nothing asked yet');

  // While it asks, the button is Stop, as wide as before; typing stops it and wins.
  await page.click('#export-title-ai-btn');
  const asking = await optionsState(page);
  assert.deepEqual([asking.aiButton.asking, asking.aiButton.width, asking.title, asking.box], [true, opened.aiButton.width, 'Kyoto trip', opened.box]);
  assert.deepEqual(await aiRequests(page), [{previous: [], exported: 'note', stopped: false}]);
  await page.click('#export-title-input');
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  assert.deepEqual([(await optionsState(page)).aiButton.asking, (await aiRequests(page))[0].stopped], [false, true], 'typing stops it');
  assert.equal((await optionsState(page)).title, 'Kyoto trip!');

  // Stop does too.
  await page.click('#export-title-ai-btn');
  await page.click('#export-title-ai-btn');
  assert.deepEqual([(await optionsState(page)).aiButton.asking, (await aiRequests(page))[1].stopped], [false, true], 'Stop stops it');

  // An answer replaces the text, selected; undo brings back what was there.
  await page.click('#export-title-ai-btn');
  await answerAi(page, {type: 'title', title: 'Spring in Kyoto'});
  const answered = await optionsState(page);
  assert.deepEqual([answered.title, answered.selected, answered.focused, answered.aiButton.asking],
    ['Spring in Kyoto', [0, 'Spring in Kyoto'.length], 'export-title-input', false]);
  assert.equal(await page.evaluate(() => {
    document.execCommand('undo');
    return document.getElementById('export-title-input').value;
  }), 'Kyoto trip!', 'Cmd/Ctrl+Z brings back the title before');
  await page.evaluate(() => document.execCommand('redo'));

  // Asking again names what it already gave; a failure floats, moving nothing, until the next action.
  await page.click('#export-title-ai-btn');
  assert.deepEqual((await aiRequests(page)).at(-1).previous, ['Spring in Kyoto']);
  await answerAi(page, {type: 'failed', message: 'OpenAI API request failed: connection reset'});
  const failed = await optionsState(page);
  assert.deepEqual([failed.aiFailure, failed.title, failed.box],
    ["The AI couldn't suggest a title: OpenAI API request failed: connection reset", 'Spring in Kyoto', opened.box]);
  await page.keyboard.press('Shift');
  assert.equal((await optionsState(page)).aiFailure, null, 'gone at the next action');

  // Escape while it asks: nothing prints, and the request stops.
  await page.click('#export-title-ai-btn');
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  assert.deepEqual([(await optionsState(page)).dialogOpen, (await aiRequests(page)).at(-1).stopped], [false, true]);

  // Export asks the same way, and its file is named after the title.
  await openNoteMenu(page, ids.trip);
  await chooseFromMenu(page, ['Export', 'Note as HTML']);
  assert.equal((await optionsState(page)).aiButton.disabled, false);
  await page.click('#export-title-ai-btn');
  assert.equal((await aiRequests(page)).at(-1).exported, 'note');
  await answerAi(page, {type: 'title', title: 'Spring in Kyoto'});
  await page.keyboard.press('Enter');
  await pause(SETTLE_MS);
  await idle(page);
  assert.equal((await caughtNames(page)).at(-1), 'Spring in Kyoto.html');

  // All private: the button is dimmed and says why; nothing can be asked.
  await standInForTheAi(page, 'private');
  await openPrintDialog(page, ids);
  const hidden = await optionsState(page);
  assert.deepEqual([hidden.aiButton.disabled, hidden.aiNote], [true, "These notes are private, so the AI can't suggest a title."]);
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  await page.evaluate(() => { window.fetch = window.realFetch; });
}

async function printViewCase(page) {
  // The background menu prints the view; Escape at the title step prints nothing.
  await page.mouse.click(5, 300, {button: 'right'});
  await pause(SETTLE_MS);
  await chooseFromMenu(page, ['Print View']);
  const asked = await optionsState(page);
  assert.equal(asked.dialogOpen, true);
  assert.equal(asked.title, 'MetaList', 'a view without a search');
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  const cancelled = await optionsState(page);
  assert.equal(cancelled.dialogOpen, false);
  assert.equal(cancelled.frame, null, 'nothing prints');

  // Included passwords print readable, not blurred.
  await page.mouse.click(5, 300, {button: 'right'});
  await pause(SETTLE_MS);
  await chooseFromMenu(page, ['Print View']);
  await page.click('#export-passwords-include');
  await page.click('#export-options-submit-btn');
  await pause(SETTLE_MS);
  await idle(page);
  const printed = await page.evaluate(() => {
    const printedDocument = document.querySelector('iframe.print-frame').contentDocument;
    const values = [...printedDocument.querySelectorAll('.meta-credential-password .meta-credential-value')];
    const wifi = values.find(value => value.textContent === 'hunter22');
    return {found: wifi !== undefined, filter: wifi === undefined ? null : getComputedStyle(wifi).filter};
  });
  assert.deepEqual(printed, {found: true, filter: 'none'});
  await page.evaluate(() => document.querySelector('iframe.print-frame').contentWindow.dispatchEvent(new Event('afterprint')));
}

// Long unbroken text (a token, a hash, a URL) wraps inside its note, in
// MetaList and in an exported file, whatever the note's format: it never runs
// out of the note's box.
const TOKEN = 'pypi-' + 'AgEIcHlwaS5vcmcCJDBj'.repeat(10);
// [name, tags, content]; EMBED stands for embedding the first (plain) note.
const EMBED = 'EMBED';
const WRAP_FORMATS = [
  ['plain', '', `<p>${TOKEN}</p>`],
  ['in a sentence', '', `<p>The token is ${TOKEN} for uploads</p>`],
  ['monospace', '@monospace', `<p>${TOKEN}</p>`],
  ['copyable', '@copyable', `<p>${TOKEN}</p>`],
  ['copyable monospace', '@copyable @monospace', `<p>${TOKEN}</p>`],
  ['username', '@username', `<p>${TOKEN}</p>`],
  ['password', '@password', `<p>${TOKEN}</p>`],
  ['code', '@code=python', `<div>token = "${TOKEN}"</div>`],
  ['json', '@json', `<div>{"token": "${TOKEN}"}</div>`],
  ['diff', '@diff', `<div>+${TOKEN}</div>`],
  ['csv', '@csv', `<div>name,token</div><div>upload,${TOKEN}</div>`],
  ['markdown', '@markdown', `<p>${TOKEN}</p>`],
  ['markdown code', '@markdown', `<div>\`\`\`</div><div>${TOKEN}</div><div>\`\`\`</div>`],
  ['embedded', '', EMBED],
];

function textOverflow(contents) {
  // How far each note's text reaches past the right of its box, in pixels.
  return contents.map(content => {
    const box = content.getBoundingClientRect();
    let right = box.right;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) right = Math.max(right, rect.right);
    }
    return Math.round(right - box.right);
  });
}

async function wrappingCase(browser, page) {
  const created = await page.evaluate(async ({formats, embed}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const root = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(root.id, '<p>Wrapping</p>', '');
    const ids = [];
    let previous = null;
    for (const [, tags, content] of formats) {
      let note;
      if (previous === null) note = await NotesAPI.createChild(root.id, '');
      else note = await NotesAPI.createSibling(previous, '');
      await NotesAPI.saveNote(note.id, content === embed ? `<p>![[${ids[0]}]]</p>` : content, tags);
      ids.push(note.id);
      previous = note.id;
    }
    return {root: root.id, ids};
  }, {formats: WRAP_FORMATS, embed: EMBED});
  await reloadApp(page);
  const names = WRAP_FORMATS.map(([name]) => name);
  const inMetaList = await page.evaluate((ids, measure) => {
    const textOverflow = new Function(`return (${measure})`)();
    return textOverflow(ids.map(id => document.querySelector(`.note[data-note-id="${id}"] > .note-content`)));
  }, created.ids, textOverflow.toString());
  // A credential row is its icon, which names it on hover, then the value:
  // no label, and a long value wraps beside the icon, not below it.
  const username = created.ids[WRAP_FORMATS.findIndex(([name]) => name === 'username')];
  const row = await page.evaluate(id => {
    const icon = document.querySelector(`.note[data-note-id="${id}"] .meta-credential-icon`);
    const value = document.querySelector(`.note[data-note-id="${id}"] .meta-credential-value`);
    const [iconBox, valueBox] = [icon.getBoundingClientRect(), value.getBoundingClientRect()];
    return {
      text: icon.parentElement.textContent, title: icon.getAttribute('title'), label: icon.getAttribute('aria-label'),
      gap: Math.round(valueBox.left - iconBox.right), lines: Math.round(valueBox.height / parseFloat(getComputedStyle(value).lineHeight)) > 1,
    };
  }, username);
  assert.deepEqual(row, {text: TOKEN, title: 'Username', label: 'Username', gap: 6, lines: true});

  const htmlText = await page.evaluate(async id => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const {blob} = await NotesAPI.exportCurrentViewAsHtml('light', {noteId: id, includeCredentials: true, title: ''});
    return blob.text();
  }, created.root);
  const file = await browser.newPage();
  let inExport = null;
  try {
    await file.setViewport({width: 900, height: 800});
    await file.setContent(htmlText, {waitUntil: 'load'});
    inExport = await file.evaluate((ids, measure) => {
      const textOverflow = new Function(`return (${measure})`)();
      return textOverflow(ids.map(id => document.querySelector(`#note-${id} > .note-content`)));
    }, created.ids, textOverflow.toString());
    assert.equal(await file.evaluate(id => document.querySelector(`#note-${id} .meta-credential`).textContent, username), TOKEN, 'the same in a file');
  } finally {
    await file.close();
  }
  await page.evaluate(async id => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.deleteNote(id);
  }, created.root);
  const table = Object.fromEntries(names.map((name, index) => [name, [inMetaList[index], inExport[index]]]));
  const none = Object.fromEntries(names.map(name => [name, [0, 0]]));
  assert.deepEqual(table, none, 'text overflow past the note box (in MetaList, in the export)');
}

// An image never runs out of the box it sits in: in a note, an embedded note,
// an embed inside an embed or an embedded note's child, at any @size, in
// MetaList and in an exported file. Each maps to how far past its box it
// reaches (MetaList, export), in pixels.
const IMAGE_PLACES = ['plain', 'sized up', 'embedded', 'embedded child', 'embed in an embed'];

function imageOverflow(images) {
  return images.map(image => {
    const box = image.closest('.note-embed-content, .note-content').getBoundingClientRect();
    return Math.max(0, Math.round(image.getBoundingClientRect().right - box.right));
  });
}

async function imageBoundsCase(browser, page) {
  const created = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 120;
    const context = canvas.getContext('2d');
    context.fillStyle = '#88aadd';
    context.fillRect(0, 0, 1600, 120);
    const image = `<img src="${canvas.toDataURL('image/png')}">`;
    canvas.width = 200;
    context.fillRect(0, 0, 200, 120);
    const smallImage = `<img src="${canvas.toDataURL('image/png')}">`;
    const make = async (parent, previous, html, tags) => {
      let note;
      if (parent === null) note = await NotesAPI.createNote(null, '');
      else if (previous === null) note = await NotesAPI.createChild(parent, '');
      else note = await NotesAPI.createSibling(previous, '');
      await NotesAPI.saveNote(note.id, html, tags);
      return note.id;
    };
    const root = await make(null, null, '<p>Images</p>', '');
    const plain = await make(root, null, `<p>Plain</p><p>${image}</p>`, '');
    const sized = await make(root, plain, `<p>Sized up</p><p>${image}</p>`, '@size=2.0');
    const source = await make(root, sized, `<p>Source</p><p>${image}</p>`, '');
    const sourceChild = await make(source, null, `<p>Child</p><p>${image}</p>`, '');
    const embedding = await make(root, source, `<p>![[${source}]]</p>`, '');
    const outer = await make(root, embedding, `<p>![[${embedding}]]</p>`, '');
    const small = await make(root, outer, `<p>Small</p><p>${smallImage}</p>`, '');
    const smallSized = await make(root, small, `<p>Small, sized up</p><p>${smallImage}</p>`, '@size=2.0');
    return {root, plain, sized, source, sourceChild, embedding, outer, small, smallSized};
  });
  await reloadApp(page);
  const measure = ids => {
    const inside = (host, id) => [...document.querySelectorAll(`${host} [data-embed-note-id="${id}"] > .note-embed-body > .note-embed-content img`)][0];
    const own = host => document.querySelector(`${host} > .note-content img`);
    return [
      own(ids.plainHost), own(ids.sizedHost), inside(ids.embeddingHost, ids.source),
      document.querySelector(`${ids.embeddingHost} [data-embed-note-id="${ids.sourceChild}"] > .note-embed-body > .note-embed-content img`),
      inside(ids.outerHost, ids.source),
    ];
  };
  const hosts = (selector) => ({
    plainHost: selector(created.plain), sizedHost: selector(created.sized), embeddingHost: selector(created.embedding),
    outerHost: selector(created.outer), source: created.source, sourceChild: created.sourceChild,
  });
  const inMetaList = await page.evaluate((ids, measureSource, overflowSource) => {
    const measure = new Function(`return (${measureSource})`)();
    const imageOverflow = new Function(`return (${overflowSource})`)();
    return imageOverflow(measure(ids));
  }, hosts(id => `.note[data-note-id="${id}"]`), measure.toString(), imageOverflow.toString());
  // @size still scales an image up while there is room.
  const smallWidths = await page.evaluate(ids => ids.map(id => Math.round(
    document.querySelector(`.note[data-note-id="${id}"] > .note-content img`).getBoundingClientRect().width)), [created.small, created.smallSized]);
  assert.deepEqual(smallWidths, [200, 400], 'a 200px image, and the same at @size=2.0');

  const htmlText = await page.evaluate(async id => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const {blob} = await NotesAPI.exportCurrentViewAsHtml('light', {noteId: id, includeCredentials: false, title: ''});
    return blob.text();
  }, created.root);
  const file = await browser.newPage();
  let inExport = null;
  try {
    await file.setViewport({width: 900, height: 800});
    await file.setContent(htmlText, {waitUntil: 'load'});
    inExport = await file.evaluate((ids, measureSource, overflowSource) => {
      const measure = new Function(`return (${measureSource})`)();
      const imageOverflow = new Function(`return (${overflowSource})`)();
      return imageOverflow(measure(ids));
    }, hosts(id => `#note-${id}`), measure.toString(), imageOverflow.toString());
  } finally {
    await file.close();
  }
  await page.evaluate(async id => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.deleteNote(id);
  }, created.root);
  const table = Object.fromEntries(IMAGE_PLACES.map((name, index) => [name, [inMetaList[index], inExport[index]]]));
  assert.deepEqual(table, Object.fromEntries(IMAGE_PLACES.map(name => [name, [0, 0]])), 'image overflow past its box (in MetaList, in the export)');
}

// A holder showing a source whose collapsed child has a child of its own: in
// the file, the embedded child starts collapsed and its arrow folds it.
async function exportedEmbedCase(browser, page) {
  const ids = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const source = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(source.id, '<p>Packing list</p>', '');
    const kid = await NotesAPI.createChild(source.id, '');
    await NotesAPI.saveNote(kid.id, '<p>Clothes</p>', '');
    const grandkid = await NotesAPI.createChild(kid.id, '');
    await NotesAPI.saveNote(grandkid.id, '<p>Rain jacket</p>', '');
    await NotesAPI.setCollapsedBulk([kid.id], true);
    const holder = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(holder.id, `<p>[[${source.id}]]</p>`, '');
    return {source: source.id, kid: kid.id, grandkid: grandkid.id, holder: holder.id};
  });
  await reloadApp(page);
  const htmlText = await page.evaluate(async id => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const {blob} = await NotesAPI.exportCurrentViewAsHtml('light', {noteId: id, includeCredentials: false, title: ''});
    return blob.text();
  }, ids.holder);
  const file = await browser.newPage();
  try {
    await file.setContent(htmlText, {waitUntil: 'load'});
    // Drawn as in MetaList: the holder takes the embed tint, and its embed has no panel of its own.
    const colours = await file.evaluate(id => {
      const tint = document.createElement('div');
      tint.style.background = 'var(--embed-tint-1)';
      document.body.appendChild(tint);
      const expected = getComputedStyle(tint).backgroundColor;
      tint.remove();
      const holder = document.getElementById(`note-${id}`);
      const block = holder.querySelector(':scope > .note-content .note-reference-block');
      const style = getComputedStyle(holder);
      return {
        holder: style.backgroundColor === expected, panel: getComputedStyle(block).backgroundColor,
        // Paper keeps them: browsers drop backgrounds when printing unless asked not to.
        onPaper: [style.printColorAdjust, style.webkitPrintColorAdjust].includes('exact'),
      };
    }, ids.holder);
    assert.deepEqual(colours, {holder: true, panel: 'rgba(0, 0, 0, 0)', onPaper: true},
      'the holder is tinted, its embed has no panel, and paper keeps the tint');
    const state = () => file.evaluate(ids => {
      const kid = document.querySelector(`#note-${ids.holder} [data-embed-note-id="${ids.kid}"]`);
      const toggle = kid.querySelector(':scope > .note-embed-body > .note-embed-collapse-toggle');
      const shownText = [...document.querySelectorAll(`#note-${ids.holder} .note-embed-content`)]
        .filter(content => content.getBoundingClientRect().height > 0).map(content => content.textContent.trim());
      return {
        expanded: toggle.getAttribute('aria-expanded'),
        arrowShown: toggle.getBoundingClientRect().width > 0,
        clothes: shownText.filter(text => text === 'Clothes').length,
        rainJacket: shownText.includes('Rain jacket'),
      };
    }, ids);
    assert.deepEqual(await state(), {expanded: 'false', arrowShown: true, clothes: 1, rainJacket: false},
      'the embedded note starts collapsed, as in MetaList: its first line, no children');
    await file.click(`#note-${ids.holder} [data-embed-note-id="${ids.kid}"] > .note-embed-body > .note-embed-collapse-toggle`);
    assert.deepEqual(await state(), {expanded: 'true', arrowShown: true, clothes: 1, rainJacket: true}, 'its arrow expands it');
    await file.click(`#note-${ids.holder} [data-embed-note-id="${ids.kid}"] > .note-embed-body > .note-embed-collapse-toggle`);
    assert.deepEqual(await state(), {expanded: 'false', arrowShown: true, clothes: 1, rainJacket: false}, 'and collapses it again');
  } finally {
    await file.close();
  }
  await page.evaluate(async ids => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.deleteNote(ids.holder);
    await NotesAPI.deleteNote(ids.source);
  }, ids);
}

export async function checkExportAndPrint(browser, page) {
  await reloadApp(page);
  const ids = await createTrip(page);
  await reloadApp(page);
  await exportedFileCase(browser, page, ids);
  await exportedEmbedCase(browser, page);
  await exportPasswordsCase(browser, page, ids);
  // Stands in for the browser's print dialog, in the print frame only.
  const printDialog = await page.evaluateOnNewDocument(() => {
    if (window.frameElement !== null && window.frameElement.classList.contains('print-frame')) {
      window.print = () => { window.parent.printDialogs.push(document.title); };
    }
  });
  await page.evaluate(() => { window.printDialogs = []; });
  await printNoteCase(page, ids);
  await aiTitleCase(page, ids);
  await printViewCase(page);
  assert.equal(await page.evaluate(() => window.printDialogs.length), 2, 'cancelling opens no dialog');
  await page.removeScriptToEvaluateOnNewDocument(printDialog.identifier);
  await wrappingCase(browser, page);
  await imageBoundsCase(browser, page);
  await page.evaluate(async id => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.deleteNote(id);
  }, ids.trip);
  await reloadApp(page);
}
