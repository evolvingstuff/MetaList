import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';


const BASE_MODAL_URL = new URL('../../app/static/js/modules/modals/base-modal.js', import.meta.url);
const MAIN_CSS_URL = new URL('../../app/static/css/main.css', import.meta.url);
const MODALS_ROOT_URL = new URL('../../app/static/js/modules/modals/', import.meta.url);
const IMAGE_CHOICE_URL = new URL(
    '../../app/static/js/modules/mode-manager/services/image-file-insert-choice-modal-service.js',
    import.meta.url,
);
const CONTEXT_MENU_URL = new URL(
    '../../app/static/js/modules/context-menu/context-menu-service.js',
    import.meta.url,
);


function readModalSource(filename) {
    return readFileSync(new URL(filename, MODALS_ROOT_URL), 'utf8');
}


function modalSourceEntries() {
    return readdirSync(MODALS_ROOT_URL)
        .filter((filename) => filename.endsWith('.js'))
        .map((filename) => ({ filename, source: readModalSource(filename) }));
}


test('BaseModal supports a universal close button, Escape, outside click, and Enter actions', () => {
    const source = readFileSync(BASE_MODAL_URL, 'utf8');

    assert.match(source, /className = 'modal-close-button'/);
    assert.match(source, /textContent = '×'/);
    assert.match(source, /title = 'Close \(Esc\)'/);
    assert.match(source, /closeButton\.onclick = \(\) => this\.requestClose\(\)/);
    assert.match(source, /event\.key === 'Escape'/);
    assert.match(source, /this\.requestClose\(\)/);
    assert.match(source, /event\.target === event\.currentTarget/);
    assert.match(source, /\[data-modal-enter-action\]/);
});


test('modal render replacement reinstalls the universal close button', () => {
    const source = readFileSync(BASE_MODAL_URL, 'utf8');

    assert.match(source, /_wrapModalContentRenderer\(\)/);
    assert.match(source, /renderModalContent\.apply\(this, args\)/);
    assert.match(source, /this\._installModalCloseButton\(\)/);
});


test('retired sound manager is absent from the modal registry', () => {
    assert.ok(!modalSourceEntries().some(({ filename }) => filename === 'sound-manager-modal.js'));
});

test('reminders render their modal panel before BaseModal installs shared chrome', () => {
    const source = readModalSource('reminder-modal.js');
    const showStart = source.indexOf('    showModalElement() {');
    const showEnd = source.indexOf('    onOpen() {', showStart);
    assert.notEqual(showStart, -1);
    assert.notEqual(showEnd, -1);
    const showSource = source.slice(showStart, showEnd);

    const renderIndex = showSource.indexOf('this._render();');
    const displayIndex = showSource.indexOf("modalElement.style.display = 'block';");
    assert.notEqual(renderIndex, -1);
    assert.notEqual(displayIndex, -1);
    assert.ok(renderIndex < displayIndex, 'reminder panel must exist before BaseModal installs its close control');
});


test('the universal modal close control is circular and upper-right aligned', () => {
    const source = readFileSync(MAIN_CSS_URL, 'utf8');
    const ruleStart = source.indexOf('.modal-content .modal-close-button');
    const ruleEnd = source.indexOf('.modal-content .modal-close-button:hover', ruleStart);
    assert.notEqual(ruleStart, -1);
    assert.notEqual(ruleEnd, -1);
    const ruleSource = source.slice(ruleStart, ruleEnd);

    assert.match(ruleSource, /position:\s*absolute/);
    assert.match(ruleSource, /top:\s*16px/);
    assert.match(ruleSource, /right:\s*16px/);
    assert.match(ruleSource, /border-radius:\s*50%/);
});


test('help modal header reserves the close control footprint above its first panel', () => {
    const source = readFileSync(MAIN_CSS_URL, 'utf8');
    const ruleStart = source.indexOf('.help-modal-content h2 {');
    const ruleEnd = source.indexOf('.help-shortcuts-container', ruleStart);
    assert.notEqual(ruleStart, -1);
    assert.notEqual(ruleEnd, -1);
    const ruleSource = source.slice(ruleStart, ruleEnd);

    assert.match(ruleSource, /margin:\s*0 56px 0 0/);
    assert.match(ruleSource, /min-height:\s*42px/);
});


test('help modal uses a centered flex overlay with internal panel scrolling', () => {
    const source = readModalSource('help-modal.js');
    const css = readFileSync(MAIN_CSS_URL, 'utf8');

    assert.match(source, /modalElement\.style\.display = 'flex'/);
    assert.match(css, /#help-modal\s*\{[\s\S]*align-items:\s*center/);
    assert.match(css, /#help-modal\s*\{[\s\S]*justify-content:\s*center/);
    assert.match(css, /\.help-modal-content\s*\{[\s\S]*overflow-y:\s*auto/);
});


test('all app modals inherit the theme-independent dark visual system', () => {
    const source = readFileSync(MAIN_CSS_URL, 'utf8');
    const shellStart = source.indexOf('/* Shared modal shell. Modal contents are intentionally dark in every app theme. */');
    const unifiedStart = source.indexOf('/* Unified dark modal visual system');

    assert.notEqual(shellStart, -1);
    assert.notEqual(unifiedStart, -1);
    const shellSource = source.slice(shellStart, source.indexOf('.image-file-insert-choice-modal-content', shellStart));
    const unifiedSource = source.slice(unifiedStart);

    assert.match(shellSource, /\.modal\s*\{[\s\S]*--modal-surface:/);
    assert.match(shellSource, /color-scheme:\s*dark/);
    assert.match(shellSource, /z-index:\s*15000/);
    assert.match(shellSource, /backdrop-filter:\s*blur\(/);
    assert.match(shellSource, /\.modal-content\s*\{[\s\S]*background:\s*linear-gradient/);
    assert.match(unifiedSource, /\.modal-content input:not\(\[type="checkbox"\]\)/);
    assert.match(unifiedSource, /\.modal-content \.secondary-btn/);
    assert.match(unifiedSource, /\.modal-content \.danger-btn/);

    const specializedSurfaces = [
        'namespace-modal-radio-row',
        'search-suggestion-statistics-day',
        'note-layout-preview',
        'help-section',
        'password-length',
        'password-strength',
        'reminder-row',
        'backup-result-table thead th',
        'prioritize-modal-tag-bar',
        'command-palette-panel',
    ];
    for (const className of specializedSurfaces) {
        assert.ok(unifiedSource.includes(className), `missing dark modal coverage for ${className}`);
    }
});


test('ontology editor keeps its established visual system outside shared modal overrides', () => {
    const source = readFileSync(MAIN_CSS_URL, 'utf8');
    const unifiedStart = source.indexOf('/* Unified dark modal visual system');
    assert.notEqual(unifiedStart, -1);
    const unifiedSource = source.slice(unifiedStart);

    assert.doesNotMatch(unifiedSource, /#ontology-modal/);
    assert.doesNotMatch(unifiedSource, /\.ontology-dialog/);
    assert.match(source, /#ontology-modal\s*\{[\s\S]*padding:\s*0;[\s\S]*backdrop-filter:\s*none/);
    assert.match(
        source,
        /#ontology-modal \.modal-content\.ontology-modal-content\s*\{[\s\S]*max-width:\s*90%;[\s\S]*margin:\s*60px auto;[\s\S]*padding:\s*20px;[\s\S]*border-radius:\s*8px/,
    );
});


test('modal sources do not render dismiss-only Close or OK footer buttons', () => {
    for (const { filename, source } of modalSourceEntries()) {
        assert.doesNotMatch(source, />\s*(?:Close|OK)\s*</, `${filename} has a dismiss-only button`);
    }
});


test('BaseModal outside-click detection survives modal content replacement during a click', () => {
    const source = readFileSync(BASE_MODAL_URL, 'utf8');
    const handlerStart = source.indexOf('    handleClickOutside(event) {');
    const handlerEnd = source.indexOf('    _wrapModalContentRenderer()', handlerStart);
    assert.notEqual(handlerStart, -1);
    assert.notEqual(handlerEnd, -1);
    const handlerSource = source.slice(handlerStart, handlerEnd);

    assert.match(handlerSource, /event\.target === event\.currentTarget/);
    assert.doesNotMatch(handlerSource, /querySelector/);
});


test('every modal with a primary button declares or implements Enter behavior', () => {
    for (const { filename, source } of modalSourceEntries()) {
        if (!source.includes('primary-btn')) {
            continue;
        }
        const hasDeclaredAction = source.includes('data-modal-enter-action');
        const hasCustomHandler = source.includes('onKeyDown(event)') || source.includes('handleKeyDown(event)');
        assert.equal(
            hasDeclaredAction || hasCustomHandler,
            true,
            `${filename} must support Enter`,
        );
    }
});


test('formerly blocking modals allow outside-click closing', () => {
    const modalFiles = [
        'backup-restore-modal.js',
        'backup-result-modal.js',
        'backup-retention-modal.js',
        'backup-settings-modal.js',
        'delete-namespace-modal.js',
        'namespace-modals.js',
        'password-modal.js',
    ];

    for (const filename of modalFiles) {
        const source = readModalSource(filename);
        assert.doesNotMatch(
            source,
            /shouldCloseOnClickOutside\(\)\s*\{\s*return false;/,
            `${filename} must allow outside-click closing`,
        );
    }
});


test('delete namespace modal starts in loading state before its async onOpen hook', () => {
    const source = readModalSource('delete-namespace-modal.js');
    const initialStateStart = source.indexOf('    getInitialModalState() {');
    const initialStateEnd = source.indexOf('    shouldCloseOnClickOutside()', initialStateStart);
    assert.notEqual(initialStateStart, -1);
    assert.notEqual(initialStateEnd, -1);
    const initialStateSource = source.slice(initialStateStart, initialStateEnd);

    assert.match(initialStateSource, /loading:\s*true,/);
});


test('the only BaseModal outside-click override has an explicit equivalent handler', () => {
    for (const { filename, source } of modalSourceEntries()) {
        const disablesBaseOutsideClick = /shouldCloseOnClickOutside\(\)\s*\{\s*return false;/.test(source);
        if (!disablesBaseOutsideClick) {
            continue;
        }
        assert.equal(filename, 'ontology-modal.js');
        assert.match(source, /_handleMouseDownOutside\(event\)/);
        assert.match(source, /_handleMouseDownOutside[\s\S]*?this\.close\(\)/);
    }
});


test('image insert choice supports the universal close button, Escape, outside click, and Enter', () => {
    const source = readFileSync(IMAGE_CHOICE_URL, 'utf8');

    assert.match(source, /class="modal-close-button"/);
    assert.match(source, /title="Close \(Esc\)"/);
    assert.match(source, /event\.target === modalElement/);
    assert.match(source, /event\.key === 'Escape'/);
    assert.match(source, /event\.key === 'Enter'/);
});


test('context menus support Escape, outside click, and Enter', () => {
    const source = readFileSync(CONTEXT_MENU_URL, 'utf8');

    assert.match(source, /event\.key === 'Escape'/);
    assert.match(source, /handleGlobalMouseDown/);
    assert.match(source, /event\.key (?:===|!==) 'Enter'/);
});
