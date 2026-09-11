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
        throw new Error(`Failed to load command palette tag config: ${response.status}`);
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
