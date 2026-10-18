// Links in shown notes open in a new tab, and the page they open gets no
// handle back to MetaList (rel noopener noreferrer). In-page links (#...) stay.

const NEW_TAB_REL_TOKENS = ['noopener', 'noreferrer'];

function mergeRelTokens(relValue) {
    const existingTokens = typeof relValue === 'string'
        ? relValue.split(/\s+/).filter((value) => value.length > 0)
        : [];
    const mergedTokens = [...existingTokens];
    for (const tokenName of NEW_TAB_REL_TOKENS) {
        if (!mergedTokens.includes(tokenName)) {
            mergedTokens.push(tokenName);
        }
    }
    return mergedTokens.join(' ');
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
