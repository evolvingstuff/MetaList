import assert from 'node:assert/strict';
import test from 'node:test';

class TestElement {
    constructor(id, disabled = false) {
        this.id = id;
        this._disabled = disabled;
        this.focusCount = 0;
    }

    hasAttribute(name) {
        if (name !== 'disabled') {
            return false;
        }
        return this._disabled;
    }

    focus() {
        this.focusCount += 1;
    }
}

class TestInputElement extends TestElement {}
class TestButtonElement extends TestElement {}

test('BackupSettingsModal focuses the first enabled control inside the modal', async (t) => {
    const originalSessionStorage = globalThis.sessionStorage;
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;

    globalThis.sessionStorage = {
        getItem() {
            return null;
        },
        setItem() {},
    };
    globalThis.HTMLElement = TestElement;

    const retentionInput = new TestInputElement('backup-settings-retention-count');
    const folderPickButton = new TestButtonElement('backup-settings-folder-pick-btn');
    const runButton = new TestButtonElement('backup-settings-run-btn');
    const cancelButton = new TestButtonElement('backup-settings-cancel-btn');

    const elements = new Map([
        ['backup-settings-retention-count', retentionInput],
        ['backup-settings-folder-pick-btn', folderPickButton],
        ['backup-settings-run-btn', runButton],
        ['backup-settings-cancel-btn', cancelButton],
    ]);

    globalThis.document = {
        getElementById(id) {
            return elements.get(id) ?? null;
        },
    };

    t.after(() => {
        if (typeof originalSessionStorage === 'undefined') {
            delete globalThis.sessionStorage;
        } else {
            globalThis.sessionStorage = originalSessionStorage;
        }
        if (typeof originalDocument === 'undefined') {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }
        if (typeof originalHTMLElement === 'undefined') {
            delete globalThis.HTMLElement;
        } else {
            globalThis.HTMLElement = originalHTMLElement;
        }
    });

    const { BackupSettingsModal } = await import('../../app/static/js/modules/modals/backup-settings-modal.js');
    const modal = new BackupSettingsModal();

    modal._focusPreferredControl();

    assert.equal(retentionInput.focusCount, 1);
    assert.equal(folderPickButton.focusCount, 0);
    assert.equal(runButton.focusCount, 0);
    assert.equal(cancelButton.focusCount, 0);
});

test('BackupSettingsModal falls back to the next enabled control when retention is disabled', async (t) => {
    const originalSessionStorage = globalThis.sessionStorage;
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;

    globalThis.sessionStorage = {
        getItem() {
            return null;
        },
        setItem() {},
    };
    globalThis.HTMLElement = TestElement;

    const retentionInput = new TestInputElement('backup-settings-retention-count', true);
    const folderPickButton = new TestButtonElement('backup-settings-folder-pick-btn', true);
    const runButton = new TestButtonElement('backup-settings-run-btn', true);
    const cancelButton = new TestButtonElement('backup-settings-cancel-btn');

    const elements = new Map([
        ['backup-settings-retention-count', retentionInput],
        ['backup-settings-folder-pick-btn', folderPickButton],
        ['backup-settings-run-btn', runButton],
        ['backup-settings-cancel-btn', cancelButton],
    ]);

    globalThis.document = {
        getElementById(id) {
            return elements.get(id) ?? null;
        },
    };

    t.after(() => {
        if (typeof originalSessionStorage === 'undefined') {
            delete globalThis.sessionStorage;
        } else {
            globalThis.sessionStorage = originalSessionStorage;
        }
        if (typeof originalDocument === 'undefined') {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }
        if (typeof originalHTMLElement === 'undefined') {
            delete globalThis.HTMLElement;
        } else {
            globalThis.HTMLElement = originalHTMLElement;
        }
    });

    const { BackupSettingsModal } = await import('../../app/static/js/modules/modals/backup-settings-modal.js');
    const modal = new BackupSettingsModal();

    modal._focusPreferredControl();

    assert.equal(cancelButton.focusCount, 1);
    assert.equal(retentionInput.focusCount, 0);
    assert.equal(folderPickButton.focusCount, 0);
    assert.equal(runButton.focusCount, 0);
});

test('BackupSettingsModal selects every available namespace by default', async (t) => {
    const originalSessionStorage = globalThis.sessionStorage;
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;

    globalThis.sessionStorage = {
        getItem() {
            return null;
        },
        setItem() {},
    };
    globalThis.HTMLElement = TestElement;
    globalThis.document = {
        getElementById() {
            return null;
        },
    };

    t.after(() => {
        if (typeof originalSessionStorage === 'undefined') {
            delete globalThis.sessionStorage;
        } else {
            globalThis.sessionStorage = originalSessionStorage;
        }
        if (typeof originalDocument === 'undefined') {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }
        if (typeof originalHTMLElement === 'undefined') {
            delete globalThis.HTMLElement;
        } else {
            globalThis.HTMLElement = originalHTMLElement;
        }
    });

    const { BackupSettingsModal } = await import('../../app/static/js/modules/modals/backup-settings-modal.js');
    const modal = new BackupSettingsModal();

    assert.deepEqual(
        modal._defaultSelectedNamespaces(['default', 'cla', 'test']),
        ['default', 'cla', 'test'],
    );
});

test('BackupSettingsModal returns validated settings without a settings-only request', async () => {
    const { BackupSettingsModal } = await import('../../app/static/js/modules/modals/backup-settings-modal.js');
    const modal = new BackupSettingsModal();
    const state = {
        folderPath: '/tmp/metalist-backups',
        selectedNamespaces: ['default'],
        retentionCountText: '30',
        saving: false,
        error: '',
    };
    let requestCount = 0;
    let closeCount = 0;
    let closeResult = null;

    modal.getModalState = () => state;
    modal.updateModalState = (patch) => Object.assign(state, patch);
    modal.renderModalContent = () => {};
    modal._parseRetentionCount = () => 30;
    modal._authRequest = async () => {
        requestCount += 1;
        return { status: 'saved' };
    };
    modal._decision = { result: { action: 'cancel' } };
    modal.close = () => {
        closeCount += 1;
        closeResult = modal._decision.result;
    };

    await modal.handleRunBackup();

    assert.equal(requestCount, 0);
    assert.equal(closeCount, 1);
    assert.deepEqual(closeResult, {
        action: 'run_backup',
        settings: {
            folder_path: '/tmp/metalist-backups',
            retention_count: 30,
            selected_namespaces: ['default'],
        },
    });
});

test('BackupSettingsModal ignores Escape and backdrop dismissal during active operations', async (t) => {
    const originalKeyboardEvent = globalThis.KeyboardEvent;
    class TestKeyboardEvent {
        constructor(key) {
            this.key = key;
            this.defaultPrevented = false;
            this.propagationStopped = false;
        }

        preventDefault() {
            this.defaultPrevented = true;
        }

        stopPropagation() {
            this.propagationStopped = true;
        }
    }
    globalThis.KeyboardEvent = TestKeyboardEvent;
    t.after(() => {
        if (typeof originalKeyboardEvent === 'undefined') {
            delete globalThis.KeyboardEvent;
        } else {
            globalThis.KeyboardEvent = originalKeyboardEvent;
        }
    });

    const { BackupSettingsModal } = await import('../../app/static/js/modules/modals/backup-settings-modal.js');
    const modal = new BackupSettingsModal();
    let closeCount = 0;
    let activeState = { loading: true, saving: false, pickingFolder: false };
    modal.getModalState = () => activeState;
    modal.close = () => {
        closeCount += 1;
    };

    for (const nextState of [
        { loading: true, saving: false, pickingFolder: false },
        { loading: false, saving: false, pickingFolder: true },
        { loading: false, saving: true, pickingFolder: false },
    ]) {
        activeState = nextState;
        const escapeEvent = new TestKeyboardEvent('Escape');
        modal.handleKeyDown(escapeEvent);
        const backdrop = {};
        modal.handleClickOutside({ target: backdrop, currentTarget: backdrop });
        assert.equal(escapeEvent.defaultPrevented, true);
        assert.equal(escapeEvent.propagationStopped, true);
    }
    assert.equal(closeCount, 0);
});
