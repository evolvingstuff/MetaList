'use strict';


class TotalResults extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }


    render(totalResults) {
        let content = `<div class="total-results">${totalResults} search results</div>`;
        this.innerHTML = content;
    }


    connectedCallback() {
        this.myId = this.getAttribute('id');
        console.log('cp1');
        PubSub.subscribe('search.results', (msg, searchResults) => {
            console.log('cp2');
            this.render(searchResults['total_results']);
        });
        this.render(0);
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

}

customElements.define('total-results', TotalResults);