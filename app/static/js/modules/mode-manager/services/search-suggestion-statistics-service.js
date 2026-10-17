const ISO_DATE_TEXT_LENGTH = 'YYYY-MM-DD'.length;


function requirePositiveInteger(value, label) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return value;
}


function validateDateText(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error('Search suggestion statistics date must use YYYY-MM-DD');
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, ISO_DATE_TEXT_LENGTH) !== value) {
        throw new Error('Search suggestion statistics date is invalid');
    }
    return value;
}


export function validateSearchSuggestionStatistics(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Search suggestion statistics response must be an object');
    }
    const retentionPopulatedDayLimit = requirePositiveInteger(
        payload.retentionPopulatedDayLimit,
        'retentionPopulatedDayLimit',
    );
    if (!Array.isArray(payload.days)) {
        throw new Error('Search suggestion statistics days must be an array');
    }

    let previousDate = '';
    const days = payload.days.map((day) => {
        if (!day || typeof day !== 'object' || Array.isArray(day)) {
            throw new Error('Search suggestion statistics day must be an object');
        }
        const date = validateDateText(day.date);
        if (previousDate !== '' && date >= previousDate) {
            throw new Error('Search suggestion statistics days must be newest first');
        }
        previousDate = date;
        const totalTagCredits = requirePositiveInteger(
            day.totalTagCredits,
            'totalTagCredits',
        );
        if (!Array.isArray(day.tags) || day.tags.length === 0) {
            throw new Error('Search suggestion statistics day requires tags');
        }
        const seenTags = new Set();
        let calculatedTotal = 0;
        const tags = day.tags.map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new Error('Search suggestion statistics tag must be an object');
            }
            if (typeof entry.tag !== 'string' || entry.tag.length === 0) {
                throw new Error('Search suggestion statistics tag name must be non-empty');
            }
            const tagCasefold = entry.tag.toLowerCase();
            if (seenTags.has(tagCasefold)) {
                throw new Error('Search suggestion statistics tags must be unique');
            }
            seenTags.add(tagCasefold);
            const count = requirePositiveInteger(entry.count, 'tag count');
            calculatedTotal += count;
            return { tag: entry.tag, count };
        });
        if (calculatedTotal !== totalTagCredits) {
            throw new Error('Search suggestion statistics totalTagCredits does not match tags');
        }
        return { date, totalTagCredits, tags };
    });

    if (days.length > retentionPopulatedDayLimit) {
        throw new Error('Search suggestion statistics exceeds populated-day retention limit');
    }
    return { retentionPopulatedDayLimit, days };
}
