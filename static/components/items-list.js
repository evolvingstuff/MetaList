'use strict';

import {state, stateNoMode} from "../js/state.js"
import {itemFormatter} from './item-formatter.js';
import {
    EVT_SELECTED_SUBITEMS_CLEARED,
    EVT_SEARCH__RESULTS,
    EVT_ITEMS_LIST_SHOW_MORE__RESULTS,
    EVT_ENTER_MODE_TAGS,
    EVT_ENTER_MODE_MOVE,
    EVT_EXIT_MODE_FORMAT,
    EVT_EXIT_MODE_TAGS,
    EVT_ITEMS_LIST_EDIT_SUBITEM,
    EVT_TOGGLE_TODO__RESULT,
    EVT_TOGGLE_OUTLINE__RESULT,
    EVT_ENTER_MODE_FORMAT,
    EVT_ITEMS_LIST_TOGGLE_OUTLINE,
    EVT_ITEMS_LIST_TOGGLE_TODO,
    EVT_ENTER_MODE_EDIT,
    EVT_SEARCH_FOCUS,
    EVT_SEARCH_UPDATED,
    EVT_EXIT_ALL_MODES,
    EVT_EXIT_MODE_MOVE,
    EVT_EXIT_MODE_EDIT
} from '../js/events.js';

export const numberedListChar = '.';  //TODO: make this configurable
const scrollToTopOnNewResults = true;

let itemsCache = {};  //TODO: move this into the ItemsList class?

class ItemsList extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }

    renderItems(items, totalResults) {
        console.log(`rendering ${items.length} items`);
        this.updateItemCache(items);
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
        this.addEventHandlersToItems(this);
        //TODO: maybe move this into the AddEventHandlersToItems function?
        if (state.modeShowMoreResults === false) {
            let el = this.querySelector('#show-more-results')
            if (el) {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    state.modeShowMoreResults = true;
                    el.disabled = true;
                    el.innerHTML = 'Loading...'; //TODO this should be a spinner
                    PubSub.publish(EVT_ITEMS_LIST_SHOW_MORE__RESULTS, state.mostRecentQuery);
                });
            }
        }
        t2 = Date.now();
        console.log(`added events for ${items.length} items in ${(t2 - t1)}ms`);
        if (scrollToTopOnNewResults) {
            window.scrollTo(0, 0);
        }
    }

    addEventHandlersToItems(elItems) {

        elItems.querySelectorAll('a').forEach(el => el.addEventListener('click', (e) => {
            if (state.modeEdit) {
                console.log('mode edit is on, so not opening link');
                e.preventDefault();
            }
            else {
                console.log('mode edit is off, so opening link in new tab');
                let url = e.target.href;
                e.preventDefault();
                e.stopPropagation(); //do not trigger the click event on the parent element
                window.open(url, '_blank');
            }
        }));

        elItems.querySelectorAll('.tag-todo').forEach(el => el.addEventListener('click', (e) => {
            e.stopPropagation();
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( EVT_ITEMS_LIST_TOGGLE_TODO, {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.tag-done').forEach(el => el.addEventListener('click', (e) => {
            e.stopPropagation();
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( EVT_ITEMS_LIST_TOGGLE_TODO, {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.expand').forEach(el => el.addEventListener('click', (e) => {
            e.stopPropagation();
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( EVT_ITEMS_LIST_TOGGLE_OUTLINE, {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.collapse').forEach(el => el.addEventListener('click', (e) => {
            e.stopPropagation();
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( EVT_ITEMS_LIST_TOGGLE_OUTLINE, {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.subitem').forEach(el => el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (el.classList.contains("subitem-redacted")) {
                alert('Cannot select a redacted subitem.');  //TODO set redact display mode in the future
                return;
            }

            let itemSubitemId = e.currentTarget.getAttribute('data-id');

            if (state.modeEdit && state.selectedItemSubitemIds.size > 0 && state.selectedItemSubitemIds.has(itemSubitemId)) {
                // edit mode is on, not re-selecting subitem
                return;
            }

            //TODO additional logic here for other modes
            state._selectedItemSubitemIds = new Set(state.selectedItemSubitemIds);
            if (e.ctrlKey && state.modeEdit === false) {
                if (state.selectedItemSubitemIds.has(itemSubitemId)) {
                    state.selectedItemSubitemIds.delete(itemSubitemId);
                }
                else {
                    state.selectedItemSubitemIds.add(itemSubitemId);
                }
            }
            else {
                if (state.selectedItemSubitemIds.size == 1 &&
                    state.selectedItemSubitemIds.has(itemSubitemId) &&
                    state.modeEdit === false) {

                    state.selectedItemSubitemIds.clear();
                }
                else {
                    state.selectedItemSubitemIds.clear();
                    state.selectedItemSubitemIds.add(itemSubitemId);
                }
            }

            ////////////////////////////////////////////////
            //2023.03.05 experimental logic
            if (stateNoMode()) {
                state.modeEdit = true;  //important to set this BEFORE publishing the event
                PubSub.publish(EVT_ENTER_MODE_EDIT, {});
            }
            ////////////////////////////////////////////////


            if (state.modeEdit) {
                let toReplace = this.itemsToUpdateBasedOnSelectionChange();
                this.replaceItemsInDom(toReplace);
            }
            this.refreshSelectionHighlights();
        }));
    }

    onClickSubitemV1(e) {

    }

    itemsToUpdateBasedOnSelectionChange() {
        let unionSub = new Set([...state._selectedItemSubitemIds, ...state.selectedItemSubitemIds]);
        let unionItems = new Set();
        for (let itemSubitemId of unionSub) {
            let itemId = itemSubitemId.split(':')[0];
            let item = itemsCache[itemId];
            if (item) {
                unionItems.add(item);
            }
            else {
                console.log('item not found in cache: ' + itemId);
            }
        }
        return Array.from(unionItems);
    }

    onPasteSubitemContentEditable(e) {
        e.preventDefault();
        //let text = e.clipboardData.getData("text/plain");
        let html = e.clipboardData.getData("text/html");
        console.log('pasting html: ' + html);
        //TODO 2023.03.05: this is where my clean up parsing code should go
        document.execCommand("insertHTML", false, html);
    }

    onInputSubitemContentEditable(e) {
        let itemSubitemId = e.currentTarget.getAttribute('data-id');
        let newHtml = e.currentTarget.innerHTML;
        let newText = e.currentTarget.innerText;
        console.log(`${itemSubitemId}: ${newText}`);
        let itemId = itemSubitemId.split(':')[0];
        let subitemIndex = parseInt(itemSubitemId.split(':')[1]);
        itemsCache[itemId]['subitems'][subitemIndex].data = newHtml;
        PubSub.publish( EVT_ITEMS_LIST_EDIT_SUBITEM, {
            itemSubitemId: itemSubitemId,
            updatedContent: newHtml
        });
    }

    refreshSelectionHighlights() {

        //remove old highlights
        let els = Array.from(document.querySelectorAll('.subitem-selected'));
        els.forEach(el => el.classList.remove('subitem-selected'));
        els.forEach(el => el.removeAttribute('contenteditable'));

        els = Array.from(document.querySelectorAll('.subitem-action'));
        els.forEach(el => el.classList.remove('subitem-action'));
        els.forEach(el => el.removeAttribute('contenteditable'));

        //add new highlights
        if (state.selectedItemSubitemIds.size > 0) {
            for (let id of state.selectedItemSubitemIds) {
                let el = document.querySelector(`.subitem[data-id="${id}"]`);
                if (el !== null) {
                    if (state.modeEdit || state.modeMove || state.modeTags || state.modeFormat) {
                        el.classList.add('subitem-action');
                        if (state.modeEdit) {
                            el.setAttribute('contenteditable', 'true');
                            el.addEventListener('paste', this.onPasteSubitemContentEditable);
                            el.addEventListener('input', this.onInputSubitemContentEditable);
                        }
                    }
                    else {
                        el.classList.add('subitem-selected');
                    }
                }
            }
        }
    }

    updateItemCache(items) {
        //TODO 2021.03.05: this does not handle deleted items
        if (items.length == 0) {
            console.log('updateItemCache() - no items to update');
            return;
        }
        console.log('updateItemCache() ' + items.length + ' items');
        for (let item of items) {
            itemsCache[item.id] = item;
        }
    }

    filterSelectedSubitems(item) {
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
                if (state.selectedItemSubitemIds.has(id)) {
                    console.log(`removing ${id} from selected because no _match`);
                    doRemove = true;
                }
            }
            else if (!isNotCollapsed) {
                if (state.selectedItemSubitemIds.has(id)) {
                    console.log(`removing ${id} from selected because collapsed`);
                    doRemove = true;
                }
            }
            if (doRemove) {
                state.selectedItemSubitemIds.delete(id);
            }
            subitemIndex++;
        }
    }

    subscribeToPubSubEvents() {

        PubSub.subscribe(EVT_SELECTED_SUBITEMS_CLEARED, (msg, data) => {
            let toReplace = this.itemsToUpdateBasedOnSelectionChange();
            this.replaceItemsInDom(toReplace);
            this.refreshSelectionHighlights();
        });

        PubSub.subscribe(EVT_SEARCH__RESULTS, (msg, searchResults) => {
            let totalResults = searchResults['total_results']
            let items = searchResults.items;
            this.renderItems(items, totalResults);
        });

        PubSub.subscribe(EVT_ENTER_MODE_EDIT, (msg, data) => {
            let toReplace = this.itemsToUpdateBasedOnSelectionChange();
            this.replaceItemsInDom(toReplace);
            this.refreshSelectionHighlights();
        });

        PubSub.subscribe(EVT_EXIT_MODE_EDIT, (msg, data) => {
            //asdf
            let toReplace = this.itemsToUpdateBasedOnSelectionChange();
            this.replaceItemsInDom(toReplace);
            this.refreshSelectionHighlights();
        });

        PubSub.subscribe(EVT_ENTER_MODE_MOVE, (msg, data) => {
            this.refreshSelectionHighlights();
        });

        PubSub.subscribe(EVT_EXIT_MODE_MOVE, (msg, data) => {
            this.refreshSelectionHighlights();
        });

        PubSub.subscribe(EVT_ENTER_MODE_TAGS, (msg, data) => {
            this.refreshSelectionHighlights();
        });

        PubSub.subscribe(EVT_EXIT_MODE_TAGS, (msg, data) => {
            this.refreshSelectionHighlights();
        });

        PubSub.subscribe(EVT_ENTER_MODE_FORMAT, (msg, data) => {
            this.refreshSelectionHighlights();
        });

        PubSub.subscribe(EVT_EXIT_MODE_FORMAT, (msg, data) => {
            this.refreshSelectionHighlights();
        });

        PubSub.subscribe(EVT_TOGGLE_OUTLINE__RESULT, (msg, data) => {
            this.updateItemCache(data.updated_items);
            this.replaceItemsInDom(data.updated_items);
        });

        PubSub.subscribe(EVT_TOGGLE_TODO__RESULT, (msg, data) => {
            this.updateItemCache(data.updated_items);
            let at_least_one_match = false;
            for (let item of data.updated_items) {
                for (let subitem of item.subitems) {
                    if (subitem['_match'] !== undefined) {
                        at_least_one_match = true;
                        break;
                    }
                }
            }
            if (at_least_one_match) {
                this.replaceItemsInDom(data.updated_items);
            }
            else {
                this.removeItemsFromDom(data.updated_items);
                //TODO: so we need to update our selections as well?
                //TODO: what if selections are redacted?
            }
        });
    }


    connectedCallback() {
        this.myId = this.getAttribute('id');
        this.renderItems([], 0);
        this.subscribeToPubSubEvents();
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

    replaceItemsInDom(items) {
        //console.log('replaceItemsInDom()')
        for (let item of items) {
            let currentNode = document.querySelector(`[id="${item.id}"]`);
            let newNode = document.createElement('div');
            newNode.innerHTML = itemFormatter(item);
            currentNode.replaceWith(newNode);
            this.addEventHandlersToItems(newNode);
            this.filterSelectedSubitems(item);
            this.refreshSelectionHighlights();
            //TODO: if the item has no matched subitems, remove the item from the DOM completely
        }
    }

    removeItemsFromDom(items) {
        //TODO: move much of this logic into app.js
        for (let item of items) {
            //clean up selections
            let subitemIndex = 0;
            let atLeastOneRemoved = false;
            for (let subitem of item['subitems']) {
                let id = `${item.id}:${subitemIndex}`;
                if (state.selectedItemSubitemIds.has(id)) {
                    console.log(
                        `removing ${id} from selected because entire item has been removed`);
                    state.selectedItemSubitemIds.delete(id);
                    atLeastOneRemoved = true;
                }
                subitemIndex++;
            }

            let currentNode = document.querySelector(`[id="${item.id}"]`);
            currentNode.remove();
        }
    }

}

customElements.define('items-list', ItemsList);