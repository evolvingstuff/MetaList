import assert from 'node:assert/strict';
import test from 'node:test';
import { navigateToFootnote, navigateToFootnoteWithExpansion } from '../../app/static/js/modules/mode-manager/services/footnote-navigation-service.js';

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

test('collapsed marker expands the note before navigating through its refreshed content', async () => {
    const calls = [];
    const note = { dataset: { isCollapsed: 'true', noteId: 'note-1' } };
    const oldButton = { dataset: { footnoteNumber: '2' }, closest: () => note };
    const newButton = { dataset: { footnoteNumber: '2' }, closest: () => container };
    const reference = {
        dataset: { footnoteReference: '2' }, closest: () => container,
        focus: () => calls.push('focus'), scrollIntoView: () => calls.push('scroll'),
    };
    const container = {
        querySelector: (selector) => {
            assert.equal(selector, '.meta-footnote-link[data-footnote-number="2"]');
            return newButton;
        },
        querySelectorAll: () => [reference],
    };
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    await navigateToFootnoteWithExpansion(oldButton,
        async (id) => { assert.equal(id, 'note-1'); calls.push('expand'); },
        (id) => {
            assert.equal(id, 'note-1');
            assert.deepEqual(calls, ['expand']);
            return { querySelector: () => container };
        });
    assert.deepEqual(calls, ['expand', 'focus', 'scroll']);
    delete globalThis.window;
});
