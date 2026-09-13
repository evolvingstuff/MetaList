import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationState } from '../../app/static/js/modules/application-state.js';

test('state scopes own input data and reject equal composite writes', () => {
    const input = { nested: { count: 1 }, flags: [true] };
    const scope = ApplicationState.createScope('test', input);
    input.nested.count = 9;
    assert.equal(scope.get().nested.count, 1);
    assert.throws(() => scope.get().flags.push(false), TypeError);
    assert.throws(() => scope.set({ nested: { count: 1 }, flags: [true] }), /Redundant/);
    scope.set({ nested: { count: 2 }, flags: [true] });
    assert.equal(scope.get().nested.count, 2);
    scope.dispose();
    assert.throws(() => scope.get(), /not initialized/);
});

test('property accessors enforce strict transitions and prevent undeclared fields', () => {
    const state = ApplicationState.createFields('test', { active: false });
    assert.throws(() => { state.active = false; }, /Redundant/);
    state.active = true;
    assert.equal(state.active, true);
    assert.throws(() => { state.extra = false; }, TypeError);
});

test('owned controller records and collections use strict setters without leaking input aliases', () => {
    const input = { count: 1 };
    const controller = { active: false, messages: [input], cache: new Map([['a', 'one']]) };
    ApplicationState.own(controller, 'test.controller', true);
    input.count = 4;
    assert.equal(controller.messages[0].count, 1);
    assert.throws(() => { controller.active = false; }, /Redundant/);
    assert.throws(() => { controller.messages[0].count = 1; }, /Redundant/);
    assert.throws(() => controller.cache.set('a', 'one'), /Redundant/);
    controller.messages[0].count = 2;
    controller.messages.push({ count: 3 });
    assert.equal(controller.messages.length, 2);
    assert.throws(() => { controller.other = true; }, TypeError);
});

test('snapshot collections cannot mutate state, including nested values', () => {
    const scope = ApplicationState.createScope('collections', { map: new Map([['a', {count: 1}]]), set: new Set(['a']) });
    assert.throws(() => scope.get().map.set('a', {count: 2}), /immutable/);
    assert.throws(() => { scope.get().map.get('a').count = 2; }, TypeError);
    assert.throws(() => scope.get().set.add('b'), /immutable/);
    scope.dispose();
});

test('managed array truncation works and snapshot validation is atomic', () => {
    const state = ApplicationState.createFields('atomic', { items: [1, 2], active: false });
    state.items.length = 1;
    assert.deepEqual([...state.items], [1]);
    assert.throws(() => { state.items.length = 1; }, /Redundant/);
    assert.throws(() => ApplicationState.receiveOwnerSnapshot(state, {active: true, missing: 1}), /Unknown/);
    assert.equal(state.active, false);
});
