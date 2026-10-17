import assert from 'node:assert/strict';

// A Send the server refuses before it starts the turn (the AI not set up, the
// active tab changed, a message it rejects) stays on screen with the server's
// reason: the user's message is their work and the reason is what to fix.

const REFUSAL_STATUS = 409;
const REFUSAL_DETAIL = 'Active MetaList tab changed before Send';
const MESSAGE = 'Is this message kept when the server refuses it?';

export async function checkAiChatRefusal(page) {
    await page.evaluate(async () => {
        const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
        await CommandPalette.applyPreference('pref.show_ai_chat', true);
    });
    await page.waitForFunction(async () => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        return !AiChatPanel._isLoadingModels;
    });
    await page.evaluate(async ({status, detail}) => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        const {stateValuesEqual} = await import('/static/js/modules/application-state.js');
        const models = [AiChatPanel._getSettings().model];
        if (!stateValuesEqual(AiChatPanel._models, models)) AiChatPanel._models = models;
        AiChatPanel._syncSettingsControls();
        const originalFetch = window.fetch;
        window.chatRefusalTest = {originalFetch, refused: 0};
        window.fetch = async (url, options) => {
            if (new URL(url, location.href).pathname === '/api2/ai/chat') {
                window.chatRefusalTest.refused += 1;
                return new Response(JSON.stringify({detail}), {status, headers: {'Content-Type': 'application/json'}});
            }
            return originalFetch(url, options);
        };
    }, {status: REFUSAL_STATUS, detail: REFUSAL_DETAIL});
    try {
        await page.click('#ai-chat-input');
        await page.type('#ai-chat-input', MESSAGE);
        await page.keyboard.press('Enter');
        await page.waitForFunction(async () => {
            const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
            return window.chatRefusalTest.refused === 1 && !AiChatPanel._isBusy;
        });
        await page.waitForNetworkIdle({idleTime: 300});
        const shown = await page.evaluate(() => ({
            user: [...document.querySelectorAll('#ai-chat-messages .ai-chat-message-user')].map(node => node.textContent.trim()),
            errors: [...document.querySelectorAll('#ai-chat-messages .ai-chat-message-error')].map(node => node.textContent.trim()),
        }));
        assert.deepEqual(shown.user, [MESSAGE], 'the refused message stays on screen');
        assert.equal(shown.errors.length, 1, 'one error is shown for the refused Send');
        assert.ok(shown.errors[0].includes(REFUSAL_DETAIL), `the error gives the server's reason: ${shown.errors[0]}`);
    } finally {
        await page.evaluate(() => { window.fetch = window.chatRefusalTest.originalFetch; delete window.chatRefusalTest; });
    }
}
