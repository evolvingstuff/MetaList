'use strict';

export const EVT_SEARCH_FOCUS = 'search.focus';
export const EVT_SEARCH__RESULTS = 'search.results';
export const EVT_SEARCH_UPDATED = 'search.updated';

class SearchBar extends HTMLElement {

    constructor() {
        super();
        this.INTERVAL = 50;
        this.lastValueChecked = null;
        this.currentValue = '';
        this.currentParse = null;
        this.myId = null;

        //TODO: 2023.09.21 move this somewhere else
        document.body.addEventListener('mousedown', (evt) => {
            this.querySelector('input').blur();
        });
    }

    checkForUpdatedSearch() {
        if (this.lastValueChecked === this.currentValue) {
            return;
        }
        localStorage.setItem('search', this.currentValue);
        console.log('setting localStorage.search to "' + this.currentValue + '"');
        this.lastValueChecked = this.currentValue;
        this.currentParse = this.parseSearch(this.currentValue);  //rerun
        if (this.currentParse !== null) {
            console.log('search-bar: search.update');
            PubSub.publish(EVT_SEARCH_UPDATED, this.currentParse);
        }
    }

    onTyping() {
        this.currentValue = this.querySelector('input').value;
        this.currentParse = this.parseSearch(this.currentValue);
        if (this.currentParse === null) {
            this.querySelector('input').style.backgroundColor = 'red';
        } else {
            this.querySelector('input').style.backgroundColor = 'white';
        }
    }

    render(defaultValue) {
        if (defaultValue === null) {
            this.innerHTML = `<input class="search-bar" type="text" placeholder="SEARCH..." spellcheck="false" size="64"/>`;
        }
        else {
            this.innerHTML = `<input class="search-bar" type="text" placeholder="SEARCH..." value="${defaultValue}" spellcheck="false" size="64"/>`;
            this.onTyping();
        }
    }

    attachEventHandlers() {
        this.intervalID = setInterval(this.checkForUpdatedSearch.bind(this), this.INTERVAL);

        this.querySelector('input').addEventListener('input', () => {
            this.onTyping();
        });

        this.querySelector('input').addEventListener('mousedown', evt => {
            //override default behavior of body
            evt.stopPropagation();
        });

        this.querySelector('input').addEventListener('focus', () => {
            PubSub.publish(EVT_SEARCH_FOCUS, {});
        });
    }

    connectedCallback() {
        this.myId = this.getAttribute('id');
        this.currentParse = this.parseSearch(this.currentValue);
        let searchString = localStorage.getItem('search');
        this.render(searchString);
        this.attachEventHandlers();
    }

    disconnectedCallback() {
        clearInterval(this.intervalID);
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