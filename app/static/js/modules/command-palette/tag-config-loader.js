import { HttpRequestError } from '../expected-errors.js';

// At most this many near-miss tags are suggested for one token.
const MAX_NEAR_MISS_TAGS = 8;
export function validateCommandPaletteTagMappings(endpoints, tagMap) {
    if (!(tagMap instanceof Map)) {
        throw new Error('Command palette tag map not loaded');
    }
    if (!Array.isArray(endpoints)) {
        throw new Error('Command palette endpoint registry must be an array');
    }

    const endpointsById = new Map();
    for (const endpoint of endpoints) {
        if (!endpoint || typeof endpoint !== 'object') {
            throw new Error('Command palette endpoint registry contains invalid endpoint');
        }
        if (typeof endpoint.id !== 'string' || endpoint.id.length === 0) {
            throw new Error('Command palette endpoints must have id');
        }
        if (endpointsById.has(endpoint.id)) {
            throw new Error(`Duplicate command palette endpoint id: ${endpoint.id}`);
        }
        endpointsById.set(endpoint.id, endpoint);
    }

    for (const id of tagMap.keys()) {
        if (!endpointsById.has(id)) {
            throw new Error(`Tag config references unknown endpoint id: ${id}`);
        }
    }

    for (const endpoint of endpoints) {
        if (!tagMap.has(endpoint.id)) {
            throw new Error(`Endpoint ${endpoint.id} has no tag mapping in config`);
        }
    }
}

export async function loadCommandPaletteTagMap() {
    const response = await fetch('/static/config/command_palette_tags.json', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        cache: 'no-store',
    });

    if (!response.ok) {
        throw new HttpRequestError(`Failed to load command palette tag config: ${response.status}`);
    }

    const data = await response.json();
    if (!data || typeof data !== 'object') {
        throw new Error('Command palette tag config must be an object');
    }

    const endpoints = data.endpoints;
    if (!Array.isArray(endpoints)) {
        throw new Error('Command palette tag config must include endpoints array');
    }

    const tagMap = new Map();
    for (const endpoint of endpoints) {
        if (!endpoint || typeof endpoint !== 'object') {
            throw new Error('Command palette tag config contains invalid endpoint entry');
        }

        const id = endpoint.id;
        if (typeof id !== 'string' || id.length === 0) {
            throw new Error('Command palette tag config endpoint.id must be a non-empty string');
        }
        if (tagMap.has(id)) {
            throw new Error(`Command palette tag config has duplicate id: ${id}`);
        }

        const tags = endpoint.tags;
        if (!Array.isArray(tags) || tags.length === 0) {
            throw new Error(`Command palette tag config endpoint ${id} must have non-empty tags array`);
        }

        const normalizedTags = [];
        for (const tag of tags) {
            if (typeof tag !== 'string' || tag.length === 0) {
                throw new Error(`Command palette tag config endpoint ${id} has invalid tag`);
            }
            normalizedTags.push(tag.toLowerCase());
        }

        tagMap.set(id, new Set(normalizedTags));
    }

    return tagMap;
}

// Every distinct tag from the loaded command palette tag map.
export function collectCommandPaletteTags(tagMap) {
    if (!(tagMap instanceof Map)) {
        throw new Error('collectCommandPaletteTags requires the loaded tag map');
    }
    // Each map value is a Set; Array.prototype.flat() would keep the Sets themselves.
    const allTags = new Set();
    for (const [id, tags] of tagMap) {
        if (!(tags instanceof Set)) {
            throw new Error(`Command palette tags for ${id} must be a Set`);
        }
        for (const tag of tags) {
            allTags.add(tag);
        }
    }
    return allTags;
}

// Suggestions shown under "No matches": prefix matches first, then tags one edit away.
export function findNearMissTags(allTags, token) {
    if (!(allTags instanceof Set)) {
        throw new Error('findNearMissTags requires a Set of tags');
    }
    if (token === null || typeof token === 'undefined') {
        return [];
    }
    if (typeof token !== 'string' || token.length === 0) {
        return [];
    }

    const maxResults = MAX_NEAR_MISS_TAGS;
    const lower = token.toLowerCase();
    const prefixMatches = [];
    for (const tag of allTags) {
        if (tag.startsWith(lower)) {
            prefixMatches.push(tag);
        }
    }
    prefixMatches.sort();
    if (prefixMatches.length > 0) {
        return prefixMatches.slice(0, maxResults);
    }

    const editMatches = [];
    for (const tag of allTags) {
        if (isEditDistanceAtMostOne(lower, tag)) {
            editMatches.push(tag);
        }
    }
    editMatches.sort();
    return editMatches.slice(0, maxResults);
}

function isEditDistanceAtMostOne(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        throw new Error('isEditDistanceAtMostOne requires strings');
    }
    if (a === b) {
        return true;
    }
    const lenDiff = Math.abs(a.length - b.length);
    if (lenDiff > 1) {
        return false;
    }

    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;

    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < shorter.length && j < longer.length) {
        if (shorter[i] === longer[j]) {
            i += 1;
            j += 1;
            continue;
        }
        edits += 1;
        if (edits > 1) {
            return false;
        }
        if (shorter.length === longer.length) {
            i += 1;
            j += 1;
        } else {
            j += 1;
        }
    }
    if (i < shorter.length || j < longer.length) {
        edits += 1;
    }
    return edits <= 1;
}
