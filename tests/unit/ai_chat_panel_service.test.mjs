import assert from 'node:assert/strict';
import test from 'node:test';

import {
    calculateAiChatMaximumWidth,
    calculateAiChatPanelWidth,
    collapseCompletedActivityPairs,
    formatOpenAiCostUsd,
    selectPersistentNonDiagnosticActivities,
    parseAiChatNdjsonBuffer,
    synchronizeExpandedReferenceMessage,
    validateOpenAiCostSnapshot,
} from '../../app/static/js/modules/ai-chat/ai-chat-panel-service.js';


test('eye-off mode retains only completed context truncation warnings', () => {
    const activities = [
        {
            action: 'planning',
            status: 'completed',
            label: 'Structured action validated',
        },
        {
            action: 'evidence_root_prefix',
            status: 'completed',
            label: 'Context truncated · included 8 of 12 result trees',
        },
        {
            action: 'respond',
            status: 'started',
            label: 'Writing response',
        },
    ];

    assert.deepEqual(
        selectPersistentNonDiagnosticActivities(activities),
        [activities[1]],
    );
});


test('OpenAI cost display validates every token category and preserves small costs', () => {
    const snapshot = {
        estimated_cost_usd: 0.00438,
        uncached_input_tokens: 700,
        cached_input_tokens: 200,
        cache_write_tokens: 100,
        output_tokens: 50,
    };

    assert.equal(validateOpenAiCostSnapshot(snapshot), snapshot);
    assert.equal(formatOpenAiCostUsd(0), '$0.00');
    assert.equal(formatOpenAiCostUsd(snapshot.estimated_cost_usd), '$0.00438');
    assert.throws(
        () => validateOpenAiCostSnapshot({ ...snapshot, cached_input_tokens: -1 }),
        /cached_input_tokens/,
    );
});


test('chat resizer converts pointer position into clamped right-panel width', () => {
    assert.equal(calculateAiChatPanelWidth({ pointerClientX: 800, viewportWidth: 1200 }), 400);
    assert.equal(calculateAiChatPanelWidth({ pointerClientX: 1100, viewportWidth: 1200 }), 280);
    assert.equal(calculateAiChatPanelWidth({ pointerClientX: 100, viewportWidth: 1200 }), 720);
});


test('chat maximum width preserves the minimum notes area', () => {
    assert.equal(calculateAiChatMaximumWidth(1200), 720);
    assert.equal(calculateAiChatMaximumWidth(2000), 1520);
    assert.equal(calculateAiChatMaximumWidth(760), 280);
});


test('reference disclosure toggle ignores browser-emitted redundant state events', () => {
    const calls = [];
    let isExpanded = false;
    const strictState = {
        has: messageId => {
            assert.equal(messageId, 'assistant-1');
            return isExpanded;
        },
        add: messageId => {
            if (isExpanded) throw new Error('redundant add');
            calls.push(['add', messageId]);
            isExpanded = true;
        },
        delete: messageId => {
            if (!isExpanded) throw new Error('redundant delete');
            calls.push(['delete', messageId]);
            isExpanded = false;
        },
    };

    synchronizeExpandedReferenceMessage(strictState, 'assistant-1', true);
    synchronizeExpandedReferenceMessage(strictState, 'assistant-1', true);
    synchronizeExpandedReferenceMessage(strictState, 'assistant-1', false);
    synchronizeExpandedReferenceMessage(strictState, 'assistant-1', false);

    assert.deepEqual(calls, [
        ['add', 'assistant-1'],
        ['delete', 'assistant-1'],
    ]);
});


test('completed activity collapses only its identical preceding started panel', () => {
    const activities = [
        {
            sequence: 1,
            action: 'read_notes_by_id',
            status: 'started',
            label: 'Reading 2 notes',
        },
        {
            sequence: 2,
            action: 'read_notes_by_id',
            status: 'completed',
            label: 'Reading 2 notes',
        },
        {
            sequence: 3,
            action: 'planning',
            status: 'started',
            label: 'Preparing action selection',
        },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [
        activities[1],
        activities[2],
    ]);
});


test('completed search replaces its live row with the result count and exact query', () => {
    const activities = [
        {
            sequence: 1,
            action: 'search_view_notes',
            status: 'started',
            label: 'Searching notes · page 1 · "Pydantic AI"',
        },
        {
            sequence: 2,
            action: 'search_view_notes',
            status: 'completed',
            label: 'Search complete · 2 of 8 result trees · 5 of 20 matching notes · page 1 of 3 · "Pydantic AI"',
        },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [activities[1]]);
});


test('model wait response and validation phases update one attempt panel', () => {
    const activities = [
        {
            sequence: 1,
            action: 'model_request',
            status: 'started',
            label: 'Waiting for OpenAI',
            approx_input_tokens: 1300,
        },
        {
            sequence: 2,
            action: 'validation',
            status: 'started',
            label: 'OpenAI responded · validating',
            approx_input_tokens: 1300,
        },
        {
            sequence: 3,
            action: 'validation',
            status: 'completed',
            label: 'Structured reply validated',
            approx_input_tokens: 1300,
        },
        {
            sequence: 4,
            action: 'search_view_notes',
            status: 'started',
            label: 'Searching your view',
            approx_input_tokens: 1300,
        },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [
        activities[2],
        activities[3],
    ]);
});


test('live output-token updates replace the active model request panel', () => {
    const activities = [
        {
            sequence: 1,
            action: 'model_request',
            status: 'started',
            label: 'OpenAI updating evidence and choosing next step',
            approx_input_tokens: 12000,
            output_tokens_received: 8,
        },
        {
            sequence: 2,
            action: 'model_request',
            status: 'started',
            label: 'OpenAI updating evidence and choosing next step',
            approx_input_tokens: 12000,
            output_tokens_received: 16,
        },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [activities[1]]);
});


test('model retries remain visible between independently collapsed attempt panels', () => {
    const activities = [
        {
            action: 'model_request',
            status: 'started',
            label: 'Waiting for OpenAI',
        },
        {
            action: 'validation',
            status: 'started',
            label: 'OpenAI responded · validating',
        },
        {
            action: 'retry',
            status: 'started',
            label: 'Structured output invalid (ValidationError) · Instructor will retry',
        },
        {
            action: 'model_request',
            status: 'started',
            label: 'Instructor retrying · Waiting for OpenAI · attempt 2 of 2',
        },
        {
            action: 'validation',
            status: 'started',
            label: 'OpenAI responded · validating attempt 2 of 2',
        },
        {
            action: 'validation',
            status: 'completed',
            label: 'Structured action validated · attempt 2 of 2',
        },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [
        activities[1],
        activities[2],
        activities[5],
    ]);
});


test('response lifecycle updates one panel even when its completed label changes', () => {
    const activities = [
        { action: 'respond', status: 'started', label: 'Writing response' },
        { action: 'respond', status: 'completed', label: 'Response complete' },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [activities[1]]);
});


test('response retry updates the existing lifecycle panel', () => {
    const activities = [
        { action: 'respond', status: 'started', label: 'Writing response' },
        {
            action: 'respond',
            status: 'started',
            label: 'OpenAI rejected the response before output · retrying attempt 2 of 2',
        },
        { action: 'respond', status: 'completed', label: 'Response complete' },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [activities[2]]);
});


test('NDJSON parser retains incomplete tail while returning complete stream events', () => {
    const parsed = parseAiChatNdjsonBuffer(
        '{"type":"action_status","action":"search_view_notes","status":"started","label":"Searching notes","approx_input_tokens":1234,"output_tokens_received":0,"duration_ms":1250.5}\n'
        + '{"type":"thinking_delta","text":"hmm","rendered_text":"<p>hmm</p>"}\n'
        + '{"type":"content_delta","text":"Hi","rendered_text":"<p>Hi',
    );

    assert.deepEqual(parsed.events, [
        {
            type: 'action_status',
            action: 'search_view_notes',
            status: 'started',
            label: 'Searching notes',
            approx_input_tokens: 1234,
            output_tokens_received: 0,
            duration_ms: 1250.5,
        },
        {
            type: 'thinking_delta',
            text: 'hmm',
            rendered_text: '<p>hmm</p>',
        },
    ]);
    assert.equal(
        parsed.remainder,
        '{"type":"content_delta","text":"Hi","rendered_text":"<p>Hi',
    );

    const completed = parseAiChatNdjsonBuffer(
        `${parsed.remainder}</p>","reference_note_ids":[],"reference_web_ids":[]}\n`
        + '{"type":"done","content":"Hi","rendered_content":"<p>Hi</p>","reference_note_ids":[],"reference_web_ids":[]}\n',
    );
    assert.deepEqual(completed.events, [
        {
            type: 'content_delta',
            text: 'Hi',
            rendered_text: '<p>Hi</p>',
            reference_note_ids: [],
            reference_web_ids: [],
        },
        {
            type: 'done',
            content: 'Hi',
            rendered_content: '<p>Hi</p>',
            reference_note_ids: [],
            reference_web_ids: [],
        },
    ]);
    assert.equal(completed.remainder, '');
});


test('NDJSON parser rejects malformed action status events', () => {
    assert.throws(
        () => parseAiChatNdjsonBuffer(
            '{"type":"action_status","action":"search_view_notes","status":"started"}\n',
        ),
        /action_status requires label/,
    );
    assert.throws(
        () => parseAiChatNdjsonBuffer(
            '{"type":"action_status","action":"search_view_notes","status":"waiting","label":"Searching notes"}\n',
        ),
        /action_status status is invalid/,
    );
    assert.throws(
        () => parseAiChatNdjsonBuffer(
            '{"type":"action_status","action":"search_view_notes","status":"started","label":"Searching notes","approx_input_tokens":1234,"output_tokens_received":0}\n',
        ),
        /action_status requires non-negative finite duration_ms/,
    );
});


test('NDJSON parser fails loudly for unknown event types', () => {
    assert.throws(
        () => parseAiChatNdjsonBuffer('{"type":"mystery"}\n'),
        /Unknown AI stream event type/,
    );
});


test('NDJSON parser requires rendered snapshots for streamed text', () => {
    assert.throws(
        () => parseAiChatNdjsonBuffer('{"type":"thinking_delta","text":"hmm"}\n'),
        /thinking_delta requires rendered_text/,
    );
    assert.throws(
        () => parseAiChatNdjsonBuffer('{"type":"content_delta","text":"hello"}\n'),
        /content_delta requires rendered_text/,
    );
    assert.throws(
        () => parseAiChatNdjsonBuffer(
            '{"type":"done","content":"hello","reference_note_ids":[],"reference_web_ids":[]}\n',
        ),
        /done requires rendered_content/,
    );
});


test('a model turn still merges with its result when the provider wait sits in between', () => {
    // Thinking → Waiting for OpenAI → OpenAI responded → turn result: the wait's
    // line stays (its time is the time to OpenAI's first signal), the turn shows
    // one line, after it, in time order.
    const activities = [
        { sequence: 1, action: 'agent_turn', status: 'started', label: 'Thinking' },
        { sequence: 2, action: 'provider_wait', status: 'started', label: 'Waiting for OpenAI' },
        { sequence: 3, action: 'provider_wait', status: 'completed', label: 'OpenAI responded' },
        { sequence: 4, action: 'agent_turn', status: 'completed', label: 'Using lookup metalist help' },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [activities[2], activities[3]]);
});


test('a streamed answer keeps one live line across its provider wait and progress updates', () => {
    const activities = [
        { sequence: 1, action: 'respond', status: 'started', label: 'Writing response' },
        { sequence: 2, action: 'provider_wait', status: 'started', label: 'Waiting for OpenAI' },
        { sequence: 3, action: 'provider_wait', status: 'completed', label: 'OpenAI responded' },
        { sequence: 4, action: 'respond', status: 'started', label: 'Writing response' },
        { sequence: 5, action: 'respond', status: 'started', label: 'Writing response' },
        { sequence: 6, action: 'respond', status: 'completed', label: 'Answer written' },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [activities[2], activities[5]]);
});
