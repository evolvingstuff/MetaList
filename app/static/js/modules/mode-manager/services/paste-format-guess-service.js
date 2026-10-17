// Guesses for pasted text whose format is likely but not certain: CSV-like,
// Markdown-like, or code in a language the text does not name
// (docs/ui/content-formatting.md, "Paste format guesses"). A guess is offered,
// never applied: the card under the paste says "Apply as Markdown" with "Skip"
// (paste-format-offer-service.js), so a wrong guess costs nothing.

// At most this many languages are offered for one paste.
const MAX_LANGUAGE_OPTIONS = 3;
// A language is offered only with at least this score, and runners-up only
// within this share of the best score.
const MIN_LANGUAGE_SCORE = 5;
const RUNNER_UP_SHARE = 0.6;
// Text whose lines do not look like code (SQL, shell, YAML, Dockerfile) still
// counts as code with this strong a score and no sentences.
const STRONG_LANGUAGE_SCORE = 8;
// Weights of signs that hint at a language without settling it: weak signs
// are shared with other languages, fair signs lean toward one.
const WEAK_SIGN_WEIGHT = 2;
const FAIR_SIGN_WEIGHT = 3;
// Weights of signs that point to one language. A strong sign needs company to
// reach MIN_LANGUAGE_SCORE; a distinctive or defining sign reaches it alone; a
// decisive sign (a shebang, a doctype, an XML declaration) reaches
// STRONG_LANGUAGE_SCORE alone.
const STRONG_SIGN_WEIGHT = 4;
const DISTINCTIVE_SIGN_WEIGHT = 5;
const DEFINING_SIGN_WEIGHT = 6;
const DECISIVE_SIGN_WEIGHT = 8;

// A sentence has at least this many words.
const MIN_SENTENCE_WORDS = 5;
// A CSV cell is short: at most this many words and characters.
const MAX_CSV_CELL_WORDS = 8;
const MAX_CSV_CELL_CHARACTERS = 80;
// Text is code when at least this share of its lines read as code.
const MIN_CODE_LINE_SHARE = 0.6;
// YAML is mostly `key: value` lines: at least this share of them.
const MIN_YAML_KEY_LINE_SHARE = 0.6;

// CSV: at least this many lines, each with at least this many cells.
const MIN_CSV_LINES = 3;
const MIN_CSV_COLUMNS = 2;
// Markdown: a list is at least this many items; a bare code fence is an
// opening and a closing line; plain text needs this many kinds of signs.
const MIN_LIST_LINES = 2;
const FENCE_LINES = 2;
const MIN_MARKDOWN_SIGN_KINDS = 2;
// YAML: at least this many `key: value` lines.
const MIN_YAML_KEY_LINES = 3;

const LANGUAGES = Object.freeze([
    { tag: '@code=sql', label: 'SQL' },
    { tag: '@code=python', label: 'Python' },
    { tag: '@code=ruby', label: 'Ruby' },
    { tag: '@code=javascript', label: 'JavaScript' },
    { tag: '@code=typescript', label: 'TypeScript' },
    { tag: '@code=bash', label: 'Shell' },
    { tag: '@code=html', label: 'HTML' },
    { tag: '@code=xml', label: 'XML' },
    { tag: '@code=css', label: 'CSS' },
    { tag: '@code=java', label: 'Java' },
    { tag: '@code=c', label: 'C' },
    { tag: '@code=cpp', label: 'C++' },
    { tag: '@code=csharp', label: 'C#' },
    { tag: '@code=go', label: 'Go' },
    { tag: '@code=rust', label: 'Rust' },
    { tag: '@code=yaml', label: 'YAML' },
    { tag: '@code=docker', label: 'Dockerfile' },
]);

// Signs of each language: [pattern, weight]. A pattern counts once however
// often it matches; distinctive signs weigh more.
const LANGUAGE_SIGNS = Object.freeze({
    '@code=sql': [
        [/^\s*SELECT\b[\s\S]+?\bFROM\b/im, DEFINING_SIGN_WEIGHT], [/^\s*INSERT\s+INTO\b/im, DEFINING_SIGN_WEIGHT], [/^\s*UPDATE\s+\w+\s+SET\b/im, DEFINING_SIGN_WEIGHT],
        [/^\s*CREATE\s+(?:TABLE|INDEX|VIEW|DATABASE)\b/im, DEFINING_SIGN_WEIGHT], [/^\s*DELETE\s+FROM\b/im, DEFINING_SIGN_WEIGHT], [/^\s*ALTER\s+TABLE\b/im, DEFINING_SIGN_WEIGHT],
        [/\bWHERE\b/i, 1], [/\b(?:GROUP|ORDER)\s+BY\b/i, WEAK_SIGN_WEIGHT], [/\b(?:INNER|LEFT|RIGHT|OUTER)?\s*JOIN\b[\s\S]+?\bON\b/i, WEAK_SIGN_WEIGHT],
    ],
    '@code=python': [
        [/^\s*def\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:]+)?:\s*$/m, DEFINING_SIGN_WEIGHT], [/^\s*class\s+\w+(?:\([^)]*\))?:\s*$/m, DISTINCTIVE_SIGN_WEIGHT],
        [/^\s*(?:from\s+[\w.]+\s+import\s+\w+|import\s+[\w.]+(?:\s+as\s+\w+)?)\s*$/m, STRONG_SIGN_WEIGHT], [/\belif\b/, STRONG_SIGN_WEIGHT],
        [/\bself\.\w+/, FAIR_SIGN_WEIGHT], [/__\w+__/, FAIR_SIGN_WEIGHT], [/\bf"[^"\n]*\{[^}\n]+\}/, FAIR_SIGN_WEIGHT], [/\blambda\s+\w*\s*:/, FAIR_SIGN_WEIGHT],
        [/\b(?:None|True|False)\b/, 1], [/^\s*(?:if|for|while|with|try|else|except)\b[^\n{;]*:\s*$/m, WEAK_SIGN_WEIGHT],
        [/\bprint\(/, 1],
    ],
    '@code=ruby': [
        [/^\s*def\s+\w+[?!]?(?:\s*\([^)]*\))?\s*$/m, STRONG_SIGN_WEIGHT], [/^\s*end\s*$/m, FAIR_SIGN_WEIGHT], [/\bputs\b/, FAIR_SIGN_WEIGHT],
        [/\bdo\s*\|[^|\n]*\|/, DISTINCTIVE_SIGN_WEIGHT], [/\.each(?:_with_index)?\b/, WEAK_SIGN_WEIGHT], [/@\w+\s*=/, FAIR_SIGN_WEIGHT], [/\brequire\s+['"]/, FAIR_SIGN_WEIGHT],
        [/\bnil\b/, WEAK_SIGN_WEIGHT], [/\belsif\b/, STRONG_SIGN_WEIGHT], [/\battr_(?:accessor|reader|writer)\b/, DISTINCTIVE_SIGN_WEIGHT], [/#\{[^}\n]+\}/, WEAK_SIGN_WEIGHT],
    ],
    '@code=javascript': [
        [/\b(?:const|let|var)\s+\w+\s*=/, FAIR_SIGN_WEIGHT], [/=>/, WEAK_SIGN_WEIGHT], [/\bfunction\s*\w*\s*\([^)]*\)\s*\{/, STRONG_SIGN_WEIGHT],
        [/\bconsole\.\w+\(/, STRONG_SIGN_WEIGHT], [/^\s*import\s+[\s\S]+?\s+from\s+['"]/m, STRONG_SIGN_WEIGHT], [/\brequire\(\s*['"]/, FAIR_SIGN_WEIGHT],
        [/[!=]==/, FAIR_SIGN_WEIGHT], [/\b(?:document|window)\.\w+/, WEAK_SIGN_WEIGHT], [/\bundefined\b/, WEAK_SIGN_WEIGHT], [/\bawait\s+\w+/, 1],
        [/;\s*$/m, 1],
    ],
    '@code=bash': [
        [/^#!.*\b(?:ba|z|k)?sh\b/, DECISIVE_SIGN_WEIGHT], [/^\s*\$\s+\S/m, FAIR_SIGN_WEIGHT], [/\|\s*(?:grep|awk|sed|xargs|sort|uniq|head|tail|wc)\b/, STRONG_SIGN_WEIGHT],
        [/^\s*(?:sudo|apt(?:-get)?|brew|npm|pip3?|git|cd|ls|echo|export|curl|wget|chmod|mkdir|rm|cp|mv|source)\s/m, FAIR_SIGN_WEIGHT],
        [/^\s*(?:fi|done|esac)\s*$/m, STRONG_SIGN_WEIGHT], [/^\s*if\s+\[\[?\s/m, STRONG_SIGN_WEIGHT], [/\$\{?\w+\}?/, 1], [/\s(?:&&|\|\|)\s/, 1],
    ],
    '@code=html': [
        [/<!DOCTYPE\s+html>/i, DECISIVE_SIGN_WEIGHT], [/<\/?(?:html|head|body|div|span|p|a|ul|ol|li|table|tr|td|script|style|section|header|footer|nav)\b[^>]*>/i, DISTINCTIVE_SIGN_WEIGHT],
        [/<\w+\s+(?:class|id|href|src)=["']/i, FAIR_SIGN_WEIGHT],
    ],
    '@code=xml': [
        [/^\s*<\?xml\b/, DECISIVE_SIGN_WEIGHT], [/<(\w+:)?\w+(?:\s+[\w:]+="[^"]*")*\s*\/?>[\s\S]*<\/(\w+:)?\w+>/, WEAK_SIGN_WEIGHT], [/\bxmlns(?::\w+)?=/, STRONG_SIGN_WEIGHT],
    ],
    '@code=css': [
        [/[\w.#\-[\]="':>*\s]+\{\s*[\w-]+\s*:\s*[^;{}]+;[^{}]*\}/, DEFINING_SIGN_WEIGHT], [/@media\b[^{]*\{/, DISTINCTIVE_SIGN_WEIGHT],
        [/^\s*(?:color|margin|padding|display|font-(?:size|family|weight)|background(?:-color)?|border|width|height)\s*:/m, WEAK_SIGN_WEIGHT],
    ],
    '@code=java': [
        [/\bpublic\s+(?:static\s+)?(?:final\s+)?(?:class|void|int|String|boolean)\b/, DISTINCTIVE_SIGN_WEIGHT], [/\bSystem\.out\.print(?:ln)?\(/, DEFINING_SIGN_WEIGHT],
        [/^\s*import\s+java\./m, DEFINING_SIGN_WEIGHT], [/@Override\b/, STRONG_SIGN_WEIGHT], [/\bString\[\]\s+\w+/, FAIR_SIGN_WEIGHT], [/\bnew\s+[A-Z]\w*\s*[(<]/, 1],
    ],
    '@code=c': [
        [/^\s*#include\s*[<"]/m, DEFINING_SIGN_WEIGHT], [/\bint\s+main\s*\(/, DISTINCTIVE_SIGN_WEIGHT], [/\bprintf\s*\(/, FAIR_SIGN_WEIGHT], [/\b(?:malloc|free|sizeof)\s*\(/, FAIR_SIGN_WEIGHT],
    ],
    '@code=cpp': [
        [/\bstd::\w+/, DEFINING_SIGN_WEIGHT], [/\b(?:cout|cin|cerr)\s*(?:<<|>>)/, DEFINING_SIGN_WEIGHT], [/\bnullptr\b/, STRONG_SIGN_WEIGHT], [/\btemplate\s*</, STRONG_SIGN_WEIGHT],
        [/^\s*#include\s*<\w+>/m, WEAK_SIGN_WEIGHT], [/\bnamespace\s+\w+\s*\{/, WEAK_SIGN_WEIGHT],
    ],
    '@code=csharp': [
        [/^\s*using\s+System(?:\.\w+)*\s*;/m, DEFINING_SIGN_WEIGHT], [/\bConsole\.Write(?:Line)?\(/, DEFINING_SIGN_WEIGHT], [/\bpublic\s+(?:async\s+)?Task\b/, STRONG_SIGN_WEIGHT],
        [/\bnamespace\s+[\w.]+/, WEAK_SIGN_WEIGHT], [/\bvar\s+\w+\s*=\s*new\b/, WEAK_SIGN_WEIGHT], [/\{\s*get;\s*(?:set;)?\s*\}/, DISTINCTIVE_SIGN_WEIGHT],
    ],
    '@code=go': [
        [/^\s*package\s+\w+\s*$/m, DISTINCTIVE_SIGN_WEIGHT], [/\bfunc\s+(?:\(\w+\s+\*?\w+\)\s*)?\w+\s*\(/, DISTINCTIVE_SIGN_WEIGHT], [/:=/, FAIR_SIGN_WEIGHT], [/\bfmt\.\w+\(/, DISTINCTIVE_SIGN_WEIGHT],
        [/^\s*import\s*\(/m, WEAK_SIGN_WEIGHT],
    ],
    '@code=rust': [
        [/\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(/, STRONG_SIGN_WEIGHT], [/\blet\s+mut\b/, DISTINCTIVE_SIGN_WEIGHT], [/\bimpl\b(?:\s*<[^>]*>)?\s+\w+/, FAIR_SIGN_WEIGHT],
        [/\b\w+!\(/, WEAK_SIGN_WEIGHT], [/\bprintln!\(/, DISTINCTIVE_SIGN_WEIGHT], [/&(?:mut\s+)?str\b|\bVec</, FAIR_SIGN_WEIGHT], [/\bpub\s+(?:fn|struct|enum)\b/, STRONG_SIGN_WEIGHT],
    ],
    '@code=yaml': [
        [/^---\s*$/m, WEAK_SIGN_WEIGHT], [/^\s*-\s+[\w"']/m, 1],
    ],
    '@code=docker': [
        [/^FROM\s+\S+/m, STRONG_SIGN_WEIGHT], [/^(?:RUN|CMD|COPY|ADD|ENTRYPOINT|WORKDIR|ENV|EXPOSE|ARG|USER|VOLUME)\s+\S/m, STRONG_SIGN_WEIGHT],
    ],
});

// TypeScript is JavaScript with types: these signs add to its JavaScript score.
const TYPESCRIPT_SIGNS = Object.freeze([
    [/:\s*(?:string|number|boolean|any|void|unknown|never)(?:\[\])?\s*[,)=;{]/, DISTINCTIVE_SIGN_WEIGHT], [/\binterface\s+\w+\s*\{/, DISTINCTIVE_SIGN_WEIGHT],
    [/^\s*type\s+\w+\s*=/m, STRONG_SIGN_WEIGHT], [/\bimplements\s+\w+/, WEAK_SIGN_WEIGHT], [/\b(?:private|public|readonly)\s+\w+\s*:/, FAIR_SIGN_WEIGHT],
]);

function nonEmptyLines(text) {
    return text.split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim() !== '');
}

// A sentence: starts with a capital, five words or more, ends like a sentence.
function isSentence(line) {
    const trimmed = line.trim();
    return /^[A-Z]/.test(trimmed) && /[.!?]["')]?$/.test(trimmed) && trimmed.split(/\s+/).length >= MIN_SENTENCE_WORDS;
}

// --- CSV --------------------------------------------------------------------

// The cells of one CSV line, or null when its quotes do not close.
function splitCsvLine(line) {
    const cells = [];
    let cell = '';
    let isQuoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (isQuoted) {
            if (char === '"' && line[index + 1] === '"') {
                cell += '"';
                index += 1;
            } else if (char === '"') {
                isQuoted = false;
            } else {
                cell += char;
            }
        } else if (char === '"' && cell.trim() === '') {
            isQuoted = true;
        } else if (char === ',') {
            cells.push(cell);
            cell = '';
        } else {
            cell += char;
        }
    }
    if (isQuoted) {
        return null;
    }
    cells.push(cell);
    return cells;
}

// Three or more lines with the same number of comma-separated cells (two or
// more), short cells rather than sentences.
export function looksLikeCsv(text) {
    const lines = nonEmptyLines(text);
    if (lines.length < MIN_CSV_LINES) {
        return false;
    }
    const rows = lines.map(splitCsvLine);
    if (rows.some((cells) => cells === null)) {
        return false;
    }
    const columns = rows[0].length;
    if (columns < MIN_CSV_COLUMNS || rows.some((cells) => cells.length !== columns)) {
        return false;
    }
    if (lines.some(isSentence)) {
        return false;
    }
    const cells = rows.flat().map((cell) => cell.trim());
    return cells.every((cell) => cell.split(/\s+/).length <= MAX_CSV_CELL_WORDS && cell.length <= MAX_CSV_CELL_CHARACTERS);
}

// --- Markdown ---------------------------------------------------------------

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

// The kinds of Markdown signs in the text: headings, lists, emphasis, inline
// code, links, quotes, a table, a bare code fence.
export function markdownSignKinds(text) {
    const lines = text.split('\n');
    const kinds = new Set();
    if (lines.some((line) => /^#{1,6}\s+\S/.test(line))) kinds.add('heading');
    const listLines = lines.filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line));
    if (listLines.length >= MIN_LIST_LINES) kinds.add('list');
    if (/(\*\*|__)(?=\S)[^\n]*?\S\1/.test(text)) kinds.add('emphasis');
    if (/`[^`\n]+`/.test(text)) kinds.add('inline-code');
    if (/!?\[[^\]\n]+\]\((?:https?:\/\/|\/|#|mailto:)[^)\s]*\)/.test(text)) kinds.add('link');
    if (lines.some((line) => /^>\s?\S/.test(line))) kinds.add('quote');
    if (lines.some((line, index) => index > 0 && TABLE_SEPARATOR_RE.test(line) && lines[index - 1].includes('|'))) kinds.add('table');
    if (lines.filter((line) => /^```\s*$/.test(line.trim())).length >= FENCE_LINES) kinds.add('fence');
    return kinds;
}

function looksLikeMarkdown(kinds) {
    if (kinds.has('table')) {
        return true;
    }
    return kinds.size >= MIN_MARKDOWN_SIGN_KINDS;
}

// --- Code -------------------------------------------------------------------

// A line that reads as code: ends in code punctuation, or is indented code,
// or has an assignment or call without reading as a sentence.
function isCodeLine(line) {
    const trimmed = line.trim();
    if (isSentence(line)) {
        return false;
    }
    if (/[;{}()[\]:,]$|=>$|\\$/.test(trimmed)) return true;
    if (/^(?:\s{2,}|\t)\S/.test(line) && /[=(){}[\];:.<>]/.test(trimmed)) return true;
    if (/^[<#$@]/.test(trimmed) || /^(?:end|fi|done|esac)$/.test(trimmed)) return true;
    return /\w\s*(?:[-+*/%]?=|==|!=|<=|>=|->)\s*\S|\w\(/.test(trimmed);
}

function looksLikeCode(text) {
    const lines = nonEmptyLines(text);
    if (lines.length === 0) {
        return false;
    }
    const codeLines = lines.filter(isCodeLine).length;
    return codeLines / lines.length >= MIN_CODE_LINE_SHARE;
}

function scoreSigns(text, signs) {
    return signs.reduce((score, [pattern, weight]) => (pattern.test(text) ? score + weight : score), 0);
}

// YAML has few distinctive words: mostly `key: value` lines, no code
// punctuation, and nesting (an indented line or a `- item`), so that a note of
// "Meeting: Monday" lines is not taken for it.
function yamlScore(text) {
    const lines = nonEmptyLines(text).filter((line) => !/^\s*#/.test(line));
    const keyLines = lines.filter((line) => /^\s*-?\s*[\w"'.-]+:(?:\s+\S|\s*$)/.test(line)).length;
    const isNested = lines.some((line) => /^\s+\S|^\s*-\s+\S/.test(line));
    if (keyLines < MIN_YAML_KEY_LINES || !isNested || keyLines / lines.length < MIN_YAML_KEY_LINE_SHARE || lines.some((line) => /[;{}]\s*$|=>|\(\)/.test(line))) {
        return 0;
    }
    return STRONG_LANGUAGE_SCORE + scoreSigns(text, LANGUAGE_SIGNS['@code=yaml']);
}

// Each language's score for the text.
export function scoreLanguages(text) {
    const scores = {};
    for (const { tag } of LANGUAGES) {
        if (tag === '@code=typescript') continue;
        scores[tag] = tag === '@code=yaml' ? yamlScore(text) : scoreSigns(text, LANGUAGE_SIGNS[tag]);
    }
    const typescriptExtra = scoreSigns(text, TYPESCRIPT_SIGNS);
    scores['@code=typescript'] = typescriptExtra > 0 ? scores['@code=javascript'] + typescriptExtra : 0;
    // C++ and C# share C's signs; the more specific language should lead.
    if (scores['@code=cpp'] >= MIN_LANGUAGE_SCORE) scores['@code=cpp'] += scores['@code=c'];
    return scores;
}

// The languages to offer, best first: the best one, and up to two more close behind it.
export function guessLanguages(text) {
    const scores = scoreLanguages(text);
    const ranked = LANGUAGES
        .filter(({ tag }) => scores[tag] >= MIN_LANGUAGE_SCORE)
        .sort((first, second) => scores[second.tag] - scores[first.tag]);
    if (ranked.length === 0) {
        return [];
    }
    const best = scores[ranked[0].tag];
    const isStrong = best >= STRONG_LANGUAGE_SCORE && !nonEmptyLines(text).some(isSentence);
    if (!looksLikeCode(text) && !isStrong) {
        return [];
    }
    return ranked.filter(({ tag }) => scores[tag] >= best * RUNNER_UP_SHARE).slice(0, MAX_LANGUAGE_OPTIONS);
}

// --- The guess ----------------------------------------------------------------

// Whether the clipboard's HTML (if any) is just text, as from an editor or a
// code block on a page: a guess inserts the paste as plain text, so formatted
// text (headings, lists, links, bold) keeps its formatting instead.
export function isPlainClipboardHtml(html) {
    if (typeof html !== 'string') {
        throw new Error('isPlainClipboardHtml requires html string');
    }
    return !/<(?:h[1-6]|ul|ol|li|table|a\s[^>]*href|b|strong|i|em|u|img|blockquote)\b/i.test(html);
}

// What to offer for pasted text: { kind, options: [{ tag, label }] }, or null.
export function guessPastedFormat(plainText) {
    if (typeof plainText !== 'string') {
        throw new Error('guessPastedFormat requires plainText string');
    }
    const text = plainText.replace(/\r\n?/g, '\n');
    if (text.trim() === '') {
        return null;
    }
    if (looksLikeCsv(text)) {
        return { kind: 'csv', options: [{ tag: '@csv', label: 'CSV' }] };
    }
    const kinds = markdownSignKinds(text);
    const languages = guessLanguages(text);
    // A Markdown table is unmistakable; otherwise strong code wins over a
    // `# comment` or `- item` that only looks like Markdown.
    if (kinds.has('table') || (looksLikeMarkdown(kinds) && languages.length === 0)) {
        return { kind: 'markdown', options: [{ tag: '@markdown', label: 'Markdown' }] };
    }
    if (languages.length > 0) {
        return { kind: 'code', options: languages.map(({ tag, label }) => ({ tag, label })) };
    }
    return null;
}
