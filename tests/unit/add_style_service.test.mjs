import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ADD_STYLE_OPTIONS,
    appendStyleTagToken,
    buildStyleApplicationPlan,
    chooseStyleScope,
} from '../../app/static/js/modules/mode-manager/services/add-style-service.js';


test('Add Style exposes the supported formatting and renderer tags', () => {
    const tags = ADD_STYLE_OPTIONS.map((option) => option.tag);
    assert.equal(tags.includes('@heading'), true);
    assert.equal(tags.includes('@red'), true);
    assert.equal(tags.includes('@blue'), true);
    assert.equal(tags.includes('@highlighter'), true);
    assert.equal(tags.includes('@markdown'), true);
    assert.equal(tags.includes('@csv'), true);
    assert.equal(tags.includes('@size=0.1'), true);
    assert.equal(tags.includes('@size=0.25'), true);
    assert.equal(tags.includes('@size=0.5'), true);
    assert.equal(tags.includes('@size=3.0'), true);
});


test('whole-note style plan adds an unscoped tag', () => {
    assert.deepEqual(
        buildStyleApplicationPlan({
            styleTag: '@red',
            contentText: 'scarlet',
            tagBarText: '',
            hasSelection: false,
        }),
        {
            styleTag: '@red',
            tagToken: '@red',
            openToken: '',
            closeToken: '',
        },
    );
});


test('selected style prefers single curly braces', () => {
    assert.deepEqual(
        buildStyleApplicationPlan({
            styleTag: '@red',
            contentText: 'my content has scarlet',
            tagBarText: '',
            hasSelection: true,
        }),
        {
            styleTag: '@red',
            tagToken: '{@red}',
            openToken: '{',
            closeToken: '}',
        },
    );
});


test('scope selection avoids symbols already used by content or tag bar', () => {
    assert.deepEqual(chooseStyleScope('uses {curly}', ''), {
        opener: '[',
        closer: ']',
        depth: 1,
        openToken: '[',
        closeToken: ']',
    });
    assert.deepEqual(chooseStyleScope('uses {curly} and [square]', '(existing)'), {
        opener: '{',
        closer: '}',
        depth: 2,
        openToken: '{{',
        closeToken: '}}',
    });
});


test('scope selection fails loudly after all supported delimiters are exhausted', () => {
    const allDelimiters = '{}[]() {{}} [[]] (()) {{{}}} [[[]]] ((()))';
    assert.throws(
        () => chooseStyleScope(allDelimiters, ''),
        /No unused style scope delimiter/,
    );
});


test('style tag append preserves wrappers and avoids exact duplicates', () => {
    assert.equal(appendStyleTagToken('@blue {{@red @bold}}', '{@italic}'), '@blue {{@red @bold}} {@italic}');
    assert.equal(appendStyleTagToken('@blue /* note */', '@blue'), '@blue /* note */');
});


test('footnote requires a selection and reuses an existing dedicated scope', () => {
    assert.equal(ADD_STYLE_OPTIONS.find((option) => option.tag === '@footnote').selectionOnly, true);
    assert.throws(() => buildStyleApplicationPlan({
        styleTag: '@footnote', contentText: 'body', tagBarText: '', hasSelection: false,
    }), /requires a text selection/);
    const first = buildStyleApplicationPlan({
        styleTag: '@footnote', contentText: 'body', tagBarText: '', hasSelection: true,
    });
    assert.equal(first.tagToken, '{@footnote}');
    const second = buildStyleApplicationPlan({
        styleTag: '@footnote', contentText: 'body{first} next', tagBarText: '{@footnote}', hasSelection: true,
    });
    assert.deepEqual(second, first);
    assert.equal(appendStyleTagToken('{@footnote}', second.tagToken), '{@footnote}');
});
