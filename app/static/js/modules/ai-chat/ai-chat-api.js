import { rethrowUnexpectedError, HttpRequestError } from '../expected-errors.js';
import { CONFIG } from '../config.js';
import { buildSessionHeaders } from '../session-auth.js';
import { parseAiChatNdjsonBuffer } from './ai-chat-panel-service.js';
import { validateAiThinkingLevel } from './ai-thinking-level-service.js';


export class AiApiError extends HttpRequestError {
    constructor(message) {
        super(message);
        this.name = 'AiApiError';
    }
}


async function fetchAi(url, options) {
    try {
        return await fetch(url, options);
    } catch (error) {
            rethrowUnexpectedError(error);
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


// Suggest Tags with AI (docs/ui/tag-bar.md): whether it applies to the note as
// it is being edited, unsaved tags and text included: an AI is set up and the
// privacy settings let it see the note.
export async function loadNoteTagSuggestionAvailability({ noteId, provider, tags, contentHtml }) {
    if (typeof noteId !== 'string' || noteId === '') {
        throw new Error('loadNoteTagSuggestionAvailability requires noteId');
    }
    if (typeof provider !== 'string' || typeof tags !== 'string' || typeof contentHtml !== 'string') {
        throw new Error('loadNoteTagSuggestionAvailability requires provider, tags and contentHtml strings');
    }
    const response = await fetchAi(CONFIG.API.AI.NOTE_TAG_SUGGESTION_AVAILABILITY(noteId), {
        method: 'POST',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({ provider, tags, content_html: contentHtml }),
    });
    const payload = await readJsonResponse(response, 'Failed to check Suggest Tags with AI');
    if (typeof payload.is_available !== 'boolean') {
        throw new Error('Suggest Tags with AI availability must be a boolean');
    }
    return payload.is_available;
}


function validateProposalMap(proposals) {
    if (!proposals || typeof proposals !== 'object' || Array.isArray(proposals)) {
        throw new Error('Suggest Tags with AI proposals must be an object of note ids');
    }
    for (const tags of Object.values(proposals)) {
        if (!Array.isArray(tags) || tags.length === 0 || tags.some((tag) => typeof tag !== 'string' || tag === '')) {
            throw new Error('Suggest Tags with AI proposals must be non-empty tag lists');
        }
    }
    return proposals;
}

// Ask the AI for the saved note's tags, alone or with the notes below it the
// view shows (scope: { search, tabId, isUntaggedView }). onProgress(completed,
// total) follows its batches. Resolves to { noteId: [tags] } (possibly empty);
// rejects with an AiApiError saying why the AI could not answer.
export async function requestNoteTagSuggestions({ noteId, includeChildren, scope, provider, model, thinkingLevel, onProgress }) {
    if (typeof noteId !== 'string' || noteId === '' || typeof includeChildren !== 'boolean') {
        throw new Error('requestNoteTagSuggestions requires noteId and includeChildren');
    }
    if (!scope || typeof scope.search !== 'string' || typeof scope.tabId !== 'string' || typeof scope.isUntaggedView !== 'boolean') {
        throw new Error('requestNoteTagSuggestions requires the view scope');
    }
    if (typeof provider !== 'string' || typeof model !== 'string' || model === '' || typeof onProgress !== 'function') {
        throw new Error('requestNoteTagSuggestions requires provider, model and onProgress');
    }
    validateAiThinkingLevel(thinkingLevel);
    const response = await fetchAi(CONFIG.API.AI.NOTE_TAG_SUGGESTIONS(noteId), {
        method: 'POST',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({
            provider, model, thinking_level: thinkingLevel, include_children: includeChildren,
            search: scope.search, tab_id: scope.tabId, is_untagged_view: scope.isUntaggedView,
        }),
    });
    if (!response.ok) {
        await readJsonResponse(response, 'Failed to ask the AI for tags');
        throw new Error('readJsonResponse returns only for a successful response');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let proposals = null;
    while (proposals === null) {
        const { value, done } = await reader.read();
        if (done) {
            throw new Error('Suggest Tags with AI ended without an answer');
        }
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0 && proposals === null) {
            const event = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (event.type === 'progress' && Number.isInteger(event.completed) && Number.isInteger(event.total)) {
                onProgress(event.completed, event.total);
            } else if (event.type === 'proposals') {
                proposals = validateProposalMap(event.proposals);
            } else if (event.type === 'failed' && typeof event.message === 'string') {
                throw new AiApiError(event.message);
            } else {
                throw new Error(`Suggest Tags with AI answered an unknown line: ${event.type}`);
            }
        }
    }
    return proposals;
}


// Suggest with AI in the Export and Print dialog (docs/ui/controls.md): a title
// for a note with its children (noteId), or for the view as it is shown (noteId
// null), in scope: { search, tabId, isUntaggedView }.
function exportTitleScope({ provider, scope, noteId }) {
    if (typeof provider !== 'string' || provider === '') {
        throw new Error('The export title requires the AI provider');
    }
    if (!scope || typeof scope.search !== 'string' || typeof scope.tabId !== 'string' || typeof scope.isUntaggedView !== 'boolean') {
        throw new Error('The export title requires the view scope');
    }
    if (noteId !== null && (typeof noteId !== 'string' || noteId === '')) {
        throw new Error('The export title requires a note id or null for the view');
    }
    const scopeFields = { provider, search: scope.search, tab_id: scope.tabId, is_untagged_view: scope.isUntaggedView };
    if (noteId === null) {
        return { ...scopeFields, exported: 'view', note_id: '' };
    }
    return { ...scopeFields, exported: 'note', note_id: noteId };
}

// 'unavailable' (no AI set up), 'nothing' (no text to title), 'private' (all of
// it hidden from the AI), 'partial' (some of it), or 'ready'.
export async function loadExportTitleAvailability({ provider, scope, noteId }) {
    const response = await fetchAi(CONFIG.API.AI.EXPORT_TITLE_AVAILABILITY, {
        method: 'POST',
        headers: buildSessionHeaders(true),
        body: JSON.stringify(exportTitleScope({ provider, scope, noteId })),
    });
    const payload = await readJsonResponse(response, 'Failed to check Suggest with AI');
    if (!['unavailable', 'nothing', 'private', 'partial', 'ready'].includes(payload.availability)) {
        throw new Error('Export title availability is unknown');
    }
    return payload.availability;
}

// The AI's title, unlike previousTitles; rejects with an
// AiApiError saying why it could not answer. Aborting signal stops it.
export async function requestExportTitle({ provider, model, thinkingLevel, scope, noteId, previousTitles, signal }) {
    if (typeof model !== 'string' || model === '' || !Array.isArray(previousTitles) || !(signal instanceof AbortSignal)) {
        throw new Error('requestExportTitle requires model, previousTitles and signal');
    }
    validateAiThinkingLevel(thinkingLevel);
    const response = await fetchAi(CONFIG.API.AI.EXPORT_TITLE, {
        method: 'POST',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({
            ...exportTitleScope({ provider, scope, noteId }),
            model, thinking_level: thinkingLevel, previous_titles: previousTitles,
        }),
        signal,
    });
    if (!response.ok) {
        await readJsonResponse(response, 'Failed to ask the AI for a title');
        throw new Error('readJsonResponse returns only for a successful response');
    }
    const event = JSON.parse((await response.text()).trim());
    if (event.type === 'title' && typeof event.title === 'string' && event.title !== '') {
        return event.title;
    }
    if (event.type === 'failed' && typeof event.message === 'string') {
        throw new AiApiError(event.message);
    }
    throw new Error(`Suggest with AI answered an unknown line: ${event.type}`);
}


export async function previewCloudPrivacy({ provider, noteIds, signal }) {
    if (provider !== 'openai') {
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


export async function streamAiChat({
    settings,
    message,
    scope,
    selectedNoteId,
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
    if (typeof selectedNoteId !== 'string') {
        throw new Error('streamAiChat requires selectedNoteId string (empty when no note is selected)');
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
            selected_note_id: selectedNoteId,
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
            await onEvent(event);
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


export async function loadAiHistory() {
    const response = await fetchAi(CONFIG.API.AI.HISTORY, {
        headers: buildSessionHeaders(false), cache: 'no-store',
    });
    if (!response.ok) {
        await readJsonResponse(response, 'Failed to export LLM history');
    }
    const pairs = await response.json();
    if (!Array.isArray(pairs) || pairs.some((pair) => !Array.isArray(pair) || pair.length !== 2)) {
        throw new Error('LLM history must contain input/output pairs');
    }
    return pairs;
}


export async function acknowledgeAgentMenu(result) {
    const response = await fetchAi(CONFIG.API.AI.MENU_RESULT, {
        method: 'POST', headers: buildSessionHeaders(true), body: JSON.stringify(result),
    });
    return await readJsonResponse(response, 'Failed to acknowledge menu opening');
}
