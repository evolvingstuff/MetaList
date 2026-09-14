import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const storage = new Map([['metalist_tab_id', 'update-test-tab']]);
globalThis.sessionStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)};
const servicePath = '../../app/static/js/modules/app-update-service.js';
const { checkRelease, validateRelease } = await import(servicePath);
const release = {supported: true, update_available: true, current_version: '0.6.2', target_version: '0.6.3', message: 'New release'};

function fakeDocument() {
    const elements = new Map();
    function element() {
        return { children: [], listeners: {}, setAttribute() {},
            append(...children) { this.children.push(...children); },
            addEventListener(name, listener) { this.listeners[name] = listener; },
            remove() { elements.delete(this.id); },
        };
    }
    return { getElementById: id => elements.get(id), createElement: element,
        body: {appendChild(node) {elements.set(node.id, node);}}, elements };
}

test('slow page check returns later, shows notice once, and a refresh performs a fresh request', async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', (url, options) => {
        assert(url.endsWith('/app-update/check'));
        assert.equal(options.cache, 'no-store');
        return new Promise(resolve => requests.push(resolve));
    });
    const preferences = new Map();
    const store = {getRaw: key => preferences.get(key) ?? null, setRaw: async (key, value) => preferences.set(key, value)};
    let opened = 0;
    globalThis.document = fakeDocument();
    const firstPage = await import(`${servicePath}?page=first`);
    firstPage.checkReleaseOnPageLoad();
    const pending = firstPage.showUpdateNotice(store, async () => {opened += 1;});
    assert.equal(document.elements.size, 0);
    requests.shift()({ok: true, json: async () => release});
    await pending;
    const notice = document.getElementById('app-update-notice');
    assert(notice);
    await notice.children[1].listeners.click();
    assert.equal(opened, 1);
    notice.children[2].listeners.click();
    assert.equal(document.elements.size, 0);
    const secondPage = await import(`${servicePath}?page=refresh`);
    secondPage.checkReleaseOnPageLoad();
    assert.equal(requests.length, 1, 'refresh must make a new server request');
    const secondPending = secondPage.showUpdateNotice(store, async () => {});
    requests.shift()({ok: true, json: async () => release});
    await secondPending;
    assert.equal(document.elements.size, 0, 'same version must not nag after refresh');
    const thirdPage = await import(`${servicePath}?page=newrelease`);
    thirdPage.checkReleaseOnPageLoad();
    const thirdPending = thirdPage.showUpdateNotice(store, async () => {});
    requests.shift()({ok: true, json: async () => ({...release, target_version: '0.6.4'})});
    await thirdPending;
    assert(document.getElementById('app-update-notice'));
    delete globalThis.document;
});

test('PyPI outage is an explicit failed check, not a claim of being up to date', async t => {
    t.mock.method(globalThis, 'fetch', async () => ({ok: false, status: 503, json: async () => ({detail: 'Could not reach PyPI'})}));
    const outcome = await checkRelease();
    assert.equal(outcome.release, null);
    assert.match(outcome.error, /Could not check PyPI/);
});

test('internal malformed-release errors remain fatal', async t => {
    t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => ({})}));
    await assert.rejects(checkRelease, /Invalid update check response/);
    assert.throws(() => validateRelease({...release, supported: undefined}), /Invalid/);
});

test('typing update finds the existing Version Info command through its menu tags', async () => {
    const config = JSON.parse(await readFile(new URL('../../app/static/config/command_palette_tags.json', import.meta.url), 'utf8'));
    const entries = config.endpoints;
    const version = entries.find(entry => entry.id === 'form.version_info');
    assert(version.tags.includes('update'));
    assert(version.tags.includes('upgrade'));
});


test('the public page check works before authentication creates a browser tab ID', async t => {
    storage.delete('metalist_tab_id');
    t.after(() => storage.set('metalist_tab_id', 'update-test-tab'));
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        assert.equal(options.headers, undefined);
        return {ok: true, json: async () => release};
    });
    assert.deepEqual((await checkRelease()).release, release);
});

test('only failed jobs can be cleared for another update attempt', async () => {
    const {rememberUpdateJob, clearFailedUpdateJob, currentUpdateJob} = await import(servicePath);
    const job = {job_id: 'fixture-job', status: 'preparing', log_path: '/fixture/update.log', message: 'Preparing'};
    rememberUpdateJob(job);
    assert.throws(clearFailedUpdateJob, /Only a failed update/);
    rememberUpdateJob({...job, status: 'failed', message: 'Failed'});
    clearFailedUpdateJob();
    assert.equal(currentUpdateJob(), null);
});
