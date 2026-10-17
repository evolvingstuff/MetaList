import { ApplicationState } from '../../application-state.js';

// Pasting text in a recognisable format tags the note for it at once
// (docs/ui/content-formatting.md, "Paste format detection"). Only unambiguous
// formats: missing one costs nothing (the tag can be added by hand), a wrong
// guess would be annoying. Into an otherwise empty note the plain tag is added
// (@json); into a note with content the pasted text is wrapped ((...)) and the
// wrapped tag added (((@json))).

const moduleState = ApplicationState.createFields('paste-format-detection-service', {
    // ⇧⌘V / Ctrl+Shift+V ("paste as plain text") asks for no detection.
    isPlainPasteRequested: false,
    // The last detected paste, so ⌘Z right after it removes the added tag too.
    lastDetectedPaste: null,
});

const FEN_PIECES = new Set(['k', 'q', 'r', 'b', 'n', 'p']);
// Positions of the optional FEN fields after the piece placement.
const FEN_SIDE_TO_MOVE_FIELD = 1;
const FEN_CASTLING_FIELD = 2;
const FEN_EN_PASSANT_FIELD = 3;
const FEN_HALFMOVE_CLOCK_FIELD = 4;
const FEN_FULLMOVE_FIELD = 5;
const FEN_FIELD_COUNT = FEN_FULLMOVE_FIELD + 1;
// The board is square: as many ranks as files, and as many squares in a rank.
const FEN_BOARD_SIZE = 'abcdefgh'.length;
const JSON_UNICODE_ESCAPE_PREFIX = '\\u';
// \u and four hex digits, such as é.
const JSON_UNICODE_ESCAPE_HEX_DIGITS = 4;
const JSON_UNICODE_ESCAPE_LENGTH = JSON_UNICODE_ESCAPE_PREFIX.length + JSON_UNICODE_ESCAPE_HEX_DIGITS;
// A backslash and one character, such as \n.
const JSON_SHORT_ESCAPE_LENGTH = 2;
const CSV_ESCAPED_QUOTE = '""';
// The diagram-type line plus at least one line of diagram.
const MERMAID_MIN_LINES = 2;
// One column of cells is plain text, not a table.
const SPREADSHEET_MIN_COLUMNS = 2;
const MERMAID_FIRST_LINE_RE = /^(?:(?:graph|flowchart)\s+(?:TD|TB|BT|RL|LR)\b|sequenceDiagram\b|classDiagram\b|stateDiagram(?:-v2)?\b|erDiagram\b|gantt\b|pie\b|journey\b|gitGraph\b|mindmap\b|timeline\b|quadrantChart\b)/;
const DIFF_HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
const LATEX_BLOCK_RES = [
    /^\$\$[\s\S]+\$\$$/,
    /^\\\[[\s\S]+\\\]$/,
    /^\\begin\{([A-Za-z*]+)\}[\s\S]*\\end\{\1\}$/,
];
// A fenced block whose opening line names a language (```python), closed later.
const FENCE_OPEN_WITH_LANGUAGE_RE = /^```[ \t]*[A-Za-z0-9][A-Za-z0-9+#._-]*[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
// VS Code's language ids (on the clipboard as vscode-editor-data) -> the tag for them.
// Ids not listed get no tag; plaintext falls through to the other checks.
const VSCODE_LANGUAGE_TAGS = Object.freeze({
    markdown: '@markdown', diff: '@diff', mermaid: '@mermaid', csv: '@csv',
    shellscript: '@code=bash', javascriptreact: '@code=jsx', typescriptreact: '@code=tsx',
    dockerfile: '@code=docker', makefile: '@code=make', bat: '@code=batch', jsonc: '@code=json',
    python: '@code=python', ruby: '@code=ruby', sql: '@code=sql', javascript: '@code=javascript',
    typescript: '@code=typescript', html: '@code=html', xml: '@code=xml', css: '@code=css',
    scss: '@code=scss', less: '@code=less', java: '@code=java', c: '@code=c', cpp: '@code=cpp',
    csharp: '@code=csharp', go: '@code=go', rust: '@code=rust', php: '@code=php',
    kotlin: '@code=kotlin', swift: '@code=swift', r: '@code=r', lua: '@code=lua', perl: '@code=perl',
    powershell: '@code=powershell', yaml: '@code=yaml', toml: '@code=toml', ini: '@code=ini',
    'objective-c': '@code=objective-c', dart: '@code=dart', scala: '@code=scala',
    haskell: '@code=haskell', elixir: '@code=elixir', graphql: '@code=graphql', terraform: '@code=terraform',
    vue: '@code=vue', latex: '@code=latex', json: '@code=json',
});
const WRAPPED_RENDERER_OPENER = '((';
const WRAPPED_RENDERER_CLOSER = '))';
const CLOSER_FOR = { '(': ')', '[': ']', '{': '}' };

function normalizeLineEnds(text) {
    return text.replace(/\r\n?/g, '\n');
}

// A complete JSON object or array, checked without JSON.parse (which throws).
function isJsonDocument(text) {
    if (!(text.startsWith('{') && text.endsWith('}')) && !(text.startsWith('[') && text.endsWith(']'))) {
        return false;
    }
    const scanner = { text, index: 0 };
    if (!scanJsonValue(scanner)) {
        return false;
    }
    skipJsonWhitespace(scanner);
    return scanner.index === text.length;
}

function skipJsonWhitespace(scanner) {
    while (scanner.index < scanner.text.length && ' \t\n\r'.includes(scanner.text[scanner.index])) {
        scanner.index += 1;
    }
}

function scanJsonValue(scanner) {
    skipJsonWhitespace(scanner);
    const char = scanner.text[scanner.index];
    if (char === '{') return scanJsonContainer(scanner, '}', true);
    if (char === '[') return scanJsonContainer(scanner, ']', false);
    if (char === '"') return scanJsonString(scanner);
    for (const literal of ['true', 'false', 'null']) {
        if (scanner.text.startsWith(literal, scanner.index)) {
            scanner.index += literal.length;
            return true;
        }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(scanner.text.slice(scanner.index));
    if (number === null) {
        return false;
    }
    scanner.index += number[0].length;
    return true;
}

function scanJsonString(scanner) {
    scanner.index += 1;
    while (scanner.index < scanner.text.length) {
        const char = scanner.text[scanner.index];
        if (char === '"') {
            scanner.index += 1;
            return true;
        }
        if (char === '\n') {
            return false;
        }
        if (char === '\\') {
            const escape = scanner.text[scanner.index + 1];
            if (escape === 'u') {
                if (!/^[0-9a-fA-F]{4}$/.test(scanner.text.slice(scanner.index + JSON_UNICODE_ESCAPE_PREFIX.length, scanner.index + JSON_UNICODE_ESCAPE_LENGTH))) return false;
                scanner.index += JSON_UNICODE_ESCAPE_LENGTH;
                continue;
            }
            if (!'"\\/bfnrt'.includes(escape)) return false;
            scanner.index += JSON_SHORT_ESCAPE_LENGTH;
            continue;
        }
        scanner.index += 1;
    }
    return false;
}

function scanJsonContainer(scanner, closer, hasKeys) {
    scanner.index += 1;
    skipJsonWhitespace(scanner);
    if (scanner.text[scanner.index] === closer) {
        scanner.index += 1;
        return true;
    }
    while (scanner.index < scanner.text.length) {
        if (hasKeys) {
            skipJsonWhitespace(scanner);
            if (scanner.text[scanner.index] !== '"' || !scanJsonString(scanner)) return false;
            skipJsonWhitespace(scanner);
            if (scanner.text[scanner.index] !== ':') return false;
            scanner.index += 1;
        }
        if (!scanJsonValue(scanner)) return false;
        skipJsonWhitespace(scanner);
        const separator = scanner.text[scanner.index];
        scanner.index += 1;
        if (separator === closer) return true;
        if (separator !== ',') return false;
    }
    return false;
}

// One FEN position line (app/services/chess_rendering.py parses the same).
function isFenPosition(text) {
    if (text.includes('\n')) {
        return false;
    }
    const fields = text.split(/\s+/);
    if (fields.length > FEN_FIELD_COUNT) {
        return false;
    }
    const ranks = fields[0].split('/');
    if (ranks.length !== FEN_BOARD_SIZE) {
        return false;
    }
    for (const rank of ranks) {
        let squares = 0;
        for (const char of rank) {
            if (/[1-8]/.test(char)) {
                squares += Number(char);
            } else if (FEN_PIECES.has(char.toLowerCase())) {
                squares += 1;
            } else {
                return false;
            }
        }
        if (squares !== FEN_BOARD_SIZE) {
            return false;
        }
    }
    if (fields.length > FEN_SIDE_TO_MOVE_FIELD && !['w', 'b'].includes(fields[FEN_SIDE_TO_MOVE_FIELD])) return false;
    if (fields.length > FEN_CASTLING_FIELD && !/^(?:-|K?Q?k?q?)$/.test(fields[FEN_CASTLING_FIELD])) return false;
    if (fields.length > FEN_EN_PASSANT_FIELD && !/^(?:-|[a-h][36])$/.test(fields[FEN_EN_PASSANT_FIELD])) return false;
    // The halfmove clock and fullmove number are counts.
    return fields.slice(FEN_HALFMOVE_CLOCK_FIELD).every((field) => /^\d+$/.test(field));
}

function isUnifiedDiff(text) {
    const lines = text.split('\n');
    const hasChangedLine = lines.some((line) => /^[+-](?![+-]{2}( |$))/.test(line));
    if (!hasChangedLine) {
        return false;
    }
    if (DIFF_HUNK_RE.test(text)) {
        return true;
    }
    if (lines[0].startsWith('diff --git ')) {
        return true;
    }
    return lines.some((line, index) => line.startsWith('--- ') && index + 1 < lines.length && lines[index + 1].startsWith('+++ '));
}

function isMermaidDiagram(text) {
    const lines = text.split('\n');
    return lines.length >= MERMAID_MIN_LINES && MERMAID_FIRST_LINE_RE.test(lines[0].trim());
}

function isLatexBlock(text) {
    return LATEX_BLOCK_RES.some((pattern) => pattern.test(text));
}

// Markdown for certain: a fenced block naming its language, opened and closed.
function hasFencedCodeWithLanguage(text) {
    const lines = text.split('\n');
    return lines.some((line, index) => FENCE_OPEN_WITH_LANGUAGE_RE.test(line.trim())
        && lines.slice(index + 1).some((later) => FENCE_CLOSE_RE.test(later.trim())));
}

// One row of tab-separated cells as a spreadsheet writes it: a cell holding a
// tab, newline or quote is quoted, quotes doubled. Returns the rows of cells.
function parseTabSeparatedRows(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let index = 0;
    let isQuoted = false;
    while (index < text.length) {
        const char = text[index];
        if (isQuoted) {
            if (char === '"' && text[index + 1] === '"') {
                cell += '"';
                index += CSV_ESCAPED_QUOTE.length;
                continue;
            }
            if (char === '"') {
                isQuoted = false;
            } else {
                cell += char;
            }
            index += 1;
            continue;
        }
        if (char === '"' && cell === '') {
            isQuoted = true;
        } else if (char === '\t') {
            row.push(cell);
            cell = '';
        } else if (char === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else {
            cell += char;
        }
        index += 1;
    }
    row.push(cell);
    rows.push(row);
    return rows.filter((cells) => !(cells.length === 1 && cells[0] === ''));
}

function csvCell(cell) {
    if (/[",\n]/.test(cell) || cell !== cell.trim()) {
        return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
}

// Cells copied from Excel, Google Sheets or Numbers (an HTML table on the
// clipboard, tab-separated text alongside) as CSV text, or null.
function spreadsheetCellsAsCsv(plainText, html) {
    if (!/<table[\s>]/i.test(html) || !plainText.includes('\t')) {
        return null;
    }
    const rows = parseTabSeparatedRows(normalizeLineEnds(plainText).replace(/\n+$/, ''));
    if (rows.length === 0 || rows[0].length < SPREADSHEET_MIN_COLUMNS || rows.some((cells) => cells.length !== rows[0].length)) {
        return null;
    }
    return rows.map((cells) => cells.map(csvCell).join(',')).join('\n');
}

// VS Code's language for code copied from it, as a tag, or null. A single
// line (an identifier, one statement) is not worth formatting.
function vscodeLanguageTag(plainText, vscodeEditorData) {
    if (vscodeEditorData === '' || !plainText.trim().includes('\n')) {
        return null;
    }
    const data = JSON.parse(vscodeEditorData);
    if (!data || typeof data.mode !== 'string' || !Object.hasOwn(VSCODE_LANGUAGE_TAGS, data.mode)) {
        return null;
    }
    return VSCODE_LANGUAGE_TAGS[data.mode];
}

// The tag for a paste, from everything the clipboard says: what VS Code says
// the language is, a spreadsheet's table, then the text itself.
export function detectClipboardFormat({ plainText, html, vscodeEditorData }) {
    if (typeof plainText !== 'string' || typeof html !== 'string' || typeof vscodeEditorData !== 'string') {
        throw new Error('detectClipboardFormat requires plainText, html and vscodeEditorData strings');
    }
    const fromText = detectPastedFormat(plainText);
    const vscodeTag = vscodeLanguageTag(plainText, vscodeEditorData);
    if (vscodeTag !== null) {
        // JSON that parses keeps its pretty-printed @json view.
        if (vscodeTag === '@code=json' && fromText !== null && fromText.tag === '@json') {
            return fromText;
        }
        const text = normalizeLineEnds(plainText).replace(/^\s*\n/, '').replace(/\n\s*$/, '');
        return { tag: vscodeTag, text };
    }
    const csv = spreadsheetCellsAsCsv(plainText, html);
    if (csv !== null) {
        return { tag: '@csv', text: csv };
    }
    return fromText;
}

// The tag for pasted text in a format that is certain, or null. The text
// returned is what to insert: the paste without blank lines around it.
export function detectPastedFormat(plainText) {
    if (typeof plainText !== 'string') {
        throw new Error('detectPastedFormat requires plainText string');
    }
    const text = normalizeLineEnds(plainText).replace(/^\s*\n/, '').replace(/\n\s*$/, '');
    const trimmed = text.trim();
    if (trimmed === '') {
        return null;
    }
    if (isJsonDocument(trimmed)) return { tag: '@json', text };
    if (isFenPosition(trimmed)) return { tag: '@chess', text: trimmed };
    if (isUnifiedDiff(text)) return { tag: '@diff', text };
    if (hasFencedCodeWithLanguage(trimmed)) return { tag: '@markdown', text };
    if (isMermaidDiagram(trimmed)) return { tag: '@mermaid', text };
    if (isLatexBlock(trimmed)) return { tag: '@LaTeX', text };
    return null;
}

function tagBarTokens(tags) {
    return tags.split(/\s+/).filter((token) => token.length > 0);
}

function isRendererToken(token) {
    const folded = token.toLowerCase();
    if (['@markdown', '@latex', '@json', '@csv', '@shell', '@chess', '@diff', '@mermaid'].includes(folded)) {
        return true;
    }
    return /^@code=[a-z0-9][a-z0-9+#._-]*$/.test(folded);
}

// The delimiter of a wrapped tag-bar token: "((@json))" -> "((".
function wrapperOpener(token) {
    const match = /^([([{]{1,3})/.exec(token);
    if (match === null) {
        return null;
    }
    const opener = match[1];
    if (!opener.split('').every((char) => char === opener[0])) {
        return null;
    }
    return opener;
}

function countOccurrences(text, needle) {
    let count = 0;
    let index = text.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = text.indexOf(needle, index + needle.length);
    }
    return count;
}

function isInsideWrappedRegion(tokens, textBeforeCaret) {
    return tokens.some((token) => {
        const opener = wrapperOpener(token);
        if (opener === null) {
            return false;
        }
        const closer = CLOSER_FOR[opener[0]].repeat(opener.length);
        return countOccurrences(textBeforeCaret, opener) > countOccurrences(textBeforeCaret, closer);
    });
}

// What a detected paste does, or null to paste normally: the text to insert and
// the tag bar afterwards.
export function planFormatPaste({ detected, tags, noteIsEmpty, textBeforeCaret }) {
    if (detected === null) {
        return null;
    }
    if (!detected || typeof detected.tag !== 'string' || typeof detected.text !== 'string') {
        throw new Error('planFormatPaste requires a detected format');
    }
    if (typeof tags !== 'string' || typeof noteIsEmpty !== 'boolean' || typeof textBeforeCaret !== 'string') {
        throw new Error('planFormatPaste requires tags, noteIsEmpty and textBeforeCaret');
    }
    const tokens = tagBarTokens(tags);
    // The note is already formatted (a renderer applies to all of it).
    if (tokens.some(isRendererToken)) {
        return null;
    }
    const trimmedTags = tags.trim();
    const separator = trimmedTags === '' ? '' : ' ';
    if (noteIsEmpty) {
        return { insertText: detected.text, nextTags: `${trimmedTags}${separator}${detected.tag}` };
    }
    // Pasting inside an existing wrapped region, or "((" already used: paste normally.
    if (isInsideWrappedRegion(tokens, textBeforeCaret)) {
        return null;
    }
    if (tokens.some((token) => wrapperOpener(token) === WRAPPED_RENDERER_OPENER)) {
        return null;
    }
    return {
        insertText: `${WRAPPED_RENDERER_OPENER}${detected.text}${WRAPPED_RENDERER_CLOSER}`,
        nextTags: `${trimmedTags}${separator}${WRAPPED_RENDERER_OPENER}${detected.tag}${WRAPPED_RENDERER_CLOSER}`,
    };
}

export function requestPlainPaste() {
    if (!moduleState.isPlainPasteRequested) moduleState.isPlainPasteRequested = true;
}

export function consumePlainPasteRequest() {
    if (!moduleState.isPlainPasteRequested) {
        return false;
    }
    moduleState.isPlainPasteRequested = false;
    return true;
}

export function rememberDetectedPaste(record) {
    if (!record || typeof record.noteId !== 'string' || typeof record.tagsBefore !== 'string'
        || typeof record.tagsAfter !== 'string' || typeof record.contentAfter !== 'string') {
        throw new Error('rememberDetectedPaste requires noteId, tagsBefore, tagsAfter and contentAfter');
    }
    moduleState.lastDetectedPaste = Object.freeze({ ...record });
}

// The tags to restore when ⌘Z undoes the detected paste (nothing changed since),
// or null. The record is used once.
export function takeDetectedPasteUndo({ noteId, tags, content }) {
    const record = moduleState.lastDetectedPaste;
    if (record === null) {
        return null;
    }
    moduleState.lastDetectedPaste = null;
    if (record.noteId !== noteId || record.tagsAfter !== tags || record.contentAfter !== content) {
        return null;
    }
    return record.tagsBefore;
}
