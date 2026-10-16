import assert from 'node:assert/strict';

export async function checkAgentHelpMenus(page) {
    await checkPasswordLogin(page);
    const catalog = await page.evaluate(async () => await (await fetch('/static/config/agent-menu-actions.json')).json());
    for (const target of catalog) {
        const result = await page.evaluate(async (entry) => {
            const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
            const {captureActiveAgentScope} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
            const result = await CommandPalette.openAgentMenu(entry.id, captureActiveAgentScope(), new AbortController().signal);
            // A destination that opened its alternate dialog says so (no other namespace: Create namespace).
            let shownSelector = entry.selector;
            if ('alternate_dialog' in entry && result.detail === entry.alternate_dialog.label) {
                shownSelector = entry.alternate_dialog.selector;
            }
            const element = document.querySelector(shownSelector);
            return {result, visible: Boolean(element?.getClientRects().length),
                selected: document.querySelector('#command-palette-results .selected')?.textContent || ''};  // shockharness: ignore[DEF003] reason="no selected palette item reads as empty text"
        }, target);
        assert.equal(result.result.status, 'opened', target.id + ': ' + JSON.stringify(result));
        assert.equal(result.visible, true, target.id);
        if (target.presentation === 'palette' && target.id !== 'command_palette') assert(result.selected.length > 0);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 0);
    }
    const stale = await page.evaluate(async () => {
        const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
        const {captureActiveAgentScope} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        const scope = captureActiveAgentScope(); scope.active_tab_id = 'stale-tab';
        return await CommandPalette.openAgentMenu('form.ai_agent_settings', scope, new AbortController().signal);
    });
    assert.equal(stale.status, 'unavailable');
    console.log(`PASS all ${catalog.length} agent menu destinations and stale-context rejection`);
    await checkDelayedModalResponses(page);
    await checkChatMenuAcknowledgment(page);
    await checkComposerAfterPasswordDialog(page);
}

async function checkComposerAfterPasswordDialog(page) {
    await page.click('#ai-chat-input');
    const result = await page.evaluate(async () => {
        const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
        const {captureActiveAgentScope} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        return await CommandPalette.openAgentMenu('form.random_password_generator', captureActiveAgentScope(), new AbortController().signal);
    });
    assert.equal(result.status, 'opened');
    await page.click('#random-password-modal .modal-close-button');
    await page.waitForFunction(() => !document.querySelector('#random-password-modal').getClientRects().length);
    await page.click('#ai-chat-input');
    await page.click('#ai-chat-input');
    await page.type('#ai-chat-input', 'Composer still works');
    assert.equal(await page.$eval('#ai-chat-input', input => input.value), 'Composer still works');
    assert.equal(await page.evaluate(async () => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        return AiChatPanel._composerHeightBeforePointerInteraction;
    }), 0);
    console.log('PASS repeated composer clicks before and after closing the agent-opened password generator');
}

async function checkPasswordLogin(page) {
    const password = 'Agent-help-login-fixture!2026';
    await page.evaluate(async password => {
        const {buildSessionHeaders} = await import('/static/js/modules/session-auth.js');
        const response = await fetch('/api2/auth/settings/password/create', {
            method: 'POST', headers: buildSessionHeaders(true), body: JSON.stringify({password}),
        });
        if (!response.ok) throw new Error(await response.text());
    }, password);
    await page.reload();
    await page.waitForSelector('#login-panel[data-revealed="true"] #login-password', {visible: true});
    await page.type('#login-password', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('[data-app-ready="true"]', {timeout: 30000});
    assert.equal(await page.evaluate(async () => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        return typeof AiChatPanel._openMenu;
    }), 'function');
    console.log('PASS password login initializes chat with menu opening support');
}

async function checkDelayedModalResponses(page) {
    const result = await page.evaluate(async () => {
        const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
        const modal = CommandPalette._aiAgentSettingsModal;
        const originalFetch = window.fetch;
        const releases = [];
        window.fetch = async (url, options) => {
            if (String(url).endsWith('/ai/openai/credential')) {
                return await new Promise(resolve => releases.push(resolve));
            }
            return originalFetch(url, options);
        };
        const credentialResponse = () => new Response(JSON.stringify({configured: false, persistent: false}),
            {headers: {'content-type': 'application/json'}});
        try {
            const first = modal.open();
            modal.close();
            const second = modal.open();
            if (releases.length !== 2) throw new Error('Expected two independent credential requests');
            releases[0](credentialResponse());
            await first;
            const stillLoading = modal.getModalState().isLoadingCredential;
            modal.close();
            releases[1](credentialResponse());
            await second;
            return {stillLoading, isOpen: modal.isOpen};
        } finally { window.fetch = originalFetch; }
    });
    assert.deepEqual(result, {stillLoading: true, isOpen: false});
    console.log('PASS late modal responses cannot update a closed or reopened dialog');
}

async function checkChatMenuAcknowledgment(page) {
    await page.evaluate(async () => {
        const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
        await CommandPalette.applyPreference('pref.show_ai_chat', true);
    });
    await page.waitForFunction(async () => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        return !AiChatPanel._isLoadingModels && AiChatPanel._models.length > 0;
    });
    const result = await page.evaluate(async () => {
        const {AiChatPanel, captureActiveAgentScope} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        const originalFetch = window.fetch;
        let streamController;
        let acknowledgment;
        let chatRequests = 0;
        const encode = event => new TextEncoder().encode(JSON.stringify(event) + '\n');
        window.fetch = async (url, options) => {
            if (String(url).endsWith('/ai/session')) {
                return new Response(JSON.stringify({messages: AiChatPanel._messages}), {headers: {'content-type': 'application/json'}});
            }
            if (String(url).endsWith('/ai/chat')) {
                chatRequests++;
                return new Response(new ReadableStream({start(controller) {
                    streamController = controller;
                    controller.enqueue(encode({type: 'menu_open', request_id: 'browser-help-fixture',
                        menu_id: 'form.ai_agent_settings', scope: captureActiveAgentScope()}));
                }}), {headers: {'content-type': 'application/x-ndjson'}});
            }
            if (String(url).endsWith('/ai/menu-result')) {
                acknowledgment = JSON.parse(options.body);
                const content = 'Opened AI agent settings.';
                streamController.enqueue(encode({type: 'done', content, rendered_content: `<p>${content}</p>`, reference_note_ids: [], reference_web_ids: []}));
                streamController.close();
                return new Response(JSON.stringify({acknowledged: true}), {headers: {'content-type': 'application/json'}});
            }
            return originalFetch(url, options);
        };
        try {
            document.getElementById('ai-chat-input').value = 'Open AI agent settings';
            await AiChatPanel._submitMessage();
            return {chatRequests, acknowledgment, status: AiChatPanel._messages.at(-1).status,
                visible: Boolean(document.querySelector('#ai-agent-settings-modal')?.getClientRects().length)};
        } finally { window.fetch = originalFetch; }
    });
    assert.equal(result.chatRequests, 1);
    assert.equal(result.acknowledgment.request_id, 'browser-help-fixture');
    assert.equal(result.acknowledgment.status, 'opened');
    assert.equal(result.status, 'complete');
    assert.equal(result.visible, true);
    await page.keyboard.press('Escape');
    console.log('PASS chat NDJSON menu request opens dialog and sends acknowledgment before completion');
}
