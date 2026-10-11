import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildMermaidConfig,
    renderMermaidCodeElement,
    renderMermaidDiagrams,
    resolveMermaidTheme,
} from '../../app/static/js/modules/mode-manager/services/mermaid-render-service.js';

function createFakeClassList() {
    const values = new Set();
    return {
        add(...classNames) {
            classNames.forEach((className) => values.add(className));
        },
        contains(className) {
            return values.has(className);
        },
        snapshot() {
            return [...values];
        },
    };
}

function createFakeDocument(theme = 'light') {
    const rootAttributes = new Map([['data-theme', theme]]);
    const fakeDocument = {
        defaultView: {
            matchMedia() {
                return { matches: false };
            },
        },
        documentElement: {
            getAttribute(name) {
                return rootAttributes.has(name) ? rootAttributes.get(name) : null;
            },
        },
        createElement(tagName) {
            return createFakeElement(fakeDocument, tagName);
        },
    };
    return fakeDocument;
}

function createFakeElement(ownerDocument, tagName) {
    const attributes = new Map();
    const element = {
        tagName: tagName.toUpperCase(),
        ownerDocument,
        parentElement: null,
        children: [],
        classList: createFakeClassList(),
        textContent: '',
        innerHTML: '',
        replacement: null,
        // Not laid out: no size to measure, so nothing is cached.
        clientWidth: 0,
        getBoundingClientRect() {
            return { top: 0, height: 0 };
        },
        setAttribute(name, value) {
            attributes.set(name, value);
        },
        getAttribute(name) {
            return attributes.has(name) ? attributes.get(name) : null;
        },
        insertBefore(child, referenceChild) {
            const referenceIndex = this.children.indexOf(referenceChild);
            assert.notEqual(referenceIndex, -1);
            child.parentElement = this;
            this.children.splice(referenceIndex, 0, child);
        },
        replaceWith(replacement) {
            this.replacement = replacement;
        },
    };
    return element;
}

function createMermaidSource(source, theme = 'light') {
    const ownerDocument = createFakeDocument(theme);
    const sourceBlock = createFakeElement(ownerDocument, 'pre');
    const codeElement = createFakeElement(ownerDocument, 'code');
    codeElement.textContent = source;
    codeElement.parentElement = sourceBlock;
    sourceBlock.children.push(codeElement);
    return { codeElement, ownerDocument, sourceBlock };
}

function createFakeMermaidApi({ isValid = true } = {}) {
    const calls = {
        initialize: [],
        parse: [],
        render: [],
        boundElement: null,
    };
    return {
        calls,
        initialize(config) {
            calls.initialize.push(config);
        },
        async parse(source, options) {
            calls.parse.push({ source, options });
            return isValid;
        },
        async render(renderId, source) {
            calls.render.push({ renderId, source });
            return {
                svg: '<svg viewBox="0 0 100 50"><text>diagram</text></svg>',
                bindFunctions(element) {
                    calls.boundElement = element;
                },
            };
        },
    };
}

test('buildMermaidConfig enforces strict local rendering', () => {
    assert.deepEqual(buildMermaidConfig('dark'), {
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'dark',
        themeVariables: {
            fontSize: '13px',
        },
        flowchart: {
            htmlLabels: true,
            useMaxWidth: true,
            nodeSpacing: 24,
            rankSpacing: 28,
            padding: 6,
            diagramPadding: 4,
        },
    });
    assert.equal(buildMermaidConfig('light').theme, 'default');
});

test('resolveMermaidTheme honors explicit and system themes', () => {
    const darkDocument = createFakeDocument('dark');
    assert.equal(resolveMermaidTheme(darkDocument), 'dark');

    const systemDocument = createFakeDocument('system');
    systemDocument.defaultView.matchMedia = (query) => {
        assert.equal(query, '(prefers-color-scheme: dark)');
        return { matches: true };
    };
    assert.equal(resolveMermaidTheme(systemDocument), 'dark');
});

test('renderMermaidCodeElement replaces valid source with accessible SVG', async () => {
    const source = 'flowchart TD\nA[Source<br/>table_a] --> B[Target]';
    const { codeElement, sourceBlock } = createMermaidSource(source);
    const mermaidApi = createFakeMermaidApi();

    const didRender = await renderMermaidCodeElement(codeElement, mermaidApi);

    assert.equal(didRender, true);
    assert.deepEqual(mermaidApi.calls.parse, [
        { source, options: { suppressErrors: true } },
    ]);
    assert.equal(mermaidApi.calls.render.length, 1);
    assert.equal(mermaidApi.calls.render[0].source, source);
    assert.match(mermaidApi.calls.render[0].renderId, /^metalist-mermaid-\d+$/);
    const diagram = sourceBlock.replacement;
    assert.ok(diagram.classList.contains('meta-mermaid-diagram'));
    assert.equal(diagram.getAttribute('role'), 'img');
    assert.equal(diagram.getAttribute('aria-label'), 'Mermaid diagram');
    assert.equal(diagram.getAttribute('data-mermaid-state'), 'rendered');
    assert.match(diagram.innerHTML, /^<svg/);
    assert.equal(mermaidApi.calls.boundElement, diagram);
});

test('renderMermaidCodeElement gives Mermaid ordinary spaces for pasted indentation', async () => {
    // Pasting into a note stores leading spaces as non-breaking spaces; Mermaid's
    // pie (and other) parsers reject them, so a pasted pie chart showed
    // "Invalid Mermaid diagram".
    const { codeElement } = createMermaidSource('pie title Paste tests\n\u00a0 \u00a0 "Passed" : 9\n\u00a0 \u00a0 "Pending" : 1');
    const mermaidApi = createFakeMermaidApi();

    await renderMermaidCodeElement(codeElement, mermaidApi);

    const expected = 'pie title Paste tests\n    "Passed" : 9\n    "Pending" : 1';
    assert.deepEqual(mermaidApi.calls.parse, [{ source: expected, options: { suppressErrors: true } }]);
    assert.equal(mermaidApi.calls.render[0].source, expected);
});

test('renderMermaidCodeElement preserves invalid source with an error badge', async () => {
    const source = 'flowchart TD\nA -x';
    const { codeElement, sourceBlock } = createMermaidSource(source);
    const mermaidApi = createFakeMermaidApi({ isValid: false });

    const didRender = await renderMermaidCodeElement(codeElement, mermaidApi);

    assert.equal(didRender, false);
    assert.equal(sourceBlock.replacement, null);
    assert.ok(sourceBlock.classList.contains('meta-mermaid-invalid'));
    assert.equal(sourceBlock.children.length, 2);
    assert.equal(sourceBlock.children[0].textContent, 'Invalid Mermaid diagram');
    assert.equal(sourceBlock.children[1], codeElement);
    assert.equal(codeElement.getAttribute('data-mermaid-state'), 'invalid');
    assert.equal(codeElement.textContent, source);
    assert.equal(mermaidApi.calls.render.length, 0);
});

test('renderMermaidDiagrams initializes the current theme and reports counts', async () => {
    const { codeElement, ownerDocument } = createMermaidSource('flowchart LR\nA-->B', 'dark');
    const mermaidApi = createFakeMermaidApi();
    const rootElement = {
        ownerDocument,
        querySelectorAll(selector) {
            assert.match(selector, /language-mermaid/);
            return [codeElement];
        },
    };

    const counts = await renderMermaidDiagrams(rootElement, { mermaidApi });

    assert.deepEqual(counts, { renderedCount: 1, invalidCount: 0 });
    assert.equal(mermaidApi.calls.initialize.length, 1);
    assert.equal(mermaidApi.calls.initialize[0].theme, 'dark');
    assert.equal(mermaidApi.calls.initialize[0].securityLevel, 'strict');
});
