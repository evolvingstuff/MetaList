// MetaList is idle: nothing is loading and no command is running. The one
// definition the browser suites wait on, so a new idle condition is added once.
export async function waitForAppIdle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return !mode.isLoading && !CommandGate.isBusy();
  });
}
