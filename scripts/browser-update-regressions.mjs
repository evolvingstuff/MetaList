import assert from 'node:assert/strict';

// Intercept only release metadata and installer jobs. App startup, authentication,
// preference persistence, menu search and modal rendering use the disposable server.
export async function prepareUpdateFixture(page) {
    const fixture = { version: '99.0.1', checks: 0, installs: 0, polls: 0, outage: false, releaseInitial: null };
    const initial = new Promise(resolve => { fixture.releaseInitial = resolve; });
    await page.setRequestInterception(true);
    page.on('request', async request => {
        const path = new URL(request.url()).pathname;
        if (path === '/api2/auth/app-update/check') {
            fixture.checks += 1;
            if (fixture.checks === 1) await initial;
            if (fixture.outage) {
                await request.respond({status: 503, contentType: 'application/json', body: JSON.stringify({detail: 'Could not reach PyPI'})});
                return;
            }
            await request.respond({status: 200, contentType: 'application/json', body: JSON.stringify({
                supported: true, update_available: true, current_version: '0.6.2',
                target_version: fixture.version, message: `Version ${fixture.version} is available.`,
            })});
        } else if (path === '/api2/auth/app-update' && request.method() === 'POST') {
            fixture.installs += 1;
            assert.equal(JSON.parse(request.postData()).target_version, fixture.version);
            await request.respond({status: 202, contentType: 'application/json', body: JSON.stringify({
                job_id: 'e1a65e72-2ac2-40a7-a6e4-e8beee60ad3c', status: 'preparing',
                message: 'Checking the update', log_path: '/disposable/update.log',
            })});
        } else if (path.startsWith('/api2/auth/app-update/jobs/')) {
            fixture.polls += 1;
            await request.respond({status: 200, contentType: 'application/json', body: JSON.stringify({
                job_id: 'e1a65e72-2ac2-40a7-a6e4-e8beee60ad3c', status: 'complete',
                message: 'Updated successfully', log_path: '/disposable/update.log',
            })});
        } else {
            await request.continue();
        }
    });
    return fixture;
}

export async function checkAppUpdates(page, fixture) {
    assert.equal(await page.$('#app-update-notice'), null, 'app must become ready before the delayed release response');
    fixture.releaseInitial();
    await page.waitForSelector('#app-update-notice');
    await page.waitForNetworkIdle({idleTime: 100});
    await page.click('#app-update-notice button');
    await page.waitForSelector('#version-info-modal [data-update-action="install"]', {visible: true});
    assert.match(await page.$eval('#version-info-modal', node => node.textContent), /restarts all namespaces/);
    await page.keyboard.press('Escape');
    const checksBeforeRefresh = fixture.checks;
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await page.waitForNetworkIdle({idleTime: 100});
    assert.equal(fixture.checks, checksBeforeRefresh + 1);
    assert.equal(await page.$('#app-update-notice'), null, 'refresh must not repeat the announced release');
    fixture.version = '99.0.2';
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await page.waitForSelector('#app-update-notice');
    await page.waitForNetworkIdle({idleTime: 100});
    await page.click('#app-update-notice button[aria-label]');
    await page.evaluate(async () => {
        const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
        await CommandPalette.open();
    });
    await page.type('#command-palette-input', 'update');
    await page.waitForFunction(() => document.querySelector('#command-palette-results').textContent.includes('Version info'));
    await page.click('#command-palette-results [data-endpoint-id="form.version_info"]');
    await page.waitForSelector('#version-info-modal [data-update-action="install"]', {visible: true});
    await page.click('#version-info-modal [data-update-action="install"]');
    await page.waitForSelector('#version-info-modal .version-update-log');
    // Closing/reopening must resume an accepted job, never submit another installer.
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
        const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
        await CommandPalette.openVersionInfo();
    });
    await page.waitForSelector('#version-info-modal [data-update-action="reload"]');
    assert.equal(fixture.installs, 1);
    assert(fixture.polls >= 1);
    await page.keyboard.press('Escape');
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await page.waitForNetworkIdle({idleTime: 100});
    fixture.outage = true;
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await page.waitForNetworkIdle({idleTime: 100});
    assert.equal(await page.$('#app-update-notice'), null);
    await page.evaluate(async () => {
        const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
        await CommandPalette.openVersionInfo();
    });
    await page.waitForSelector('#version-info-modal [data-update-action="check"]', {visible: true});
    assert.match(await page.$eval('#version-info-modal', node => node.textContent), /Could not check PyPI/);
    fixture.outage = false;
    await page.click('#version-info-modal [data-update-action="check"]');
    await page.waitForSelector('#version-info-modal [data-update-action="install"]', {visible: true});
    await page.keyboard.press('Escape');
    console.log('PASS async release notice, refresh, new release, update menu search, install action, resumed progress, and PyPI outage/retry');
}
