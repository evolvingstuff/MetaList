// The new tab that opens another namespace shows the login screen's dark logo
// screen while that namespace answers, with the logo exactly where the namespace's
// own login screen puts it, so its arrival only fades the panel in under the logo
// (docs/ui/login-screen.md, Switching namespace). The styles are the login screen's
// own rules, copied from this page, so the two cannot drift apart.

function escapeHtml(value) {
    if (typeof value !== 'string') {
        throw new Error('escapeHtml requires string');
    }
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}


function isLoginScreenRule(rule) {
    if (rule.type === CSSRule.STYLE_RULE) {
        if (rule.selectorText === 'html') return true;
        return rule.selectorText.includes('.login-');
    }
    if (rule.type === CSSRule.KEYFRAMES_RULE) {
        return rule.name.startsWith('login-');
    }
    if (rule.type === CSSRule.MEDIA_RULE) {
        return rule.cssText.includes('.login-');
    }
    return false;
}


// The login screen's rules from this page's stylesheets (main.css is same-origin).
export function collectLoginScreenCss(sourceDocument) {
    if (!sourceDocument || !sourceDocument.styleSheets) {
        throw new Error('collectLoginScreenCss requires a document');
    }
    const rules = [];
    for (const sheet of Array.from(sourceDocument.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules)) {
            if (isLoginScreenRule(rule)) rules.push(rule.cssText);
        }
    }
    if (!rules.some((cssText) => cssText.startsWith('.login-stage'))) {
        throw new Error('The login screen styles are not loaded on this page');
    }
    return rules.join('\n');
}


export function buildNamespaceLoadingPageHtml(namespace, loginCss, logoMarkup) {
    if (typeof namespace !== 'string' || namespace.trim().length === 0) {
        throw new Error('buildNamespaceLoadingPageHtml requires namespace');
    }
    if (typeof loginCss !== 'string' || loginCss.length === 0) {
        throw new Error('buildNamespaceLoadingPageHtml requires the login screen styles');
    }
    if (typeof logoMarkup !== 'string' || !logoMarkup.includes('<svg')) {
        throw new Error('buildNamespaceLoadingPageHtml requires the logo markup');
    }
    const normalizedNamespace = namespace.trim();
    const escapedNamespace = escapeHtml(normalizedNamespace);
    const escapedTitle = escapeHtml(`Opening ${normalizedNamespace}…`);
    // A "</style>" inside the copied rules would end the style element early.
    if (loginCss.toLowerCase().includes('</style')) {
        throw new Error('The login screen styles cannot contain a closing style tag');
    }
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapedTitle}</title>
    <style>
        :root { color-scheme: dark; }
        html, body { margin: 0; background: #050505; cursor: wait; }
${loginCss}
    </style>
</head>
<body>
    <div class="login-page" style="display: flex;">
        <div class="login-stage">
            <div class="login-logo" aria-hidden="true">${logoMarkup}</div>
            <p class="login-opening-note">Starting ${escapedNamespace}…</p>
        </div>
    </div>
</body>
</html>`;
}


export function renderNamespaceLoadingTab(pendingTab, namespace) {
    if (!pendingTab || typeof pendingTab !== 'object' || pendingTab.closed) {
        throw new Error('renderNamespaceLoadingTab requires an open pending tab');
    }
    if (!pendingTab.document || typeof pendingTab.document.open !== 'function') {
        throw new Error('renderNamespaceLoadingTab requires pending tab document');
    }
    const logo = document.getElementById('login-logo');
    if (logo === null) {
        throw new Error('renderNamespaceLoadingTab requires the login logo on this page');
    }
    const loadingHtml = buildNamespaceLoadingPageHtml(namespace, collectLoginScreenCss(document), logo.innerHTML.trim());
    pendingTab.document.open();
    pendingTab.document.write(loadingHtml);
    pendingTab.document.close();
}
