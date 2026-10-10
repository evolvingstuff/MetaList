/** Validate the actual installed application in a release browser. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import puppeteer from 'puppeteer-core';

const [
  browserName, executablePath, outputDirectory,
  coldRunsText, reloadsText, validateLoginText, ...origins
] = process.argv.slice(2);
assert(['chrome', 'firefox', 'edge'].includes(browserName), `Unsupported release browser: ${browserName}`);
assert(executablePath && outputDirectory && origins.length === 2, 'Expected browser, executable path, output directory, and two namespace URLs');
assert(/^\d+$/.test(coldRunsText) && Number(coldRunsText) >= 1, 'Cold runs must be a positive integer');
assert(/^\d+$/.test(reloadsText) && Number(reloadsText) >= 1, 'Reloads must be a positive integer');
assert(['0', '1'].includes(validateLoginText), 'Encrypted-login validation must be 0 or 1');
const coldRuns = Number(coldRunsText);
const reloads = Number(reloadsText);
const validateEncryptedLogin = validateLoginText === '1';
const protocols = new Set(origins.map(origin => new URL(origin).protocol));
assert.equal(protocols.size, 1, 'Both browser namespaces must use the same transport');
const [protocol] = protocols;
assert(['http:', 'https:'].includes(protocol), `Unsupported browser transport: ${protocol}`);
for (const origin of origins) {
  const url = new URL(origin);
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (protocol === 'http:') assert(isLoopback, 'Plain HTTP browser validation must stay on loopback');
  else assert(!isLoopback, 'HTTPS browser validation must exercise a non-loopback address');
}
await mkdir(outputDirectory, {recursive: true});
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  browser: browserName === 'firefox' ? 'firefox' : 'chrome',
  // The hosted Windows runner can take longer than Puppeteer's 30-second
  // default to expose the DevTools endpoint while the release matrix is busy.
  // Keep the bound finite and surface browser stderr if it is exceeded.
  timeout: 60000,
  dumpio: true,
  // Hosted Windows images may configure a system proxy that intermittently
  // intercepts private-LAN URLs. These origins are the local test server and
  // must be exercised directly; Firefox already bypasses local addresses.
  args: browserName === 'firefox' ? [] : ['--no-proxy-server'],
});
const version = await browser.version();
console.log(`Release browser: ${browserName}; executable: ${executablePath}; version: ${version}`);
const diagnostics = [];

async function checkPage(context, origin, coldRun) {
  const page = await context.newPage();
  const errors = [];
  const scripts = new Set();
  let navigationInProgress = false;
  page.on('pageerror', error => errors.push(`JavaScript: ${error.message}`));
  page.on('requestfailed', request => {
    const errorText = request.failure()?.errorText;
    const isCanceledByNavigation = navigationInProgress
      && ['NS_BINDING_ABORTED', 'net::ERR_ABORTED'].includes(errorText);
    if (isCanceledByNavigation) {
      diagnostics.push({origin, coldRun, ignoredNavigationCancellation: request.url(), errorText});
      return;
    }
    errors.push(`${request.url()}: ${errorText}`);
  });
  page.on('response', response => {
    const responseUrl = new URL(response.url());
    // A delivered 503 from this optional check is the documented PyPI-outage result.
    // Transport failures, missing routes, and every startup asset failure still fail the gate.
    const releaseUnavailable = responseUrl.pathname === '/api2/auth/app-update/check' && response.status() === 503;
    if (releaseUnavailable) diagnostics.push({origin, coldRun, releaseCheck: 'PyPI unavailable'});
    if (responseUrl.origin === new URL(origin).origin && response.status() >= 400 && !releaseUnavailable) {
      errors.push(`${response.url()}: HTTP ${response.status()}`);
    }
    if (responseUrl.origin === new URL(origin).origin && responseUrl.pathname.endsWith('.js')) scripts.add(response.url());
  });
  await page.setCacheEnabled(false);
  try {
    for (let reload = 0; reload < reloads; reload += 1) {
      scripts.clear();
      errors.length = 0;
      navigationInProgress = true;
      try {
        if (reload === 0) await page.goto(origin, {waitUntil: 'domcontentloaded', timeout: 30000});
        else await page.reload({waitUntil: 'domcontentloaded', timeout: 30000});
        await page.waitForSelector('[data-app-ready="true"]', {timeout: 30000});
      } finally {
        navigationInProgress = false;
      }
      await page.waitForNetworkIdle({idleTime: 500, timeout: 30000});
      assert(scripts.size > 20, `Expected a real module graph, received ${scripts.size} script URLs`);
      assert.deepEqual(errors, [], `Startup failed for ${origin}`);
      assert(await page.$eval('#main-app', element => element.getBoundingClientRect().height > 0), 'Application is blank or hidden');
      diagnostics.push({origin, coldRun, reload, scripts: scripts.size, passed: true});
    }
  } catch (error) {
    diagnostics.push({origin, coldRun, errors, failure: error.message});
    await page.screenshot({path: join(outputDirectory, `failure-${new URL(origin).port}-${coldRun}.png`)});
    throw error;
  } finally {
    await page.close();
  }
}

// A login-style screen reserves no scrollbar strip: nothing there scrolls, and
// with always-visible scrollbars the strip showed white at the right edge and
// shifted the logo 7.5px until the next layout (main.css, html:has(.login-page)).
// The app keeps its strip so the notes do not shift when the list starts to scroll.
async function assertLoginScreenUsesFullWidth(target, label) {
  const layout = await target.evaluate(() => {
    const logo = document.querySelector('.login-logo').getBoundingClientRect();
    return {
      gutter: getComputedStyle(document.documentElement).scrollbarGutter,
      screenWidth: document.querySelector('.login-page').getBoundingClientRect().width,
      windowWidth: window.innerWidth,
      logoCenter: logo.x + logo.width / 2,
    };
  });
  assert.equal(layout.gutter, 'auto', `${label}: the login screen must not reserve a scrollbar strip`);
  assert.equal(layout.screenWidth, layout.windowWidth, `${label}: the login screen must fill the window`);
  assert.equal(layout.logoCenter, layout.windowWidth / 2, `${label}: the logo must be centered in the window`);
}

async function assertAppKeepsScrollbarStrip(target, label) {
  const gutter = await target.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter);
  assert.equal(gutter, 'stable', `${label}: the app must keep its scrollbar strip`);
}

// Picking another namespace on the login screen loads it in this tab (no new
// tab): everything under the logo goes in the same frame and the logo stays
// still; a failure brings the panel back as it was; Back returns to the previous
// namespace (docs/ui/login-screen.md, Switching namespace). The open request is answered in the page, so no namespace server
// is started or restarted: slowly with this namespace's own address (its login
// screen stands in for the other one), or with a refusal.
async function checkNamespaceSwitchStaysInTab(context, page) {
  const loginState = () => page.evaluate(() => {
    const logo = document.getElementById('login-logo').getBoundingClientRect();
    const select = document.getElementById('login-namespace-select');
    const status = document.getElementById('login-namespace-status');
    const panel = document.getElementById('login-panel');
    const note = document.getElementById('login-opening-note');
    return {
      panelRevealed: panel.dataset.revealed,
      panelOpacity: getComputedStyle(panel).opacity,
      note: note.hidden ? '' : note.textContent,
      logo: [logo.x, logo.y, logo.width, logo.height],
      selected: select.value,
      disabled: select.disabled,
      status: status.hidden ? '' : status.textContent,
      statusState: status.dataset.state,
      formShown: !document.getElementById('login-form-view').hidden,
      loadingShown: !document.getElementById('login-loading').hidden,
      historyLength: history.length,
      path: location.pathname + location.search,
    };
  });
  const answerOpenRequests = mode => page.evaluate(answer => {
    const switchOption = document.createElement('option');
    switchOption.value = 'switch-check';
    switchOption.textContent = 'switch-check';
    document.getElementById('login-namespace-select').append(switchOption);
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
      if (url.pathname !== '/api2/auth/login-namespaces/open') return originalFetch(...args);
      if (answer === 'refuse') {
        return new Response(JSON.stringify({detail: 'Namespace switch-check is not available'}),
          {status: 400, headers: {'Content-Type': 'application/json'}});
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
      return new Response(JSON.stringify({namespace: 'switch-check', action: 'opened-running', url: location.origin + '/', message: 'Opened'}),
        {status: 200, headers: {'Content-Type': 'application/json'}});
    };
  }, mode);
  const openedTargets = [];
  const recordTarget = target => openedTargets.push(target.url());
  context.on('targetcreated', recordTarget);
  try {
    const before = await loginState();

    await answerOpenRequests('refuse');
    await page.select('#login-namespace-select', 'switch-check');
    await page.waitForFunction(() => document.getElementById('login-namespace-status').dataset.state === 'error', {timeout: 10000});
    const refused = await loginState();
    assert.deepEqual(openedTargets, [], 'Switching namespace must not open a tab');
    assert.equal(refused.status, 'Failed to open namespace: Namespace switch-check is not available');
    assert.equal(refused.selected, before.selected, 'A refused switch must put the dropdown back');
    assert.equal(refused.disabled, false);
    assert.deepEqual([refused.formShown, refused.loadingShown], [true, false], 'A refused switch must leave the form in place');
    assert.equal(refused.panelRevealed, 'true', 'A refused switch brings the panel back');
    assert.equal(refused.note, '', 'A refused switch removes the Starting line');
    assert.deepEqual(refused.logo, before.logo, 'A refused switch must not move the logo');
    assert.equal(refused.path, before.path);

    await page.reload({waitUntil: 'domcontentloaded', timeout: 30000});
    await page.waitForSelector('#login-panel[data-revealed="true"] #login-password', {visible: true, timeout: 30000});
    const reloaded = await loginState();
    await answerOpenRequests('slow');
    const pickedAt = Date.now();
    const switched = page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 30000});
    await page.select('#login-namespace-select', 'switch-check');
    const waiting = await loginState();
    assert.equal(waiting.panelRevealed, 'false', 'Everything under the logo goes when a namespace is picked');
    assert.equal(waiting.panelOpacity, '0', 'The panel is gone in the same frame, with no fade-out');
    assert.equal(waiting.disabled, true, 'The dropdown waits while the namespace answers');
    assert.equal(waiting.note, 'Starting switch-check…');
    assert.deepEqual(waiting.logo, reloaded.logo, 'The logo stays in place when the panel goes');
    const earlyNote = await page.evaluate(() => {
      const note = document.getElementById('login-opening-note');
      const [fade] = note.getAnimations();
      return {early: fade.currentTime < 1000, opacity: getComputedStyle(note).opacity};
    });
    if (earlyNote.early) assert.equal(earlyNote.opacity, '0', 'The Starting line waits a second');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('login-opening-note')).opacity === '1', {timeout: 10000});
    assert(Date.now() - pickedAt >= 900, 'The Starting line waits a second');
    await switched;
    await page.waitForSelector('#login-panel[data-revealed="true"] #login-password', {visible: true, timeout: 30000});
    const arrived = await loginState();
    assert.deepEqual(openedTargets, [], 'Switching namespace must not open a tab');
    assert.deepEqual(arrived.logo, reloaded.logo, 'The logo stays in place across the switch');
    assert.equal(arrived.historyLength, reloaded.historyLength + 1, 'The switch is one Back step');
    assert.equal(arrived.path, '/', 'The switch arrives on the namespace login screen');
    await assertLoginScreenUsesFullWidth(page, 'login screen after switching namespace');

    await page.goBack({waitUntil: 'domcontentloaded', timeout: 30000});
    await page.waitForSelector('#login-panel[data-revealed="true"] #login-password', {visible: true, timeout: 30000});
    const back = await loginState();
    assert.equal(back.selected, reloaded.selected, 'Back returns to the previous namespace');
    assert.equal(back.disabled, false, 'Back returns to a usable dropdown');
    assert.equal(back.status, '');
    assert.equal(back.panelRevealed, 'true', 'Back returns to a shown panel');
    assert.equal(back.note, '');
    assert.deepEqual(back.logo, reloaded.logo);
  } finally {
    context.off('targetcreated', recordTarget);
  }
}

async function checkEncryptedLogin(context, origin) {
  const page = await context.newPage();
  const errors = [];
  let stage = 'opening encrypted workspace';
  let removeStoredIdentity = null;
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  const password = 'Disposable-browser-login!2026';
  try {
    await page.goto(origin, {waitUntil: 'domcontentloaded', timeout: 30000});
    stage = 'waiting for initial workspace readiness';
    await page.waitForSelector('[data-app-ready="true"]', {timeout: 30000});
    await assertAppKeepsScrollbarStrip(page, 'passwordless app');
    stage = 'creating encrypted workspace password';
    await page.evaluate(async value => {
      const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
      const response = await fetch('/api2/auth/settings/password/create', {
        method: 'POST', headers: buildSessionHeaders(true), body: JSON.stringify({password: value}),
      });
      if (!response.ok) throw new Error(`Password setup failed: ${response.status}`);
    }, password);
    for (removeStoredIdentity of [false, true]) {
      stage = `reloading encrypted login (removeStoredIdentity=${removeStoredIdentity})`;
      await page.reload({waitUntil: 'domcontentloaded', timeout: 30000});
      await assertLoginScreenUsesFullWidth(page, 'login screen as it opens');
      stage = `waiting for login form (removeStoredIdentity=${removeStoredIdentity})`;
      await page.waitForSelector('#login-panel[data-revealed="true"] #login-password', {visible: true, timeout: 30000});
      await assertLoginScreenUsesFullWidth(page, 'login screen with its panel shown');
      if (!removeStoredIdentity) {
        // The tab that opens another namespace shows the login screen's logo exactly
        // where that namespace's login screen puts it, so its arrival only fades the
        // panel in (namespace-loading-page.js); the "Starting" line waits a second.
        stage = 'opening the namespace-opening tab';
        const popupOpened = new Promise(resolve => page.once('popup', resolve));
        await page.evaluate(async () => {
          const {renderNamespaceLoadingTab} = await import('/static/js/modules/modals/namespace-loading-page.js');
          renderNamespaceLoadingTab(window.open('about:blank', '_blank'), 'other');
        });
        const openingTab = await popupOpened;
        try {
          await openingTab.setViewport(page.viewport());
          const logoBox = selector => {
            const box = document.querySelector(selector).getBoundingClientRect();
            return [box.x, box.y, box.width, box.height];
          };
          const loginLogo = await page.evaluate(logoBox, '#login-logo');
          const openingLogo = await openingTab.evaluate(logoBox, '.login-logo');
          assert.deepEqual(openingLogo, loginLogo, 'The namespace-opening tab must show the logo where the login screen does');
          await assertLoginScreenUsesFullWidth(openingTab, 'namespace-opening tab');
          const note = await openingTab.evaluate(() => {
            const element = document.querySelector('.login-opening-note');
            const [fade] = element.getAnimations();
            return {text: element.textContent, delay: getComputedStyle(element).animationDelay,
              early: fade.currentTime < 1000, opacity: getComputedStyle(element).opacity};
          });
          assert.equal(note.text, 'Starting other…');
          assert.equal(note.delay, '1s');
          if (note.early) assert.equal(note.opacity, '0', 'The Starting line must wait before fading in');
          await openingTab.waitForFunction(
            () => getComputedStyle(document.querySelector('.login-opening-note')).opacity === '1', {timeout: 5000});
        } finally {
          await openingTab.close();
        }
        stage = 'opening the Session locked page';
        const lockedPage = await context.newPage();
        try {
          await lockedPage.goto(new URL('/locked', origin).href, {waitUntil: 'domcontentloaded', timeout: 30000});
          await assertLoginScreenUsesFullWidth(lockedPage, 'Session locked page');
        } finally {
          await lockedPage.close();
        }
        await checkNamespaceSwitchStaysInTab(context, page);
      }
      stage = `preparing login identity (removeStoredIdentity=${removeStoredIdentity})`;
      const identity = await page.evaluate(shouldRemove => {
        const tabId = sessionStorage.getItem('metalist_tab_id');
        if (!tabId) throw new Error('Login page did not initialize its tab identity');
        if (shouldRemove) {
          const originalFetch = globalThis.fetch;
          globalThis.fetch = async (...args) => {
            const response = await originalFetch(...args);
            if (new URL(response.url).pathname === '/api2/auth/login' && response.ok) {
              sessionStorage.removeItem('metalist_tab_id');
              globalThis.fetch = originalFetch;
            }
            return response;
          };
        }
        return tabId;
      }, removeStoredIdentity);
      errors.length = 0;
      stage = `submitting login (removeStoredIdentity=${removeStoredIdentity})`;
      await page.type('#login-password', password);
      await page.click('#login-form button[type="submit"]');
      stage = `waiting for workspace readiness (removeStoredIdentity=${removeStoredIdentity})`;
      await page.waitForSelector('[data-app-ready="true"]', {timeout: 30000});
      stage = `checking authenticated identity (removeStoredIdentity=${removeStoredIdentity})`;
      const state = await page.evaluate(async () => {
        const {getRequiredTabId} = await import('/static/js/modules/session-auth.js');
        return {active: getRequiredTabId(), stored: sessionStorage.getItem('metalist_tab_id')};
      });
      assert.equal(state.active, identity, 'Login must preserve the authenticated tab identity');
      assert.equal(state.stored, removeStoredIdentity ? null : identity);
      assert.deepEqual(errors, [], 'Encrypted login must finish without JavaScript or transport failures');
      assert(await page.$eval('#main-app', element => element.getBoundingClientRect().height > 0));
      await assertAppKeepsScrollbarStrip(page, 'app after login');
      diagnostics.push({origin, encryptedLogin: true, removeStoredIdentity, passed: true});
      if (removeStoredIdentity) {
        // Remove the password through the real dialog, with the race forced: the
        // removal reaches the server (which ends every session), then its answer
        // is held back while the page runs its background requests, which are
        // answered "not logged in". The page must still reload into the app, not
        // Session locked (Auth.runPasswordChange; seen on the 0.14.0 release run).
        stage = 'removing the password through the dialog during background requests';
        await page.evaluate(() => {
          const originalFetch = window.fetch;
          window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            const url = typeof args[0] === 'string' ? args[0] : args[0].url;
            if (!url.includes('/settings/password/remove')) return response;
            window.fetch = originalFetch;
            const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
            if (!mode.userActivity) mode.setUserActivity(true);
            document.dispatchEvent(new Event('visibilitychange'));
            await new Promise(resolve => setTimeout(resolve, 1500));
            return response;
          };
        });
        await page.evaluate(async () => {
          const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
          await CommandPalette.openRemovePassword();
        });
        await page.waitForSelector('#remove-password-modal #current-password', {visible: true, timeout: 30000});
        await page.type('#remove-password-modal #current-password', password);
        await page.click('#remove-password-modal #confirm-remove');
        await page.waitForSelector('#remove-password-modal [data-password-submit]:not([disabled])', {timeout: 30000});
        const reload = page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 60000});
        await page.click('#remove-password-modal [data-password-submit]');
        await reload;
        stage = 'confirming the page reloaded into the passwordless app';
        assert.equal(new URL(page.url()).pathname, '/', 'A password change must not end on Session locked');
        await page.waitForSelector('[data-app-ready="true"]', {timeout: 30000});
      } else {
        stage = `logging out (removeStoredIdentity=${removeStoredIdentity})`;
        await page.evaluate(async () => {
          const {Auth} = await import('/static/js/modules/auth.js');
          await Auth.logout();
        });
        stage = `waiting for logout form (removeStoredIdentity=${removeStoredIdentity})`;
        await page.waitForSelector('#login-panel[data-revealed="true"] #login-password', {visible: true, timeout: 30000});
        await assertLoginScreenUsesFullWidth(page, 'login screen after logging out');
      }
    }
  } catch (error) {
    const [pageStateOutcome] = await Promise.allSettled([page.evaluate(() => ({
      appReady: document.body?.dataset.appReady ?? null,
      bodyLoading: document.body?.classList.contains('loading') ?? null,
      loginVisible: document.querySelector('#login-password')?.getBoundingClientRect().height > 0,
      mainVisible: document.querySelector('#main-app')?.getBoundingClientRect().height > 0,
      storedIdentity: sessionStorage.getItem('metalist_tab_id'),
    }))]);
    const pageState = pageStateOutcome.status === 'fulfilled'
      ? pageStateOutcome.value
      : {diagnosticError: pageStateOutcome.reason.message};
    diagnostics.push({
      origin,
      encryptedLogin: true,
      removeStoredIdentity,
      stage,
      pageState,
      errors,
      failure: error.message,
    });
    await page.screenshot({path: join(outputDirectory, 'failure-encrypted-login.png')});
    throw error;
  } finally {
    await page.close();
  }
}

try {
  for (let coldRun = 0; coldRun < coldRuns; coldRun += 1) {
    const context = await browser.createBrowserContext();
    try {
      const outcomes = await Promise.allSettled(origins.map(origin => checkPage(context, origin, coldRun)));
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    } finally {
      await context.close();
    }
  }
  if (validateEncryptedLogin) {
    const loginContext = await browser.createBrowserContext();
    try {
      await checkEncryptedLogin(loginContext, origins[0]);
    } finally {
      await loginContext.close();
    }
  }
  console.log(`PASS ${browserName}: two installed namespaces, ${coldRuns} cold sessions, and ${reloads} uncached loads each`);
  if (validateEncryptedLogin) {
    console.log(`PASS ${browserName}: encrypted login, hydration, logout, and storage loss during login`);
  }
} finally {
  await writeFile(join(outputDirectory, 'startup-results.json'), JSON.stringify({browserName, version, diagnostics}, null, 2));
  await browser.close();
}
