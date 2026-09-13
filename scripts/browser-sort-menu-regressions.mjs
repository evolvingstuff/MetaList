import assert from 'node:assert/strict';

async function openSortMenu(page) {
  const {width} = page.viewport();
  await page.mouse.click(width - 2, 180, {button: 'right'});
  await page.waitForSelector('#context-menu.is-visible');
  const buttons = await page.$$('#context-menu .context-menu-item');
  const labels = await Promise.all(buttons.map(button => button.evaluate(node => node.textContent)));
  const index = labels.findIndex(label => label.startsWith('Sort by'));
  assert(index >= 0, 'Background context menu must offer Sort by');
  await buttons[index].click();
  await page.waitForSelector('#context-submenu.is-visible');
}

async function waitForSortMode(page, expectedMode) {
  await page.waitForFunction(async mode => {
    const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !state.isLoading && state.activeTabSortMode === mode;
  }, {}, expectedMode);
}

export async function checkBackgroundSortMenu(page) {
  const modes = ['normal', 'created', 'updated', 'alphabetical', 'content-volume'];
  await waitForSortMode(page, 'normal');
  const tabId = await page.evaluate(async () => {
    const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
    return state.activeTabId;
  });
  let currentMode = 'normal';
  for (const nextMode of ['created', 'updated', 'alphabetical', 'content-volume', 'normal']) {
    console.log(`Checking background sort ${currentMode} -> ${nextMode}`);
    await openSortMenu(page);
    const buttons = await page.$$('#context-submenu .context-menu-item');
    assert.equal(buttons.length, modes.length);
    const disabledLabels = await page.$$eval('#context-submenu button:disabled', nodes => nodes.map(node => node.textContent));
    assert.equal(disabledLabels.length, 1);
    assert.match(disabledLabels[0], /\(current\)$/);
    assert.equal(await buttons[modes.indexOf(currentMode)].evaluate(node => node.disabled), true);
    await buttons[modes.indexOf(nextMode)].click();
    await waitForSortMode(page, nextMode);
    if (nextMode === 'content-volume') {
      await page.reload();
      await page.waitForSelector('[data-app-ready="true"]');
      await waitForSortMode(page, nextMode);
      await page.evaluate(async () => {
        const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
        const {createTabOnServer, persistTabStateSnapshot} = await import('/static/js/modules/mode-manager/services/tab-state-service.js');
        const {switchToTabContext} = await import('/static/js/modules/mode-manager/events/keyboard-events.js');
        const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
        const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
        const originalTabId = state.activeTabId;
        await CommandGate.run('smoke.sorted-tabs', async () => {
          await persistTabStateSnapshot();
          const response = await createTabOnServer(originalTabId);
          state.hydrateTabState(response);
          await switchToTabContext(response.newTabId, {animateNoteChanges: false});
          await CommandPalette.setSortMode('updated');
          await switchToTabContext(originalTabId, {animateNoteChanges: false});
          if (state.activeTabSortMode !== 'content-volume') throw new Error('Tab A lost its sort mode');
          await switchToTabContext(response.newTabId, {animateNoteChanges: false});
          if (state.activeTabSortMode !== 'updated') throw new Error('Tab B lost its sort mode');
          await switchToTabContext(originalTabId, {animateNoteChanges: false});
        });
      });
      await page.waitForNetworkIdle({idleTime:100});
      await waitForSortMode(page, nextMode);
    }
    currentMode = nextMode;
  }
  assert.equal(await page.evaluate(async () => {
    const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
    return state.activeTabId;
  }), tabId);
  console.log('PASS background sort menu: all modes, active mode, reload persistence, return to normal');
}
