import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AGENT_RETRIEVAL_PREFERENCE_KEYS,
    DEFAULT_AGENT_RETRIEVAL_SETTINGS,
    DEFAULT_OPENAI_AGENT_RETRIEVAL_SETTINGS,
    OPENAI_AGENT_RETRIEVAL_PREFERENCE_KEYS,
    readAgentRetrievalSettings,
    validateAgentRetrievalSettings,
} from '../../app/static/js/modules/ai-chat/agent-retrieval-settings.js';


test('retrieval settings contain evidence and tagging token limits', () => {
    assert.deepEqual(DEFAULT_AGENT_RETRIEVAL_SETTINGS, {
        maxPageApproximateTokens: 5000,
        taggingBatchTokens: 2000,
    });
    assert.deepEqual(DEFAULT_OPENAI_AGENT_RETRIEVAL_SETTINGS, {
        maxPageApproximateTokens: 250000,
        taggingBatchTokens: 8000,
    });
});


test('provider-specific evidence limits read independently', () => {
    const values = new Map([
        [AGENT_RETRIEVAL_PREFERENCE_KEYS.maxPageApproximateTokens, '7000'],
        [OPENAI_AGENT_RETRIEVAL_PREFERENCE_KEYS.maxPageApproximateTokens, '500000'],
        [AGENT_RETRIEVAL_PREFERENCE_KEYS.taggingBatchTokens, '3000'],
        [OPENAI_AGENT_RETRIEVAL_PREFERENCE_KEYS.taggingBatchTokens, '12000'],
    ]);
    const getPreference = (key) => values.get(key) ?? null;
    assert.deepEqual(readAgentRetrievalSettings(getPreference, 'ollama'), {
        maxPageApproximateTokens: 7000,
        taggingBatchTokens: 3000,
    });
    assert.deepEqual(readAgentRetrievalSettings(getPreference, 'openai'), {
        maxPageApproximateTokens: 500000,
        taggingBatchTokens: 12000,
    });
});


test('legacy OpenAI default migrates to current default', () => {
    const getPreference = (key) => (
        key === OPENAI_AGENT_RETRIEVAL_PREFERENCE_KEYS.maxPageApproximateTokens
            ? '24000'
            : null
    );
    assert.deepEqual(
        readAgentRetrievalSettings(getPreference, 'openai'),
        DEFAULT_OPENAI_AGENT_RETRIEVAL_SETTINGS,
    );
});


test('validation rejects limits outside the provider range', () => {
    assert.throws(() => validateAgentRetrievalSettings({
        maxPageApproximateTokens: 24001,
    }, 'ollama'));
    assert.throws(() => validateAgentRetrievalSettings({
        maxPageApproximateTokens: 500001,
    }, 'openai'));
});
