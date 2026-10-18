// MetaList is idle: nothing is loading and no command is running. The one
// definition the browser suites wait on, so a new idle condition is added once.
export async function waitForAppIdle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    return !mode.isLoading && !CommandGate.isBusy();
  });
}

// The page has stopped moving: MetaList is idle, the network is quiet, and for
// STILL_FOR_MS no command has run, no Mermaid diagram has been rendering, no image in
// view has been loading, and the scroll position, page height and every note's top
// have stayed the same. That is longer than the slowest timer MetaList starts work or
// moves anything with (a note animation's 320 ms fallback, the search that runs 300 ms
// after typing stops, the 180 ms follow-up scroll, CSS transitions of at most 200 ms),
// so late work still starts, and a late jump still lands, before this returns. It
// replaces fixed settle pauses, which waited the worst case every time.
const STILL_FOR_MS = 500;
// A page still moving after this long fails the check instead of hanging it.
const SETTLE_DEADLINE_MS = 10000;
const SETTLE_NETWORK_IDLE_MS = 300;

export async function waitForPageSettled(page) {
  await waitForAppIdle(page);
  await page.waitForNetworkIdle({idleTime: SETTLE_NETWORK_IDLE_MS});
  await page.evaluate(async ({stillForMs, deadlineMs}) => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    await new Promise((resolve, reject) => {
      const inView = element => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      };
      const observe = () => ({
        layout: [window.scrollY, document.documentElement.scrollHeight,
          ...[...document.querySelectorAll('.note[data-note-id]')].map(note => Math.round(note.getBoundingClientRect().top))].join(','),
        isBusy: mode.isLoading || CommandGate.isBusy()
          || document.querySelector('[data-mermaid-state="rendering"]') !== null
          || [...document.images].some(image => inView(image) && !image.complete),
      });
      const startedAt = performance.now();
      let last = observe();
      let stillSince = startedAt;
      const check = () => {
        const now = performance.now();
        const current = observe();
        if (current.layout !== last.layout || current.isBusy) {
          last = current;
          stillSince = now;
        } else if (now - stillSince >= stillForMs) {
          resolve();
          return;
        }
        if (now - startedAt > deadlineMs) {
          reject(new Error(`The page was still moving or rendering after ${deadlineMs} ms`));
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }, {stillForMs: STILL_FOR_MS, deadlineMs: SETTLE_DEADLINE_MS});
}
