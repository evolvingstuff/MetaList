import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';


const TEMPLATE_URL = new URL('../../app/templates/index.html', import.meta.url);
const CSS_URL = new URL('../../app/static/css/main.css', import.meta.url);
const CONTROLLER_URL = new URL(
    '../../app/static/js/modules/ai-chat/ai-chat-panel-controller.js',
    import.meta.url,
);
const ENDPOINTS_URL = new URL(
    '../../app/static/js/modules/command-palette/endpoint-registry.js',
    import.meta.url,
);
const TAGS_URL = new URL('../../app/static/config/command_palette_tags.json', import.meta.url);
const SETTINGS_MODAL_URL = new URL(
    '../../app/static/js/modules/modals/ai-agent-settings-modal.js',
    import.meta.url,
);
const PROMPT_MODAL_URL = new URL(
    '../../app/static/js/modules/modals/agent-prompt-editor-modal.js',
    import.meta.url,
);
const COMMAND_CONTROLLER_URL = new URL(
    '../../app/static/js/modules/command-palette/command-palette-controller.js',
    import.meta.url,
);
const CHAT_API_URL = new URL(
    '../../app/static/js/modules/ai-chat/ai-chat-api.js',
    import.meta.url,
);
const CHAT_PANEL_SERVICE_URL = new URL(
    '../../app/static/js/modules/ai-chat/ai-chat-panel-service.js',
    import.meta.url,
);
const DEBUG_VIEW_URL = new URL(
    '../../app/static/js/modules/ai-chat/ai-agent-debug-view.js',
    import.meta.url,
);


test('chat panel markup has a resizer, transcript, thinking region, and composer', () => {
    const template = readFileSync(TEMPLATE_URL, 'utf8');

    assert.match(template, /id="ai-chat-panel"/);
    assert.match(template, /id="ai-chat-resizer"/);
    assert.match(template, /id="ai-chat-resizer"[\s\S]*?tabindex="0"/);
    assert.match(template, /id="ai-chat-messages"/);
    assert.match(template, /id="ai-chat-input"/);
    assert.match(
        template,
        /id="ai-chat-model"[\s\S]*?id="ai-chat-thinking-level"[\s\S]*?id="ai-chat-send"/,
    );
    assert.match(template, /id="ai-chat-send"/);
});


test('OpenAI chat shows a process-local resettable live cost estimate', () => {
    const template = readFileSync(TEMPLATE_URL, 'utf8');
    const css = readFileSync(CSS_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const chatApi = readFileSync(CHAT_API_URL, 'utf8');

    assert.match(template, /id="ai-chat-openai-cost"[\s\S]*?hidden/);
    assert.match(template, /id="ai-chat-openai-cost-amount">\$0\.00/);
    assert.match(template, /id="ai-chat-openai-cost-reset"/);
    assert.match(template, /New input/);
    assert.match(template, /Cached input/);
    assert.match(template, /Cache writes/);
    assert.match(template, /Output/);
    assert.match(chatApi, /export async function loadOpenAiCostSnapshot/);
    assert.match(chatApi, /export async function resetOpenAiCostSnapshot/);
    assert.match(controller, /settings\.provider === 'openai'/);
    assert.match(controller, /event\.status === 'completed'/);
    assert.match(controller, /formatOpenAiCostUsd/);
    assert.match(controller, /snapshot\.uncached_input_tokens\.toLocaleString\(\)/);
    assert.match(controller, /snapshot\.cached_input_tokens\.toLocaleString\(\)/);
    assert.match(controller, /snapshot\.cache_write_tokens\.toLocaleString\(\)/);
    assert.match(controller, /snapshot\.output_tokens\.toLocaleString\(\)/);
    assert.match(css, /\.ai-chat-openai-cost/);
});


test('agent debugger retains the latest trace and toggles exact detail visibility', () => {
    const template = readFileSync(TEMPLATE_URL, 'utf8');
    const css = readFileSync(CSS_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const chatApi = readFileSync(CHAT_API_URL, 'utf8');
    const debugView = readFileSync(DEBUG_VIEW_URL, 'utf8');

    assert.match(template, /id="ai-chat-debug"[^>]*aria-haspopup="dialog"/);
    assert.match(template, /id="ai-chat-debug"[^>]*aria-expanded="false"/);
    assert.match(template, /id="ai-chat-diagnostics-toggle"[^>]*aria-pressed="false"/);
    assert.match(template, /id="ai-agent-debug-dialog"/);
    assert.match(template, /id="ai-agent-debug-enabled"[^>]*type="checkbox"[^>]*checked/);
    assert.match(template, /id="ai-agent-debug-copy-all"[^>]*disabled/);
    assert.match(template, /Current or most recent run only/);
    assert.match(css, /\.ai-agent-debug-dialog[\s\S]*?width:\s*min\(1100px, 94vw\)/);
    assert.match(css, /\.ai-agent-debug-event[\s\S]*?summary/);
    assert.match(chatApi, /CONFIG\.API\.AI\.DEBUG/);
    assert.match(chatApi, /export async function loadAiDebugSnapshot/);
    assert.match(chatApi, /export async function setAiDebugExactDetails/);
    assert.match(debugView, /payload\.has_trace/);
    assert.match(debugView, /run\.events/);
    assert.match(debugView, /document\.createElement\('details'\)/);
    assert.match(debugView, /JSON\.stringify\(event\.detail, null, 2\)/);
    assert.match(debugView, /navigator\.clipboard\.writeText/);
    assert.match(debugView, /JSON\.stringify\(this\._snapshot\.run, null, 2\)/);
    assert.match(debugView, /Copied complete trace to clipboard/);
    assert.match(debugView, /Latest trace recorded\. Enable exact details to inspect payloads/);
    assert.match(debugView, /this\._renderRun\(payload\.run, payload\.enabled\)/);
    assert.match(debugView, /this\._closeFromBackdropClick\(event\)/);
    assert.match(debugView, /event\.target !== this\._elements\.dialog/);
    assert.match(debugView, /this\._elements\.dialog\.getBoundingClientRect\(\)/);
    assert.match(debugView, /this\._elements\.dialog\.close\(\)/);
    assert.match(debugView, /setAttribute\('aria-expanded', 'false'\)/);
    assert.doesNotMatch(debugView, /classList\.toggle\('is-active'/);
    assert.doesNotMatch(css, /#ai-chat-debug\.is-active/);
    assert.doesNotMatch(debugView, /Debug capture is off/);
    assert.doesNotMatch(debugView, /localStorage|sessionStorage/);
    assert.match(controller, /event\.type === 'action_status'/);
    assert.match(controller, /assistantMessage\.activities\.push/);
    assert.match(
        controller,
        /article\.appendChild\(this\._renderActivities\(message, 'diagnostic'\)\)/,
    );
    assert.match(controller, /collapseCompletedActivityPairs\(message\.activities\)/);
    assert.match(controller, /const nextVisibility = !this\._showDiagnosticActivities/);
    assert.match(controller, /String\(this\._showDiagnosticActivities\)/);
    assert.match(controller, /await this\._saveDiagnosticsVisible\(nextVisibility\)/);
    assert.match(controller, /!this\._showDiagnosticActivities[\s\S]*?_renderWorkingIndicator\(\)/);
    assert.match(controller, /label\.textContent = 'Working'/);
    assert.doesNotMatch(controller, /formatCompactWorkingActivityLabel/);
    assert.match(controller, /splitSearchActivityLabel\(activity\)/);
    assert.match(controller, /query\.className = 'ai-chat-activity-query'/);
    assert.match(controller, /tokenCount\.className = 'ai-chat-activity-token-count'/);
    assert.match(controller, /`≈ \$\{activity\.approx_input_tokens\.toLocaleString\(\)\} input tokens`/);
    assert.match(controller, /activity\.output_tokens_received\.toLocaleString\(\)/);
    assert.match(controller, /ai-chat-activity-output-token-count/);
    assert.match(css, /@keyframes ai-chat-output-token-pulse/);
    assert.match(css, /\.ai-chat-working-indicator/);
    assert.match(css, /\.ai-chat-activity-query/);
    assert.match(css, /\.ai-chat-activity-token-count/);
    assert.match(css, /font-family:\s*ui-monospace/);
    assert.match(css, /\.ai-chat-note-mention/);
    assert.match(css, /\.ai-chat-references/);
    assert.match(css, /\.ai-chat-note-reference/);
    assert.match(css, /\.ai-chat-open-all-references/);
    assert.match(css, /\.ai-chat-activity-panel\[data-action="retry"\]/);
    assert.match(css, /\.ai-chat-activity-panel\[data-action="search_notes"\]/);
    assert.match(controller, /AgentDebugView\.refreshIfOpen\(\)/);
});


test('AI agent settings expose one provider-specific evidence limit', () => {
    const settingsModal = readFileSync(SETTINGS_MODAL_URL, 'utf8');
    const commandController = readFileSync(COMMAND_CONTROLLER_URL, 'utf8');

    assert.match(settingsModal, /id="ai-agent-max-page-approximate-tokens"/);
    assert.match(settingsModal, /isOpenAi \? 500000 : 24000/);
    assert.match(settingsModal, /Maximum approximate evidence tokens/);
    assert.match(settingsModal, /A result tree is never divided/);
    assert.match(settingsModal, /trailing trees are omitted/);
    assert.doesNotMatch(settingsModal, /max-note-characters/);
    assert.doesNotMatch(settingsModal, /max-notes-per-page/);
    assert.doesNotMatch(settingsModal, /max-ranked-tags-per-page/);
    assert.doesNotMatch(settingsModal, /max-working-summary-characters/);
    assert.doesNotMatch(settingsModal, /ideal-narrowed-scope/);
    assert.match(commandController, /openAiRetrievalSettings/);
    assert.match(commandController, /ollamaRetrievalSettings/);
    assert.match(commandController, /readAgentRetrievalSettings/);
    assert.match(commandController, /maxPageApproximateTokens/);
});


test('cloud AI privacy settings and hover visualization share a server boundary', () => {
    const settingsModal = readFileSync(SETTINGS_MODAL_URL, 'utf8');
    const commandController = readFileSync(COMMAND_CONTROLLER_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const chatApi = readFileSync(CHAT_API_URL, 'utf8');
    const css = readFileSync(CSS_URL, 'utf8');

    for (const inputId of [
        'ai-agent-cloud-whitelist-tags',
        'ai-agent-cloud-whitelist-phrases',
        'ai-agent-cloud-blacklist-tags',
        'ai-agent-cloud-blacklist-phrases',
    ]) {
        assert.match(settingsModal, new RegExp(`id="${inputId}"`));
    }
    assert.match(settingsModal, /<code>@password<\/code> is always hidden/);
    assert.match(commandController, /CLOUD_PRIVACY_POLICY_PREFERENCE_KEY/);
    assert.match(commandController, /serializeCloudPrivacyPolicy/);
    assert.match(chatApi, /CLOUD_PRIVACY_PREVIEW/);
    assert.match(controller, /pointerenter/);
    assert.match(controller, /pointerleave/);
    assert.match(controller, /previewCloudPrivacy/);
    assert.match(controller, /cloud-ai-private-preview/);
    assert.match(css, /\.note\.cloud-ai-private-preview/);
    assert.doesNotMatch(controller, /classList\.add\('search-redacted'\)/);
});


test('chat accepts scoped-investigation lifecycle activities', () => {
    const controller = readFileSync(CONTROLLER_URL, 'utf8');

    for (const action of [
        'scope',
        'investigate_current_scope',
        'evidence_selection',
        'investigation_step',
        'investigation_evidence',
        'investigation_facets',
        'investigation_refinement',
        'investigation_sources',
        'evidence_root_prefix',
        'context_narrowing',
        'context_narrowing_plan',
        'context_narrowing_test',
    ]) {
        assert.match(controller, new RegExp(`'${action}'`));
    }
    assert.match(controller, /activity\.duration_ms/);
    assert.match(controller, /Step duration/);
    assert.match(controller, /_formatActivityDuration/);
});


test('context truncation remains a calm informational notice when diagnostics are hidden', () => {
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const service = readFileSync(CHAT_PANEL_SERVICE_URL, 'utf8');
    const css = readFileSync(CSS_URL, 'utf8');

    assert.match(service, /selectPersistentNonDiagnosticActivities/);
    assert.match(service, /activity\.action === 'evidence_root_prefix'/);
    assert.match(controller, /_renderActivities\([\s\S]*?'persistent'/);
    assert.match(controller, /is-persistent-notice/);
    assert.match(controller, /isPersistentNotice[\s\S]*?\? 'i'/);
    assert.match(css, /data-action="evidence_root_prefix"/);
    assert.match(css, /background: #eff6ff/);
});


test('chat scope is available through diagnostics without a persistent response chip', () => {
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const css = readFileSync(CSS_URL, 'utf8');

    assert.match(controller, /'scope'/);
    assert.doesNotMatch(controller, /_renderScopeChip|ai-chat-scope-chip/);
    assert.doesNotMatch(css, /\.ai-chat-scope-chip/);
});


test('chat freezes the active scope only when submitting a turn', () => {
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const chatApi = readFileSync(CHAT_API_URL, 'utf8');
    const submitMethod = /async _submitMessage\(\) \{[\s\S]*?\n    \}/.exec(controller)?.[0];
    const settingsMethod = /_syncSettingsControls\(\) \{[\s\S]*?\n    \}/.exec(controller)?.[0];

    assert.ok(submitMethod);
    assert.ok(settingsMethod);
    assert.match(submitMethod, /const scope = captureActiveAgentScope\(\)/);
    assert.match(controller, /scope_tab_id: scopeTabId/);
    assert.match(controller, /getActiveReferenceOriginScope\(\)/);
    assert.match(
        submitMethod,
        /const showDiagnostics = this\._showDiagnosticActivities/,
    );
    assert.match(
        submitMethod,
        /streamAiChat\(\{[\s\S]*?scope,[\s\S]*?showDiagnostics,/,
    );
    assert.match(chatApi, /show_diagnostics: showDiagnostics/);
    assert.doesNotMatch(settingsMethod, /captureActiveAgentScope/);
});


test('skill prompt headers expose an explicit expand collapse chevron', () => {
    const promptModal = readFileSync(PROMPT_MODAL_URL, 'utf8');
    const css = readFileSync(CSS_URL, 'utf8');

    assert.match(promptModal, /class="agent-skill-editor-chevron"/);
    assert.match(promptModal, /aria-hidden="true">▶<\/span>/);
    assert.match(css, /\.agent-skill-editor-chevron/);
    assert.match(
        css,
        /\.agent-skill-editor-field\[open\][\s\S]*?\.agent-skill-editor-chevron[\s\S]*?rotate\(90deg\)/,
    );
});


test('failed assistant responses render a compact tinted error panel', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');

    assert.match(controller, /error\.className = 'ai-chat-message-error'/);
    assert.match(controller, /error\.textContent = message\.error/);
    assert.match(
        css,
        /\.ai-chat-message-error\s*\{[^}]*background:\s*#fef2f2;[^}]*border-left:\s*4px solid #ef4444;/s,
    );
});


test('global controls place the shared chat toggle between menu and go-to-top', () => {
    const template = readFileSync(TEMPLATE_URL, 'utf8');
    const css = readFileSync(CSS_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');

    assert.match(
        template,
        /id="menu-button"[\s\S]*?id="chat-toggle-button"[\s\S]*?id="scroll-to-top-button"/,
    );
    assert.match(
        template,
        /id="chat-toggle-button"[\s\S]*?aria-pressed="false"[\s\S]*?<path d="M4 5h16v11H9l-5 4z"/,
    );
    assert.match(
        css,
        /\.chat-toggle-button svg\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s,
    );
    assert.match(controller, /toggle:\s*requireElement\('chat-toggle-button', HTMLButtonElement\)/);
    assert.match(controller, /elements\.toggle\.addEventListener\('click'[\s\S]*?this\._setVisible\(!isVisible\)/);
    assert.match(controller, /setAttribute\('aria-pressed', String\(isVisible\)\)/);
});


test('chat layout defaults to one third and narrows the notes shell', () => {
    const css = readFileSync(CSS_URL, 'utf8');

    assert.match(css, /--ai-chat-width:\s*33\.333vw;/);
    assert.match(css, /--ai-chat-min-notes-width:\s*480px;/);
    assert.match(
        css,
        /--ai-chat-effective-width:\s*clamp\(\s*280px,\s*var\(--ai-chat-width\),\s*calc\(100vw - var\(--ai-chat-min-notes-width\)\)\s*\);/,
    );
    assert.match(
        css,
        /body\.pref-show-ai-chat #app\s*\{[\s\S]*?width:\s*calc\(\s*100%\s*\+ \(2 \* var\(--app-page-padding\)\)\s*- var\(--ai-chat-effective-width\)\s*\);/,
    );
    assert.match(
        css,
        /body\.pref-show-ai-chat #app\s*\{[\s\S]*?margin-left:\s*calc\(-1 \* var\(--app-page-padding\)\);[\s\S]*?margin-right:\s*0;/,
    );
    assert.match(
        css,
        /--ai-chat-control-edge:\s*9px;/,
    );
    assert.match(
        css,
        /body\.pref-show-ai-chat \.global-controls\s*\{[\s\S]*?right:\s*calc\(var\(--ai-chat-effective-width\) \+ var\(--ai-chat-control-edge\)\);/,
    );
    assert.match(
        css,
        /\.ai-chat-panel\s*\{[\s\S]*?width:\s*var\(--ai-chat-effective-width\);/,
    );
    assert.match(css, /\.ai-chat-resizer[\s\S]*?cursor:\s*col-resize;/);
    assert.match(css, /\.ai-chat-resizer:focus-visible::after/);
    assert.match(css, /body\.pref-show-ai-chat\.pref-show-rhs-panel[\s\S]*?\.rhs-panel[\s\S]*?display:\s*none/);
});


test('chat width persists after resizing and restores through client preferences', () => {
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const main = readFileSync(
        new URL('../../app/static/js/main.js', import.meta.url),
        'utf8',
    );
    const auth = readFileSync(
        new URL('../../app/static/js/modules/auth.js', import.meta.url),
        'utf8',
    );
    const commandController = readFileSync(COMMAND_CONTROLLER_URL, 'utf8');

    assert.match(controller, /AiChatPanel\.init requires getPanelWidth/);
    assert.match(controller, /AiChatPanel\.init requires savePanelWidth/);
    assert.match(controller, /const savedWidth = this\._getPanelWidth\(\)/);
    assert.match(controller, /void this\._persistPanelWidth\(\)/);
    assert.match(commandController, /getAiChatPanelWidth\(\)/);
    assert.match(commandController, /saveAiChatPanelWidth\(width\)/);
    assert.match(commandController, /'pref\.ai\.chat_width'/);
    assert.match(main, /getPanelWidth:[\s\S]*?savePanelWidth:/);
    assert.match(auth, /getPanelWidth:[\s\S]*?savePanelWidth:/);
});


test('developer diagnostic panel visibility defaults hidden and persists by namespace', () => {
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const main = readFileSync(
        new URL('../../app/static/js/main.js', import.meta.url),
        'utf8',
    );
    const auth = readFileSync(
        new URL('../../app/static/js/modules/auth.js', import.meta.url),
        'utf8',
    );
    const commandController = readFileSync(COMMAND_CONTROLLER_URL, 'utf8');

    assert.match(controller, /this\._showDiagnosticActivities = false/);
    assert.match(controller, /AiChatPanel\.init requires getDiagnosticsVisible/);
    assert.match(controller, /AiChatPanel\.init requires saveDiagnosticsVisible/);
    assert.match(controller, /this\._showDiagnosticActivities = this\._getDiagnosticsVisible\(\)/);
    assert.match(commandController, /getAiChatDiagnosticsVisible\(\)/);
    assert.match(commandController, /saveAiChatDiagnosticsVisible\(isVisible\)/);
    assert.match(commandController, /'pref\.ai\.show_diagnostics'/);
    assert.match(main, /getDiagnosticsVisible:[\s\S]*?saveDiagnosticsVisible:/);
    assert.match(auth, /getDiagnosticsVisible:[\s\S]*?saveDiagnosticsVisible:/);
});


test('resized chat composer height persists through client preferences', () => {
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const main = readFileSync(
        new URL('../../app/static/js/main.js', import.meta.url),
        'utf8',
    );
    const auth = readFileSync(
        new URL('../../app/static/js/modules/auth.js', import.meta.url),
        'utf8',
    );
    const commandController = readFileSync(COMMAND_CONTROLLER_URL, 'utf8');

    assert.match(controller, /AiChatPanel\.init requires getComposerHeight/);
    assert.match(controller, /AiChatPanel\.init requires saveComposerHeight/);
    assert.match(controller, /const savedComposerHeight = this\._getComposerHeight\(\)/);
    assert.match(controller, /void this\._saveComposerHeight\(height\)/);
    assert.match(commandController, /getAiChatComposerHeight\(\)/);
    assert.match(commandController, /saveAiChatComposerHeight\(height\)/);
    assert.match(commandController, /'pref\.ai\.composer_height'/);
    assert.match(main, /getComposerHeight:[\s\S]*?saveComposerHeight:/);
    assert.match(auth, /getComposerHeight:[\s\S]*?saveComposerHeight:/);
});


test('notes keep symmetric gutters and spend gutter space before note width', () => {
    const css = readFileSync(CSS_URL, 'utf8');

    assert.match(
        css,
        /--app-min-visible-gutter:\s*calc\(var\(--side-rail-edge\) \+ 30px \+ 8px\);/,
    );
    assert.match(
        css,
        /\.container\s*\{[\s\S]*?max-width:\s*var\(--app-shell-width\);[\s\S]*?box-sizing:\s*border-box;/,
    );
    assert.match(
        css,
        /padding-inline:\s*clamp\([\s\S]*?calc\(var\(--app-min-visible-gutter\) - var\(--app-page-padding\)\)[\s\S]*?calc\(\(100% - var\(--app-content-width\)\) \/ 2\)[\s\S]*?5rem/,
    );
    assert.match(
        css,
        /body\.pref-show-ai-chat \.container\s*\{[\s\S]*?padding-inline:\s*clamp\([\s\S]*?var\(--app-min-visible-gutter\)[\s\S]*?calc\(\(100% - var\(--app-content-width\)\) \/ 2\)[\s\S]*?5rem/,
    );
});


test('small windows temporarily hide active chat without changing its preference', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');

    assert.match(
        css,
        /@media \(max-width:\s*760px\), \(max-height:\s*300px\)\s*\{[\s\S]*?body\.pref-show-ai-chat \.ai-chat-panel\s*\{[^}]*display:\s*none;[^}]*\}/,
    );
    assert.match(
        css,
        /@media \(max-width:\s*760px\), \(max-height:\s*300px\)[\s\S]*?body\.pref-show-ai-chat #app\s*\{[^}]*width:\s*min\(var\(--app-shell-width\), 100%\);[^}]*margin:\s*0 auto;/,
    );
    assert.match(
        css,
        /@media \(max-width:\s*760px\), \(max-height:\s*300px\)[\s\S]*?body\.pref-show-ai-chat \.global-controls\s*\{[^}]*right:\s*var\(--side-rail-edge\);/,
    );
    assert.doesNotMatch(controller, /ai-chat-responsive-hidden/);
});


test('empty chat does not render explanatory filler text', () => {
    const template = readFileSync(TEMPLATE_URL, 'utf8');
    const css = readFileSync(CSS_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');

    assert.doesNotMatch(template, /Chat directly with your configured Ollama model/);
    assert.doesNotMatch(template, /id="ai-chat-empty"/);
    assert.doesNotMatch(css, /\.ai-chat-empty/);
    assert.doesNotMatch(controller, /ai-chat-empty/);
});


test('chat messages use directional bubbles without repeated speaker labels', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');

    assert.match(css, /\.ai-chat-message-user[\s\S]*?border-bottom-right-radius:\s*0;/);
    assert.match(css, /\.ai-chat-message-assistant[\s\S]*?border-bottom-left-radius:\s*0;/);
    assert.doesNotMatch(controller, /ai-chat-message-role/);
});


test('completed AI responses have a right-click copy action with provenance tags', () => {
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const chatApi = readFileSync(CHAT_API_URL, 'utf8');

    assert.match(controller, /elements\.messages\.addEventListener\('contextmenu', this\._handleMessageContextMenu\)/);
    assert.match(controller, /article\.dataset\.messageId = message\.id/);
    assert.match(controller, /label:\s*'Copy Response'/);
    assert.match(controller, /message\.status !== 'complete'/);
    assert.match(controller, /copyAiChatResponse\(\{ messageId, clientId \}\)/);
    assert.match(controller, /payload\.tags !== '@llm'/);
    assert.match(controller, /ModeContext\.setClipboardMode\('note'\)/);
    assert.match(controller, /ModeContext\.setClipboardNoteId\(null\)/);
    assert.match(chatApi, /CONFIG\.API\.AI\.COPY_MESSAGE\(messageId\)/);
    assert.match(chatApi, /body:\s*JSON\.stringify\(\{ client_id: clientId \}\)/);
});


test('completed assistant messages render server markdown and queue Mermaid diagrams', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');

    assert.match(controller, /'rendered_content'/);
    assert.match(
        controller,
        /message\.role === 'assistant' && message\.rendered_content !== ''[\s\S]*?classList\.add\('meta-markdown'\)[\s\S]*?content\.innerHTML = message\.rendered_content/,
    );
    assert.match(controller, /await queueMermaidDiagramRendering\(this\._elements\.messages\)/);
    assert.match(css, /\.ai-chat-message-content\.meta-markdown\s*\{[^}]*white-space:\s*normal;/s);
});


test('streaming thinking renders honest progress and only discloses real reasoning', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');

    assert.match(controller, /createElement\(hasThinkingText \? 'details' : 'div'\)/);
    assert.match(controller, /hasThinkingText \? 'summary' : 'div'/);
    assert.match(controller, /ai-chat-thinking-dots/);
    assert.match(controller, /index < 3/);
    assert.match(controller, /ai-chat-thinking-elapsed/);
    assert.match(controller, /assistantMessage\.rendered_thinking = event\.rendered_text/);
    assert.match(controller, /assistantMessage\.rendered_content = event\.rendered_text/);
    assert.match(controller, /const isActivelyThinking = message\.status === 'streaming' && message\.content === ''/);
    assert.match(controller, /let shouldOpenThinking = isActivelyThinking[\s\S]*?this\._expandedThinkingMessageIds\.has\(message\.id\)[\s\S]*?thinking\.open = shouldOpenThinking/);
    assert.match(controller, /event\.type === 'content_delta'[\s\S]*?this\._stopThinkingFeedback\(\)/);
    assert.match(controller, /assistantMessage\.content === ''[\s\S]*?_expandedThinkingMessageIds\.delete\(assistantMessage\.id\)/);
    assert.match(controller, /thinking\.addEventListener\('toggle'[\s\S]*?_expandedThinkingMessageIds\.add\(message\.id\)/);
    assert.match(controller, /ai-chat-thinking-content meta-markdown/);
    assert.match(controller, /thinkingText\.innerHTML = message\.rendered_thinking/);
    assert.match(controller, /window\.setInterval/);
    assert.match(controller, /window\.clearInterval/);
    assert.match(controller, /`\$\{elapsedSeconds\}s`/);
    assert.doesNotMatch(controller, /Waiting for reasoning/);
    assert.match(controller, /message\.role === 'assistant' && message\.thinking !== ''/);
    assert.doesNotMatch(controller, /message\.thinking !== '' \|\| message\.status === 'streaming'/);
    assert.match(controller, /if \(hasThinkingText\)[\s\S]*?thinkingText\.textContent = message\.thinking/);
    assert.match(css, /@keyframes ai-chat-thinking-dot/);
    assert.match(css, /\.ai-chat-thinking-elapsed/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
});


test('streaming keeps drafting available and reset cancels the active Ollama request', () => {
    const template = readFileSync(TEMPLATE_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const chatApi = readFileSync(CHAT_API_URL, 'utf8');

    assert.doesNotMatch(controller, /this\._elements\.input\.disabled\s*=\s*isBusy/);
    assert.match(controller, /let isModelDisabled = this\._isBusy/);
    assert.match(controller, /let isThinkingLevelDisabled = this\._isBusy/);
    assert.match(controller, /this\._elements\.send\.textContent = this\._isBusy \? 'Stop' : 'Send'/);
    assert.match(controller, /this\._activeChatAbortController\.abort\(\)/);
    assert.match(controller, /new AbortController\(\)/);
    assert.match(controller, /label: 'Cancelled by user'/);
    assert.match(controller, /assistantMessage\.rendered_content = event\.rendered_content/);
    assert.match(
        chatApi,
        /streamAiChat\(\{[\s\S]*?showDiagnostics,[\s\S]*?signal,[\s\S]*?\}\)/,
    );
    assert.match(chatApi, /signal,/);
    assert.doesNotMatch(controller, /this\._elements\.clear\.disabled = isBusy/);
    assert.match(
        controller,
        /const activeRequestCompletion = this\._activeChatCompletion;[\s\S]*?this\._cancelActiveRequest\(\);[\s\S]*?await activeRequestCompletion;[\s\S]*?await clearAiChatSession\(\)/,
    );
    assert.match(
        controller,
        /this\._elements\.clear\.disabled = \([\s\S]*?this\._messages\.length === 0 \|\| this\._isClearingSession[\s\S]*?\)/,
    );
    assert.doesNotMatch(template, /id="ai-chat-status"/);
    assert.doesNotMatch(controller, /_setStatus|ai-chat-status/);
    assert.match(controller, /_appendLocalErrorPanel\(error\.message\)/);
});


test('completion reveals the collapsed References header without scrolling through refs', () => {
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const css = readFileSync(CSS_URL, 'utf8');

    assert.match(
        controller,
        /event\.type !== 'done'[\s\S]*?this\._render\(\{ shouldScrollToBottom \}\)/,
    );
    assert.match(
        controller,
        /querySelector\('\.ai-chat-references'\)[\s\S]*?referencePreviewHeight[\s\S]*?clientHeight/,
    );
    assert.match(controller, /details\.ai-chat-references-disclosure/);
    assert.match(controller, /this\._expandedReferenceMessageIds\.has\(message\.id\)/);
    assert.match(css, /\.ai-chat-references-heading\s*\{[\s\S]*?cursor:\s*pointer;/);
    assert.doesNotMatch(
        controller,
        /_render\(\)[\s\S]*?messages\.scrollTop = this\._elements\.messages\.scrollHeight/,
    );
});


test('command menu contains chat, AI configuration, and prompt editor actions', () => {
    const endpointSource = readFileSync(ENDPOINTS_URL, 'utf8');
    const tagConfig = JSON.parse(readFileSync(TAGS_URL, 'utf8'));

    assert.match(endpointSource, /id:\s*'pref\.show_ai_chat'/);
    assert.match(endpointSource, /id:\s*'form\.ai_agent_settings'/);
    assert.match(endpointSource, /id:\s*'form\.cloud_ai_privacy'/);
    assert.match(endpointSource, /id:\s*'form\.agent_prompts'/);
    assert.ok(tagConfig.endpoints.some((endpoint) => endpoint.id === 'pref.show_ai_chat'));
    assert.ok(tagConfig.endpoints.some((endpoint) => endpoint.id === 'form.ai_agent_settings'));
    const cloudPrivacyEndpoint = tagConfig.endpoints.find(
        (endpoint) => endpoint.id === 'form.cloud_ai_privacy',
    );
    assert.ok(cloudPrivacyEndpoint);
    assert.ok(cloudPrivacyEndpoint.tags.includes('privacy'));
    assert.ok(cloudPrivacyEndpoint.tags.includes('whitelist'));
    assert.ok(cloudPrivacyEndpoint.tags.includes('blacklist'));
    assert.ok(tagConfig.endpoints.some((endpoint) => endpoint.id === 'form.agent_prompts'));
});


test('agent prompt editor inspects, overrides, and resets prompts and skills', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    const modal = readFileSync(PROMPT_MODAL_URL, 'utf8');
    const commandController = readFileSync(COMMAND_CONTROLLER_URL, 'utf8');
    const chatApi = readFileSync(CHAT_API_URL, 'utf8');

    assert.match(modal, /<h2>Agent Prompts &amp; Skills<\/h2>/);
    assert.match(modal, /id="agent-prompt-system"/);
    assert.match(modal, /id="agent-prompt-final-response"/);
    assert.match(modal, /id="agent-prompt-tool-result"/);
    assert.match(modal, /data-agent-skill-index/);
    assert.match(modal, /Each skill is injected only after its trigger action/);
    assert.match(modal, /Restore packaged defaults/);
    assert.match(modal, /Save overrides/);
    assert.match(modal, /apply to the next run/);
    assert.match(modal, /not\s+conversation history/);
    assert.match(commandController, /AGENT_PROMPT_PREFERENCE_KEYS/);
    assert.match(commandController, /skill\.preferenceKey/);
    assert.match(commandController, /_preferences\.removeMany/);
    assert.match(chatApi, /export async function loadAgentPromptDefaults/);
    assert.match(css, /\.agent-prompt-editor-modal-content[\s\S]*?width:\s*min\(1100px, 96vw\)/);
});


test('AI settings persist and submit a required thinking level', () => {
    const template = readFileSync(TEMPLATE_URL, 'utf8');
    const css = readFileSync(CSS_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const modal = readFileSync(SETTINGS_MODAL_URL, 'utf8');
    const commandController = readFileSync(COMMAND_CONTROLLER_URL, 'utf8');
    const chatApi = readFileSync(CHAT_API_URL, 'utf8');

    assert.match(template, /id="ai-chat-model"/);
    assert.match(template, /id="ai-chat-thinking-level"/);
    assert.match(css, /\.ai-chat-composer-actions[\s\S]*?justify-content:\s*flex-end/);
    assert.match(css, /#ai-chat-thinking-level\s*\{[\s\S]*?width:\s*138px/);
    assert.match(controller, /model:\s*requireElement\('ai-chat-model', HTMLSelectElement\)/);
    assert.match(controller, /thinkingLevel:\s*requireElement\('ai-chat-thinking-level', HTMLSelectElement\)/);
    assert.match(controller, /elements\.model\.addEventListener\('change', \(\) => void this\._selectModel\(\)\)/);
    assert.match(controller, /await listAiModels\(settings\)/);
    assert.doesNotMatch(modal, /id="ai-agent-model"/);
    assert.doesNotMatch(modal, /id="ai-agent-thinking-level"/);
    assert.match(commandController, /'pref\.ai\.thinking_level'/);
    assert.match(commandController, /DEFAULT_AI_THINKING_LEVEL/);
    assert.match(chatApi, /thinking_level:\s*thinkingLevel/);
    assert.match(modal, /id="ai-agent-installed-model"/);
    assert.match(modal, /id="ai-agent-save"[^>]*>Save<\/button>/);
    assert.match(modal, /MetaList-managed Ollama/);
    assert.match(modal, /32,768-token context/);
    assert.doesNotMatch(modal, /id="ai-agent-base-url"/);
    assert.doesNotMatch(chatApi, /base_url:/);
    assert.doesNotMatch(modal, /_saveConnection/);
    assert.match(modal, /<option value="openai"/);
    assert.match(modal, /id="ai-agent-openai-api-key" type="password"/);
    assert.match(modal, /Encrypted namespaces[\s\S]*?persist it encrypted/);
    assert.match(modal, /unencrypted namespaces keep it[\s\S]*?server session only/);
    assert.match(modal, /await saveOpenAiCredential\(apiKey\)/);
    assert.match(chatApi, /export async function loadOpenAiCredentialStatus/);
    assert.match(chatApi, /export async function clearOpenAiCredential/);
});


test('OpenAI API key storage is independent from provider model settings', () => {
    const modal = readFileSync(SETTINGS_MODAL_URL, 'utf8');
    const renderMethod = modal.slice(
        modal.indexOf('renderModalContent()'),
        modal.indexOf('_setupControls()'),
    );
    const settingsSaveHandler = modal.slice(
        modal.indexOf('async _handleSave()'),
        modal.indexOf('\n}', modal.indexOf('async _handleSave()')),
    );

    assert.match(modal, /id="ai-agent-openai-save"[^>]*>Save key<\/button>/);
    assert.match(modal, /async _handleSaveOpenAiKey\(\)/);
    assert.match(modal, /await saveOpenAiCredential\(apiKey\)/);
    assert.doesNotMatch(renderMethod, /!state\.openAiCredentialConfigured/);
    assert.doesNotMatch(renderMethod, /state\.openAiApiKey/);
    assert.doesNotMatch(renderMethod, /!state\.installedModels\.includes\(state\.model\)/);
    assert.doesNotMatch(settingsSaveHandler, /saveOpenAiCredential/);
});


test('AI settings download a named Ollama model through the supported pull API', () => {
    const modal = readFileSync(SETTINGS_MODAL_URL, 'utf8');
    const chatApi = readFileSync(CHAT_API_URL, 'utf8');
    const controller = readFileSync(CONTROLLER_URL, 'utf8');
    const downloadHandler = modal.slice(
        modal.indexOf('async _handleDownload()'),
        modal.indexOf('async _handleSave()'),
    );

    assert.match(modal, /id="ai-agent-download-model"/);
    assert.match(modal, /href="https:\/\/ollama\.com\/library"/);
    assert.match(modal, /id="ai-agent-download"/);
    assert.match(modal, /id="ai-agent-download-progress"/);
    assert.match(modal, /await pullOllamaModel\(/);
    assert.match(chatApi, /CONFIG\.API\.AI\.PULL_MODEL/);
    assert.match(chatApi, /export async function pullOllamaModel/);
    assert.match(chatApi, /onEvent\(event\)/);
    assert.doesNotMatch(modal, /Configure the temporary unmanaged Ollama connection/);
    assert.match(modal, /Downloaded \$\{model\}\. Select it above when ready\./);
    assert.match(downloadHandler, /if \(didComplete\) \{[\s\S]*?await this\._loadInstalledModels\(\)/);
    assert.doesNotMatch(downloadHandler, /this\._saveSettings/);
    assert.doesNotMatch(controller, /model = this\._models\[0\]/);
    assert.match(controller, /option\.textContent = 'Select model'/);
});
