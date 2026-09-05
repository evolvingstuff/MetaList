const AI_STREAM_EVENT_TYPES = new Set([
    'bulk_progress', 'bulk_question', 'bulk_complete', 'bulk_preferences',
    'action_status',
    'thinking_delta',
    'content_delta',
    'done',
    'error',
]);
const AI_CHAT_MINIMUM_WIDTH = 280;
const AI_CHAT_MINIMUM_NOTES_WIDTH = 480;


export function validateOpenAiCostSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new Error('OpenAI cost snapshot must be an object');
    }
    if (
        !Number.isFinite(snapshot.estimated_cost_usd)
        || snapshot.estimated_cost_usd < 0
    ) {
        throw new Error('OpenAI estimated cost must be non-negative and finite');
    }
    for (const fieldName of [
        'uncached_input_tokens',
        'cached_input_tokens',
        'cache_write_tokens',
        'output_tokens',
    ]) {
        const value = snapshot[fieldName];
        if (!Number.isInteger(value) || value < 0) {
            throw new Error(`OpenAI ${fieldName} must be a non-negative integer`);
        }
    }
    return snapshot;
}


export function formatOpenAiCostUsd(estimatedCostUsd) {
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
        throw new Error('formatOpenAiCostUsd requires non-negative finite cost');
    }
    return `$${estimatedCostUsd.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
    })}`;
}


export function calculateAiChatMaximumWidth(viewportWidth) {
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
        throw new Error('calculateAiChatMaximumWidth requires positive viewportWidth');
    }
    return Math.max(
        AI_CHAT_MINIMUM_WIDTH,
        Math.floor(viewportWidth - AI_CHAT_MINIMUM_NOTES_WIDTH),
    );
}


export function calculateAiChatPanelWidth({ pointerClientX, viewportWidth }) {
    if (!Number.isFinite(pointerClientX)) {
        throw new Error('calculateAiChatPanelWidth requires finite pointerClientX');
    }
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
        throw new Error('calculateAiChatPanelWidth requires positive viewportWidth');
    }
    const maximumWidth = calculateAiChatMaximumWidth(viewportWidth);
    const requestedWidth = Math.round(viewportWidth - pointerClientX);
    return Math.max(AI_CHAT_MINIMUM_WIDTH, Math.min(maximumWidth, requestedWidth));
}


export function collapseCompletedActivityPairs(activities) {
    if (!Array.isArray(activities)) {
        throw new Error('collapseCompletedActivityPairs requires an activity array');
    }
    const displayedActivities = [];
    for (const activity of activities) {
        if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
            throw new Error('AI chat activity must be an object');
        }
        const previous = displayedActivities[displayedActivities.length - 1];
        const completesPrevious = previous
            && activity.status === 'completed'
            && previous.status === 'started'
            && previous.action === activity.action;
        const updatesPreviousStartedLifecycle = previous
            && activity.status === 'started'
            && previous.status === 'started'
            && previous.action === activity.action;
        const previousAttempt = previous
            ? /attempt \d+ of \d+/.exec(previous.label)?.[0]
            : undefined;
        const currentAttempt = /attempt \d+ of \d+/.exec(activity.label)?.[0];
        const advancesSameModelAttempt = previous
            && previousAttempt === currentAttempt
            && ['model_request', 'validation'].includes(previous.action)
            && ['model_request', 'validation'].includes(activity.action);
        const beginsPlannedModelRequest = previous
            && previous.action === 'planning'
            && previous.status === 'started'
            && ['model_request', 'validation'].includes(activity.action);
        if (
            completesPrevious
            || updatesPreviousStartedLifecycle
            || advancesSameModelAttempt
            || beginsPlannedModelRequest
        ) {
            displayedActivities[displayedActivities.length - 1] = activity;
        } else {
            displayedActivities.push(activity);
        }
    }
    return displayedActivities;
}


export function selectPersistentNonDiagnosticActivities(activities) {
    if (!Array.isArray(activities)) {
        throw new Error(
            'selectPersistentNonDiagnosticActivities requires an activity array',
        );
    }
    return activities.filter((activity) => {
        if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
            throw new Error('AI chat activity must be an object');
        }
        return (
            activity.action === 'evidence_root_prefix'
            && activity.status === 'completed'
        );
    });
}


export function splitSearchActivityLabel(activity) {
    if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
        throw new Error('splitSearchActivityLabel requires activity object');
    }
    if (typeof activity.action !== 'string' || activity.action === '') {
        throw new Error('Search activity display requires action');
    }
    if (typeof activity.label !== 'string' || activity.label === '') {
        throw new Error('Search activity display requires label');
    }
    if (activity.action !== 'search_notes') {
        return { statusLabel: activity.label, searchQuery: '' };
    }

    const startedPrefixMatch = /^Searching notes · page \d+ · /.exec(activity.label);
    if (startedPrefixMatch) {
        const searchQuery = activity.label.slice(startedPrefixMatch[0].length);
        if (searchQuery === '') {
            throw new Error('Search activity query must be non-empty');
        }
        const statusLabel = startedPrefixMatch[0].slice(0, -3);
        return { statusLabel, searchQuery };
    }

    const completedPrefixMatch = (
        /^Search complete · \d+ of \d+ result trees? · \d+ of \d+ matching notes? · page \d+ of \d+ · /
    ).exec(activity.label);
    if (completedPrefixMatch) {
        const searchQuery = activity.label.slice(completedPrefixMatch[0].length);
        if (searchQuery === '') {
            throw new Error('Completed search activity query must be non-empty');
        }
        const statusLabel = completedPrefixMatch[0].slice(0, -3);
        return { statusLabel, searchQuery };
    }
    const unavailablePrefixMatch = /^Search page unavailable · page \d+ of \d+ · /.exec(
        activity.label,
    );
    if (unavailablePrefixMatch) {
        const searchQuery = activity.label.slice(unavailablePrefixMatch[0].length);
        if (searchQuery === '') {
            throw new Error('Unavailable search page query must be non-empty');
        }
        const statusLabel = unavailablePrefixMatch[0].slice(0, -3);
        return { statusLabel, searchQuery };
    }
    const duplicatePrefixMatch = /^Skipped duplicate search · page \d+ · /.exec(
        activity.label,
    );
    if (duplicatePrefixMatch) {
        const searchQuery = activity.label.slice(duplicatePrefixMatch[0].length);
        if (searchQuery === '') {
            throw new Error('Skipped duplicate search query must be non-empty');
        }
        const statusLabel = duplicatePrefixMatch[0].slice(0, -3);
        return { statusLabel, searchQuery };
    }
    const repeatSelectionPrefix = 'Skipped repeat-search selection · ';
    if (activity.label.startsWith(repeatSelectionPrefix)) {
        const searchQuery = activity.label.slice(repeatSelectionPrefix.length);
        if (searchQuery === '') {
            throw new Error('Skipped repeat-search selection query must be non-empty');
        }
        return {
            statusLabel: 'Skipped repeat-search selection',
            searchQuery,
        };
    }
    return { statusLabel: activity.label, searchQuery: '' };
}


function validateAiStreamEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error('AI stream event must be an object');
    }
    if (typeof event.type !== 'string' || !AI_STREAM_EVENT_TYPES.has(event.type)) {
        throw new Error(`Unknown AI stream event type: ${event.type}`);
    }
    if (
        event.type === 'action_status'
        && (typeof event.action !== 'string' || event.action.length === 0)
    ) {
        throw new Error('action_status requires action');
    }
    if (
        event.type === 'action_status'
        && !['started', 'completed'].includes(event.status)
    ) {
        throw new Error('action_status status is invalid');
    }
    if (
        event.type === 'action_status'
        && (typeof event.label !== 'string' || event.label.length === 0)
    ) {
        throw new Error('action_status requires label');
    }
    if (
        event.type === 'action_status'
        && (!Number.isInteger(event.approx_input_tokens) || event.approx_input_tokens < 1)
    ) {
        throw new Error('action_status requires positive approx_input_tokens');
    }
    if (
        event.type === 'action_status'
        && (!Number.isInteger(event.output_tokens_received) || event.output_tokens_received < 0)
    ) {
        throw new Error('action_status requires non-negative output_tokens_received');
    }
    if (
        event.type === 'action_status'
        && (!Number.isFinite(event.duration_ms) || event.duration_ms < 0)
    ) {
        throw new Error('action_status requires non-negative finite duration_ms');
    }
    if (
        (event.type === 'thinking_delta' || event.type === 'content_delta')
        && (typeof event.text !== 'string' || event.text.length === 0)
    ) {
        throw new Error(`${event.type} requires non-empty text`);
    }
    if (
        (event.type === 'thinking_delta' || event.type === 'content_delta')
        && typeof event.rendered_text !== 'string'
    ) {
        throw new Error(`${event.type} requires rendered_text`);
    }
    if (event.type === 'content_delta' || event.type === 'done') {
        if (
            !Array.isArray(event.reference_note_ids)
            || event.reference_note_ids.some((noteId) => (
                typeof noteId !== 'string' || noteId.length === 0
            ))
            || new Set(event.reference_note_ids).size !== event.reference_note_ids.length
        ) {
            throw new Error(`${event.type} requires unique reference_note_ids`);
        }
    }
    if (
        event.type === 'done'
        && (typeof event.content !== 'string' || event.content.length === 0)
    ) {
        throw new Error('done requires final content');
    }
    if (event.type === 'done' && typeof event.rendered_content !== 'string') {
        throw new Error('done requires rendered_content');
    }
    if (event.type === 'error' && (typeof event.message !== 'string' || event.message.length === 0)) {
        throw new Error('AI error event requires message');
    }
    return event;
}


export function parseAiChatNdjsonBuffer(buffer) {
    if (typeof buffer !== 'string') {
        throw new Error('parseAiChatNdjsonBuffer requires string buffer');
    }
    const lines = buffer.split('\n');
    const remainder = lines.pop();
    if (typeof remainder !== 'string') {
        throw new Error('AI NDJSON parser remainder missing');
    }
    const events = [];
    for (const line of lines) {
        if (line === '') {
            continue;
        }
        events.push(validateAiStreamEvent(JSON.parse(line)));
    }
    return { events, remainder };
}
