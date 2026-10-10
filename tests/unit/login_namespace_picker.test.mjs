import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildLoginNamespaceStartingNote,
    buildNamespaceLoginUrl,
    buildLoginTitle,
    navigateNamespaceInNewTab,
    openPendingNamespaceTab,
    parseLoginNamespaceCatalog,
    rewriteNamespaceUrlPreservingCurrentHost,
} from '../../app/static/js/modules/login-namespace-picker.js';


test('buildLoginTitle omits the default namespace suffix', () => {
    assert.equal(buildLoginTitle('default'), 'MetaList');
});


test('buildLoginTitle appends non-default namespace suffix', () => {
    assert.equal(buildLoginTitle('cla'), 'MetaList [cla]');
});


test('parseLoginNamespaceCatalog preserves plain namespace labels', () => {
    const catalog = parseLoginNamespaceCatalog({
        current_namespace: 'default',
        namespaces: ['default', 'cla'],
    });

    assert.deepEqual(catalog, {
        currentNamespace: 'default',
        namespaces: ['default', 'cla'],
    });
});


test('buildLoginNamespaceStartingNote names the namespace that is starting', () => {
    assert.equal(buildLoginNamespaceStartingNote(' cla '), 'Starting cla…');
    assert.throws(() => buildLoginNamespaceStartingNote(' '), /non-empty namespace/);
});


test('buildNamespaceLoginUrl keeps the browser host and asks for the login screen', () => {
    // The same address the dropdown loads in this tab and the app opens in a new one.
    assert.equal(
        buildNamespaceLoginUrl('https://127.0.0.1:8444/?namespace=cla', { hostname: '10.0.0.31' }),
        'https://10.0.0.31:8444/?namespace=cla&force_reauth=1',
    );
    assert.equal(
        buildNamespaceLoginUrl('http://127.0.0.1:8001/?force_reauth=1', { hostname: '10.0.0.31' }),
        'http://10.0.0.31:8001/?force_reauth=1',
    );
});


test('rewriteNamespaceUrlPreservingCurrentHost swaps only the browser host', () => {
    const rewritten = rewriteNamespaceUrlPreservingCurrentHost(
        'http://127.0.0.1:8001/namespace-deleted?job=123',
        {
            hostname: '10.0.0.31',
        },
    );

    assert.equal(rewritten, 'http://10.0.0.31:8001/namespace-deleted?job=123');
});


test('namespace switching opens and navigates another tab without replacing the active tab', () => {
    const pendingTabUrls = [];
    const openedTabs = [];
    const pendingTab = {
        closed: false,
        location: {
            replace(url) {
                pendingTabUrls.push(url);
            },
        },
        opener: {},
    };
    const browserWindow = {
        location: {
            hostname: '10.0.0.31',
            replace() {
                throw new Error('namespace switching must leave the active tab open');
            },
        },
        open(url, target) {
            openedTabs.push({ target, url });
            return pendingTab;
        },
    };

    const openedTab = openPendingNamespaceTab(browserWindow);
    navigateNamespaceInNewTab(
        'http://127.0.0.1:8001/?namespace=cla',
        browserWindow,
        openedTab,
    );

    assert.deepEqual(openedTabs, [{ target: '_blank', url: 'about:blank' }]);
    assert.equal(pendingTab.opener, null);
    // A fresh tab never owns a session there, so it asks for the login screen at
    // once instead of a white page while it checks the cookie (login_page.py).
    assert.deepEqual(pendingTabUrls, ['http://10.0.0.31:8001/?namespace=cla&force_reauth=1']);
});


test('openPendingNamespaceTab fails loudly when the browser blocks the tab', () => {
    assert.throws(
        () => openPendingNamespaceTab({ open: () => null }),
        /Browser blocked the namespace tab/,
    );
});
