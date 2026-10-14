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
        [/^\s*SELECT\b[\s\S]+?\bFROM\b/im, 6], [/^\s*INSERT\s+INTO\b/im, 6], [/^\s*UPDATE\s+\w+\s+SET\b/im, 6],
        [/^\s*CREATE\s+(?:TABLE|INDEX|VIEW|DATABASE)\b/im, 6], [/^\s*DELETE\s+FROM\b/im, 6], [/^\s*ALTER\s+TABLE\b/im, 6],
        [/\bWHERE\b/i, 1], [/\b(?:GROUP|ORDER)\s+BY\b/i, 2], [/\b(?:INNER|LEFT|RIGHT|OUTER)?\s*JOIN\b[\s\S]+?\bON\b/i, 2],
    ],
    '@code=python': [
        [/^\s*def\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:]+)?:\s*$/m, 6], [/^\s*class\s+\w+(?:\([^)]*\))?:\s*$/m, 5],
        [/^\s*(?:from\s+[\w.]+\s+import\s+\w+|import\s+[\w.]+(?:\s+as\s+\w+)?)\s*$/m, 4], [/\belif\b/, 4],
        [/\bself\.\w+/, 3], [/__\w+__/, 3], [/\bf"[^"\n]*\{[^}\n]+\}/, 3], [/\blambda\s+\w*\s*:/, 3],
        [/\b(?:None|True|False)\b/, 1], [/^\s*(?:if|for|while|with|try|else|except)\b[^\n{;]*:\s*$/m, 2],
        [/\bprint\(/, 1],
    ],
    '@code=ruby': [
        [/^\s*def\s+\w+[?!]?(?:\s*\([^)]*\))?\s*$/m, 4], [/^\s*end\s*$/m, 3], [/\bputs\b/, 3],
        [/\bdo\s*\|[^|\n]*\|/, 5], [/\.each(?:_with_index)?\b/, 2], [/@\w+\s*=/, 3], [/\brequire\s+['"]/, 3],
        [/\bnil\b/, 2], [/\belsif\b/, 4], [/\battr_(?:accessor|reader|writer)\b/, 5], [/#\{[^}\n]+\}/, 2],
    ],
    '@code=javascript': [
        [/\b(?:const|let|var)\s+\w+\s*=/, 3], [/=>/, 2], [/\bfunction\s*\w*\s*\([^)]*\)\s*\{/, 4],
        [/\bconsole\.\w+\(/, 4], [/^\s*import\s+[\s\S]+?\s+from\s+['"]/m, 4], [/\brequire\(\s*['"]/, 3],
        [/[!=]==/, 3], [/\b(?:document|window)\.\w+/, 2], [/\bundefined\b/, 2], [/\bawait\s+\w+/, 1],
        [/;\s*$/m, 1],
    ],
    '@code=bash': [
        [/^#!.*\b(?:ba|z|k)?sh\b/, 8], [/^\s*\$\s+\S/m, 3], [/\|\s*(?:grep|awk|sed|xargs|sort|uniq|head|tail|wc)\b/, 4],
        [/^\s*(?:sudo|apt(?:-get)?|brew|npm|pip3?|git|cd|ls|echo|export|curl|wget|chmod|mkdir|rm|cp|mv|source)\s/m, 3],
        [/^\s*(?:fi|done|esac)\s*$/m, 4], [/^\s*if\s+\[\[?\s/m, 4], [/\$\{?\w+\}?/, 1], [/\s(?:&&|\|\|)\s/, 1],
    ],
    '@code=html': [
        [/<!DOCTYPE\s+html>/i, 8], [/<\/?(?:html|head|body|div|span|p|a|ul|ol|li|table|tr|td|script|style|section|header|footer|nav)\b[^>]*>/i, 5],
        [/<\w+\s+(?:class|id|href|src)=["']/i, 3],
    ],
    '@code=xml': [
        [/^\s*<\?xml\b/, 8], [/<(\w+:)?\w+(?:\s+[\w:]+="[^"]*")*\s*\/?>[\s\S]*<\/(\w+:)?\w+>/, 2], [/\bxmlns(?::\w+)?=/, 4],
    ],
    '@code=css': [
        [/[\w.#\-[\]="':>*\s]+\{\s*[\w-]+\s*:\s*[^;{}]+;[^{}]*\}/, 6], [/@media\b[^{]*\{/, 5],
        [/^\s*(?:color|margin|padding|display|font-(?:size|family|weight)|background(?:-color)?|border|width|height)\s*:/m, 2],
    ],
    '@code=java': [
        [/\bpublic\s+(?:static\s+)?(?:final\s+)?(?:class|void|int|String|boolean)\b/, 5], [/\bSystem\.out\.print(?:ln)?\(/, 6],
        [/^\s*import\s+java\./m, 6], [/@Override\b/, 4], [/\bString\[\]\s+\w+/, 3], [/\bnew\s+[A-Z]\w*\s*[(<]/, 1],
    ],
    '@code=c': [
        [/^\s*#include\s*[<"]/m, 6], [/\bint\s+main\s*\(/, 5], [/\bprintf\s*\(/, 3], [/\b(?:malloc|free|sizeof)\s*\(/, 3],
    ],
    '@code=cpp': [
        [/\bstd::\w+/, 6], [/\b(?:cout|cin|cerr)\s*(?:<<|>>)/, 6], [/\bnullptr\b/, 4], [/\btemplate\s*</, 4],
        [/^\s*#include\s*<\w+>/m, 2], [/\bnamespace\s+\w+\s*\{/, 2],
    ],
    '@code=csharp': [
        [/^\s*using\s+System(?:\.\w+)*\s*;/m, 6], [/\bConsole\.Write(?:Line)?\(/, 6], [/\bpublic\s+(?:async\s+)?Task\b/, 4],
        [/\bnamespace\s+[\w.]+/, 2], [/\bvar\s+\w+\s*=\s*new\b/, 2], [/\{\s*get;\s*(?:set;)?\s*\}/, 5],
    ],
    '@code=go': [
        [/^\s*package\s+\w+\s*$/m, 5], [/\bfunc\s+(?:\(\w+\s+\*?\w+\)\s*)?\w+\s*\(/, 5], [/:=/, 3], [/\bfmt\.\w+\(/, 5],
        [/^\s*import\s*\(/m, 2],
    ],
    '@code=rust': [
        [/\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(/, 4], [/\blet\s+mut\b/, 5], [/\bimpl\b(?:\s*<[^>]*>)?\s+\w+/, 3],
        [/\b\w+!\(/, 2], [/\bprintln!\(/, 5], [/&(?:mut\s+)?str\b|\bVec</, 3], [/\bpub\s+(?:fn|struct|enum)\b/, 4],
    ],
    '@code=yaml': [
        [/^---\s*$/m, 2], [/^\s*-\s+[\w"']/m, 1],
    ],
    '@code=docker': [
        [/^FROM\s+\S+/m, 4], [/^(?:RUN|CMD|COPY|ADD|ENTRYPOINT|WORKDIR|ENV|EXPOSE|ARG|USER|VOLUME)\s+\S/m, 4],
    ],
});

// TypeScript is JavaScript with types: these signs add to its JavaScript score.
const TYPESCRIPT_SIGNS = Object.freeze([
    [/:\s*(?:string|number|boolean|any|void|unknown|never)(?:\[\])?\s*[,)=;{]/, 5], [/\binterface\s+\w+\s*\{/, 5],
    [/^\s*type\s+\w+\s*=/m, 4], [/\bimplements\s+\w+/, 2], [/\b(?:private|public|readonly)\s+\w+\s*:/, 3],
]);

function nonEmptyLines(text) {
    return text.split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim() !== '');
}

// A sentence: starts with a capital, five words or more, ends like a sentence.
function isSentence(line) {
    const trimmed = line.trim();
    return /^[A-Z]/.test(trimmed) && /[.!?]["')]?$/.test(trimmed) && trimmed.split(/\s+/).length >= 5;
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
    if (lines.length < 3) {
        return false;
    }
    const rows = lines.map(splitCsvLine);
    if (rows.some((cells) => cells === null)) {
        return false;
    }
    const columns = rows[0].length;
    if (columns < 2 || rows.some((cells) => cells.length !== columns)) {
        return false;
    }
    if (lines.some(isSentence)) {
        return false;
    }
    const cells = rows.flat().map((cell) => cell.trim());
    return cells.every((cell) => cell.split(/\s+/).length <= 8 && cell.length <= 80);
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
    if (listLines.length >= 2) kinds.add('list');
    if (/(\*\*|__)(?=\S)[^\n]*?\S\1/.test(text)) kinds.add('emphasis');
    if (/`[^`\n]+`/.test(text)) kinds.add('inline-code');
    if (/!?\[[^\]\n]+\]\((?:https?:\/\/|\/|#|mailto:)[^)\s]*\)/.test(text)) kinds.add('link');
    if (lines.some((line) => /^>\s?\S/.test(line))) kinds.add('quote');
    if (lines.some((line, index) => index > 0 && TABLE_SEPARATOR_RE.test(line) && lines[index - 1].includes('|'))) kinds.add('table');
    if (lines.filter((line) => /^```\s*$/.test(line.trim())).length >= 2) kinds.add('fence');
    return kinds;
}

function looksLikeMarkdown(kinds) {
    if (kinds.has('table')) {
        return true;
    }
    return kinds.size >= 2;
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
    return codeLines / lines.length >= 0.6;
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
    if (keyLines < 3 || !isNested || keyLines / lines.length < 0.6 || lines.some((line) => /[;{}]\s*$|=>|\(\)/.test(line))) {
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
