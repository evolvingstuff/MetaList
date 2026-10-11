import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildNamespaceLoadingPageHtml,
    collectLoginScreenCss,
} from '../../app/static/js/modules/modals/namespace-loading-page.js';

// The tab opening another namespace shows the login screen's logo screen, so the
// namespace's own login screen arrives without a different page in between.

const LOGO = '<svg class="login-logo-mark" viewBox="0 0 340 223"><rect></rect></svg>';
const CSS = '.login-stage { margin-top: max(48px, 16vh); }';

globalThis.CSSRule = { STYLE_RULE: 1, MEDIA_RULE: 4, KEYFRAMES_RULE: 7 };

function styleRule(selectorText) {
    return { type: 1, selectorText, cssText: `${selectorText} { color: red; }` };
}


test('the opening tab shows the logo with the login screen styles and nothing else at first', () => {
    const html = buildNamespaceLoadingPageHtml('me', CSS, LOGO);

    assert.match(html, /<div class="login-page" style="display: flex;">\s*<div class="login-stage">\s*<div class="login-logo" aria-hidden="true"><svg class="login-logo-mark"/);
    assert.ok(html.includes(CSS));
    // The line under the logo fades in only after a second (main.css), for a namespace that starts.
    assert.match(html, /<p class="login-opening-note">Starting me…<\/p>/);
    assert.doesNotMatch(html, /Loading namespace/);
    assert.match(html, /background: #050505/);
});


test('the opening tab escapes the namespace name', () => {
    const html = buildNamespaceLoadingPageHtml('<script>alert(1)<\/script>', CSS, LOGO);

    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});


test('the opening tab requires the login screen styles and logo', () => {
    assert.throws(() => buildNamespaceLoadingPageHtml('me', '', LOGO), /login screen styles/);
    assert.throws(() => buildNamespaceLoadingPageHtml('me', CSS, ''), /logo markup/);
    assert.throws(() => buildNamespaceLoadingPageHtml('me', '.login-stage{} </style><b>', LOGO), /closing style tag/);
});


test('only the login screen rules are copied from the page', () => {
    const sourceDocument = {
        styleSheets: [{
            cssRules: [
                styleRule('html'),
                styleRule('.login-stage'),
                styleRule('.note-row'),
                { type: 7, name: 'login-fade-in', cssText: '@keyframes login-fade-in { }' },
                { type: 7, name: 'note-flash', cssText: '@keyframes note-flash { }' },
                { type: 4, cssText: '@media (prefers-reduced-motion: reduce) { .login-panel { animation: none; } }' },
                { type: 4, cssText: '@media (max-width: 600px) { .note-row { padding: 0; } }' },
            ],
        }],
    };

    const css = collectLoginScreenCss(sourceDocument);

    assert.deepEqual(css.split('\n'), [
        'html { color: red; }',
        '.login-stage { color: red; }',
        '@keyframes login-fade-in { }',
        '@media (prefers-reduced-motion: reduce) { .login-panel { animation: none; } }',
    ]);
});


test('a page without the login screen styles cannot build the opening tab', () => {
    assert.throws(
        () => collectLoginScreenCss({ styleSheets: [{ cssRules: [styleRule('.note-row')] }] }),
        /login screen styles are not loaded/,
    );
});
