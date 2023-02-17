'use strict';

const numberedListChar = '.';  //TODO: make this configurable

class ItemsList extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }


    renderItems(items, totalResults) {
        let t1 = Date.now();
        let content = '<div class="items-list">';
        for (let item of items) {
            content += itemFormatter(item);
        }
        if (state.modeShowMoreResults === false && items.length < totalResults) {
            let more = totalResults - items.length;
            content += `<div><button type="button" id="show-more-results">Show ${more} more results</button></div>`;
        }
        content += '</div>';
        this.innerHTML = content;
        let t2 = Date.now();
        console.log(`rendered ${items.length} items in ${(t2 - t1)}ms`);

        t1 = Date.now();

        this.addEventsToItems(this);

        if (state.modeShowMoreResults === false) {
            let el = this.querySelector('#show-more-results')
            if (el) {
                el.addEventListener('click', (e) => {
                    state.modeShowMoreResults = true;
                    el.disabled = true;
                    el.innerHTML = 'Loading...'; //TODO this should be a spinner
                    PubSub.publish('items-list.show-more-results', state.mostRecentQuery);
                });
            }
        }
        t2 = Date.now();
        console.log(`added events for ${items.length} items in ${(t2 - t1)}ms`);
    }

    addEventsToItems(elItems) {
        elItems.querySelectorAll('.tag-todo').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            console.log(`todo for ${itemSubitemId}`);
            PubSub.publish( 'items-list.toggle-todo', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.tag-done').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            console.log(`done clicked for ${itemSubitemId}`);
            PubSub.publish( 'items-list.toggle-todo', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.expand').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            console.log(`expand clicked for ${itemSubitemId}`);
            PubSub.publish( 'items-list.toggle-outline', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.collapse').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            console.log(`collapse clicked for ${itemSubitemId}`);
            PubSub.publish( 'items-list.toggle-outline', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.subitem').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            alert(`content clicked for ${itemSubitemId}`);
        }));
    }

    connectedCallback() {
        this.myId = this.getAttribute('id');

        PubSub.subscribe('search.results', (msg, searchResults) => {
            let totalResults = searchResults['total_results']
            let items = searchResults.items;
            this.renderItems(items, totalResults);
        });

        PubSub.subscribe('toggle-outline.result', (msg, data) => {
            this.replaceItemInDom(data.updated_item);
        });

        //TODO: get rid of repetition here
        PubSub.subscribe('toggle-todo.result', (msg, data) => {
            this.replaceItemInDom(data.updated_item);
        });

        this.renderItems([], 0);
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

    replaceItemInDom(item) {
        let currentNode = document.querySelector(`[id="${item.id}"]`);
        let newNode = document.createElement('div');
        newNode.innerHTML = itemFormatter(item);
        currentNode.replaceWith(newNode);
        this.addEventsToItems(newNode);
        //TODO: if the item has no matched subitems, remove the item from the DOM completely
    }

}

customElements.define('items-list', ItemsList);