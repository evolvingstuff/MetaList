import assert from 'node:assert/strict';
import test from 'node:test';


function createSessionStorage(tabId) {
    return {
        getItem(key) {
            if (key === 'metalist_tab_id') {
                return tabId;
            }
            return null;
        },
    };
}


test('AI session API reports a non-JSON server failure as an HTTP error', async () => {
    const originalFetch = globalThis.fetch;
    const originalSessionStorage = globalThis.sessionStorage;
    globalThis.sessionStorage = createSessionStorage('tab-ai-error');
    globalThis.fetch = async () => new Response('Internal Server Error', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
    });

    try {
        const {
            AiApiError,
            loadAiChatSession,
        } = await import('../../app/static/js/modules/ai-chat/ai-chat-api.js');

        await assert.rejects(
            loadAiChatSession(),
            (error) => (
                error instanceof AiApiError
                && error.message === 'Failed to load AI chat session (500)'
            ),
        );
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.sessionStorage = originalSessionStorage;
    }
});
