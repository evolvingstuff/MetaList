const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildBacklinksQuery(payload, sourceNoteId) {
    if (!payload || payload.targetNoteId !== sourceNoteId || !Array.isArray(payload.backlinks)) {
        throw new Error('Backlinks response does not match the requested source');
    }
    const noteIds = new Set();
    for (const backlink of payload.backlinks) {
        if (!backlink || typeof backlink.id !== 'string' || !NOTE_ID_PATTERN.test(backlink.id)) {
            throw new Error('Backlinks response contains an invalid note id');
        }
        noteIds.add(backlink.id);
    }
    return [...noteIds].join(' OR ');
}
