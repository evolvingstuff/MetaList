import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';


const AUTH_SOURCE_URL = new URL('../../app/static/js/modules/auth.js', import.meta.url);


test('encrypted login checks the password before anything moves, then completes the progress flow', async () => {
    const source = await readFile(AUTH_SOURCE_URL, 'utf8');
    const loginStart = source.indexOf('async handleLogin(event)');
    const loginEnd = source.indexOf('async logout()', loginStart);
    assert.notEqual(loginStart, -1);
    assert.notEqual(loginEnd, -1);

    const loginSource = source.slice(loginStart, loginEnd);
    const busyIndex = loginSource.indexOf('this._setLoginSubmitBusy(true);');
    const loginRequestIndex = loginSource.indexOf('fetch(CONFIG.API.AUTH.LOGIN');
    const progressFlowIndex = loginSource.indexOf('await this._runHydrationFlow();');

    assert.ok(busyIndex >= 0);
    assert.ok(loginRequestIndex > busyIndex);
    assert.ok(progressFlowIndex > loginRequestIndex);
    // The loading view only appears once the password is accepted.
    assert.equal(loginSource.slice(0, progressFlowIndex).includes('_showLoginLoadingPanel('), false);
    assert.match(loginSource, /data\.hydration_required !== true/);
    assert.match(source, /Hydration failed during \$\{failedPhase\}: \$\{failedMessage\}/);
});


test('a refused login keeps the form in place with the reason', async () => {
    const source = await readFile(AUTH_SOURCE_URL, 'utf8');
    const rejectStart = source.indexOf('_rejectLoginAttempt(message) {');
    assert.notEqual(rejectStart, -1);
    const rejectSource = source.slice(rejectStart, source.indexOf('\n    },', rejectStart));
    assert.match(rejectSource, /this\._setLoginSubmitBusy\(false\);/);
    assert.match(rejectSource, /this\.showLoginError\(message\);/);
    assert.doesNotMatch(rejectSource, /showLoginModal|_showLoginLoadingPanel/);
});


test('the login screen is the logo with a form or the progress under it, nothing else', async () => {
    const templatesUrl = new URL('../../app/templates/', import.meta.url);
    const templateSource = await readFile(new URL('index.html', templatesUrl), 'utf8');
    const logoSource = await readFile(new URL('_logo_mark.html', templatesUrl), 'utf8');

    assert.match(templateSource, /id="login-logo"[\s\S]*<%include file="_logo_mark.html"\/>/);
    // The logo is static: the M and both bars, always fully shown.
    assert.match(logoSource, /<polygon points=/);
    assert.equal((logoSource.match(/<rect /g) ?? []).length, 2);
    assert.doesNotMatch(logoSource, /opacity|data-logo-part|MetaList</);
    assert.match(templateSource, /id="login-progress-bar"/);
    assert.match(templateSource, /id="login-loading-message"[^>]*><\/span><span id="login-loading-elapsed"/);
    for (const removed of ['login-loading-title', 'login-loading-first', 'login-subtitle', 'startup-splash',
        'login-startup-video', 'wordmark']) {
        assert.doesNotMatch(templateSource, new RegExp(removed));
    }
});


test('the panel reads namespace, password, then OK at the bottom', async () => {
    const templateSource = await readFile(new URL('../../app/templates/index.html', import.meta.url), 'utf8');
    // Safe above the field: the whole panel fades in once the list is known, so it never pushes the field down.
    const picker = templateSource.indexOf('id="login-namespace-switcher"');
    const password = templateSource.indexOf('id="login-password"');
    const ok = templateSource.indexOf('id="login-submit"');
    assert.ok(picker >= 0 && password > picker && ok > password);
    assert.doesNotMatch(templateSource, />Namespace</);
});


test('everything under the logo fades in together once the namespace list is known', async () => {
    const css = await readFile(new URL('../../app/static/css/main.css', import.meta.url), 'utf8');
    const templateSource = await readFile(new URL('../../app/templates/index.html', import.meta.url), 'utf8');
    const source = await readFile(AUTH_SOURCE_URL, 'utf8');
    assert.match(templateSource, /id="login-panel" class="login-panel" data-revealed="false"/);
    // Transparent, not hidden: a browser can fill a saved password before it fades in.
    assert.match(css, /\.login-panel\[data-revealed="false"\] \{\s*opacity: 0;\s*pointer-events: none;/);
    assert.doesNotMatch(css, /\.login-panel\[data-revealed="false"\] \{[^}]*visibility/);
    assert.match(css, /\.login-panel\[data-revealed="true"\] \{\s*animation: login-fade-in 250ms ease-out;/);
    assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.login-panel\[data-revealed="true"\] \{\s*animation: none;/);
    // Revealed after the list loads, and also when loading it fails (never stuck hidden).
    const show = source.slice(source.indexOf('showLoginModal() {'), source.indexOf('_revealLoginPanel(passwordInput) {'));
    assert.match(show, /_loadLoginNamespaceCatalog\(\)\.then\(\s*\(\) => this\._revealLoginPanel\(passwordInput\),/);
    assert.match(show, /'error'\);[\s\S]*this\._revealLoginPanel\(passwordInput\);/);
    assert.match(css, /\.login-form input:-webkit-autofill,[\s\S]*box-shadow: 0 0 0 1000px #161616 inset;/);
});


test('leaving the locked page fades its heading and button out before opening the login', async () => {
    const lockedSource = await readFile(new URL('../../app/static/js/locked.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../../app/static/css/main.css', import.meta.url), 'utf8');
    const template = await readFile(new URL('../../app/templates/locked.html', import.meta.url), 'utf8');
    assert.match(template, /id="locked-panel" class="login-panel locked-panel"/);
    assert.match(lockedSource, /lockedPanel\.dataset\.leaving = 'true';\s*window\.setTimeout\(\(\) => \{\s*window\.location\.href = url;\s*\}, LEAVE_FADE_MS\);/);
    assert.match(lockedSource, /prefers-reduced-motion: reduce/);
    assert.match(lockedSource, /leaveTo\('\/\?force_reauth=1'\)/);
    assert.match(css, /\.locked-panel \{\s*text-align: center;\s*transition: opacity 200ms ease-in;/);
    assert.match(css, /\.locked-panel\[data-leaving="true"\] \{\s*opacity: 0;/);
});


test('an accepted password slides the form out left and the loading view in from the right', async () => {
    const source = await readFile(AUTH_SOURCE_URL, 'utf8');
    const css = await readFile(new URL('../../app/static/css/main.css', import.meta.url), 'utf8');
    const template = await readFile(new URL('../../app/templates/index.html', import.meta.url), 'utf8');
    assert.match(template, /class="login-views"[\s\S]*id="login-form-view"[\s\S]*id="login-loading"/);
    assert.match(css, /\.login-views > \* \{\s*grid-area: 1 \/ 1;/);
    assert.match(css, /@keyframes login-slide-out-left \{\s*to \{\s*transform: translateX\(-100%\);/);
    assert.match(css, /@keyframes login-slide-in-right \{\s*from \{\s*transform: translateX\(100%\);/);
    assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.login-view-leaving,\s*\.login-view-entering \{\s*animation: none;/);
    const slide = source.slice(source.indexOf('_slideToLoadingView() {'));
    const body = slide.slice(0, slide.indexOf('\n    },'));
    assert.match(body, /formView\.classList\.add\('login-view-leaving'\);/);
    assert.match(body, /loadingView\.classList\.add\('login-view-entering'\);/);
    assert.match(body, /if \(formView\.hidden \|\| reducedMotion\)/);
    assert.match(body, /window\.setTimeout\(finish, LOGIN_SLIDE_MS \+ LOGIN_SLIDE_GRACE_MS\);/);
});


test('a login that will upgrade the database says so under OK while it runs', async () => {
    const source = await readFile(AUTH_SOURCE_URL, 'utf8');
    const template = await readFile(new URL('../../app/templates/index.html', import.meta.url), 'utf8');
    assert.match(template, /id="login-note" class="login-note" hidden>Backing up and upgrading this namespace…</);
    assert.match(source, /typeof status\.database_upgrade_pending !== 'boolean'/);
    assert.match(source, /this\._requireElement\('login-note'\)\.hidden = !\(isBusy && this\._isUpgradePending\);/);
});


test('the loading time counts from the loading view and stops when the app opens or the form returns', async () => {
    const source = await readFile(AUTH_SOURCE_URL, 'utf8');
    const panel = source.slice(source.indexOf('_showLoginLoadingPanel(message, progressPercent) {'));
    assert.match(panel.slice(0, panel.indexOf('\n    },')), /this\._startLoadingElapsed\(\);/);
    for (const stopper of ['_showLoginForm() {', 'revealMainApp() {']) {
        const body = source.slice(source.indexOf(stopper));
        assert.match(body.slice(0, body.indexOf('\n    },')), /this\._stopLoadingElapsed\(\);/, stopper);
    }
    assert.match(source, /textContent = ` · \$\{formatElapsedDuration\(elapsed\)\}`/);
});


test('post-login startup failures do not return to the password form', async () => {
    const source = await readFile(AUTH_SOURCE_URL, 'utf8');
    const loginStart = source.indexOf('async handleLogin(event)');
    const loginEnd = source.indexOf('async logout()', loginStart);
    const loginSource = source.slice(loginStart, loginEnd);
    const failedResponseBranch = loginSource.indexOf('if (!response.ok)');
    const modeManagerInitialization = loginSource.indexOf('await window.ModeManager.init({});');
    const loginFailureCatch = loginSource.indexOf('catch (error)');

    assert.ok(failedResponseBranch >= 0);
    assert.ok(loginFailureCatch < failedResponseBranch);
    assert.ok(modeManagerInitialization > loginFailureCatch);
    assert.doesNotMatch(
        loginSource.slice(modeManagerInitialization),
        /this\.showLoginModal\(\)/,
    );
});


test('post-login startup failures expose the underlying browser error', async () => {
    const source = await readFile(AUTH_SOURCE_URL, 'utf8');
    const loginStart = source.indexOf('async handleLogin(event)');
    const loginEnd = source.indexOf('async logout()', loginStart);
    const loginSource = source.slice(loginStart, loginEnd);

    assert.match(loginSource, /let startupPhase = enterStartupStage\('reading the login response'\)/);
    assert.match(loginSource, /startupPhase = enterStartupStage\('hydrating the workspace'\)/);
    assert.match(loginSource, /startupPhase = enterStartupStage\('initializing the workspace UI'\)/);
    assert.match(loginSource, /const errorMessage = error instanceof Error/);
    assert.match(loginSource, /loadingMessage\.textContent =[\s\S]*\$\{startupPhase\}: \$\{errorMessage\}/);
    assert.doesNotMatch(loginSource, /window\.alert\(/);
    assert.match(loginSource, /throw new Error\(errorMessage\)/);
});
