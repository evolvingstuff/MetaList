import assert from 'node:assert/strict';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// A Send the server refuses before it starts the turn (the AI not set up, the
// active tab changed, a message it rejects) stays on screen with the server's
// reason: the user's message is their work and the reason is what to fix. The
// server keeps no record of it, so the page puts it back in place each time
// the chat reloads from the server: after later Sends, in order, and after
// closing and reopening the chat. Clear chat clears it; a turn whose earlier
// message the server trimmed goes with it; a page reload forgets it.
//
// The page stands in for the server's chat: refused Sends get a 409, answered
// ones are added to a transcript that the session reload returns.

const REFUSAL_STATUS = 409;
const REFUSAL_DETAIL = 'Active MetaList tab changed before Send';
const ANSWER = 'Fake answer';
const SETTLE_MS = 300;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function installFakeServer(page) {
    await page.evaluate(async ({status, detail, answer}) => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        const {stateValuesEqual} = await import('/static/js/modules/application-state.js');
        const models = [AiChatPanel._getSettings().model];
        if (!stateValuesEqual(AiChatPanel._models, models)) AiChatPanel._models = models;
        AiChatPanel._syncSettingsControls();
        const originalFetch = window.fetch;
        const fake = {originalFetch, refuseNext: false, chats: 0, transcript: []};
        window.chatRefusalTest = fake;
        const serverMessage = (id, role, content, model) => ({
            id, role, content, rendered_content: `<p>${content}</p>`, thinking: '', rendered_thinking: '',
            status: 'complete', error: '', provider: 'openai', model, activities: [],
        });
        const json = (body, statusCode) => new Response(JSON.stringify(body), {
            status: statusCode, headers: {'Content-Type': 'application/json'},
        });
        window.fetch = async (url, options) => {
            const path = new URL(url, location.href).pathname;
            const method = options && options.method ? options.method : 'GET';
            if (path === '/api2/ai/chat') {
                fake.chats += 1;
                if (fake.refuseNext) return json({detail}, status);
                const request = JSON.parse(options.body);
                fake.transcript.push(
                    serverMessage(`server-${fake.chats}-user`, 'user', request.message, request.model),
                    serverMessage(`server-${fake.chats}-assistant`, 'assistant', answer, request.model),
                );
                return new Response(JSON.stringify({
                    type: 'done', content: answer, rendered_content: `<p>${answer}</p>`,
                    reference_note_ids: [], reference_web_ids: [],
                }) + '\n', {headers: {'Content-Type': 'application/x-ndjson'}});
            }
            if (path === '/api2/ai/session' && method === 'GET') return json({messages: fake.transcript}, 200);
            if (path === '/api2/ai/session' && method === 'DELETE') {
                fake.transcript.splice(0);
                return json({}, 200);
            }
            return originalFetch(url, options);
        };
    }, {status: REFUSAL_STATUS, detail: REFUSAL_DETAIL, answer: ANSWER});
}

// What the chat shows, one line per message: a refused answer as its error.
function shownChat(page) {
    return page.evaluate(() => [...document.querySelectorAll('#ai-chat-messages .ai-chat-message')].map(node => {
        const error = node.querySelector('.ai-chat-message-error');
        if (error !== null) return `error: ${error.textContent.trim()}`;
        const role = node.classList.contains('ai-chat-message-user') ? 'user' : 'assistant';
        return `${role}: ${node.textContent.trim()}`;
    }));
}

async function send(page, text, {refused}) {
    await page.evaluate(refusedSend => { window.chatRefusalTest.refuseNext = refusedSend; }, refused);
    const before = await page.evaluate(() => window.chatRefusalTest.chats);
    await page.click('#ai-chat-input');
    await page.type('#ai-chat-input', text);
    await page.keyboard.press('Enter');
    await page.waitForFunction(async before => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        return window.chatRefusalTest.chats === before + 1 && !AiChatPanel._isBusy;
    }, {}, before);
    await waitForAppQuiet(page, SETTLE_MS);
}

const refusedTurn = text => [`user: ${text}`, `error: ${REFUSAL_DETAIL}`];
const answeredTurn = text => [`user: ${text}`, `assistant: ${ANSWER}`];

export async function checkAiChatRefusal(page) {
    await page.evaluate(async () => {
        const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
        await CommandPalette.applyPreference('pref.show_ai_chat', true);
    });
    await page.waitForFunction(async () => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        return !AiChatPanel._isLoadingModels;
    });
    await installFakeServer(page);
    try {
        await send(page, 'First refused', {refused: true});
        assert.deepEqual(await shownChat(page), refusedTurn('First refused'), 'a refused Send stays with its reason');

        await send(page, 'First answered', {refused: false});
        assert.deepEqual(await shownChat(page), [...refusedTurn('First refused'), ...answeredTurn('First answered')],
            'a later answered Send leaves the refused turn above it');

        await send(page, 'Second refused', {refused: true});
        await send(page, 'Third refused', {refused: true});
        await send(page, 'Second answered', {refused: false});
        const afterThreeRefusals = [
            ...refusedTurn('First refused'), ...answeredTurn('First answered'),
            ...refusedTurn('Second refused'), ...refusedTurn('Third refused'), ...answeredTurn('Second answered'),
        ];
        assert.deepEqual(await shownChat(page), afterThreeRefusals, 'two refusals stay in order above the next answer');

        await page.click('#ai-chat-close');
        await pause(SETTLE_MS);
        await page.click('#chat-toggle-button');
        await waitForAppQuiet(page, SETTLE_MS);
        assert.deepEqual(await shownChat(page), afterThreeRefusals, 'closing and reopening the chat keeps refused turns');

        // The server trims its oldest turn, the one the second and third refusals followed.
        await page.evaluate(() => { window.chatRefusalTest.transcript.splice(0, 2); });
        await send(page, 'Third answered', {refused: false});
        assert.deepEqual(await shownChat(page), [
            ...refusedTurn('First refused'), ...answeredTurn('Second answered'), ...answeredTurn('Third answered'),
        ], 'refused turns after a trimmed message go with it; one from before any message stays');

        await page.click('#ai-chat-clear');
        await waitForAppQuiet(page, SETTLE_MS);
        assert.deepEqual(await shownChat(page), [], 'Clear chat clears refused turns too');

        await send(page, 'Refused before a reload', {refused: true});
        assert.deepEqual(await shownChat(page), refusedTurn('Refused before a reload'));
    } finally {
        await page.evaluate(() => { window.fetch = window.chatRefusalTest.originalFetch; delete window.chatRefusalTest; });
    }
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await waitForAppQuiet(page, SETTLE_MS);
    assert.deepEqual(await shownChat(page), [], 'a page reload forgets refused turns');
}
