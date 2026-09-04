import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.sessionStorage = {
    getItem: () => null,
    setItem: () => {},
};

const { selectInfiniteScrollRootTotal } = await import(
    '../../app/static/js/modules/mode-manager/services/infinite-scroll-service.js'
);

test('blank untagged view paginates against the filtered root total', () => {
    assert.equal(selectInfiniteScrollRootTotal({
        searchQuery: '',
        isUntaggedView: true,
        rootCountTotal: 100,
        searchRootCountTotal: 3,
    }), 3);
});

test('unfiltered blank view paginates against the global root total', () => {
    assert.equal(selectInfiniteScrollRootTotal({
        searchQuery: '',
        isUntaggedView: false,
        rootCountTotal: 100,
        searchRootCountTotal: 3,
    }), 100);
});
