// HTML rich-text overlay. Only validated text/bold/italic/color runs leave this module.
export function mergeRuns(runs) {
    const merged = [];
    for (const part of runs) {
        if (!part.text) continue;
        const previous = merged.at(-1);
        if (previous && previous.bold === part.bold && previous.italic === part.italic && previous.color === part.color) previous.text += part.text;
        else merged.push({ ...part });
    }
    return merged;
}
function hexColor(value) {
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    const match = value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (!match) throw new Error(`Unexpected editor text color: ${value}`);
    return '#' + match.slice(1).map(n => Number(n).toString(16).padStart(2, '0')).join('');
}
export function readRuns(editor) {
    const runs = [];
    function visit(node, style) {
        if (node.nodeType === 3) { runs.push({ ...style, text: node.textContent }); return; }
        if (!(node instanceof Element)) return;
        if (node.tagName === 'BR') { runs.push({ ...style, text: '\n' }); return; }
        const next = { ...style };
        if (['B', 'STRONG'].includes(node.tagName) || node.style.fontWeight === 'bold' || Number(node.style.fontWeight) >= 600) next.bold = true;
        if (node.style.fontWeight === 'normal' || node.style.fontWeight === '400') next.bold = false;
        if (['I', 'EM'].includes(node.tagName) || node.style.fontStyle === 'italic') next.italic = true;
        if (node.style.fontStyle === 'normal') next.italic = false;
        if (node.style.color) next.color = hexColor(node.style.color);
        if (node.tagName === 'FONT' && node.hasAttribute('color')) next.color = hexColor(node.getAttribute('color'));
        const block = ['DIV', 'P'].includes(node.tagName);
        if (block && runs.length && !runs.at(-1).text.endsWith('\n')) runs.push({ ...next, text: '\n' });
        for (const child of node.childNodes) visit(child, next);
    }
    const initial = { text: '', bold: editor.style.fontWeight === 'bold', italic: editor.style.fontStyle === 'italic', color: hexColor(editor.style.color) };
    for (const child of editor.childNodes) visit(child, initial);
    const merged = mergeRuns(runs);
    if (!merged.length) return [initial];
    return merged;
}
export function writeRuns(editor, runs) {
    editor.replaceChildren();
    for (const part of runs) {
        const span = document.createElement('span');
        span.textContent = part.text;
        Object.assign(span.style, { fontWeight: part.bold ? 'bold' : 'normal', fontStyle: part.italic ? 'italic' : 'normal', color: part.color });
        editor.append(span);
    }
}
export function createTextEditor(editor, changed) {
    let savedRange = null;
    const remember = () => {
        const selection = window.getSelection();
        if (selection.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) savedRange = selection.getRangeAt(0).cloneRange();
    };
    document.addEventListener('selectionchange', remember);
    editor.addEventListener('input', changed);
    // Paste plain text; never allow clipboard HTML, images, or external resources into the overlay.
    editor.addEventListener('paste', event => {
        event.preventDefault();
        document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    });
    editor.addEventListener('drop', event => event.preventDefault());
    return {
        reset() { savedRange = null; },
        format(key, value) {
            editor.focus({ preventScroll: true });
            if (savedRange) { const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(savedRange); }
            else { const range = document.createRange(); range.selectNodeContents(editor); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
            const command = { bold: 'bold', italic: 'italic', color: 'foreColor' }[key];
            if (!command) throw new Error(`Unknown text format ${key}`);
            document.execCommand(command, false, value); remember(); changed();
        },
        destroy() { document.removeEventListener('selectionchange', remember); },
    };
}
