'use strict';


class TotalResults extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }


    render(totalResults) {
        let msg = 'search results';
        if (totalResults === 1) {
            msg = 'search result';
        }
        let content = `<div class="total-results">${totalResults} ${msg}</div>`;
        this.innerHTML = content;
    }


    connectedCallback() {
        this.myId = this.getAttribute('id');
        PubSub.subscribe(EVT_SEARCH_RETURN, (msg, searchResults) => {
            this.render(searchResults['total_results']);
        });
        this.render(0);
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

}

customElements.define('total-results', TotalResults);