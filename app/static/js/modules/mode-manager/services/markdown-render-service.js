import { ApplicationState } from '../../application-state.js';
const META_MARKDOWN_SELECTOR = '.meta-markdown';
const MARKDOWN_RENDERED_ATTR = 'markdown-rendered';
const MARKDOWN_NEW_TAB_REL_TOKENS = ['noopener', 'noreferrer'];

const moduleState = ApplicationState.createFields('markdown-render-service', {
    cachedRenderer: null,
});

function setTokenAttribute(token, name, value) {
    const existingIndex = token.attrIndex(name);
    if (existingIndex >= 0) {
        token.attrs[existingIndex][1] = value;
        return;
    }
    token.attrPush([name, value]);
}

export function ensureMarkdownLinkTokenOpensInNewTab(token) {
    if (!token || typeof token !== 'object') {
        throw new Error('ensureMarkdownLinkTokenOpensInNewTab requires token object');
    }
    if (typeof token.attrIndex !== 'function') {
        throw new Error('Markdown link token missing attrIndex');
    }
    if (typeof token.attrPush !== 'function') {
        throw new Error('Markdown link token missing attrPush');
    }
    if (!Array.isArray(token.attrs)) {
        token.attrs = [];
    }

    setTokenAttribute(token, 'target', '_blank');

    const relIndex = token.attrIndex('rel');
    if (relIndex >= 0) {
        const existingTokens = token.attrs[relIndex][1].split(/\s+/).filter((value) => value.length > 0);
        const mergedTokens = [...existingTokens];
        for (const tokenName of MARKDOWN_NEW_TAB_REL_TOKENS) {
            if (!mergedTokens.includes(tokenName)) {
                mergedTokens.push(tokenName);
            }
        }
        token.attrs[relIndex][1] = mergedTokens.join(' ');
        return;
    }

    token.attrPush(['rel', MARKDOWN_NEW_TAB_REL_TOKENS.join(' ')]);
}

function mergeRelTokens(relValue) {
    const existingTokens = typeof relValue === 'string'
        ? relValue.split(/\s+/).filter((value) => value.length > 0)
        : [];
    const mergedTokens = [...existingTokens];
    for (const tokenName of MARKDOWN_NEW_TAB_REL_TOKENS) {
        if (!mergedTokens.includes(tokenName)) {
            mergedTokens.push(tokenName);
        }
    }
    return mergedTokens.join(' ');
}

export function applyMarkdownLinkTargetPolicy(renderer) {
    if (!renderer || typeof renderer !== 'object') {
        throw new Error('applyMarkdownLinkTargetPolicy requires renderer object');
    }
    if (!renderer.renderer || typeof renderer.renderer !== 'object') {
        throw new Error('applyMarkdownLinkTargetPolicy requires renderer.renderer');
    }

    const existingLinkOpenRule = renderer.renderer.rules.link_open;
    renderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        ensureMarkdownLinkTokenOpensInNewTab(tokens[idx]);
        if (typeof existingLinkOpenRule === 'function') {
            return existingLinkOpenRule(tokens, idx, options, env, self);
        }
        return self.renderToken(tokens, idx, options);
    };
}

export function ensureAnchorOpensInNewTab(anchorElement) {
    if (!anchorElement || typeof anchorElement !== 'object') {
        throw new Error('ensureAnchorOpensInNewTab requires anchor element');
    }
    if (typeof anchorElement.getAttribute !== 'function') {
        throw new Error('Anchor element missing getAttribute');
    }
    if (typeof anchorElement.setAttribute !== 'function') {
        throw new Error('Anchor element missing setAttribute');
    }

    const href = anchorElement.getAttribute('href');
    if (typeof href !== 'string' || href.length === 0 || href.startsWith('#')) {
        return;
    }

    anchorElement.setAttribute('target', '_blank');
    anchorElement.setAttribute('rel', mergeRelTokens(anchorElement.getAttribute('rel')));
}

export function ensureAnchorsOpenInNewTabs(rootElement) {
    if (!rootElement || typeof rootElement !== 'object') {
        throw new Error('ensureAnchorsOpenInNewTabs requires root element');
    }
    if (typeof rootElement.querySelectorAll !== 'function') {
        throw new Error('Root element missing querySelectorAll');
    }

    const anchors = rootElement.querySelectorAll('a[href]');
    for (const anchor of anchors) {
        ensureAnchorOpensInNewTab(anchor);
    }
}

function getMarkdownRenderer() {
    if (moduleState.cachedRenderer) {
        return moduleState.cachedRenderer;
    }
    const factory = window.markdownit;
    if (typeof factory !== 'function') {
        throw new Error('markdown-it is not available; ensure markdown-it is loaded');
    }
    moduleState.cachedRenderer = factory({
        html: false,
        linkify: true,
        breaks: true,
    });
    applyMarkdownLinkTargetPolicy(moduleState.cachedRenderer);
    return moduleState.cachedRenderer;
}

export function renderMarkdownBlocks(rootElement) {
    if (!rootElement) {
        throw new Error('renderMarkdownBlocks requires a root element');
    }
    const blocks = rootElement.querySelectorAll(
        `${META_MARKDOWN_SELECTOR}:not([data-${MARKDOWN_RENDERED_ATTR}="true"])`
    );
    if (blocks.length === 0) {
        return;
    }
    const renderer = getMarkdownRenderer();
    blocks.forEach((block) => {
        const rawText = block.textContent;
        const source = rawText === null ? '' : rawText;
        const rendered = renderer.render(source);
        block.innerHTML = rendered;
        ensureAnchorsOpenInNewTabs(block);
        block.setAttribute(`data-${MARKDOWN_RENDERED_ATTR}`, 'true');
    });
}

export function renderMarkdownHtml(htmlText) {
    if (typeof htmlText !== 'string') {
        throw new Error('renderMarkdownHtml requires htmlText string');
    }
    const container = document.createElement('div');
    container.innerHTML = htmlText;
    renderMarkdownBlocks(container);
    ensureAnchorsOpenInNewTabs(container);
    return container.innerHTML;
}
