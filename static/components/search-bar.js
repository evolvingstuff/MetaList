"use strict";

function parseSearch(search) {

    //console.log(`parsing search: "${search}"`);

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

class SearchBar extends HTMLElement {

  constructor() {
    super();

    this.INTERVAL = 100;
    this.lastValueChecked = null;
    this.currentValue = '';
    this.currentParse = null;
    this.my_id = null;
  }

    checkForUpdatedSearch() {
        //console.log(`checking for updated search: "${this.currentValue}" vs "${this.lastValueChecked}"`);
        if (this.lastValueChecked === this.currentValue) {
            return;
        }
        this.lastValueChecked = this.currentValue;
        if (this.currentParse !== null) {
            console.log('publishing search.updated');
            console.log(this.currentParse);
            PubSub.publish('search.updated', this.currentParse);
        }
        else {
            PubSub.publish('search.invalid', this.currentValue);
        }
  }

  render() {
    this.innerHTML = `
      <style>
        
      </style>

      <input id="${this.my_id}" type="text" placeholder="search" spellcheck="false" size="64"/>
    `;
      this.querySelector('input').addEventListener('input', () => {
        this.currentValue = this.querySelector('input').value;
        this.currentParse = parseSearch(this.currentValue);
        if (this.currentParse === null) {
            this.querySelector('input').style.backgroundColor = 'red';
        }
        else {
            this.querySelector('input').style.backgroundColor = 'white';
        }
      });
  }

  connectedCallback() {
    this.my_id = this.getAttribute('id');
    this.currentParse = parseSearch(this.currentValue);
    this.intervalID = setInterval(this.checkForUpdatedSearch.bind(this), this.INTERVAL);
    this.render();
  }

}

customElements.define('search-bar', SearchBar);