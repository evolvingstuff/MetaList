import assert from 'node:assert/strict';

async function windowPoint(page, id, selector) {
  return page.evaluate((id, selector) => {
    const element = document.querySelector(`[data-floating-note-id="${id}"]`).shadowRoot.querySelector(selector);
    const rect = element.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  }, id, selector);
}

async function readRect(page, id) {
  return page.$eval(`[data-floating-note-id="${id}"]`, node => {
    const {x, y, width, height} = node.getBoundingClientRect();
    return {x, y, width, height};
  });
}

async function waitForWindowText(page, id, text) {
  await page.waitForFunction((id, text) => {
    const host = document.querySelector(`[data-floating-note-id="${id}"]`);
    return host !== null && host.shadowRoot.textContent.includes(text);
  }, {}, id, text);
}

export async function checkFloatingNotes(page) {
  const fixture = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const parent = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(parent.id, 'Floating parent excluded', 'floating-fixture');
    const root = await NotesAPI.createChild(parent.id, '');
    await NotesAPI.saveNote(root.id, `<p>Floating root <a href="${location.origin}/static/css/main.css?floating-link-test">Example link</a></p>`, '');
    const child = await NotesAPI.createChild(root.id, '');
    await NotesAPI.saveNote(child.id, 'Floating child original', '');
    const password = await NotesAPI.createChild(child.id, '');
    await NotesAPI.saveNote(password.id, 'floating-test-password', '@password');
    await NotesAPI.setCollapsedBulk([parent.id, root.id, child.id], false);
    return {parent: parent.id, root: root.id, child: child.id, password: password.id};
  });
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await page.evaluate(async root => {
    const {openNoteFullscreen} = await import('/static/js/modules/mode-manager/services/note-fullscreen-service.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    await CommandGate.run('smoke.fullscreen-layout', () => openNoteFullscreen(root));
  }, fixture.root);
  const gap = await page.$eval('.note-fullscreen-tree > .note', root => {
    const content = root.querySelector(':scope > .note-content').getBoundingClientRect();
    const child = root.querySelector(':scope > .note-children').getBoundingClientRect();
    return child.top - content.bottom;
  });
  assert(gap >= 0 && gap < 32, `Fullscreen title-to-children gap: ${gap}px`);
  await page.keyboard.press('Escape');

  await page.click(`[data-note-id="${fixture.root}"] > .note-content`, {button: 'right'});
  const menuIndex = await page.$$eval('#context-menu .context-menu-item', nodes => {
    const button = nodes.find(node => node.textContent === 'Open in Floating Window');
    if (!button) throw new Error('Floating note context action missing');
    return button.dataset.index;
  });
  await page.click(`#context-menu [data-index="${menuIndex}"]`);
  await page.waitForSelector('.floating-note-window');
  const first = await page.$eval('.floating-note-window', host => host.dataset.floatingNoteId);
  await waitForWindowText(page, first, 'Floating child original');
  assert.equal(await page.$eval('.floating-note-window', host => host.shadowRoot.textContent.includes('Floating parent excluded')), false);
  assert.equal(await page.$eval('.floating-note-window', host => host.shadowRoot.querySelectorAll('.note').length), 3);
  await page.waitForNetworkIdle({idleTime: 100});
  const second = await page.evaluate(async root => {
    const {openFloatingNote} = await import('/static/js/modules/mode-manager/services/floating-note-service.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return CommandGate.run('smoke.floating-second', () => openFloatingNote(root));
  }, fixture.child);
  await waitForWindowText(page, second, 'Floating child original');
  await page.waitForNetworkIdle({idleTime: 100});

  // Real pointer drags move and resize independently of document scrolling.
  const before = await readRect(page, second);
  const header = await windowPoint(page, second, '.floating-note-drag-handle');
  await page.mouse.move(header.x, header.y);
  await page.mouse.down();
  await page.mouse.move(header.x + 60, header.y + 30, {steps: 4});
  await page.mouse.up();
  const moved = await readRect(page, second);
  assert.equal(moved.x, before.x + 60);
  assert.equal(moved.y, before.y + 30);
  const handle = await windowPoint(page, second, '.floating-note-resize');
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 40, handle.y + 30, {steps: 4});
  await page.mouse.up();
  const resized = await readRect(page, second);
  assert.equal(resized.width, moved.width + 40);
  assert.equal(resized.height, moved.height + 30);
  await page.evaluate(() => { document.body.style.minHeight = '2400px'; window.scrollTo(0, 700); });
  assert.deepEqual(await readRect(page, second), resized);
  await page.evaluate(() => { document.body.style.minHeight = ''; window.scrollTo(0, 0); });

  // Native links remain live; password copying uses the real handler with a
  // test clipboard so the user's system clipboard is never overwritten.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async text => { window.floatingCopiedText = text; }}});
  });
  const credential = await windowPoint(page, second, '.meta-credential-value');
  await page.mouse.click(credential.x, credential.y);
  await page.waitForFunction(() => window.floatingCopiedText === 'floating-test-password');
  assert.equal(await page.evaluate(async () => {
    const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
    return state.isEditing;
  }), false);
  const link = await page.$eval(`[data-floating-note-id="${first}"]`, host => {
    const link = host.shadowRoot.querySelector('a[href*="floating-link-test"]');
    return {target: link.target, href: link.href, events: getComputedStyle(link).pointerEvents};
  });
  assert.equal(link.target, '_blank');
  assert.notEqual(link.events, 'none');
  const headerFirst = await windowPoint(page, first, '.floating-note-drag-handle');
  await page.mouse.click(headerFirst.x, headerFirst.y);
  const linkPoint = await windowPoint(page, first, 'a[href*="floating-link-test"]');
  const openedTarget = page.browser().waitForTarget(target => target.url().includes('floating-link-test'));
  await page.mouse.click(linkPoint.x, linkPoint.y);
  const linkPage = await (await openedTarget).page();
  await linkPage.close();
  await page.bringToFront();
  assert.equal((await page.$$('.floating-note-window')).length, 2);
  await page.screenshot({path: '/tmp/metalist-floating-windows.png'});

  await page.evaluate(async parent => {
    const {actionSelectNote} = await import('/static/js/modules/mode-manager/actions/selection-actions.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    await CommandGate.run('smoke.floating-background-editor', () => actionSelectNote(parent, {initialCaretVisibility: 'visible'}));
  }, fixture.parent);
  const beforeEditor = await page.$eval(`[data-note-id="${fixture.parent}"] > .note-content`, node => node.innerHTML);
  const firstCredential = await windowPoint(page, first, '.meta-credential-value');
  await page.mouse.click(firstCredential.x, firstCredential.y);
  await page.keyboard.type('must-not-edit-background');
  assert.equal(await page.$eval(`[data-note-id="${fixture.parent}"] > .note-content`, node => node.innerHTML), beforeEditor);
  assert.equal(await page.evaluate(async () => {
    const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
    return state.isEditing;
  }), true);
  await page.evaluate(async () => {
    const {actionDeselectNote} = await import('/static/js/modules/mode-manager/actions/selection-actions.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    await CommandGate.run('smoke.floating-background-deselect', () => actionDeselectNote());
  });

  await page.evaluate(async fixture => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.saveNote(fixture.child, 'Floating child changed live', '');
  }, fixture);
  await waitForWindowText(page, first, 'Floating child changed live');
  await waitForWindowText(page, second, 'Floating child changed live');
  assert.equal(await page.$eval(`[data-floating-note-id="${second}"]`, host => host.shadowRoot.querySelector('.floating-note-title').textContent), '↗ Floating child changed live');

  await page.click('#search-input');
  await page.type('#search-input', 'floating-query-with-no-matches');
  await page.waitForFunction(async () => {
    const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !state.isLoading && state.getExecutedSearchQuery() === 'floating-query-with-no-matches';
  });
  assert.equal((await page.$$('.floating-note-window')).length, 2);
  assert.deepEqual(await readRect(page, second), resized);
  await page.$eval('#search-input', input => { input.focus(); input.select(); });
  await page.keyboard.press('Backspace');
  await page.waitForFunction(async () => {
    const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !state.isLoading && state.getExecutedSearchQuery() === '';
  });
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {createTabOnServer, persistTabStateSnapshot} = await import('/static/js/modules/mode-manager/services/tab-state-service.js');
    const {switchToTabContext} = await import('/static/js/modules/mode-manager/events/keyboard-events.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    await CommandGate.run('smoke.floating-tabs', async () => {
      const original = state.activeTabId;
      await persistTabStateSnapshot();
      const response = await createTabOnServer(original);
      state.hydrateTabState(response);
      await switchToTabContext(response.newTabId, {animateNoteChanges: false});
      await switchToTabContext(original, {animateNoteChanges: false});
    });
  });
  assert.equal((await page.$$('.floating-note-window')).length, 2);

  // The header follows the source using regular ML3 reference navigation,
  // leaving both floating windows and their geometry intact.
  const originalTab = await page.evaluate(async () => {
    const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
    return state.activeTabId;
  });
  const sourceLink = await windowPoint(page, first, '.floating-note-title');
  await page.mouse.click(sourceLink.x, sourceLink.y);
  await page.waitForFunction(async (original, root) => {
    const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !state.isLoading && state.activeTabId !== original && state.getExecutedSearchQuery().includes(root);
  }, {}, originalTab, fixture.root);
  assert.equal((await page.$$('.floating-note-window')).length, 2);
  assert.deepEqual(await readRect(page, second), resized);
  await page.evaluate(async () => {
    const {navigateBackFromReferenceContext} = await import('/static/js/modules/mode-manager/events/keyboard-events.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    await CommandGate.run('smoke.floating-source-back', () => navigateBackFromReferenceContext());
  });
  const passwordTitle = await page.evaluate(async password => {
    const {openFloatingNote, closeFloatingNote} = await import('/static/js/modules/mode-manager/services/floating-note-service.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    const id = await CommandGate.run('smoke.floating-password-title', () => openFloatingNote(password));
    const title = document.querySelector(`[data-floating-note-id="${id}"]`).shadowRoot.querySelector('.floating-note-title').textContent;
    closeFloatingNote(id);
    return title;
  }, fixture.password);
  assert(passwordTitle.includes('••••'));
  assert(!passwordTitle.includes('floating-test-password'));

  await page.evaluate(async child => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.deleteNote(child);
  }, fixture.child);
  await waitForWindowText(page, second, 'This note was deleted.');
  await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.undo();
  });
  await waitForWindowText(page, second, 'Floating child changed live');
  const close = await windowPoint(page, second, '.floating-note-close');
  await page.mouse.click(close.x, close.y);
  assert.equal((await page.$$('.floating-note-window')).length, 1);
  await page.evaluate(async () => {
    const {closeAllFloatingNotes} = await import('/static/js/modules/mode-manager/services/floating-note-service.js');
    closeAllFloatingNotes();
    closeAllFloatingNotes();
    delete navigator.clipboard;
    delete window.floatingCopiedText;
  });
  assert.equal((await page.$$('.floating-note-window')).length, 0);
  console.log('PASS floating windows: subtree, drag, resize, scroll, copy, live updates, searches/tabs, delete/undo, cleanup; fullscreen spacing');
}
