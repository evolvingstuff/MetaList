import { detectPastedFormat } from './paste-format-detection-service.js';
import { guessPastedFormat } from './paste-format-guess-service.js';

// A paste with formatting (bold, links, code from a web page or an AI chat) goes
// in with its formatting, but it may still be a format underneath: Markdown
// whose headings were left as `##`, LaTeX in a paragraph, CSV in a code block.
// Its text with the formatting removed is checked as a plain paste is, and a
// format found is offered on the card, never applied at once: applying drops
// the formatting (docs/ui/content-formatting.md, "Formatted pastes").

// Labels of the formats a plain paste is tagged with at once; here they are offered.
const DETECTED_FORMAT_LABELS = Object.freeze({
    '@json': 'JSON', '@chess': 'Chess', '@diff': 'Diff', '@markdown': 'Markdown', '@mermaid': 'Mermaid', '@LaTeX': 'LaTeX',
});

// Elements that start and end a line of the visible text.
const BLOCK_ELEMENTS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
    'TABLE', 'TR', 'UL',
]);
// Elements whose text is never seen.
const HIDDEN_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD']);
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// The pasted text as it is inserted: no blank lines around it, \n line ends.
export function normalizePastedText(text) {
    if (typeof text !== 'string') {
        throw new Error('normalizePastedText requires text string');
    }
    return text.replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').replace(/\n\s*$/, '');
}

function checkText(text) {
    const detected = detectPastedFormat(text);
    if (detected === null) {
        return guessPastedFormat(text);
    }
    if (!Object.hasOwn(DETECTED_FORMAT_LABELS, detected.tag)) {
        throw new Error(`No label for the detected format ${detected.tag}`);
    }
    return { kind: 'format', options: [{ tag: detected.tag, label: DETECTED_FORMAT_LABELS[detected.tag] }] };
}

// What a formatted paste offers, judged on its visible text: { kind, options,
// text } or null. The text applied is the clipboard's plain text when it reads
// as the same format (it often keeps the source, `**bold**` included), or else
// the visible text.
export function checkFormattedPaste({ visibleText, plainText }) {
    if (typeof visibleText !== 'string' || typeof plainText !== 'string') {
        throw new Error('checkFormattedPaste requires visibleText and plainText strings');
    }
    const offer = checkText(visibleText);
    if (offer === null) {
        return null;
    }
    const fromPlainText = checkText(plainText);
    let text = normalizePastedText(visibleText);
    if (fromPlainText !== null && fromPlainText.options[0].tag === offer.options[0].tag) {
        text = normalizePastedText(plainText);
    }
    return { kind: offer.kind, options: offer.options, text };
}

// The text of clipboard HTML as it reads, without its formatting: blocks on
// lines of their own, spaces collapsed outside <pre>. The HTML is parsed inert
// (DOMParser loads nothing and runs nothing) and never put in the page.
export function visibleTextOfHtml(html) {
    if (typeof html !== 'string') {
        throw new Error('visibleTextOfHtml requires html string');
    }
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    const parts = [];
    appendVisibleText(body, parts, { isPreformatted: false });
    const lines = parts.join('').split('\n').map((line) => line.replace(/[ \t]+$/, '').replace(/^ /, ''));
    // Nested blocks end on the same line: at most one blank line between blocks.
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function appendVisibleText(node, parts, { isPreformatted }) {
    for (const child of node.childNodes) {
        if (child.nodeType === TEXT_NODE) {
            if (isPreformatted) {
                parts.push(child.data);
            } else {
                parts.push(child.data.replace(/\s+/g, ' '));
            }
            continue;
        }
        if (child.nodeType !== ELEMENT_NODE || HIDDEN_ELEMENTS.has(child.nodeName)) {
            continue;
        }
        if (child.nodeName === 'BR') {
            parts.push('\n');
            continue;
        }
        const isBlock = BLOCK_ELEMENTS.has(child.nodeName);
        if (isBlock) parts.push('\n');
        appendVisibleText(child, parts, { isPreformatted: isPreformatted || child.nodeName === 'PRE' });
        if (isBlock) parts.push('\n');
    }
}
