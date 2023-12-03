'use strict';

import {
    state
} from "../app-state.js";

import {
    EVT_SEARCH_UPDATED,
    EVT_SELECT_ITEMSUBITEM
} from "../pub-sub-events.js";

import {
    hideImpliesTagByDefault
} from '../config.js';

class SearchBar extends HTMLElement {

    constructor() {
        super();
        this.myId = null;

        //TODO: 2023.09.21 move this somewhere else
        document.body.addEventListener('mousedown', (evt) => {
            this.querySelector('input').blur();
        });
    }

    actionUpdateSearch() {
        const value = this.querySelector('input').value;
        const filter = this.parseSearch(value);
        console.log(`DEBUG SEARCH: |${value}|`);
        if (hideImpliesTagByDefault) {
            if (!filter.negated_tags.includes('@implies') &&
                !filter.tags.includes('@implies') &&
                filter.partial_tag !== '@implies') {
                filter.negated_tags.push('@implies');
            }
        }
        state.searchFilter = filter;
        if (state.searchFilter === null) {
            this.querySelector('input').style.backgroundColor = 'red';
            return;
        }
        this.querySelector('input').style.backgroundColor = 'white';
        localStorage.setItem('search', value);
        PubSub.publishSync(EVT_SEARCH_UPDATED, {});
    }

    actionBlur() {
        this.querySelector('input').blur();
    }

    render(searchString) {
        let html = '';
        if (searchString !== null) {
            html += `<input id="search-input" class="search-bar" type="text" placeholder="search..." value="${searchString}" spellcheck="false" autocomplete="off"/>`;
        }
        else {
            html += `<input id="search-input" class="search-bar" type="text" placeholder="search..." spellcheck="false" autocomplete="off"/>`;
        }

        this.innerHTML = html;

        if (searchString !== null) {
            this.actionUpdateSearch();
        }
    }

    attachEventHandlers() {

        const searchInput = document.getElementById('search-input');
        const suggestionsDiv = document.getElementById('suggestions');

        searchInput.addEventListener('focus', function() {
            suggestionsDiv.style.display = 'block';
        });

        searchInput.addEventListener('blur', function() {
            suggestionsDiv.style.display = 'none';
        });

        this.querySelector('input').addEventListener('input', () => {
            this.actionUpdateSearch();
        });

        this.querySelector('input').addEventListener('mousedown', evt => {
            //override default behavior of body
            evt.stopPropagation();
        });

        PubSub.subscribe(EVT_SELECT_ITEMSUBITEM, (msg, data) => {
            this.actionBlur();
        });

        // this.querySelector('input').addEventListener('focus', () => {
        //     PubSub.publishSync(EVT_SEARCH_FOCUS, {});
        // });
    }

    connectedCallback() {
        this.myId = this.getAttribute('id');
        let searchString = localStorage.getItem('search');
        if (!searchString) {
            searchString = '';
        }
        this.render(searchString);
        this.attachEventHandlers();
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

    parseSearch(search) {

        let parsedSearch = {
            tags: [],
            negated_tags: [],
            texts: [],
            negated_texts: [],
            partial_tag: null,
            negated_partial_tag: null,
            partial_text: null,
            negated_partial_text: null
        };

        if (search.trim() === '') {
            return parsedSearch;
        }

        const tag = /^\s*([^\s,-;`\\"][^\s,;`\\"]*)\s+/;
        const neg_tag = /^\s*-([^\s,-;`\\"][^\s,;`\\"]*)\s+/;
        const partial_tag = /^\s*([^\s,-;`\\"][^\s,;`\\"]*)$/;
        const partial_neg_tag = /^\s*-([^\s,-;`\\"][^\s,;`\\"]*)$/;
        const text = /^\s*"([^"\\]+)"\s*/;
        const neg_text = /^\s*-"([^"\\]+)"\s*/;
        const partial_text = /^\s*"([^"\\]+)$/;
        const partial_neg_text = /^\s*-"([^"\\]+)$/;
        const ignore_end = /^\s*-?"?$/;

        let temp = search;
        while (temp.trim() !== '') {
            let match = temp.match(tag);
            if (match) {
                parsedSearch.tags.push(match[1]);
                temp = temp.substring(match[0].length);
                continue;
            }
            match = temp.match(neg_tag);
            if (match) {
                parsedSearch.negated_tags.push(match[1]);
                temp = temp.substring(match[0].length);
                continue;
            }
            match = temp.match(partial_tag);
            if (match) {
                parsedSearch.partial_tag = match[1];
                temp = temp.substring(match[0].length);
                continue;
            }
            match = temp.match(partial_neg_tag);
            if (match) {
                parsedSearch.negated_partial_tag = match[1];
                temp = temp.substring(match[0].length);
                continue;
            }
            match = temp.match(text);
            if (match) {
                parsedSearch.texts.push(match[1]);
                temp = temp.substring(match[0].length);
                continue;
            }
            match = temp.match(neg_text);
            if (match) {
                parsedSearch.negated_texts.push(match[1]);
                temp = temp.substring(match[0].length);
                continue;
            }
            match = temp.match(partial_text);
            if (match) {
                parsedSearch.partial_text = match[1];
                temp = temp.substring(match[0].length);
                continue;
            }
            match = temp.match(partial_neg_text);
            if (match) {
                parsedSearch.negated_partial_text = match[1];
                temp = temp.substring(match[0].length);
                continue;
            }
            match = temp.match(ignore_end);
            if (match) {
                temp = temp.substring(match[0].length);
                continue;
            }
            console.warn(`could not parse search: "${temp}"`);
            return null;
        }
        return parsedSearch;
    }
}

customElements.define('search-bar', SearchBar);