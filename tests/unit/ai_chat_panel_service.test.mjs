import assert from 'node:assert/strict';
import test from 'node:test';

import {
    calculateAiChatMaximumWidth,
    calculateAiChatPanelWidth,
    collapseCompletedActivityPairs,
    formatOpenAiCostUsd,
    selectPersistentNonDiagnosticActivities,
    splitSearchActivityLabel,
    parseAiChatNdjsonBuffer,
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
            action: 'search_notes',
            status: 'started',
            label: 'Searching notes · page 1 · "Pydantic AI"',
        },
        {
            sequence: 2,
            action: 'search_notes',
            status: 'completed',
            label: 'Search complete · 2 of 8 result trees · 5 of 20 matching notes · page 1 of 3 · "Pydantic AI"',
        },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [activities[1]]);
});


test('model wait response and validation phases update one attempt panel', () => {
    const activities = [
        {
            sequence: 0,
            action: 'planning',
            status: 'started',
            label: 'Preparing action selection',
            approx_input_tokens: 1200,
        },
        {
            sequence: 1,
            action: 'model_request',
            status: 'started',
            label: 'Waiting for Ollama',
            approx_input_tokens: 1300,
        },
        {
            sequence: 2,
            action: 'validation',
            status: 'started',
            label: 'Ollama responded · validating',
            approx_input_tokens: 1300,
        },
        {
            sequence: 3,
            action: 'validation',
            status: 'completed',
            label: 'Structured search query validated',
            approx_input_tokens: 1300,
        },
        {
            sequence: 4,
            action: 'search_notes',
            status: 'started',
            label: 'Searching notes · page 1 · foo',
            approx_input_tokens: 1300,
        },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [
        activities[3],
        activities[4],
    ]);
});


test('live output-token updates replace the active model request panel', () => {
    const activities = [
        {
            sequence: 1,
            action: 'model_request',
            status: 'started',
            label: 'Ollama updating evidence and choosing next step',
            approx_input_tokens: 12000,
            output_tokens_received: 8,
        },
        {
            sequence: 2,
            action: 'model_request',
            status: 'started',
            label: 'Ollama updating evidence and choosing next step',
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
            label: 'Waiting for Ollama',
        },
        {
            action: 'validation',
            status: 'started',
            label: 'Ollama responded · validating',
        },
        {
            action: 'retry',
            status: 'started',
            label: 'Structured output invalid (ValidationError) · Instructor will retry',
        },
        {
            action: 'model_request',
            status: 'started',
            label: 'Instructor retrying · Waiting for Ollama · attempt 2 of 2',
        },
        {
            action: 'validation',
            status: 'started',
            label: 'Ollama responded · validating attempt 2 of 2',
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
            label: 'Ollama rejected the response before output · retrying attempt 2 of 2',
        },
        { action: 'respond', status: 'completed', label: 'Response complete' },
    ];

    assert.deepEqual(collapseCompletedActivityPairs(activities), [activities[2]]);
});


test('search activity labels expose the query as a separate display part', () => {
    assert.deepEqual(splitSearchActivityLabel({
        action: 'search_notes',
        label: 'Searching notes · page 1 · foo -"lorem ipsum"',
    }), {
        statusLabel: 'Searching notes · page 1',
        searchQuery: 'foo -"lorem ipsum"',
    });
    assert.deepEqual(splitSearchActivityLabel({
        action: 'search_notes',
        label: 'Search complete · 2 of 8 result trees · 5 of 20 matching notes · page 1 of 3 · foo -"lorem ipsum"',
    }), {
        statusLabel: 'Search complete · 2 of 8 result trees · 5 of 20 matching notes · page 1 of 3',
        searchQuery: 'foo -"lorem ipsum"',
    });
    assert.deepEqual(splitSearchActivityLabel({
        action: 'search_notes',
        label: 'Search page unavailable · page 7 of 6 · foo',
    }), {
        statusLabel: 'Search page unavailable · page 7 of 6',
        searchQuery: 'foo',
    });
    assert.deepEqual(splitSearchActivityLabel({
        action: 'search_notes',
        label: 'Skipped duplicate search · page 1 · foo OR "foo"',
    }), {
        statusLabel: 'Skipped duplicate search · page 1',
        searchQuery: 'foo OR "foo"',
    });
    assert.deepEqual(splitSearchActivityLabel({
        action: 'search_notes',
        label: 'Skipped repeat-search selection · foo OR "foo"',
    }), {
        statusLabel: 'Skipped repeat-search selection',
        searchQuery: 'foo OR "foo"',
    });
    assert.deepEqual(splitSearchActivityLabel({
        action: 'search_notes',
        label: 'Selected action · Search notes · The answer depends on the notes.',
    }), {
        statusLabel: 'Selected action · Search notes · The answer depends on the notes.',
        searchQuery: '',
    });
});


test('NDJSON parser retains incomplete tail while returning complete stream events', () => {
    const parsed = parseAiChatNdjsonBuffer(
        '{"type":"action_status","action":"search_notes","status":"started","label":"Searching notes","approx_input_tokens":1234,"output_tokens_received":0,"duration_ms":1250.5}\n'
        + '{"type":"thinking_delta","text":"hmm","rendered_text":"<p>hmm</p>"}\n'
        + '{"type":"content_delta","text":"Hi","rendered_text":"<p>Hi',
    );

    assert.deepEqual(parsed.events, [
        {
            type: 'action_status',
            action: 'search_notes',
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
        `${parsed.remainder}</p>","reference_note_ids":[]}\n`
        + '{"type":"done","content":"Hi","rendered_content":"<p>Hi</p>","reference_note_ids":[]}\n',
    );
    assert.deepEqual(completed.events, [
        {
            type: 'content_delta',
            text: 'Hi',
            rendered_text: '<p>Hi</p>',
            reference_note_ids: [],
        },
        {
            type: 'done',
            content: 'Hi',
            rendered_content: '<p>Hi</p>',
            reference_note_ids: [],
        },
    ]);
    assert.equal(completed.remainder, '');
});


test('NDJSON parser rejects malformed action status events', () => {
    assert.throws(
        () => parseAiChatNdjsonBuffer(
            '{"type":"action_status","action":"search_notes","status":"started"}\n',
        ),
        /action_status requires label/,
    );
    assert.throws(
        () => parseAiChatNdjsonBuffer(
            '{"type":"action_status","action":"search_notes","status":"waiting","label":"Searching notes"}\n',
        ),
        /action_status status is invalid/,
    );
    assert.throws(
        () => parseAiChatNdjsonBuffer(
            '{"type":"action_status","action":"search_notes","status":"started","label":"Searching notes","approx_input_tokens":1234,"output_tokens_received":0}\n',
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
            '{"type":"done","content":"hello","reference_note_ids":[]}\n',
        ),
        /done requires rendered_content/,
    );
});
