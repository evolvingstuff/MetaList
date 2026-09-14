import assert from 'node:assert/strict';
import test from 'node:test';

const storage = new Map([['metalist_tab_id', 'version-test-tab']]);
globalThis.sessionStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, value),
};
const {VersionInfoModal} = await import('../../app/static/js/modules/modals/version-info-modal.js');
const {ModeContextInstance} = await import('../../app/static/js/modules/mode-manager/mode-context.js');

function harness(t) {
    const elements = new Map();
    globalThis.document = {
        getElementById: id => elements.get(id),
        createElement: () => ({style:{}, innerHTML:''}),
        body: {appendChild: element => elements.set(element.id, element)},
        dispatchEvent() {},
    };
    const requests = [];
    t.mock.method(globalThis, 'fetch', url => {
        if (url.endsWith('/check')) return Promise.resolve({ok: true, json: async () => ({supported: true, update_available: false, current_version: '0.6.2', target_version: '0.6.2', message: 'MetaList is up to date.'})});
        return new Promise(resolve => requests.push(resolve));
    });
    const modal = new VersionInfoModal();
    modal._installModalCloseButton = () => {};
    modal.setupEventListeners = () => {};
    modal.cleanupEventListeners = () => {};
    let pending;
    const onOpen = modal.onOpen.bind(modal);
    modal.onOpen = () => { pending = onOpen(); return pending; };
    t.after(() => {
        if (modal.isOpen) modal.close();
        else if (ModeContextInstance.modalStack.includes(modal.modalName)) {
            modal.removeModalState();
            modal.removeFromModalStack();
        }
        delete globalThis.document;
    });
    return {
        modal, requests,
        open() { modal.open(); return pending; },
        html: () => elements.get('version-info-modal').innerHTML,
    };
}

function response(version) {
    return {ok:true, json:async () => ({
        version, database_user_version:1, namespace:'test', authenticated:true,
        has_password:false, encryption_enabled:false, cache_ready:true,
        vault_version:null, kdf_algorithm:null, kdf_memory_cost_kib:null, kdf_parallelism:null,
    })};
}

test('version modal opens in loading state and renders fetched info on every reopening', async t => {
    const h = harness(t);
    for (const version of ['0.5.0', '0.5.1']) {
        const pending = h.open();
        assert.match(h.html(), /Loading version info/);
        assert.equal(h.modal.getModalState().loading, true);
        h.requests.shift()(response(version));
        await pending;
        assert.equal(h.modal.getModalState().loading, false);
        assert.match(h.html(), new RegExp(version.replaceAll('.', '\\.')));
        assert.doesNotMatch(h.html(), /Loading version info/);
        assert.throws(() => h.modal.updateModalState({loading:false}), /Redundant/);
        h.modal.close();
    }
});

test('a version response arriving after closing cannot update a disposed modal', async t => {
    const h = harness(t);
    const pending = h.open();
    h.modal.close();
    h.requests.shift()(response('old'));
    await pending;
    assert.equal(h.modal.isOpen, false);
});

test('a previous opening cannot overwrite the reopened version modal', async t => {
    const h = harness(t);
    const oldPending = h.open();
    h.modal.close();
    const newPending = h.open();
    h.requests[1](response('new'));
    await newPending;
    h.requests[0](response('old'));
    await oldPending;
    assert.equal(h.modal.getModalState().info.version, 'new');
});

test('malformed version information still fails loudly', async t => {
    const h = harness(t);
    const pending = h.open();
    h.requests.shift()(response(undefined));
    await assert.rejects(pending, /Version info response missing version/);
});
