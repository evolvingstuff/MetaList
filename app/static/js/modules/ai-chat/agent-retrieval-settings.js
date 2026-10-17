export const OPENAI_AGENT_RETRIEVAL_PREFERENCE_KEYS = Object.freeze({
    maxPageApproximateTokens: 'pref.ai.openai.retrieval.max_page_approximate_tokens',
    taggingBatchTokens: 'pref.ai.openai.tagging.batch_tokens',
});

// The same limits as app/services/agent/retrieval_settings.py.
const DEFAULT_OPENAI_MAX_PAGE_APPROXIMATE_TOKENS = 500000;
const DEFAULT_OPENAI_TAGGING_BATCH_TOKENS = 100000;

export const DEFAULT_OPENAI_AGENT_RETRIEVAL_SETTINGS = Object.freeze({
    maxPageApproximateTokens: DEFAULT_OPENAI_MAX_PAGE_APPROXIMATE_TOKENS,
    taggingBatchTokens: DEFAULT_OPENAI_TAGGING_BATCH_TOKENS,
});

const LEGACY_DEFAULT_OPENAI_MAX_PAGE_APPROXIMATE_TOKENS = 24000;
// The tagging batch is validated against the same range as the evidence payload.
const MINIMUM_PAGE_APPROXIMATE_TOKENS = 500;
const MAXIMUM_OPENAI_PAGE_APPROXIMATE_TOKENS = 500000;


export class AgentRetrievalSettingsValidationError extends Error {}


export function validateAgentRetrievalSettings(settings, provider) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new TypeError('Agent retrieval settings must be an object');
    }
    const validationMessage = getAgentRetrievalSettingsValidationMessage(
        settings,
        provider,
    );
    if (validationMessage !== '') {
        throw new AgentRetrievalSettingsValidationError(validationMessage);
    }
    return {
        maxPageApproximateTokens: settings.maxPageApproximateTokens,
        taggingBatchTokens: settings.taggingBatchTokens,
    };
}


export function getAgentRetrievalSettingsValidationMessage(settings, provider) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new TypeError('Agent retrieval settings must be an object');
    }
    const maximum = maximumForProvider(provider);
    const evidenceError = integerRangeError(
        settings.maxPageApproximateTokens,
        'Maximum approximate tokens per evidence payload',
        MINIMUM_PAGE_APPROXIMATE_TOKENS,
        maximum,
    );
    if (evidenceError !== '') return evidenceError;
    return integerRangeError(settings.taggingBatchTokens, 'Tagging batch tokens', MINIMUM_PAGE_APPROXIMATE_TOKENS, maximum);
}


export function readAgentRetrievalSettings(getPreference, provider) {
    if (typeof getPreference !== 'function') {
        throw new Error('readAgentRetrievalSettings requires getPreference');
    }
    const { preferenceKeys, defaults } = configurationForProvider(provider);
    let storedValue = parseStoredInteger(
        getPreference(preferenceKeys.maxPageApproximateTokens),
        defaults.maxPageApproximateTokens,
    );
    if (
        provider === 'openai'
        && storedValue === LEGACY_DEFAULT_OPENAI_MAX_PAGE_APPROXIMATE_TOKENS
    ) {
        storedValue = DEFAULT_OPENAI_AGENT_RETRIEVAL_SETTINGS
            .maxPageApproximateTokens;
    }
    return validateAgentRetrievalSettings({
        maxPageApproximateTokens: storedValue,
        taggingBatchTokens: parseStoredInteger(getPreference(preferenceKeys.taggingBatchTokens), defaults.taggingBatchTokens),
    }, provider);
}


function integerRangeError(value, label, minimum, maximum) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        return `${label} must be from ${minimum} to ${maximum}.`;
    }
    return '';
}


function parseStoredInteger(value, defaultValue) {
    if (value === null || value === undefined || value === '') {
        return defaultValue;
    }
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
        throw new Error('Stored agent evidence-token preference is invalid');
    }
    return Number(value);
}


function maximumForProvider(provider) {
    if (provider === 'openai') {
        return MAXIMUM_OPENAI_PAGE_APPROXIMATE_TOKENS;
    }
    throw new Error(`Unsupported agent retrieval provider: ${provider}`);
}


function configurationForProvider(provider) {
    if (provider === 'openai') {
        return {
            preferenceKeys: OPENAI_AGENT_RETRIEVAL_PREFERENCE_KEYS,
            defaults: DEFAULT_OPENAI_AGENT_RETRIEVAL_SETTINGS,
        };
    }
    throw new Error(`Unsupported agent retrieval provider: ${provider}`);
}
