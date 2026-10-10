import assert from 'node:assert/strict';
import test from 'node:test';

// Adding, changing or removing the password ends every session on the server.
// Background requests answered "not logged in" meanwhile (the session check,
// reminders, ...) must not send the page to Session locked before the password
// dialog reloads it into the new state (seen on the 0.14.0 release run, Windows
// Edge; reproduced with the reminders poll).

function createStorage() {
    const values = new Map();
    return {
        getItem: (key) => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
    };
}

globalThis.sessionStorage = createStorage();
globalThis.localStorage = createStorage();
const navigations = [];
globalThis.window = { location: { replace: (url) => navigations.push(url) } };
globalThis.document = { body: { replaceChildren() {} } };
const { Auth } = await import('../../app/static/js/modules/auth.js');

function freshAuth(t) {
    navigations.length = 0;
    // A logout from an earlier test would otherwise make forceLogout return early.
    if (Auth._forcingLogout) Auth._forcingLogout = false;
    t.mock.method(Auth, 'clearSessionState', () => {});
}

// The failed change runs first: after a successful one, the page (and Auth) is
// reloaded in real use, so it stays in that state.
test('after a failed password change a lost session locks the page as usual', async (t) => {
    freshAuth(t);
    await assert.rejects(
        Auth.runPasswordChange(async () => { throw new Error('Wrong current password'); }),
        /Wrong current password/,
    );

    Auth.forceLogout('Session expired');

    assert.deepEqual(navigations, ['/locked']);
});


test('a "not logged in" answer during a password change does not lock the page', async (t) => {
    freshAuth(t);
    let finishChange = null;
    const change = Auth.runPasswordChange(() => new Promise((resolve) => { finishChange = resolve; }));

    Auth.forceLogout('Session expired');

    assert.deepEqual(navigations, []);
    finishChange();
    await change;
    // Still ignored after success: the dialog's reload is on its way.
    Auth.forceLogout('Session expired');
    assert.deepEqual(navigations, []);
});
