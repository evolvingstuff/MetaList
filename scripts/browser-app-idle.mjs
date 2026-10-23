// Counts the page's requests from inside the page, where a request ends when its
// fetch settles, aborted or not. Every request MetaList sends is a fetch (it uses
// no XMLHttpRequest, beacon, EventSource or socket). Puppeteer's own count, which
// page.waitForNetworkIdle reads, can lose a request the page aborts as it starts
// while request interception is on (browser-smoke.mjs turns it on for the update
// fixture), and then never reaches idle again. Runs before any page script, on
// every load of the page. Times are Date.now(), so the suite's clock compares.
export async function installRequestMonitor(page) {
  await page.evaluateOnNewDocument(() => {
    // lastActivityAt: when a request last started or ended, or a quiet wait last
    // saw MetaList busy.
    const requests = {inFlight: 0, lastActivityAt: Date.now()};
    Object.defineProperty(window, '__metalistRequests', {value: requests});
    const pageFetch = window.fetch;
    const changed = delta => {
      requests.inFlight += delta;
      requests.lastActivityAt = Date.now();
    };
    window.fetch = (...args) => {
      changed(1);
      return pageFetch.apply(window, args).finally(() => changed(-1));
    };
  });
}

// Runs in the page. MetaList is idle: nothing is loading, no command is running,
// no search is waiting for its typing delay and no dictation paste is being
// cleaned up (those two run outside CommandGate). With `quiet`, it has also been
// quiet for quiet.quietMs since the wait started at quiet.startedAt: idle at every
// check, no request in flight, none started or ended, and nothing else loading
// (images, a floating window's stylesheets, fonts). That covers what MetaList
// sends outside CommandGate after a command (saving the tab state 300 ms after a
// search, recording a view, loading suggestions) and work a timer starts within
// the window (as page.waitForNetworkIdle, the window starts no earlier than the wait).
// MetaList loads no image lazily, so every image completes (a broken one too).
async function isAppIdle(quiet) {
  const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
  const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
  const {isDebouncedSearchPending} = await import('/static/js/modules/mode-manager/services/search-debounce-service.js');
  const {isDictationCleanupInProgress} = await import('/static/js/modules/mode-manager/services/dictation-paste-service.js');
  const idle = !mode.isLoading && !CommandGate.isBusy() && !isDebouncedSearchPending() && !isDictationCleanupInProgress();
  if (quiet === null) return idle;
  const requests = window.__metalistRequests;
  if (requests === undefined) throw new Error('installRequestMonitor must run before the page loads');
  // A floating note window is the one shadow root, with its own stylesheets and images.
  const roots = [document, ...[...document.querySelectorAll('.floating-note-window')].map(host => host.shadowRoot)];
  const isLoading = requests.inFlight > 0 || document.fonts.status === 'loading'
    || roots.some(root => [...root.querySelectorAll('img')].some(image => !image.complete)
      || [...root.querySelectorAll('link[rel="stylesheet"]')].some(link => link.sheet === null));
  if (!idle || isLoading) {
    requests.lastActivityAt = Date.now();
    return false;
  }
  return Date.now() - Math.max(requests.lastActivityAt, quiet.startedAt) >= quiet.quietMs;
}

// The one definition of idle the browser suites wait on, so a new idle condition
// is added once.
export async function waitForAppIdle(page) {
  await page.waitForFunction(isAppIdle, {}, null);
}

// MetaList is idle and has been quiet for quietMs (see isAppIdle): what a step
// waits for before it reloads, reads the server, or checks that nothing else changes.
export async function waitForAppQuiet(page, quietMs) {
  await page.waitForFunction(isAppIdle, {}, {quietMs, startedAt: Date.now()});
}

// waitForAppQuiet, failing after timeoutMs instead of the page's default timeout.
export async function waitForAppQuietWithin(page, quietMs, timeoutMs) {
  await page.waitForFunction(isAppIdle, {timeout: timeoutMs}, {quietMs, startedAt: Date.now()});
}

// The page has stopped moving: MetaList is idle, its requests are quiet, and for
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
// Shorter than STILL_FOR_MS on purpose: an open floating note window asks for its
// note every 500 ms, so requests are never quiet for that long while one is open.
const SETTLE_REQUESTS_QUIET_MS = 300;

export async function waitForPageSettled(page) {
  await waitForAppQuiet(page, SETTLE_REQUESTS_QUIET_MS);
  await page.evaluate(async ({stillForMs, deadlineMs}) => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const {CommandGate} = await import('/static/js/modules/mode-manager/services/command-gate-service.js');
    await new Promise((resolve, reject) => {
      const inView = element => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      };
      const observe = () => {
        const busyReasons = [
          mode.isLoading,
          CommandGate.isBusy(),
          document.querySelector('[data-mermaid-state="rendering"]') !== null,
          [...document.images].some(image => inView(image) && !image.complete),
        ];
        return {
          layout: [window.scrollY, document.documentElement.scrollHeight,
            ...[...document.querySelectorAll('.note[data-note-id]')].map(note => Math.round(note.getBoundingClientRect().top))].join(','),
          isBusy: busyReasons.includes(true),
        };
      };
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
