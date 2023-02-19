'use strict';

const numberedListChar = '.';  //TODO: make this configurable
const scrollToTopOnNewResults = true;

class ItemsList extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
        this.selectedItemSubitemIds = new Set();
    }

    renderItems(items, totalResults) {
        console.log(`rendering ${items.length} items`);
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
        if (scrollToTopOnNewResults) {
            window.scrollTo(0, 0);
        }
    }

    addEventsToItems(elItems) {
        elItems.querySelectorAll('.tag-todo').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( 'items-list.toggle-todo', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.tag-done').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( 'items-list.toggle-todo', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.expand').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( 'items-list.toggle-outline', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.collapse').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( 'items-list.toggle-outline', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.subitem').forEach(el => el.addEventListener('click', (e) => {
            if (el.classList.contains("subitem-redacted")) {
                alert('Cannot select a redacted subitem.');  //TODO set redact display mode in the future
                return;
            }
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            this.removeHighlightFromSelectedSubitems();
            if (e.ctrlKey) {
                if (this.selectedItemSubitemIds.has(itemSubitemId)) {
                    this.selectedItemSubitemIds.delete(itemSubitemId);
                }
                else {
                    this.selectedItemSubitemIds.add(itemSubitemId);
                }
            }
            else {
                if (this.selectedItemSubitemIds.size == 1 && this.selectedItemSubitemIds.has(itemSubitemId)) {
                    this.selectedItemSubitemIds.clear();
                    //this.selectedItemSubitemIds.add(itemSubitemId);
                }
                else {
                    this.selectedItemSubitemIds.clear();
                    this.selectedItemSubitemIds.add(itemSubitemId);
                }

            }
            this.addHighlightToSelectedSubitems();

            if (this.selectedItemSubitemIds.size > 0) {
                console.log('current selections:');
                console.log(this.selectedItemSubitemIds);
            }
            else {
                console.log('no selections');
            }

            // PubSub.publish( 'items-list.item-subitem-clicked', {
            //     itemSubitemId: itemSubitemId
            // });
        }));
    }

    removeHighlightFromSelectedSubitems() {
        if (this.selectedItemSubitemIds.size > 0) {
            for (let id of this.selectedItemSubitemIds) {
                let el = document.querySelector(`.subitem[data-id="${id}"]`);
                if (el !== null) {
                    el.classList.remove('subitem-selected');
                }
            }
        }
    }

    addHighlightToSelectedSubitems() {
        if (this.selectedItemSubitemIds.size > 0) {
            for (let id of this.selectedItemSubitemIds) {
                let el = document.querySelector(`.subitem[data-id="${id}"]`);
                if (el !== null) {
                    el.classList.add('subitem-selected');
                }
            }
        }
    }

    filterSelectedSubitems(item) {
        //console.log(`filtering ${item.subitems.length} subitems`);
        let subitemIndex = 0;
        let collapseMode = false;
        let collapseIndent = 0;
        for (let subitem of item['subitems']) {
            let id = `${item.id}:${subitemIndex}`;
            let isNotCollapsed = false;
            if (collapseMode) {
                if (subitem['indent'] <= collapseIndent) {
                    collapseMode = false;
                    collapseIndent = 0;
                    isNotCollapsed = true;
                    if (subitem['collapse'] !== undefined) {
                        collapseMode = true;
                        collapseIndent = subitem['indent'];
                    }
                }
            }
            else {
                isNotCollapsed = true;
                if (subitem['collapse'] !== undefined) {
                    collapseMode = true;
                    collapseIndent = subitem['indent'];
                }
            }
            let doRemove = false;
            //TODO: this could be more compact
            if (subitem['_match'] === undefined) {
                if (this.selectedItemSubitemIds.has(id)) {
                    console.log(`removing ${id} from selected because no _match`);
                    doRemove = true;
                }
            }
            else if (!isNotCollapsed) {
                if (this.selectedItemSubitemIds.has(id)) {
                    console.log(`removing ${id} from selected because collapsed`);
                    doRemove = true;
                }
            }
            if (doRemove) {
                this.selectedItemSubitemIds.delete(id);
            }
            subitemIndex++;
        }
        if (this.selectedItemSubitemIds.size > 0) {
            console.log('current selections:');
            console.log(this.selectedItemSubitemIds);
        }
        else {
            console.log('no selections');
        }
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
            let at_least_one_match = false;
            for (let subitem of data.updated_item.subitems) {
                if (subitem['_match'] !== undefined) {
                    at_least_one_match = true;
                    break;
                }
            }
            if (at_least_one_match) {
                this.replaceItemInDom(data.updated_item);
            }
            else {
                this.removeItemFromDom(data.updated_item);
                //TODO: so we need to update our selections as well?
                //TODO: what if selections are redacted?
            }
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
        this.removeHighlightFromSelectedSubitems();
        this.filterSelectedSubitems(item);
        this.addHighlightToSelectedSubitems();
        //TODO: if the item has no matched subitems, remove the item from the DOM completely
    }

    removeItemFromDom(item) {
        //clean up selections
        let subitemIndex = 0;
        let atLeastOneRemoved = false;
        for (let subitem of item['subitems']) {
            let id = `${item.id}:${subitemIndex}`;
            if (this.selectedItemSubitemIds.has(id)) {
                console.log(`removing ${id} from selected because entire item has been removed`);
                this.selectedItemSubitemIds.delete(id);
                atLeastOneRemoved = true;
            }
            subitemIndex++;
        }
        if (!atLeastOneRemoved) {
            console.log(
                'no selections removed even though entire item removed from DOM');
        }
        if (this.selectedItemSubitemIds.size > 0) {
            console.log('current selections:');
            console.log(this.selectedItemSubitemIds);
        }
        else {
            console.log('no selections');
        }

        let currentNode = document.querySelector(`[id="${item.id}"]`);
        currentNode.remove();
    }

}

customElements.define('items-list', ItemsList);