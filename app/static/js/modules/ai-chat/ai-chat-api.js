import { CONFIG } from '../config.js';
import { buildSessionHeaders } from '../session-auth.js';
import { parseAiChatNdjsonBuffer } from './ai-chat-panel-service.js';
import { validateAiThinkingLevel } from './ai-thinking-level-service.js';


export class AiApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AiApiError';
    }
}


async function fetchAi(url, options) {
    try {
        return await fetch(url, options);
    } catch (error) {
        if (options.signal instanceof AbortSignal && options.signal.aborted) {
            throw error;
        }
        if (error instanceof TypeError) {
            throw new AiApiError('Could not reach the MetaList AI service');
        }
        throw error;
    }
}


async function readJsonResponse(response, fallbackMessage) {
    if (!(response instanceof Response)) {
        throw new Error('readJsonResponse requires Response');
    }
    if (typeof fallbackMessage !== 'string' || fallbackMessage === '') {
        throw new Error('readJsonResponse requires fallbackMessage');
    }
    const responseText = await response.text();
    const contentType = response.headers.get('content-type');
    const isJson = typeof contentType === 'string'
        && contentType.toLowerCase().includes('json');
    if (!response.ok) {
        let message = `${fallbackMessage} (${response.status})`;
        if (isJson && responseText !== '') {
            const payload = JSON.parse(responseText);
            if (payload && typeof payload.detail === 'string') {
                message = payload.detail;
            }
        }
        throw new AiApiError(message);
    }
    if (!isJson || responseText === '') {
        throw new Error(`${fallbackMessage}: response must be JSON`);
    }
    const payload = JSON.parse(responseText);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`${fallbackMessage}: response payload missing`);
    }
    return payload;
}


export async function loadAiChatSession() {
    const response = await fetchAi(CONFIG.API.AI.SESSION, {
        headers: buildSessionHeaders(false),
        cache: 'no-store',
    });
    return await readJsonResponse(response, 'Failed to load AI chat session');
}


export async function clearAiChatSession() {
    const response = await fetchAi(CONFIG.API.AI.SESSION, {
        method: 'DELETE',
        headers: buildSessionHeaders(false),
    });
    return await readJsonResponse(response, 'Failed to clear AI chat session');
}


export async function loadAgentPromptDefaults() {
    const response = await fetchAi(CONFIG.API.AI.PROMPT_DEFAULTS, {
        headers: buildSessionHeaders(false),
        cache: 'no-store',
    });
    return await readJsonResponse(response, 'Failed to load packaged agent prompts');
}


export async function loadAiDebugSnapshot() {
    const response = await fetchAi(CONFIG.API.AI.DEBUG, {
        headers: buildSessionHeaders(false),
        cache: 'no-store',
    });
    return await readJsonResponse(response, 'Failed to load agent debug trace');
}


export async function setAiDebugExactDetails(enabled) {
    if (typeof enabled !== 'boolean') {
        throw new Error('setAiDebugExactDetails requires boolean enabled');
    }
    const response = await fetchAi(CONFIG.API.AI.DEBUG, {
        method: 'PUT',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({ enabled }),
    });
    return await readJsonResponse(response, 'Failed to update agent debug detail visibility');
}


export async function previewCloudPrivacy({ provider, noteIds, signal }) {
    if (!['ollama', 'openai'].includes(provider)) {
        throw new Error('previewCloudPrivacy requires supported provider');
    }
    if (!Array.isArray(noteIds)) {
        throw new Error('previewCloudPrivacy requires note ids array');
    }
    if (noteIds.some((noteId) => typeof noteId !== 'string' || noteId === '')) {
        throw new Error('previewCloudPrivacy note ids must be non-empty strings');
    }
    if (!(signal instanceof AbortSignal)) {
        throw new Error('previewCloudPrivacy requires abort signal');
    }
    const response = await fetchAi(CONFIG.API.AI.CLOUD_PRIVACY_PREVIEW, {
        method: 'POST',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({
            provider,
            note_ids: noteIds,
        }),
        signal,
    });
    const payload = await readJsonResponse(
        response,
        'Failed to preview cloud AI privacy',
    );
    if (!Array.isArray(payload.hidden_note_ids)) {
        throw new Error('Cloud AI privacy preview response is invalid');
    }
    return payload;
}


export async function copyAiChatResponse({ messageId, clientId }) {
    if (typeof messageId !== 'string' || messageId === '') {
        throw new Error('copyAiChatResponse requires messageId');
    }
    if (typeof clientId !== 'string' || clientId === '') {
        throw new Error('copyAiChatResponse requires clientId');
    }
    const response = await fetchAi(CONFIG.API.AI.COPY_MESSAGE(messageId), {
        method: 'POST',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({ client_id: clientId }),
    });
    return await readJsonResponse(response, 'Failed to copy AI response');
}


export async function listAiModels(settings) {
    if (!settings || typeof settings !== 'object') {
        throw new Error('listAiModels requires settings object');
    }
    const response = await fetchAi(CONFIG.API.AI.MODELS, {
        method: 'POST',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({
            provider: settings.provider,
        }),
    });
    return await readJsonResponse(response, 'Failed to list AI models');
}


export async function loadOpenAiCredentialStatus() {
    const response = await fetchAi(CONFIG.API.AI.OPENAI_CREDENTIAL, {
        headers: buildSessionHeaders(false),
        cache: 'no-store',
    });
    return await readJsonResponse(response, 'Failed to load OpenAI credential status');
}


export async function saveOpenAiCredential(apiKey) {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
        throw new Error('saveOpenAiCredential requires API key');
    }
    const response = await fetchAi(CONFIG.API.AI.OPENAI_CREDENTIAL, {
        method: 'PUT',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({ api_key: apiKey }),
    });
    return await readJsonResponse(response, 'Failed to save OpenAI API key');
}


export async function clearOpenAiCredential() {
    const response = await fetchAi(CONFIG.API.AI.OPENAI_CREDENTIAL, {
        method: 'DELETE',
        headers: buildSessionHeaders(false),
    });
    return await readJsonResponse(response, 'Failed to remove OpenAI API key');
}


export async function loadOpenAiCostSnapshot() {
    const response = await fetchAi(CONFIG.API.AI.OPENAI_COST, {
        headers: buildSessionHeaders(false),
        cache: 'no-store',
    });
    return await readJsonResponse(response, 'Failed to load OpenAI cost estimate');
}


export async function resetOpenAiCostSnapshot() {
    const response = await fetchAi(CONFIG.API.AI.OPENAI_COST_RESET, {
        method: 'POST',
        headers: buildSessionHeaders(false),
    });
    return await readJsonResponse(response, 'Failed to reset OpenAI cost estimate');
}


function validateModelPullEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error('Ollama model-download event must be an object');
    }
    if (event.type === 'error') {
        if (typeof event.message !== 'string' || event.message === '') {
            throw new Error('Ollama model-download error event requires message');
        }
        return event;
    }
    if (event.type !== 'progress' && event.type !== 'done') {
        throw new Error(`Unknown Ollama model-download event type: ${event.type}`);
    }
    if (typeof event.status !== 'string' || event.status === '') {
        throw new Error('Ollama model-download event requires status');
    }
    if (!Number.isInteger(event.completed) || event.completed < 0) {
        throw new Error('Ollama model-download event requires valid completed bytes');
    }
    if (!Number.isInteger(event.total) || event.total < 0) {
        throw new Error('Ollama model-download event requires valid total bytes');
    }
    return event;
}


export function parseModelPullNdjsonBuffer(buffer) {
    if (typeof buffer !== 'string') {
        throw new Error('parseModelPullNdjsonBuffer requires string buffer');
    }
    const lines = buffer.split('\n');
    const remainder = lines.pop();
    if (typeof remainder !== 'string') {
        throw new Error('Ollama model-download parser remainder missing');
    }
    const events = [];
    for (const line of lines) {
        if (line === '') {
            continue;
        }
        events.push(validateModelPullEvent(JSON.parse(line)));
    }
    return { events, remainder };
}


export async function pullOllamaModel({ settings, model, onEvent }) {
    if (!settings || typeof settings !== 'object') {
        throw new Error('pullOllamaModel requires settings object');
    }
    if (typeof model !== 'string' || model.trim() === '') {
        throw new Error('pullOllamaModel requires model name');
    }
    if (typeof onEvent !== 'function') {
        throw new Error('pullOllamaModel requires onEvent');
    }
    const response = await fetchAi(CONFIG.API.AI.PULL_MODEL, {
        method: 'POST',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({
            provider: settings.provider,
            model: model.trim(),
        }),
    });
    if (!response.ok) {
        await readJsonResponse(response, 'Failed to start Ollama model download');
    }
    if (!(response.body instanceof ReadableStream)) {
        throw new Error('Ollama model-download response is missing readable stream');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let didFinish = false;
    while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const parsed = parseModelPullNdjsonBuffer(buffer);
        buffer = parsed.remainder;
        for (const event of parsed.events) {
            onEvent(event);
            if (event.type === 'done' || event.type === 'error') {
                didFinish = true;
            }
        }
        if (done) {
            break;
        }
    }
    if (buffer !== '') {
        throw new Error('Ollama model-download stream ended with incomplete JSON');
    }
    if (!didFinish) {
        throw new AiApiError('Ollama model-download stream ended before completion');
    }
}


export async function streamAiChat({
    settings,
    message,
    scope,
    showDiagnostics,
    onEvent,
    signal,
}) {
    if (!settings || typeof settings !== 'object') {
        throw new Error('streamAiChat requires settings object');
    }
    if (typeof message !== 'string' || message.trim() === '') {
        throw new Error('streamAiChat requires non-empty message');
    }
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
        throw new Error('streamAiChat requires scope object');
    }
    if (typeof showDiagnostics !== 'boolean') {
        throw new Error('streamAiChat requires boolean showDiagnostics');
    }
    if (typeof onEvent !== 'function') {
        throw new Error('streamAiChat requires onEvent');
    }
    if (!(signal instanceof AbortSignal)) {
        throw new Error('streamAiChat requires AbortSignal');
    }
    const thinkingLevel = validateAiThinkingLevel(settings.thinkingLevel);
    const response = await fetchAi(CONFIG.API.AI.CHAT, {
        method: 'POST',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({
            provider: settings.provider,
            model: settings.model,
            thinking_level: thinkingLevel,
            show_diagnostics: showDiagnostics,
            message,
            scope,
        }),
        signal,
    });
    if (!response.ok) {
        await readJsonResponse(response, 'Failed to start AI chat');
    }
    if (!(response.body instanceof ReadableStream)) {
        throw new Error('AI chat response is missing readable stream');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let didFinish = false;
    while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const parsed = parseAiChatNdjsonBuffer(buffer);
        buffer = parsed.remainder;
        for (const event of parsed.events) {
            onEvent(event);
            if (event.type === 'done' || event.type === 'error') {
                didFinish = true;
            }
        }
        if (done) {
            break;
        }
    }
    if (buffer !== '') {
        throw new Error('AI chat stream ended with incomplete JSON');
    }
    if (!didFinish) {
        throw new AiApiError('AI chat stream ended before completion');
    }
}
