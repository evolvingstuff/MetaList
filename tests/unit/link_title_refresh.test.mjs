import { ApplicationState } from '../../app/static/js/modules/application-state.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL(
    '../../app/static/js/modules/mode-manager/services/polling-service.js', import.meta.url,
), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    .replace("await import('../actions/ui-actions.js')", 'await loadUiActions()');

test('completed titles defer during editing and request a guaranteed refresh afterward', async () => {
    const scheduled = new Map();
    let timerId = 0;
    const refreshes = [];
    const mode = { isEditing: true };
    const dependencies = {
        ModeContext: mode, CommandGate: { isBusy: () => false },
        window: {
            setTimeout(fn) { scheduled.set(++timerId, fn); return timerId; },
            clearTimeout(id) { scheduled.delete(id); },
        },
        loadUiActions: async () => ({ actionRefreshAndMaybeSelect: async (options) => refreshes.push(options) }),
    };
    const polling = new Function('ApplicationState', ...Object.keys(dependencies), `${source}\nreturn {
        handleLinkTitleRevision, refreshForLinkTitleChanges,
    };`).bind(null, ApplicationState)(...Object.values(dependencies));
    polling.handleLinkTitleRevision({ authenticated: true, link_title_revision: 1 });
    await polling.refreshForLinkTitleChanges();
    assert.equal(refreshes.length, 0);
    assert.equal(scheduled.size, 1);
    mode.isEditing = false;
    await polling.refreshForLinkTitleChanges();
    assert.deepEqual(refreshes, [{ context: 'link-title-refresh', requireExecution: true }]);
    polling.handleLinkTitleRevision({ authenticated: false });
    assert.equal(scheduled.size, 0);
});
