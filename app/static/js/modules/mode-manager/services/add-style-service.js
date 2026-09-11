const WRAPPER_TYPES = Object.freeze([
    Object.freeze({ opener: '{', closer: '}' }),
    Object.freeze({ opener: '[', closer: ']' }),
    Object.freeze({ opener: '(', closer: ')' }),
]);

export const ADD_STYLE_OPTIONS = Object.freeze([
    Object.freeze({ id: 'footnote', label: 'Footnote', tag: '@footnote', selectionOnly: true }),
    Object.freeze({ id: 'heading', label: 'Heading', tag: '@heading' }),
    Object.freeze({ id: 'bold', label: 'Bold', tag: '@bold' }),
    Object.freeze({ id: 'italic', label: 'Italic', tag: '@italic' }),
    Object.freeze({ id: 'strikethrough', label: 'Strikethrough', tag: '@strikethrough' }),
    Object.freeze({ id: 'monospace', label: 'Monospace', tag: '@monospace' }),
    Object.freeze({ id: 'serif', label: 'Serif', tag: '@serif' }),
    Object.freeze({ id: 'red', label: 'Red', tag: '@red' }),
    Object.freeze({ id: 'green', label: 'Green', tag: '@green' }),
    Object.freeze({ id: 'blue', label: 'Blue', tag: '@blue' }),
    Object.freeze({ id: 'grey', label: 'Grey', tag: '@grey' }),
    Object.freeze({ id: 'highlighter', label: 'Highlighter', tag: '@highlighter' }),
    Object.freeze({ id: 'copyable', label: 'Copyable', tag: '@copyable' }),
    Object.freeze({ id: 'size-010', label: 'Size 10%', tag: '@size=0.1' }),
    Object.freeze({ id: 'size-025', label: 'Size 25%', tag: '@size=0.25' }),
    Object.freeze({ id: 'size-050', label: 'Size 50%', tag: '@size=0.5' }),
    Object.freeze({ id: 'size-075', label: 'Size 75%', tag: '@size=0.75' }),
    Object.freeze({ id: 'size-125', label: 'Size 125%', tag: '@size=1.25' }),
    Object.freeze({ id: 'size-150', label: 'Size 150%', tag: '@size=1.5' }),
    Object.freeze({ id: 'size-200', label: 'Size 200%', tag: '@size=2.0' }),
    Object.freeze({ id: 'size-300', label: 'Size 300%', tag: '@size=3.0' }),
    Object.freeze({ id: 'markdown', label: 'Markdown', tag: '@markdown' }),
    Object.freeze({ id: 'latex', label: 'LaTeX', tag: '@LaTeX' }),
    Object.freeze({ id: 'json', label: 'JSON', tag: '@json' }),
    Object.freeze({ id: 'csv', label: 'CSV', tag: '@csv' }),
    Object.freeze({ id: 'shell', label: 'Shell', tag: '@shell' }),
]);

const KNOWN_STYLE_TAGS = new Set(ADD_STYLE_OPTIONS.map((option) => option.tag));

function requireText(value, name) {
    if (typeof value !== 'string') {
        throw new Error(`${name} must be a string`);
    }
}

function requireKnownStyleTag(styleTag) {
    requireText(styleTag, 'styleTag');
    if (!KNOWN_STYLE_TAGS.has(styleTag)) {
        throw new Error(`Unknown Add Style tag: ${styleTag}`);
    }
}

function scanTopLevelTagTokens(tagBarText) {
    requireText(tagBarText, 'tagBarText');

    const tokens = [];
    let index = 0;
    while (index < tagBarText.length) {
        while (index < tagBarText.length && /\s/.test(tagBarText[index])) {
            index += 1;
        }
        if (index >= tagBarText.length) {
            break;
        }
        if (tagBarText.startsWith('/*', index)) {
            const commentEnd = tagBarText.indexOf('*/', index + 2);
            if (commentEnd === -1) {
                break;
            }
            index = commentEnd + 2;
            continue;
        }

        const start = index;
        const wrapper = WRAPPER_TYPES.find((candidate) => candidate.opener === tagBarText[index]);
        if (wrapper) {
            let depth = 1;
            while (depth < 3 && tagBarText[index + depth] === wrapper.opener) {
                depth += 1;
            }
            const closeToken = wrapper.closer.repeat(depth);
            const closeAt = tagBarText.indexOf(closeToken, index + depth);
            if (closeAt !== -1) {
                index = closeAt + depth;
                tokens.push(tagBarText.slice(start, index));
                continue;
            }
        }

        while (index < tagBarText.length && !/\s/.test(tagBarText[index])) {
            index += 1;
        }
        tokens.push(tagBarText.slice(start, index));
    }
    return tokens;
}

export function chooseStyleScope(contentText, tagBarText) {
    requireText(contentText, 'contentText');
    requireText(tagBarText, 'tagBarText');

    for (let depth = 1; depth <= 3; depth += 1) {
        for (const wrapper of WRAPPER_TYPES) {
            const openToken = wrapper.opener.repeat(depth);
            const closeToken = wrapper.closer.repeat(depth);
            let contentUsesScope = contentText.includes(openToken);
            if (contentText.includes(closeToken)) {
                contentUsesScope = true;
            }
            let tagBarUsesScope = tagBarText.includes(openToken);
            if (tagBarText.includes(closeToken)) {
                tagBarUsesScope = true;
            }
            if (contentUsesScope || tagBarUsesScope) {
                continue;
            }
            return Object.freeze({
                opener: wrapper.opener,
                closer: wrapper.closer,
                depth,
                openToken,
                closeToken,
            });
        }
    }

    throw new Error('No unused style scope delimiter remains for this note');
}

export function buildStyleApplicationPlan(options) {
    if (!options || typeof options !== 'object') {
        throw new Error('buildStyleApplicationPlan requires options');
    }
    const { styleTag, contentText, tagBarText, hasSelection } = options;
    requireKnownStyleTag(styleTag);
    requireText(contentText, 'contentText');
    requireText(tagBarText, 'tagBarText');
    if (typeof hasSelection !== 'boolean') {
        throw new Error('hasSelection must be a boolean');
    }

    if (styleTag === '@footnote' && !hasSelection) {
        throw new Error('Footnote requires a text selection');
    }

    if (!hasSelection) {
        return Object.freeze({
            styleTag,
            tagToken: styleTag,
            openToken: '',
            closeToken: '',
        });
    }

    if (styleTag === '@footnote') {
        const existingScope = scanTopLevelTagTokens(tagBarText)
            .find((token) => /^[{[(]{1,3}\s*@footnote\s*[}\])]{1,3}$/i.test(token));
        if (existingScope) {
            const opening = existingScope.match(/^[{[(]+/)[0];
            const closing = existingScope.match(/[}\])]+$/)[0];
            const wrapper = WRAPPER_TYPES.find((candidate) => candidate.opener === opening[0]);
            if (opening === wrapper.opener.repeat(opening.length)
                && closing === wrapper.closer.repeat(opening.length)) {
                return Object.freeze({
                    styleTag,
                    tagToken: existingScope,
                    openToken: opening,
                    closeToken: closing,
                });
            }
        }
    }

    const scope = chooseStyleScope(contentText, tagBarText);
    return Object.freeze({
        styleTag,
        tagToken: `${scope.openToken}${styleTag}${scope.closeToken}`,
        openToken: scope.openToken,
        closeToken: scope.closeToken,
    });
}

export function appendStyleTagToken(tagBarText, tagToken) {
    requireText(tagBarText, 'tagBarText');
    requireText(tagToken, 'tagToken');
    if (tagToken.length === 0) {
        throw new Error('tagToken must not be empty');
    }

    const normalizedTarget = tagToken.toLowerCase();
    const tokens = scanTopLevelTagTokens(tagBarText);
    if (tokens.some((token) => token.toLowerCase() === normalizedTarget)) {
        return tagBarText.trim();
    }
    const existing = tagBarText.trim();
    return existing.length > 0 ? `${existing} ${tagToken}` : tagToken;
}
