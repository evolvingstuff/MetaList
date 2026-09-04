const LEGACY_AUTH_TOKEN_KEY = 'auth_token';
const LEGACY_AUTH_OWNER_KEY = 'auth_owner';
const LEGACY_COMMAND_PALETTE_USAGE_KEY = 'metalist.command_palette.usage.v1';
const LEGACY_PREFERENCE_PREFIX = 'metalist.command_palette.pref.';
const LEGACY_CLIENT_PREFERENCE_KEYS = [
    'pref.show_backlinks',
    'pref.show_note_tags',
    'pref.show_tab_ui',
    'pref.show_perf_overlay',
    'pref.theme',
];
const LEGACY_OBSOLETE_CLIENT_PREFERENCE_KEYS = [
    'pref.show_rhs_panel',
];


function getLocalStorage() {
    if (!('localStorage' in globalThis)) {
        return null;
    }
    return globalThis.localStorage;
}


function isObjectRecord(value) {
    return value !== null && typeof value === 'object' && Array.isArray(value) === false;
}


function normalizePreferences(rawPreferences) {
    if (!isObjectRecord(rawPreferences)) {
        throw new Error('Preferences payload must be an object');
    }

    const normalized = {};
    for (const [key, value] of Object.entries(rawPreferences)) {
        if (typeof key !== 'string' || key.length === 0) {
            throw new Error('Preference keys must be non-empty strings');
        }
        if (typeof value !== 'string') {
            throw new Error(`Preference ${key} must be a string`);
        }
        normalized[key] = value;
    }
    return normalized;
}


function normalizeUsageRecord(endpointId, rawRecord) {
    if (!isObjectRecord(rawRecord)) {
        throw new Error(`Usage record for ${endpointId} must be an object`);
    }
    if (!Number.isInteger(rawRecord.count) || rawRecord.count < 1) {
        throw new Error(`Usage count for ${endpointId} must be a positive integer`);
    }
    if (!Number.isInteger(rawRecord.lastUsedAt) || rawRecord.lastUsedAt < 0) {
        throw new Error(`Usage lastUsedAt for ${endpointId} must be a non-negative integer`);
    }
    if (!Array.isArray(rawRecord.lastQueryTokens)) {
        throw new Error(`Usage lastQueryTokens for ${endpointId} must be an array`);
    }

    const normalizedTokens = [];
    for (const token of rawRecord.lastQueryTokens) {
        if (typeof token !== 'string') {
            throw new Error(`Usage lastQueryTokens for ${endpointId} must contain strings`);
        }
        normalizedTokens.push(token);
    }

    return {
        count: rawRecord.count,
        lastUsedAt: rawRecord.lastUsedAt,
        lastQueryTokens: normalizedTokens,
    };
}


function normalizeUsageState(rawUsageState) {
    if (!isObjectRecord(rawUsageState)) {
        throw new Error('Usage state must be an object');
    }

    const normalized = {};
    for (const [endpointId, rawRecord] of Object.entries(rawUsageState)) {
        if (typeof endpointId !== 'string' || endpointId.length === 0) {
            throw new Error('Usage endpoint ids must be non-empty strings');
        }
        normalized[endpointId] = normalizeUsageRecord(endpointId, rawRecord);
    }
    return normalized;
}


function readLegacyClientPreferences() {
    const storage = getLocalStorage();
    if (storage === null) {
        return {};
    }

    const preferences = {};
    for (const key of LEGACY_CLIENT_PREFERENCE_KEYS) {
        const storageValue = storage.getItem(`${LEGACY_PREFERENCE_PREFIX}${key}`);
        if (typeof storageValue === 'string' && storageValue.length > 0) {
            preferences[key] = storageValue;
        }
    }
    return normalizePreferences(preferences);
}


function readLegacyCommandPaletteUsage() {
    const storage = getLocalStorage();
    if (storage === null) {
        return {};
    }

    const rawUsageState = storage.getItem(LEGACY_COMMAND_PALETTE_USAGE_KEY);
    if (rawUsageState === null || rawUsageState === '') {
        return {};
    }

    const parsed = JSON.parse(rawUsageState);
    return normalizeUsageState(parsed);
}


function clearLegacyAuthStorage() {
    const storage = getLocalStorage();
    if (storage === null) {
        return;
    }
    storage.removeItem(LEGACY_AUTH_TOKEN_KEY);
    storage.removeItem(LEGACY_AUTH_OWNER_KEY);
}


function clearLegacyClientPreferences() {
    const storage = getLocalStorage();
    if (storage === null) {
        return;
    }
    for (const key of [
        ...LEGACY_CLIENT_PREFERENCE_KEYS,
        ...LEGACY_OBSOLETE_CLIENT_PREFERENCE_KEYS,
    ]) {
        storage.removeItem(`${LEGACY_PREFERENCE_PREFIX}${key}`);
    }
}


function clearLegacyCommandPaletteUsage() {
    const storage = getLocalStorage();
    if (storage === null) {
        return;
    }
    storage.removeItem(LEGACY_COMMAND_PALETTE_USAGE_KEY);
}


function normalizeClientStatePayload(clientState) {
    if (!isObjectRecord(clientState)) {
        throw new Error('Client state payload must be an object');
    }

    if (!Object.prototype.hasOwnProperty.call(clientState, 'preferences')) {
        throw new Error('Client state payload missing preferences');
    }
    if (!Object.prototype.hasOwnProperty.call(clientState, 'command_palette_usage')) {
        throw new Error('Client state payload missing command_palette_usage');
    }

    return {
        preferences: normalizePreferences(clientState.preferences),
        command_palette_usage: normalizeUsageState(clientState.command_palette_usage),
    };
}


function mergePreferences(serverPreferences, legacyPreferences) {
    return {
        ...legacyPreferences,
        ...serverPreferences,
    };
}


function mergeUsageState(serverUsageState, legacyUsageState) {
    const merged = {};

    for (const [endpointId, record] of Object.entries(legacyUsageState)) {
        merged[endpointId] = { ...record };
    }

    for (const [endpointId, serverRecord] of Object.entries(serverUsageState)) {
        if (!Object.prototype.hasOwnProperty.call(merged, endpointId)) {
            merged[endpointId] = { ...serverRecord };
            continue;
        }

        const legacyRecord = merged[endpointId];
        const useServerTokens = serverRecord.lastUsedAt >= legacyRecord.lastUsedAt;
        merged[endpointId] = {
            count: Math.max(serverRecord.count, legacyRecord.count),
            lastUsedAt: Math.max(serverRecord.lastUsedAt, legacyRecord.lastUsedAt),
            lastQueryTokens: useServerTokens
                ? [...serverRecord.lastQueryTokens]
                : [...legacyRecord.lastQueryTokens],
        };
    }

    return merged;
}


export async function migrateLegacyClientState({
    clientState,
    persistClientPreferencesFn,
    persistCommandPaletteUsageFn,
}) {
    if (typeof persistClientPreferencesFn !== 'function') {
        throw new Error('migrateLegacyClientState requires persistClientPreferencesFn');
    }
    if (typeof persistCommandPaletteUsageFn !== 'function') {
        throw new Error('migrateLegacyClientState requires persistCommandPaletteUsageFn');
    }

    const normalizedClientState = normalizeClientStatePayload(clientState);
    const legacyPreferences = readLegacyClientPreferences();
    const legacyUsageState = readLegacyCommandPaletteUsage();

    const mergedPreferences = mergePreferences(
        normalizedClientState.preferences,
        legacyPreferences,
    );
    const mergedUsageState = mergeUsageState(
        normalizedClientState.command_palette_usage,
        legacyUsageState,
    );

    if (Object.keys(legacyPreferences).length > 0) {
        await persistClientPreferencesFn(mergedPreferences);
    }
    clearLegacyClientPreferences();

    if (Object.keys(legacyUsageState).length > 0) {
        await persistCommandPaletteUsageFn(mergedUsageState);
        clearLegacyCommandPaletteUsage();
    }

    return {
        preferences: mergedPreferences,
        command_palette_usage: mergedUsageState,
    };
}


export function resolveStoredThemePreference(clientPreferences) {
    let rawTheme = null;
    if (isObjectRecord(clientPreferences) && typeof clientPreferences['pref.theme'] === 'string') {
        rawTheme = clientPreferences['pref.theme'];
    } else {
        const legacyPreferences = readLegacyClientPreferences();
        if (typeof legacyPreferences['pref.theme'] === 'string') {
            rawTheme = legacyPreferences['pref.theme'];
        }
    }

    if (rawTheme === 'dark' || rawTheme === 'light') {
        return rawTheme;
    }
    return null;
}


export {
    clearLegacyAuthStorage,
    clearLegacyClientPreferences,
    clearLegacyCommandPaletteUsage,
    readLegacyClientPreferences,
    readLegacyCommandPaletteUsage,
};
