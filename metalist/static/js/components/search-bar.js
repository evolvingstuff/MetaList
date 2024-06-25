'use strict';


import { state } from "../app-state";
import { escapeTextForHtml } from '../misc/parsing';
import {
    devDebugSearchString,
    hideImpliesTagByDefault
} from '../config';
import {
    EVT_SEARCH_FOCUS,
    EVT_SEARCH_UPDATED,
    EVT_SELECT_ITEMSUBITEM,
    EVT_ESCAPE
} from '../pub-sub-events';


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
        if (hideImpliesTagByDefault) {
            if (!filter.negated_tags.includes('@implies') &&
                !filter.tags.includes('@implies') &&
                filter.partial_tag !== '@implies') {
                filter.negated_tags.push('@implies');
            }
        }
        state.searchText = value;
        state.searchFilter = filter;
        localStorage.setItem('search', value);
        PubSub.publishSync(EVT_SEARCH_UPDATED, {});
    }

    actionBlur() {
        this.querySelector('input').blur();
    }


    render(searchString) {
        let html = '';
        if (searchString !== null) {
            let escapedSearchString = escapeTextForHtml(searchString);
            html += `<input id="search-input" class="search-bar" type="text" placeholder="search..." value="${escapedSearchString}" spellcheck="false" autocomplete="off"/>`;
        }
        else {
            html += `<input id="search-input" class="search-bar" type="text" placeholder="search..." spellcheck="false" autocomplete="off"/>`;
        }

        this.innerHTML = html;

        //position suggestions
        //TODO: move into suggestions web component
        //TODO: recalculate on window resize
        var searchInput = document.getElementById('search-input');
        var suggestions = document.getElementById('suggestions');
        let gap = 3;
        if (searchInput && suggestions) {
            let rect = searchInput.getBoundingClientRect();
            suggestions.style.top = (rect.bottom + window.scrollY + gap) + 'px';
            suggestions.style.left = rect.left + 'px';
            suggestions.style.width = rect.width + 'px';
        }

        if (searchString !== null) {
            this.actionUpdateSearch();
        }
    }

    attachEventHandlers() {

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

        this.querySelector('input').addEventListener('focus', () => {

            //1. if search is empty, it already shows suggestions, do nothing
            //2. If search is not empty, we assume the user wants to add a new tag, and
            //   in order for more suggestions to show up, there needs to be a space at the end

            let searchString = this.querySelector('input').value;
            if (searchString.trim().length > 0) {
                this.querySelector('input').value += ' ';
                this.actionUpdateSearch();
            }
            PubSub.publishSync(EVT_SEARCH_FOCUS, {});
        });

        PubSub.subscribe(EVT_ESCAPE, (msg, data) => {
            this.actionBlur();
        });
    }

    connectedCallback() {
        this.myId = this.getAttribute('id');
        let searchString = localStorage.getItem('search');
        if (!searchString) {
            searchString = devDebugSearchString;
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

        const firstChar = `[a-zA-Z0-9_@#%&+=.]`;
        const subsequentChars = `[a-zA-Z0-9_@#%&+=.-]*`;
        const tag = new RegExp(`^\\s*(${firstChar}${subsequentChars})\\s+`);
        const neg_tag = new RegExp(`^\\s*-(${firstChar}${subsequentChars})\\s+`);
        const partial_tag = new RegExp(`^\\s*(${firstChar}${subsequentChars})$`);
        const partial_neg_tag = new RegExp(`^\\s*-(${firstChar}${subsequentChars})$`);
        // const tag = /^\s*([^\s,-;`\\"][^\s,;`\\"]*)\s+/;
        // const neg_tag = /^\s*-([^\s,-;`\\"][^\s,;`\\"]*)\s+/;
        // const partial_tag = /^\s*([^\s,-;`\\"][^\s,;`\\"]*)$/;
        // const partial_neg_tag = /^\s*-([^\s,-;`\\"][^\s,;`\\"]*)$/;
        const text = /^\s*"([^"\\]+)"\s*/;
        const neg_text = /^\s*-"([^"\\]+)"\s*/;
        const partial_text = /^\s*"([^"\\]*)$/;
        const partial_neg_text = /^\s*-"([^"\\]*)$/;

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