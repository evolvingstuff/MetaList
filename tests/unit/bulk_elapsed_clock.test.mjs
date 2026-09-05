import assert from 'node:assert/strict';
import test from 'node:test';
import { createBulkElapsedClock } from '../../app/static/js/modules/ai-chat/bulk-elapsed-clock.js';

test('processing time excludes choosing vocabulary, focus, and confirmation', () => {
    let time = 0;
    const clock = createBulkElapsedClock(() => time);
    time = 20000;
    assert.equal(clock.seconds(), 0);
    clock.resume();
    time += 3000;
    clock.resume();
    assert.equal(clock.seconds(), 3);
    for (let question = 0; question < 3; question += 1) {
        clock.pause();
        time += 60000;
        clock.pause();
        assert.equal(clock.seconds(), 3 + question * 2);
        clock.resume();
        time += 2000;
    }
    assert.equal(clock.seconds(), 9);
});
