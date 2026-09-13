import { ApplicationState } from '../../application-state.js';
const MERMAID_CODE_SELECTOR = (
    '.meta-markdown .meta-mermaid-source > code.language-mermaid:not([data-mermaid-state])'
);
const MERMAID_SCRIPT_URL = '/static/js/vendor/mermaid-11.16.1.min.js';

const moduleState = ApplicationState.createFields('mermaid-render-service', {
    mermaidLoadPromise: null,
    mermaidRenderQueue: Promise.resolve(),
    mermaidRenderSequence: 0,
});


function requireMermaidApi(mermaidApi) {
    if (!mermaidApi || typeof mermaidApi !== 'object') {
        throw new Error('Mermaid API must be an object');
    }
    if (typeof mermaidApi.initialize !== 'function') {
        throw new Error('Mermaid API missing initialize');
    }
    if (typeof mermaidApi.parse !== 'function') {
        throw new Error('Mermaid API missing parse');
    }
    if (typeof mermaidApi.render !== 'function') {
        throw new Error('Mermaid API missing render');
    }
    return mermaidApi;
}

export function resolveMermaidTheme(rootDocument) {
    if (!rootDocument || typeof rootDocument !== 'object') {
        throw new Error('resolveMermaidTheme requires a document');
    }
    if (!rootDocument.documentElement) {
        throw new Error('resolveMermaidTheme requires documentElement');
    }

    const explicitTheme = rootDocument.documentElement.getAttribute('data-theme');
    if (explicitTheme === 'dark' || explicitTheme === 'light') {
        return explicitTheme;
    }

    const view = rootDocument.defaultView;
    if (
        view
        && typeof view.matchMedia === 'function'
        && view.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
        return 'dark';
    }
    return 'default';
}

export function buildMermaidConfig(theme) {
    if (!['default', 'light', 'dark'].includes(theme)) {
        throw new Error(`Unsupported Mermaid theme: ${theme}`);
    }
    return {
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'light' ? 'default' : theme,
        flowchart: {
            htmlLabels: true,
            useMaxWidth: true,
        },
    };
}

function resolveLoadedMermaidApi(rootDocument) {
    const view = rootDocument.defaultView;
    if (view && view.mermaid) {
        return requireMermaidApi(view.mermaid);
    }
    if (globalThis.mermaid) {
        return requireMermaidApi(globalThis.mermaid);
    }
    return null;
}

export function loadMermaidApi(rootDocument) {
    if (!rootDocument || typeof rootDocument !== 'object') {
        throw new Error('loadMermaidApi requires a document');
    }

    const loadedApi = resolveLoadedMermaidApi(rootDocument);
    if (loadedApi !== null) {
        return Promise.resolve(loadedApi);
    }
    if (moduleState.mermaidLoadPromise !== null) {
        return moduleState.mermaidLoadPromise;
    }
    if (!rootDocument.head || typeof rootDocument.createElement !== 'function') {
        throw new Error('loadMermaidApi requires a browser document');
    }

    moduleState.mermaidLoadPromise = new Promise((resolve, reject) => {
        const script = rootDocument.createElement('script');
        script.src = MERMAID_SCRIPT_URL;
        script.async = true;
        script.addEventListener('load', () => {
            const api = resolveLoadedMermaidApi(rootDocument);
            if (api === null) {
                reject(new Error('Mermaid script loaded without exposing its API'));
                return;
            }
            resolve(api);
        }, { once: true });
        script.addEventListener('error', () => {
            reject(new Error(`Failed to load Mermaid runtime from ${MERMAID_SCRIPT_URL}`));
        }, { once: true });
        rootDocument.head.appendChild(script);
    });
    return moduleState.mermaidLoadPromise;
}

function showInvalidMermaidSource(codeElement) {
    const sourceBlock = codeElement.parentElement;
    if (!sourceBlock) {
        throw new Error('Mermaid code element must have a parent source block');
    }
    const ownerDocument = codeElement.ownerDocument;
    if (!ownerDocument || typeof ownerDocument.createElement !== 'function') {
        throw new Error('Mermaid code element must belong to a document');
    }

    sourceBlock.classList.add('meta-mermaid-invalid');
    const badge = ownerDocument.createElement('div');
    badge.classList.add('meta-mermaid-error-badge');
    badge.textContent = 'Invalid Mermaid diagram';
    sourceBlock.insertBefore(badge, codeElement);
    codeElement.setAttribute('data-mermaid-state', 'invalid');
}

export async function renderMermaidCodeElement(codeElement, mermaidApi) {
    if (!codeElement || typeof codeElement !== 'object') {
        throw new Error('renderMermaidCodeElement requires a code element');
    }
    if (typeof codeElement.setAttribute !== 'function') {
        throw new Error('Mermaid code element missing setAttribute');
    }
    const sourceBlock = codeElement.parentElement;
    if (!sourceBlock || typeof sourceBlock.replaceWith !== 'function') {
        throw new Error('Mermaid code element must have a replaceable parent source block');
    }
    const ownerDocument = codeElement.ownerDocument;
    if (!ownerDocument || typeof ownerDocument.createElement !== 'function') {
        throw new Error('Mermaid code element must belong to a document');
    }

    const api = requireMermaidApi(mermaidApi);
    const source = codeElement.textContent;
    if (typeof source !== 'string') {
        throw new Error('Mermaid code element textContent must be a string');
    }

    codeElement.setAttribute('data-mermaid-state', 'rendering');
    const isValid = await api.parse(source, { suppressErrors: true });
    if (isValid === false) {
        showInvalidMermaidSource(codeElement);
        return false;
    }

    moduleState.mermaidRenderSequence += 1;
    const renderId = `metalist-mermaid-${moduleState.mermaidRenderSequence}`;
    const renderResult = await api.render(renderId, source);
    if (!renderResult || typeof renderResult !== 'object') {
        throw new Error('Mermaid render result must be an object');
    }
    if (typeof renderResult.svg !== 'string' || renderResult.svg.length === 0) {
        throw new Error('Mermaid render result missing SVG');
    }

    const diagram = ownerDocument.createElement('div');
    diagram.classList.add('meta-mermaid-diagram');
    diagram.setAttribute('role', 'img');
    diagram.setAttribute('aria-label', 'Mermaid diagram');
    diagram.setAttribute('data-mermaid-state', 'rendered');
    diagram.innerHTML = renderResult.svg;
    sourceBlock.replaceWith(diagram);
    if (typeof renderResult.bindFunctions === 'function') {
        renderResult.bindFunctions(diagram);
    }
    return true;
}

export async function renderMermaidDiagrams(rootElement, options) {
    if (!rootElement || typeof rootElement !== 'object') {
        throw new Error('renderMermaidDiagrams requires a root element');
    }
    if (typeof rootElement.querySelectorAll !== 'function') {
        throw new Error('Mermaid root element missing querySelectorAll');
    }
    if (!options || typeof options !== 'object') {
        throw new Error('renderMermaidDiagrams options must be an object');
    }

    const codeElements = Array.from(rootElement.querySelectorAll(MERMAID_CODE_SELECTOR));
    if (codeElements.length === 0) {
        return { renderedCount: 0, invalidCount: 0 };
    }

    const rootDocument = rootElement.ownerDocument;
    if (!rootDocument) {
        throw new Error('Mermaid root element must belong to a document');
    }
    const api = Object.prototype.hasOwnProperty.call(options, 'mermaidApi')
        ? requireMermaidApi(options.mermaidApi)
        : await loadMermaidApi(rootDocument);
    api.initialize(buildMermaidConfig(resolveMermaidTheme(rootDocument)));

    let renderedCount = 0;
    let invalidCount = 0;
    for (const codeElement of codeElements) {
        const didRender = await renderMermaidCodeElement(codeElement, api);
        if (didRender) {
            renderedCount += 1;
        } else {
            invalidCount += 1;
        }
    }
    return { renderedCount, invalidCount };
}

export function queueMermaidDiagramRendering(rootElement) {
    moduleState.mermaidRenderQueue = moduleState.mermaidRenderQueue.then(() => renderMermaidDiagrams(rootElement, {}));
    return moduleState.mermaidRenderQueue;
}
