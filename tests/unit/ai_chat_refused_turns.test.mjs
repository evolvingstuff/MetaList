import assert from 'node:assert/strict';
import test from 'node:test';
import {
    AT_CHAT_START,
    lastServerMessageId,
    placeRefusedTurns,
} from '../../app/static/js/modules/ai-chat/ai-chat-refused-turns.js';


function message(id) {
    return { id };
}

function refused(afterMessageId, label) {
    return { afterMessageId, messages: [message(`local-${label}-user`), message(`local-${label}-assistant`)] };
}

function ids(messages) {
    return messages.map((entry) => entry.id);
}


test('a refused turn goes back after the server message it followed', () => {
    const server = [message('u1'), message('a1'), message('u2'), message('a2')];
    const placed = placeRefusedTurns(server, [refused('a1', 'r')]);
    assert.deepEqual(ids(placed.messages), ['u1', 'a1', 'local-r-user', 'local-r-assistant', 'u2', 'a2']);
    assert.equal(placed.keptTurns.length, 1);
});

test('refused turns after the same message keep their order', () => {
    const server = [message('u1'), message('a1'), message('u2'), message('a2')];
    const placed = placeRefusedTurns(server, [refused('a1', 'first'), refused('a1', 'second')]);
    assert.deepEqual(ids(placed.messages), [
        'u1', 'a1', 'local-first-user', 'local-first-assistant', 'local-second-user', 'local-second-assistant', 'u2', 'a2',
    ]);
});

test('a refused turn before any server message stays at the start', () => {
    const placed = placeRefusedTurns([message('u1'), message('a1')], [refused(AT_CHAT_START, 'r')]);
    assert.deepEqual(ids(placed.messages), ['local-r-user', 'local-r-assistant', 'u1', 'a1']);
});

test('a refused turn whose earlier message the server trimmed goes with it', () => {
    const placed = placeRefusedTurns([message('u2'), message('a2')], [refused('a1', 'gone'), refused('a2', 'kept')]);
    assert.deepEqual(ids(placed.messages), ['u2', 'a2', 'local-kept-user', 'local-kept-assistant']);
    assert.deepEqual(placed.keptTurns.map((turn) => turn.afterMessageId), ['a2']);
});

test('the last server message skips the turns only this page has', () => {
    const shown = [message('u1'), message('a1'), message('local-r-user'), message('local-r-assistant')];
    assert.equal(lastServerMessageId(shown), 'a1');
    assert.equal(lastServerMessageId([message('local-r-user'), message('local-r-assistant')]), AT_CHAT_START);
    assert.equal(lastServerMessageId([]), AT_CHAT_START);
});
