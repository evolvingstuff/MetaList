"use strict";

function parseSearch(search) {
    let parsedSearch = {
        tags: [],
        negated_tags: [],
        texts: [],
        negated_texts: [],
        partial_tag: null,
        negated_partial_tag: null,
        partial_text: null,
        negated_partial_text: null
    }

    if (search.trim() === '') {
        return parsedSearch;
    }
    return null;
}