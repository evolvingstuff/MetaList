import assert from 'node:assert/strict';
import test from 'node:test';

import {
    analyzeTagBarInput,
    enforceTagBarInputForEditing,
    findTagAtIndexInTagBar,
    normalizeTagBarInput,
    parseTagBarSuggestionContext,
    splitTagsForDisplay,
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

test('sanitizeTagBarInput removes incomplete meta tags and conflicting scoped renderers', () => {
    assert.equal(analyzeTagBarInput('topic @ @red').sanitizedText, 'topic @red');
    assert.equal(analyzeTagBarInput('[@] {@ topic}').sanitizedText, '{topic}');
    assert.equal(analyzeTagBarInput('{topic @json @csv @bold}').sanitizedText, '{topic @json @bold}');
    assert.equal(analyzeTagBarInput('topic {{@ ').sanitizedText, 'topic');
    assert.equal(analyzeTagBarInput('topic @cvs @csv @size=0 @size=2.0').sanitizedText, 'topic @csv @size=2.0');
    assert.equal(analyzeTagBarInput('{topic @cvs @csv}').sanitizedText, '{topic @csv}');
    assert.equal(analyzeTagBarInput('@password @LaTeX @size=0.4').sanitizedText, '@password @LaTeX @size=0.4');
    assert.equal(analyzeTagBarInput('@json @csv topic').sanitizedText, '@json topic');
    // @chess is a renderer like the others: kept alone, and one renderer per scope.
    assert.equal(analyzeTagBarInput('opening @chess').sanitizedText, 'opening @chess');
    assert.equal(analyzeTagBarInput('@chess @csv topic').sanitizedText, '@chess topic');
    // @diff, and @code=<language> for any language name (one tag, a value like @size=).
    assert.equal(analyzeTagBarInput('changes @diff').sanitizedText, 'changes @diff');
    assert.equal(analyzeTagBarInput('snippet @code=python').sanitizedText, 'snippet @code=python');
    assert.equal(analyzeTagBarInput('@code=c++ @code=c#').sanitizedText, '@code=c++');
    assert.equal(analyzeTagBarInput('{a @code=sql @json}').sanitizedText, '{a @code=sql}');
    assert.equal(analyzeTagBarInput('topic @code=').sanitizedText, 'topic');
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
        isTypingProperty: false,
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

test('splits saved tags into display pieces without breaking scopes or comments', () => {
    assert.deepEqual(
        splitTagsForDisplay('travel japan @red {{@monospace @bold}} /* for the April trip */ [[@LaTeX]]'),
        [
            { kind: 'tag', text: 'travel' },
            { kind: 'tag', text: 'japan' },
            { kind: 'meta', text: '@red' },
            { kind: 'scope', text: '{{@monospace @bold}}' },
            { kind: 'comment', text: '/* for the April trip */' },
            { kind: 'scope', text: '[[@LaTeX]]' },
        ],
    );
});

test('display pieces keep the saved text and handle empty or unfinished input', () => {
    assert.deepEqual(splitTagsForDisplay(''), []);
    assert.deepEqual(splitTagsForDisplay('   '), []);
    assert.deepEqual(splitTagsForDisplay('todo /* unfinished'), [
        { kind: 'tag', text: 'todo' },
        { kind: 'comment', text: '/* unfinished' },
    ]);
    const saved = 'phone-number contact {@json} /* a b */';
    assert.equal(splitTagsForDisplay(saved).map((piece) => piece.text).join(' '), saved);
});

// Tag properties (docs/design/tag-properties.md): jogging:miles=3:duration=30.
test('a tag keeps properties as typed and saves only complete ones, once each', () => {
    const cases = [
        ['jogging:miles=3:duration=30', 'jogging:miles=3:duration=30', 'jogging:miles=3:duration=30'],
        ['run:start=10:30pm:miles=3', 'run:start=10:30pm:miles=3', 'run:start=10:30pm:miles=3'],
        ['meeting:at=2026-10-23T10:30:room=b2', 'meeting:at=2026-10-23T10:30:room=b2', 'meeting:at=2026-10-23T10:30:room=b2'],
        ['url:link=https://x.com/a', 'url:link=https://x.com/a', 'url:link=https://x.com/a'],
        ['jogging:', 'jogging:', 'jogging'],
        ['jogging:mi', 'jogging:mi', 'jogging'],
        ['jogging:miles=', 'jogging:miles=', 'jogging'],
        ['jogging:miles=3:miles=5', 'jogging:miles=3:miles=5', 'jogging:miles=3'],
        ['jogging:3', 'jogging:', 'jogging'],
        ['jogging=3:miles=3', 'jogging=3:miles=3', 'jogging=3:miles=3'],
        ['x:ref=abc:def', 'x:ref=abc:def', 'x:ref=abc'],
    ];
    for (const [typed, whileTyping, saved] of cases) {
        assert.equal(enforceTagBarInputForEditing(typed), whileTyping, `while typing ${typed}`);
        assert.equal(analyzeTagBarInput(typed).sanitizedText, saved, `saving ${typed}`);
    }
});

test('meta tags and tags inside scopes have no properties', () => {
    assert.equal(enforceTagBarInputForEditing('{{jogging:miles=3}}'), '{{joggingmiles=3}}');
    assert.equal(enforceTagBarInputForEditing('@size:2'), '@size2');
});

test('a tag with properties is on a note once: a second token for it is refused', () => {
    for (const typed of ['jogging:miles=3 jogging', 'jogging jogging:miles=3', 'jogging:miles=3 Jogging:miles=4']) {
        const analysis = analyzeTagBarInput(typed);
        assert.equal(analysis.sanitizedText.split(' ').length, 1, typed);
        assert.equal(analysis.reminderMessage.endsWith('is already on this note'), true, typed);
    }
    // Valued tags without properties keep working as before.
    assert.equal(analyzeTagBarInput('priority=high priority=low').sanitizedText, 'priority=high priority=low');
});

test('a tag with properties counts as its tag for menus and suggestions', () => {
    assert.equal(findTagAtIndexInTagBar('foo jogging:miles=3', 15).text, 'jogging');
    // Typing a property sends the token so far, replaced whole by the chosen name or unit.
    const typingProperty = parseTagBarSuggestionContext('foo jogging:mi', 14);
    assert.equal(typingProperty.isTypingProperty, true);
    assert.equal(typingProperty.prefix, 'jogging:mi');
    assert.equal(typingProperty.replaceStart, 4);
    assert.equal(parseTagBarSuggestionContext('foo jog', 7).isTypingProperty, false);
    assert.deepEqual(parseTagBarSuggestionContext('foo jogging:miles=3 ba', 22).explicitTags, ['foo', 'jogging', 'ba']);
});
