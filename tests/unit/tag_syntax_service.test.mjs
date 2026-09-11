import assert from 'node:assert/strict';
import test from 'node:test';

import {
    analyzeTagBarInput,
    enforceTagBarInputForEditing,
    normalizeTagBarInput,
    parseTagBarSuggestionContext,
} from '../../app/static/js/modules/mode-manager/services/tag-syntax-service.js';

test('allows matching bracket wrappers up to 3', () => {
    assert.equal(enforceTagBarInputForEditing('[tag]'), '[tag]');
    assert.equal(enforceTagBarInputForEditing('((tag))'), '((tag))');
    assert.equal(enforceTagBarInputForEditing('{{{tag}}}'), '{{{tag}}}');
});

test('truncates wrappers beyond 3', () => {
    assert.equal(enforceTagBarInputForEditing('((((tag))))'), '(((tag)))');
    assert.equal(enforceTagBarInputForEditing('[[[[tag]]]]'), '[[[tag]]]');
    assert.equal(enforceTagBarInputForEditing('{{{{tag}}}}'), '{{{tag}}}');
});

test('autocorrects mismatched or extra wrapper closers', () => {
    assert.equal(enforceTagBarInputForEditing('[tag)'), '[tag');
    assert.equal(enforceTagBarInputForEditing('tag]'), 'tag');
    assert.equal(enforceTagBarInputForEditing('[tag]]'), '[tag]');
    assert.equal(enforceTagBarInputForEditing('((tag))}'), '((tag))');
});

test('preserves standalone / tokens while editing (comment start)', () => {
    assert.equal(enforceTagBarInputForEditing('foo bar /'), 'foo bar /');
    assert.equal(enforceTagBarInputForEditing('foo bar / '), 'foo bar / ');
});

test('removes commas from tag tokens', () => {
    assert.equal(enforceTagBarInputForEditing('tag,-give'), 'tag-give');
});

test('preserves one trailing assignment separator while typing its value', () => {
    assert.equal(enforceTagBarInputForEditing('@size='), '@size=');
    assert.equal(enforceTagBarInputForEditing('{{@size='), '{{@size=');
    assert.equal(enforceTagBarInputForEditing('{{@size=2'), '{{@size=2');
    assert.equal(enforceTagBarInputForEditing('{{@size=2}}'), '{{@size=2}}');
    assert.equal(enforceTagBarInputForEditing('@size= '), '@size ');
    assert.equal(enforceTagBarInputForEditing('{{@size= }}'), '{{@size}}');
});

test('does not warn on bare wrapper openers (but omits from sanitizedText)', () => {
    const analysis = analyzeTagBarInput('(');
    assert.equal(analysis.isValid, true);
    assert.equal(analysis.errorMessage, null);
    assert.equal(analysis.sanitizedText, '');
    assert.equal(analysis.normalizedText, '(');
});

test('reminds about an unclosed wrapper after a separating space and omits from sanitizedText', () => {
    const analysis = analyzeTagBarInput('foo (bar ');
    assert.equal(analysis.isValid, true);
    assert.equal(analysis.errorMessage, null);
    assert.equal(analysis.reminderMessage, 'Close scope with )');
    assert.equal(analysis.sanitizedText, 'foo');
    assert.equal(analysis.normalizedText, 'foo (bar');
});

test('does not warn on empty unclosed comment start (but omits from sanitizedText)', () => {
    const analysis = analyzeTagBarInput('foo /*');
    assert.equal(analysis.isValid, true);
    assert.equal(analysis.errorMessage, null);
    assert.equal(analysis.sanitizedText, 'foo');
    assert.equal(analysis.normalizedText, 'foo /*');
});

test('warns on unclosed comments with content and preserves normalizedText', () => {
    const analysis = analyzeTagBarInput('foo /*bar');
    assert.equal(analysis.isValid, false);
    assert.equal(analysis.errorMessage, 'Close comment with */');
    assert.equal(analysis.sanitizedText, 'foo');
    assert.equal(analysis.normalizedText, 'foo /*bar');
});

test('normalizeTagBarInput preserves closed wrappers', () => {
    assert.equal(normalizeTagBarInput(' [tag]  '), '[tag]');
    assert.equal(normalizeTagBarInput('((tag))   {{{tag}}}'), '((tag)) {{{tag}}}');
});

test('normalizeTagBarInput preserves one internal assignment separator for regular and meta tags', () => {
    assert.equal(normalizeTagBarInput('abc=2 abc=xyz {@size=1.25} @foo=bar'), 'abc=2 abc=xyz {@size=1.25} @foo=bar');
});

test('normalizeTagBarInput strips illegal assignment separators and invalid tag characters', () => {
    assert.equal(normalizeTagBarInput('a=b=c =abc abc='), 'abc abc abc');
    assert.equal(normalizeTagBarInput('abc=<script>'), 'abc=script');
});

test('exact uppercase OR is reserved and cannot be saved as a tag', () => {
    const reserved = analyzeTagBarInput('alpha OR beta');
    assert.equal(reserved.isValid, false);
    assert.equal(reserved.errorMessage, 'OR is reserved for search');

    const lowercase = analyzeTagBarInput('alpha or beta');
    assert.equal(lowercase.isValid, true);
    assert.equal(lowercase.normalizedText, 'alpha or beta');
});

test('parseTagBarSuggestionContext exposes all explicit tags including the current token', () => {
    const rawInput = 'linux Pandoc';
    const context = parseTagBarSuggestionContext(rawInput, rawInput.length);

    assert.deepEqual(context, {
        anchors: ['linux'],
        explicitTags: ['linux', 'Pandoc'],
        prefix: 'Pandoc',
        replaceStart: 6,
        replaceEnd: 12,
    });
});

for (const [opening, closing] of [['{', '}'], ['[[', ']]'], ['(((', ')))'], ['{{', '}}']]) {
    test(`unfinished ${opening} tag suggests its inner prefix without a warning`, () => {
        for (const prefix of ['@', '@foot', 'ordinary']) {
            const raw = `topic ${opening}${prefix}`;
            const analysis = analyzeTagBarInput(raw);
            assert.equal(analysis.isValid, true);
            assert.equal(analysis.sanitizedText, 'topic');
            const context = parseTagBarSuggestionContext(raw, raw.length);
            assert.equal(context.prefix, prefix);
            assert.equal(context.replaceStart, 'topic '.length + opening.length);
            assert.equal(raw.slice(0, context.replaceStart) + '@footnote' + raw.slice(context.replaceEnd), `topic ${opening}@footnote`);
            assert.deepEqual(context.anchors, ['topic']);
            assert.deepEqual(context.explicitTags, ['topic', prefix]);
        }
    });
    test(`unfinished ${opening} tag keeps suggestions with a reminder until the wrapper closes`, () => {
        for (const suffix of [' ', ' bar', '\t']) {
            const raw = `topic ${opening}@footnote${suffix}`;
            const analysis = analyzeTagBarInput(raw);
            assert.equal(analysis.errorMessage, null);
            assert.equal(analysis.reminderMessage, `Close scope with ${closing}`);
            assert.equal(analysis.sanitizedText, 'topic');
            assert.equal(parseTagBarSuggestionContext(raw, raw.length).prefix, suffix.trim());
            assert.equal(analyzeTagBarInput(raw + closing).isValid, true);
            assert.equal(analyzeTagBarInput(raw + closing).reminderMessage, "");
        }
    });
}

test('closed multi-tag scopes still support meta-tag completion', () => {
    const raw = 'topic {{@red @bo}}';
    const context = parseTagBarSuggestionContext(raw, raw.indexOf('}}'));
    assert.equal(context.prefix, '@bo');
    assert.deepEqual(context.anchors, ['topic', '@red']);
});


test('second scoped tag suggestions preserve partial closing delimiters', () => {
    const raw = 'topic {{@red @bo}';
    const context = parseTagBarSuggestionContext(raw, raw.length - 1);
    assert.equal(context.prefix, '@bo');
    assert.deepEqual(context.anchors, ['topic', '@red']);
    assert.equal(raw.slice(0, context.replaceStart) + '@bold' + raw.slice(context.replaceEnd), 'topic {{@red @bold}');
});
