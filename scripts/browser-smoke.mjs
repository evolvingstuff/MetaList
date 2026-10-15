import {checkAgentHelpMenus} from './browser-agent-help-regressions.mjs';
import {checkAiPrivacyPreview} from './browser-ai-privacy-regressions.mjs';
import {checkAiSelectedNote} from './browser-ai-selected-note-regressions.mjs';
import {checkAiResponseMenu} from './browser-ai-response-menu-regressions.mjs';
/** A small real-browser smoke test. Every server run owns a fresh temporary namespace. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import puppeteer from 'puppeteer';
import {checkPastedHeadingFormatting} from './browser-formatting-regressions.mjs';
import {checkAdditionalStateTransitions, checkEditingShortcutSequences} from './browser-state-regressions.mjs';
import {checkTagDoubleClickSelection} from './browser-tag-selection-regressions.mjs';
import {checkBackgroundSortMenu} from './browser-sort-menu-regressions.mjs';
import {prepareUpdateFixture, checkAppUpdates} from './browser-update-regressions.mjs';
import {checkFloatingNotes} from './browser-floating-note-regressions.mjs';
import {checkAiHistoryExport} from './browser-ai-history-regressions.mjs';
import {checkOpenAiSettings} from './browser-ai-settings-regressions.mjs';
import {checkWritingAssistantCorrections} from './browser-writing-assistant-regressions.mjs';
import {checkExitEditScroll} from './browser-scroll-regressions.mjs';
import {checkMoveToBottom} from './browser-move-to-bottom-regressions.mjs';
import {checkListEdges} from './browser-list-edge-regressions.mjs';
import {checkSortedTabs} from './browser-sorted-tab-regressions.mjs';
import {checkSearchInputRejected} from './browser-search-input-regressions.mjs';
import {checkDictationPaste} from './browser-dictation-paste-regressions.mjs';
import {checkFileDropPreviews} from './browser-file-drop-preview-regressions.mjs';
import {checkTagSuggestionMenu} from './browser-tag-suggestion-menu-regressions.mjs';
import {checkPasteFormats} from './browser-paste-format-regressions.mjs';
import {checkAiNoteTagSuggestions} from './browser-ai-note-tag-regressions.mjs';
import {checkRobotProposals} from './browser-robot-proposal-regressions.mjs';
import {checkExportAndPrint} from './browser-export-print-regressions.mjs';
import {checkUrlCleaning} from './browser-url-cleaning-regressions.mjs';
import {checkReferencePaste} from './browser-reference-paste-regressions.mjs';
import {checkClickCaret} from './browser-click-caret-regressions.mjs';
import {checkEditableEmbeds} from './browser-editable-embed-regressions.mjs';
import {checkDeleteWarning} from './browser-delete-warning-regressions.mjs';

const directory = await mkdtemp(join(tmpdir(), 'metalist-browser-'));
// Free ports for HTTP and HTTPS: the user's own MetaList keeps its usual ports (HTTPS 8443).
async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const freeTcpPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return freeTcpPort;
}
const port = await freePort();
let httpsPort = await freePort();
while (httpsPort === port) httpsPort = await freePort();
const origin = `http://127.0.0.1:${port}`;
const env = {...process.env};
for (const key of Object.keys(env)) {
  if (key.startsWith('METALIST_') || key === 'TEST_MODE') delete env[key];
}
env.METALIST_DATA_DIRECTORY = directory;
env.METALIST_ENVIRONMENT = 'production';
env.METALIST_PORT = String(port);
env.METALIST_HTTPS_PORT = String(httpsPort);
env.API_PREFIX = '/api2';
env.V1_API_PREFIX = '/api';
const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
let logs = '';
const server = spawn(resolve(python), ['serve_namespace.py','--namespace','default','--port',String(port)], {env, stdio:['ignore','pipe','pipe']});
server.stdout.on('data', chunk => { logs += chunk; });
server.stderr.on('data', chunk => { logs += chunk; });
let browser;
const browserDiagnostics = [];
try {
  let ready = false;
  for (let count=0; count<300; count++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    let response = null;
    try { response = await fetch(`${origin}/api2/auth/status`, {headers:{"X-Metalist-Tab-Id":"smoke-readiness"}}); }
    catch (error) { if (!(error instanceof TypeError)) throw error; if (error.cause?.code !== 'ECONNREFUSED') throw error; }
    if (response !== null) {
      if (response.ok) {ready=true; break;}
      throw new Error(`Readiness failed: ${response.status} ${await response.text()}`);
    }
    await delay(100);
  }
  assert(ready, 'Server did not become ready');
  const browserName = process.env.BROWSER_TEST_BROWSER;
  assert(['chrome', 'firefox'].includes(browserName), 'BROWSER_TEST_BROWSER must be chrome or firefox');
  const browserDriver = process.env.BROWSER_TEST_DRIVER_MODULE
    ? (await import(process.env.BROWSER_TEST_DRIVER_MODULE)).default : puppeteer;
  browser = await browserDriver.launch({headless:true, browser:browserName,
    ...(process.env.BROWSER_TEST_EXECUTABLE ? {executablePath:process.env.BROWSER_TEST_EXECUTABLE} : {})});
  const page = await browser.newPage();
  page.on('console', message => browserDiagnostics.push(`${new Date().toISOString()} ${message.type()} ${message.text()}`));
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) browserDiagnostics.push(`${new Date().toISOString()} navigate ${frame.url()}`);
  });
  page.on('requestfailed', request => browserDiagnostics.push(`${new Date().toISOString()} failed ${request.url()} ${request.failure()?.errorText}`));
  // Why a page or frame goes away mid-check (renderer crash, close, disconnect).
  // Kept in browser.log, written when a check fails.
  const lifecycle = message => browserDiagnostics.push(`${new Date().toISOString()} LIFECYCLE ${message}`);
  page.on('error', error => lifecycle(`page crashed: ${error.message}`));
  page.on('close', () => lifecycle('page closed'));
  page.on('framedetached', frame => lifecycle(`frame detached ${frame.url()} main=${frame === page.mainFrame()}`));
  browser.on('disconnected', () => lifecycle('browser disconnected'));
  browser.on('targetdestroyed', target => lifecycle(`target destroyed ${target.type()} ${target.url()}`));
  browser.on('targetcreated', target => lifecycle(`target created ${target.type()} ${target.url()}`));
  const updateFixture = await prepareUpdateFixture(page);
  if (['ai-selected-note', 'writing-assistant', 'ai-history', 'agent-help', 'ai-privacy', 'ai-response-menu', 'exit-edit-scroll', 'move-to-bottom', 'list-edges', 'sorted-tabs', 'search-input', 'dictation-paste', 'file-drop-previews', 'tag-suggestion-menu', 'paste-formats', 'ai-note-tags', 'robot-proposals', 'export-print', 'url-cleaning', 'reference-paste', 'click-caret', 'editable-embeds', 'delete-warning'].includes(process.env.BROWSER_TEST_SUITE)) {
    // The focused suite does not run checkAppUpdates, which normally releases
    // this intentionally held request. Avoid an unrelated update notice too.
    updateFixture.outage = true;
    updateFixture.releaseInitial();
  }
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('BROWSER ERROR', error.stack); });
  const pageFailure = new Promise((resolve, reject) => page.on('pageerror', reject));
  await page.goto(origin);
  await Promise.race([page.waitForSelector('[data-app-ready="true"]', {timeout:30000}), pageFailure]);
  if (process.env.BROWSER_TEST_SUITE === 'ai-selected-note') {
    await checkAiSelectedNote(page);
    assert.deepEqual(errors, []);
    console.log(`PASS selected-note chat regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'ai-response-menu') {
    await checkAiResponseMenu(page);
    assert.deepEqual(errors, []);
    console.log(`PASS AI response menu regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'ai-privacy') {
    await checkAiPrivacyPreview(page);
    assert.deepEqual(errors, []);
    console.log(`PASS AI privacy preview regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'agent-help') {
    await checkAgentHelpMenus(page);
    assert.deepEqual(errors, []);
    console.log(`PASS agent-help regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'ai-history') {
    await checkAiHistoryExport(page);
    assert.deepEqual(errors, []);
    console.log(`PASS AI history regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'writing-assistant') {
    await checkWritingAssistantCorrections(page);
    assert.deepEqual(errors, []);
    console.log(`PASS writing-assistant regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'exit-edit-scroll') {
    await checkExitEditScroll(page);
    assert.deepEqual(errors, []);
    console.log(`PASS exit-edit scroll regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'move-to-bottom') {
    await checkMoveToBottom(page);
    assert.deepEqual(errors, []);
    console.log(`PASS move to bottom regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'list-edges') {
    await checkListEdges(page);
    assert.deepEqual(errors, []);
    console.log(`PASS list edge regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'sorted-tabs') {
    await checkSortedTabs(page);
    assert.deepEqual(errors, []);
    console.log(`PASS sorted tab regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'search-input') {
    await checkSearchInputRejected(page);
    assert.deepEqual(errors, []);
    console.log(`PASS search input regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'dictation-paste') {
    await checkDictationPaste(page);
    assert.deepEqual(errors, []);
    console.log(`PASS dictation paste regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'file-drop-previews') {
    await checkFileDropPreviews(page);
    assert.deepEqual(errors, []);
    console.log(`PASS file drop preview regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'tag-suggestion-menu') {
    await checkTagSuggestionMenu(page);
    assert.deepEqual(errors, []);
    console.log(`PASS tag suggestion menu regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'paste-formats') {
    await checkPasteFormats(page);
    assert.deepEqual(errors, []);
    console.log(`PASS paste format regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'export-print') {
    await checkExportAndPrint(browser, page);
    assert.deepEqual(errors, []);
    console.log(`PASS export and print regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'delete-warning') {
    await checkDeleteWarning(page);
    assert.deepEqual(errors, []);
    console.log(`PASS delete warning regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'editable-embeds') {
    await checkEditableEmbeds(page);
    assert.deepEqual(errors, []);
    console.log(`PASS editable embed regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'click-caret') {
    await checkClickCaret(page);
    assert.deepEqual(errors, []);
    console.log(`PASS click caret regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'reference-paste') {
    await checkReferencePaste(page);
    assert.deepEqual(errors, []);
    console.log(`PASS reference paste regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'url-cleaning') {
    await checkUrlCleaning(page);
    assert.deepEqual(errors, []);
    console.log(`PASS URL cleaning regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'robot-proposals') {
    await checkRobotProposals(page);
    assert.deepEqual(errors, []);
    console.log(`PASS robot proposal count regressions in ${await browser.version()}`);
  } else if (process.env.BROWSER_TEST_SUITE === 'ai-note-tags') {
    await checkAiNoteTagSuggestions(page);
    assert.deepEqual(errors, []);
    console.log(`PASS Suggest Tags with AI regressions in ${await browser.version()}`);
  } else {
  assert(process.env.BROWSER_TEST_SUITE === undefined, 'Unknown BROWSER_TEST_SUITE');
  await checkAppUpdates(page, updateFixture);
  await checkOpenAiSettings(page);
  await checkAiHistoryExport(page);
  await checkWritingAssistantCorrections(page);
  await checkExitEditScroll(page);
  await checkMoveToBottom(page);
  await checkListEdges(page);
  await checkTagSuggestionMenu(page);
  await checkPasteFormats(page);
  await checkAiNoteTagSuggestions(page);
  await checkRobotProposals(page);
  await checkExportAndPrint(browser, page);
  await checkUrlCleaning(page);
  await checkReferencePaste(page);
  await checkClickCaret(page);
  await checkEditableEmbeds(page);
  await checkDeleteWarning(page);
  await checkSortedTabs(page);
  await page.waitForNetworkIdle({idleTime:500});
  // Exercise initial document mouse movement, including stationary axes and
  // duplicate browser observations that must not become duplicate state writes.
  await page.mouse.move(30, 300);
  await page.mouse.move(30, 320);
  await page.mouse.move(50, 320);
  await page.mouse.move(50, 320);
  assert.deepEqual(errors, []);
  console.log('PASS initial pointer movement with unchanged coordinates');
  const noteId = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const created = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(created.id, '<p>Browser smoke original</p><p>Collapse smoke second line</p>', '');
    await NotesAPI.saveNote(created.id, '<p>Browser smoke changed</p>', '');
    const undone = await NotesAPI.undo();
    if (undone.status !== 'success') throw new Error('Undo failed');
    return created.id;
  });
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await page.waitForFunction(() => document.body.textContent.includes('Browser smoke original'));
  assert(!await page.evaluate(() => document.body.textContent.includes('Browser smoke changed')));
  console.log('PASS browser initialization, create/edit/undo, and reload');

  const initiallyCollapsed = await page.$eval(`[data-note-id="${noteId}"]`, note => note.classList.contains('collapsed'));
  for (const isCollapsed of [!initiallyCollapsed, initiallyCollapsed, !initiallyCollapsed, initiallyCollapsed]) {
    await page.click(`[data-note-id="${noteId}"] > .note-collapse-toggle`);
    await page.waitForFunction(async (noteId, isCollapsed) => {
      const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
      const note = document.querySelector(`[data-note-id="${noteId}"]`);
      return !ModeContextInstance.isLoading
        && !note.classList.contains('is-collapse-transitioning')
        && note.classList.contains('collapsed') === isCollapsed;
    }, {}, noteId, isCollapsed);
    assert.deepEqual(errors, []);
  }
  console.log('PASS repeated collapse/expand button clicks without an active drag');

  const rapidButton = await page.$(`[data-note-id="${noteId}"] > .note-collapse-toggle`);
  const rapidBounds = await rapidButton.boundingBox();
  assert(rapidBounds, 'Collapse button must be visible');
  for (let count = 0; count < 8; count += 1) {
    await page.mouse.click(rapidBounds.x + rapidBounds.width / 2, rapidBounds.y + rapidBounds.height / 2);
    await delay(25);
  }
  await page.waitForFunction(async noteId => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !ModeContextInstance.isLoading
      && !document.querySelector(`[data-note-id="${noteId}"]`).classList.contains('is-collapse-transitioning');
  }, {}, noteId);
  assert.deepEqual(errors, []);
  console.log('PASS rapid collapse clicks during animation');

  for (const release of ['outside', 'held', 'blur', 'outside', 'held', 'blur']) {
    const before = await page.$eval(`[data-note-id="${noteId}"]`, note => note.classList.contains('collapsed'));
    const button = await page.$(`[data-note-id="${noteId}"] > .note-collapse-toggle`);
    const bounds = await button.boundingBox();
    assert(bounds, 'Collapse button must be visible');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.waitForFunction(async (noteId, before) => {
      const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
      const note = document.querySelector(`[data-note-id="${noteId}"]`);
      return !ModeContextInstance.isLoading && !note.classList.contains('is-collapse-transitioning')
        && note.classList.contains('collapsed') !== before;
    }, {}, noteId, before);
    if (release === 'held') await delay(600);
    if (release !== 'held') await page.mouse.move(5, 500);
    if (release === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await page.waitForNetworkIdle({idleTime:100});
    assert.equal(await page.$eval(`[data-note-id="${noteId}"]`, note => note.classList.contains('collapsed')), !before);
    assert.deepEqual(errors, []);
  }
  console.log('PASS interrupted, held, and blurred collapse gestures without double activation');

  await page.click(`[data-note-id="${noteId}"] .note-content`);
  await page.waitForFunction(async () => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return ModeContextInstance.isEditing && !ModeContextInstance.isLoading;
  });
  await page.keyboard.type(' editor-transition-check');
  await page.waitForFunction(() => document.querySelector('.note.editing .note-content').textContent.includes('editor-transition-check'));
  const collapsedEditSession = await page.evaluate(async noteId => {
    const {collapseNote} = await import('/static/js/modules/mode-manager/actions/note-actions.js');
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    await collapseNote(noteId);
    return {
      isEditing: ModeContextInstance.isEditing,
      currentNoteId: ModeContextInstance.currentNoteId,
      isCollapsed: document.querySelector(`[data-note-id="${noteId}"]`).classList.contains('collapsed'),
    };
  }, noteId);
  assert.deepEqual(collapsedEditSession, {
    isEditing: false,
    currentNoteId: null,
    isCollapsed: true,
  });
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  assert.equal(await page.$eval(`[data-note-id="${noteId}"]`, note => note.classList.contains('collapsed')), true);
  await page.click(`[data-note-id="${noteId}"] > .note-collapse-toggle`);
  await page.waitForFunction(noteId => {
    const note = document.querySelector(`[data-note-id="${noteId}"]`);
    return !note.classList.contains('collapsed')
      && note.querySelector('.note-content').textContent.includes('editor-transition-check');
  }, {}, noteId);
  console.log('PASS collapsing an edited note saves, exits editing, and persists the draft');
  await page.evaluate(async noteId => {
    const {actionSelectNote} = await import('/static/js/modules/mode-manager/actions/selection-actions.js');
    await actionSelectNote(noteId, {
      initialCaretVisibility: 'visible',
      recordEditInteraction: false,
    });
  }, noteId);
  await page.waitForFunction(async noteId => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return ModeContextInstance.isEditing
      && ModeContextInstance.currentNoteId === noteId
      && !ModeContextInstance.isLoading;
  }, {}, noteId);
  await page.keyboard.type(' post-collapse-undo-check');
  await page.waitForFunction(() => document.querySelector('.note.editing .note-content').textContent.includes('post-collapse-undo-check'));
  assert.deepEqual(errors, []);
  for (const endOffset of [4, 1]) {
    const expectedSelection = await page.evaluate(endOffset => {
      const content = document.querySelector('.note.editing .note-content');
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      if (!text || text.length < 4) throw new Error('Expected editor text for Tab selection regression');
      const range = document.createRange();
      range.setStart(text, 1);
      range.setEnd(text, endOffset);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    }, endOffset);
    for (let count = 0; count < 3; count += 1) {
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => document.activeElement.classList.contains('note-tag-bar-input'));
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      await page.waitForFunction(() => document.activeElement.classList.contains('note-content'));
      assert.deepEqual(await page.evaluate(() => {
        const selection = window.getSelection();
        return [selection.toString(), selection.getRangeAt(0).startOffset, selection.getRangeAt(0).endOffset];
      }), [expectedSelection, 1, endOffset]);
      assert.deepEqual(errors, []);
    }
  }
  console.log('PASS repeated Tab/Shift+Tab preserves editor selections and caret positions');
  await page.keyboard.press('Escape');
  await page.waitForFunction(async () => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !ModeContextInstance.isEditing && !ModeContextInstance.isLoading;
  });
  await page.evaluate(async () => {
    const {actionUndo} = await import('/static/js/modules/mode-manager/actions/history-actions.js');
    await actionUndo();
  });
  await page.waitForFunction(() => {
    return document.body.textContent.includes('editor-transition-check')
      && !document.body.textContent.includes('post-collapse-undo-check');
  });
  assert.deepEqual(errors, []);
  console.log('PASS real editor input, save, deselection, and undo');

  await checkPastedHeadingFormatting(page);
  assert.deepEqual(errors, []);


  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.open();
  });
  await page.keyboard.type('help');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  for (const [method, args] of [['openKeyboardShortcutsHelp', []], ['openVersionInfo', []], ['openVersionInfo', []], ['openOntologyEditor', []], ['openReminders', [{search: ''}]], ['openCreateNamespace', []], ['openOpenNamespace', []], ['openManageNamespacePorts', []], ['openBackupRestore', []], ['openNoteLayoutAppearance', []], ['openSearchSuggestionStatistics', []], ['openReminders', [{search: ''}]], ['openOntologyEditor', []]]) {
    console.log(`Checking modal ${method}`);
    await page.evaluate(async ({method, args}) => {
      const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
      await CommandPalette[method](...args);
    }, {method, args});
    await page.waitForNetworkIdle({idleTime:100});
    if (method === 'openVersionInfo') {
      await page.waitForSelector('#version-info-modal .version-info-table');
      const version = await page.evaluate(async () => {
        const {CONFIG} = await import('/static/js/modules/config.js');
        const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
        const response = await fetch(CONFIG.API.AUTH.STATUS, {headers:buildSessionHeaders(false)});
        if (!response.ok) throw new Error('Version smoke status request failed');
        return (await response.json()).version;
      });
      assert.equal(await page.$eval('#version-info-modal .version-info-table td', cell => cell.textContent.trim()), version);
    }
    assert.deepEqual(errors, []);
    await page.keyboard.press('Escape');
    await page.waitForFunction(async () => {
      const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
      return ModeContextInstance.modalStack.length === 0;
    });
  }
  console.log('PASS palette navigation and modal open/close lifecycles');
  await checkAdditionalStateTransitions(page);
  await checkEditingShortcutSequences(page);
  await checkTagDoubleClickSelection(page);
  await checkBackgroundSortMenu(page);
  // After the sort menu check: its searches persist in search history.
  await checkSearchInputRejected(page);
  await checkDictationPaste(page);
  await checkFileDropPreviews(page);
  await checkFloatingNotes(page);
  await checkAiSelectedNote(page);
  assert.deepEqual(errors, []);

  await page.evaluate(async () => {
    const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {createTabOnServer, persistTabStateSnapshot} = await import('/static/js/modules/mode-manager/services/tab-state-service.js');
    const {switchToTabContext} = await import('/static/js/modules/mode-manager/events/keyboard-events.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    const originalTabId = state.activeTabId;
    await CommandGate.run('smoke.tabs', async () => {
      await persistTabStateSnapshot();
      const response = await createTabOnServer(originalTabId);
      state.hydrateTabState(response);
      await switchToTabContext(response.newTabId, {animateNoteChanges: false});
      if (state.activeTabId !== response.newTabId) throw new Error('New tab was not selected');
      await switchToTabContext(originalTabId, {animateNoteChanges: false});
      if (state.activeTabId !== originalTabId) throw new Error('Original tab was not restored');
    });
  });
  await page.waitForNetworkIdle({idleTime:100});
  assert.deepEqual(errors, []);
  console.log('PASS tab creation and switching with shared query and scroll values');


  const secondNoteId = await page.evaluate(async noteId => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const second = await NotesAPI.createNote(noteId, '');
    await NotesAPI.saveNote(second.id, '<p>Ordering smoke sibling</p>', '');
    await NotesAPI.moveNote(noteId, second.id, 'BEFORE', null);
    await NotesAPI.deleteNote(second.id);
    const restored = await NotesAPI.undo();
    if (restored.status !== 'success') throw new Error('Delete undo failed');
    return second.id;
  }, noteId);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await page.waitForFunction(() => document.body.textContent.includes('Ordering smoke sibling'));
  const orderedIds = await page.$$eval('.note[data-note-id]', notes => notes.map(note => note.dataset.noteId));
  assert(orderedIds.includes(noteId) && orderedIds.includes(secondNoteId), 'Expected both reordered notes');
  assert(orderedIds.indexOf(noteId) < orderedIds.indexOf(secondNoteId), 'Reload changed sibling ordering');
  console.log('PASS sibling move, delete/undo, and ordering after reload');

  await page.addScriptTag({url: `${origin}/static/js/vendor/markdown-it-14.3.2.min.js`});
  const vendorChecks = await page.evaluate(async () => {
    const dirty = '<img src="invalid" onerror="window.__auditXss=1"><script>window.__auditXss=1</script><p>safe</p>';
    const clean = window.DOMPurify.sanitize(dirty);
    const fragment = document.createElement('div');
    fragment.innerHTML = clean;
    const markdown = window.markdownit({html:false, linkify:true}).render('**strong** [bad](javascript:window.__auditXss=1)');
    const {loadMermaidApi, buildMermaidConfig} = await import('/static/js/modules/mode-manager/services/mermaid-render-service.js');
    const mermaid = await loadMermaidApi(document);
    mermaid.initialize(buildMermaidConfig('default'));
    const rendered = await mermaid.render('audit-mermaid', 'flowchart LR\nA[Start] --> B[Finish]');
    return {
      purifier: window.DOMPurify.version,
      clean: !fragment.querySelector('script,[onerror]') && clean.includes('safe'),
      markdown: markdown.includes('<strong>strong</strong>') && !markdown.includes('href="javascript:'),
      mermaid: rendered.svg.includes('<svg') && rendered.svg.includes('Finish'),
      executed: window.__auditXss === 1,
    };
  });
  assert.equal(vendorChecks.purifier, '3.4.16');
  assert(vendorChecks.clean && vendorChecks.markdown && vendorChecks.mermaid && !vendorChecks.executed);
  console.log('PASS actual vendored sanitization, Markdown rendering, and Mermaid rendering');

  const fileId = await page.evaluate(async () => {
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    const form = new FormData();
    form.append('file', new File(['browser fixture'], 'fixture.txt', {type:'text/plain'}));
    const uploaded = await fetch('/api2/files/upload', {method:'POST',headers:buildSessionHeaders(false),body:form});
    if (!uploaded.ok) throw new Error(`Upload failed: ${uploaded.status}`);
    const record = await uploaded.json();
    const downloaded = await fetch(`/api2/files/${record.file_id}/download`, {headers:buildSessionHeaders(false)});
    if (await downloaded.text() !== 'browser fixture') throw new Error('Attachment content mismatch');
    return record.file_id;
  });
  console.log('PASS browser attachment round-trip');

  const password = 'Smoke-only-password!2026';
  await page.evaluate(async password => {
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    const response = await fetch('/api2/auth/settings/password/create', {method:'POST', headers:buildSessionHeaders(true), body:JSON.stringify({password})});
    if (!response.ok) throw new Error(`Password setup failed: ${response.status}`);
  }, password);
  await page.reload();
  await page.waitForSelector('#login-panel[data-revealed="true"] #login-password', {visible:true});
  await page.type('#login-password', password);
  await page.click('#login-form button[type="submit"]');
  await Promise.race([page.waitForSelector('[data-app-ready="true"]', {timeout:30000}), pageFailure]);
  await page.waitForFunction(() => document.body.textContent.includes('Browser smoke original'));
  const backupFilename = await page.evaluate(async () => {
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    const response = await fetch('/api2/auth/backup/create', {method:'POST',headers:buildSessionHeaders(true)});
    if (!response.ok) throw new Error(`Backup failed: ${response.status}`);
    return (await response.json()).backup.filename;
  });
  const backupPath = join(directory,'namespaces','default','backups',backupFilename);
  const backupHash = createHash('sha256').update(await readFile(backupPath)).digest('hex');
  await page.evaluate(async ({noteId, backupFilename}) => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
    await NotesAPI.saveNote(noteId, '<p>Changed after backup</p>', '');
    const response = await fetch('/api2/auth/backup/restore', {method:'POST',headers:buildSessionHeaders(true),body:JSON.stringify({filename:backupFilename})});
    if (!response.ok) throw new Error(`Restore failed: ${response.status}`);
  }, {noteId, backupFilename});
  // Restore re-execs the same owned server process; observe its second startup.
  for (let attempt=0; attempt<300 && logs.split('Application startup complete.').length<3; attempt++) await delay(100);
  assert(logs.split('Application startup complete.').length>=3, 'Restored server did not restart');
  await page.reload();
  await page.waitForSelector('#login-panel[data-revealed="true"] #login-password', {visible:true});
  await page.type('#login-password', password);
  await page.click('#login-form button[type="submit"]');
  await Promise.race([page.waitForSelector('[data-app-ready="true"]', {timeout:30000}), pageFailure]);
  await page.waitForFunction(() => document.body.textContent.includes('Browser smoke original'));
  assert(!await page.evaluate(() => document.body.textContent.includes('Changed after backup')));
  assert.equal(createHash('sha256').update(await readFile(backupPath)).digest('hex'), backupHash);
  console.log('PASS encrypted backup restore, actual restart, reauthentication, and archive immutability');
  await page.evaluate(async () => { const {actionUndo} = await import('/static/js/modules/mode-manager/actions/history-actions.js'); await actionUndo(); });
  await page.waitForFunction(() => document.body.textContent.includes('No actions to undo'));
  console.log('PASS empty undo history shows an explanatory banner');
  await page.evaluate(async () => { const {Auth} = await import('/static/js/modules/auth.js'); await Auth.logout(); });
  await page.waitForSelector('#login-panel[data-revealed="true"] #login-password', {visible:true});
  console.log('PASS password setup, login, hydration, and logout');
  assert.deepEqual(errors, []);
  await writeFile(join(directory,'result.json'), JSON.stringify({passed:true,noteId,fileId}));
  console.log(`Browser smoke passed; disposable artifacts: ${directory}`);
  }
} catch (error) { // shockharness: ignore[EXC001] reason="the server and browser logs of the failed run are written, then the error is rethrown unchanged"
  await writeFile(join(directory,'server.log'), logs);
  await writeFile(join(directory,'browser.log'), browserDiagnostics.join('\n'));
  console.error(`Browser smoke failed; disposable logs: ${directory}`);
  throw error;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  const stopped = new Promise(resolve => server.once('exit', resolve));
  await Promise.race([stopped, delay(5000)]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}
