import assert from 'node:assert/strict';
import test from 'node:test';
import { navigateToFootnote } from '../../app/static/js/modules/mode-manager/services/footnote-navigation-service.js';

test('reference navigation stays within its note and excludes nested embedded notes', () => {
    const calls = [];
    const nested = { dataset: { footnoteReference: '1' }, closest: () => ({}) };
    const reference = {
        dataset: { footnoteReference: '1' },
        closest: () => container,
        focus: (options) => calls.push(['focus', options]),
        scrollIntoView: (options) => calls.push(['scroll', options]),
    };
    const container = { querySelectorAll: () => [nested, reference] };
    const button = { dataset: { footnoteNumber: '1' }, closest: () => container };
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    navigateToFootnote(button);
    assert.deepEqual(calls, [
        ['focus', { preventScroll: true }],
        ['scroll', { behavior: 'smooth', block: 'center' }],
    ]);
    globalThis.window.matchMedia = () => ({ matches: true });
    navigateToFootnote(button);
    assert.equal(calls[3][1].behavior, 'instant');
    delete globalThis.window;
});
