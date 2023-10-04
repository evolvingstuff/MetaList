'use strict';

import {itemFormatter} from '../misc/item-formatter.js';

import {
    EVT_CTRL_C,
    EVT_CTRL_V,
    EVT_SPACE,
    EVT_TAB,
    EVT_SHIFT_TAB,
    EVT_ENTER,
    EVT_ESCAPE,
    EVT_DELETE,
    EVT_UP,
    EVT_DOWN,
    EVT_LEFT,
    EVT_RIGHT,
    EVT_T,
    EVT_STAR,
    EVT_NUM,
    EVT_CTRL_Z,
    EVT_CTRL_Y
} from "../app.js";

import {
    EVT_SEARCH_RETURN,
    EVT_SEARCH_FOCUS,
    EVT_SEARCH_UPDATED
} from './search-bar.js';

import {state as appState} from "../app.js"

export const EVT_ADD_ITEM_TOP = 'add-item-top';
export const EVT_ADD_ITEM_TOP_RETURN = 'add-item-top-return';
export const EVT_ADD_SUBITEM_NEXT = 'add-subitem-next';
export const EVT_ADD_SUBITEM_NEXT_RETURN = 'add-subitem-next-return';
export const EVT_EDIT_SUBITEM = 'items-list.edit-subitem';
export const EVT_SHOW_MORE_RETURN = 'items-list.show-more-results';
export const EVT_TOGGLE_TODO = 'items-list.toggle-todo';
export const EVT_TOGGLE_OUTLINE = 'items-list.toggle-outline';
export const EVT_TOGGLE_OUTLINE_RETURN = 'toggle-outline.result';
export const EVT_TOGGLE_TODO_RETURN = 'toggle-todo.result';
export const EVT_DELETE_SUBITEM = 'delete-subitem';
export const EVT_DELETE_SUBITEM_RETURN = 'delete-subitem-return';
export const EVT_MOVE_DOWN = 'move-down';
export const EVT_MOVE_DOWN_RETURN = 'move-down-return';
export const EVT_MOVE_UP = 'move-up';
export const EVT_MOVE_UP_RETURN = 'move-up-return';
export const EVT_INDENT = 'indent';
export const EVT_INDENT_RETURN = 'indent-return';
export const EVT_OUTDENT = 'outdent';
export const EVT_OUTDENT_RETURN = 'outdent-return';

export const state = {
    modeShowMoreResults: false,
    selectedItemSubitemId: null
}

const scrollToTopOnNewResults = true;
const deselectOnToggleTodo = false;
const deselectOnToggleExpand = true;
const two_stage_deselect = false;
let itemsCache = {};

class ItemsList extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
        //TODO move this elsewhere
        document.body.addEventListener('mousedown', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            console.log(`evt.target ${evt.target} | evt.currentTarget ${evt.currentTarget}`)
            this.deselect();
        });
    }

    renderItems(items, totalResults) {
        console.log(`+++ rendering ${items.length} items`);
        this.updateItemCache(items);
        let t1 = Date.now();
        let content = '<div class="items-list">';
        for (let item of items) {
            content += itemFormatter(item, state.selectedItemSubitemId);
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
                el.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    state.modeShowMoreResults = true;
                    el.disabled = true;
                    el.innerHTML = 'Loading...'; //TODO this should be a spinner
                    PubSub.publish(EVT_SHOW_MORE_RETURN, appState.mostRecentQuery);
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
            console.log('mode edit is off, so opening link in new tab');
            let url = e.target.href;
            e.preventDefault();
            e.stopPropagation(); //do not trigger the click event on the parent element
            window.open(url, '_blank');
        }));

        // elItems.querySelectorAll('.tag-todo').forEach(el => el.addEventListener('mousedown', (e) => {
        //     e.stopPropagation();
        // }));

        elItems.querySelectorAll('.tag-todo').forEach(el => el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (deselectOnToggleTodo) {
                this.deselect();
            }
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( EVT_TOGGLE_TODO, {
                itemSubitemId: itemSubitemId
            });
        }));

        // elItems.querySelectorAll('.tag-done').forEach(el => el.addEventListener('mousedown', (e) => {
        //     e.stopPropagation();
        // }));

        elItems.querySelectorAll('.tag-done').forEach(el => el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (deselectOnToggleTodo) {
                this.deselect();
            }
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( EVT_TOGGLE_TODO, {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.expand').forEach(el => el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            if (deselectOnToggleExpand && itemSubitemId != state.selectedItemSubitemId) {
                this.deselect();
            }
            PubSub.publish( EVT_TOGGLE_OUTLINE, {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.collapse').forEach(el => el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            if (deselectOnToggleExpand && itemSubitemId != state.selectedItemSubitemId) {
                this.deselect();
            }
            PubSub.publish( EVT_TOGGLE_OUTLINE, {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.subitem').forEach(el => el.addEventListener('mousedown', (e) => {
            //This is needed to override deselect behavior that happens for mousedown on body
            e.stopPropagation();
        }));

        elItems.querySelectorAll('.subitem').forEach(el => el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (el.classList.contains("subitem-redacted")) {
                alert('TODO: Cannot select a redacted subitem.');  //TODO set redact display mode in the future
                return;
            }

            let itemSubitemId = e.currentTarget.getAttribute('data-id');

            if (state.selectedItemSubitemId === null ||
                state.selectedItemSubitemId !== itemSubitemId) {
                console.log('Select subitem');
                let toReplace = this.itemsToUpdateBasedOnSelectionChange(state.selectedItemSubitemId, itemSubitemId);
                state.selectedItemSubitemId = itemSubitemId;
                this.replaceItemsInDom(toReplace);
                el.blur(); //prevent drag-drop region selection
            }
        }));

        elItems.querySelectorAll('.subitem').forEach(el => el.addEventListener('mousedown', (e) => {

            // if (el.classList.contains("subitem-redacted")) {
            //     alert('TODO: Cannot select a redacted subitem.');  //TODO set redact display mode in the future
            //     return;
            // }

            let itemSubitemId = e.currentTarget.getAttribute('data-id');

            if (state.selectedItemSubitemId !== null) {
                if (state.selectedItemSubitemId === itemSubitemId) {
                    console.log('cp2');
                    e.stopPropagation();
                    //This may place or move the cursor, but there is no need for any action in the logic.
                    console.log('enter mode edit');
                    let el = document.querySelector(`.subitem[data-id="${itemSubitemId}"]`);
                    el.classList.add('subitem-editing');
                }
            }
        }));
    }

    itemsToUpdateBasedOnSelectionChange(oldSelectedItemSubitemId, newSelectedItemSubitemId) {
        let unionSub = new Set();
        if (oldSelectedItemSubitemId !== null) {
            unionSub.add(oldSelectedItemSubitemId);
        }
        if (newSelectedItemSubitemId !== null) {
            unionSub.add(newSelectedItemSubitemId);
        }
        console.log('update items based on selection change:')
        console.log(unionSub);
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
        PubSub.publish( EVT_EDIT_SUBITEM, {
            itemSubitemId: itemSubitemId,
            updatedContent: newHtml
        });
    }

    refreshSelectionHighlights() {

        let els = Array.from(document.querySelectorAll('.subitem-action'));
        els.forEach(el => el.classList.remove('subitem-action'));
        els.forEach(el => el.removeAttribute('contenteditable'));

        //add new highlights
        if (state.selectedItemSubitemId !== null) {
            let id = state.selectedItemSubitemId;
            let el = document.querySelector(`.subitem[data-id="${id}"]`);
            if (el !== null) {
                el.classList.add('subitem-action');
                el.setAttribute('contenteditable', 'true');
                el.addEventListener('paste', this.onPasteSubitemContentEditable);
                el.addEventListener('input', this.onInputSubitemContentEditable);
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
                if (state.selectedItemSubitemId === id) {
                    console.log(`removing ${id} from selected because no _match`);
                    doRemove = true;
                }
            }
            else if (!isNotCollapsed) {
                if (state.selectedItemSubitemId === id) {
                    console.log(`removing ${id} from selected because collapsed`);
                    doRemove = true;
                }
            }
            if (doRemove) {
                state.selectedItemSubitemId = null;
            }
            subitemIndex++;
        }
    }

    deselect = () => {
        if (state.selectedItemSubitemId !== null) {
            console.log('> Escape key pressed, clearing selected subitem');
            let toReplace = this.itemsToUpdateBasedOnSelectionChange(state.selectedItemSubitemId, null);
            state.selectedItemSubitemId = null;
            this.replaceItemsInDom(toReplace);
            this.refreshSelectionHighlights();
        }
    }

    isModeEditing() {
        if (state.selectedItemSubitemId === null) {
            return false;
        }
        let elem = document.querySelector(`[data-id="${state.selectedItemSubitemId}"].subitem`);
        const selection = window.getSelection();
        if (selection && selection.anchorNode) {
            return elem.contains(selection.anchorNode);
        }
        return false;
    }

    //TODO move this
    isModeSearching() {
        return false;  //TODO fix this later to actually detect
    }

    indent(msg, data) {
        if (state.selectedItemSubitemId === null) {
            return;
        }
        if (this.isModeEditing()) {
            return;
        }
        data.evt.preventDefault();
        data.evt.stopPropagation();
        console.log('items-list.js EVT_INDENT');
        PubSub.publish(EVT_INDENT, {
            itemSubitemId: state.selectedItemSubitemId
        });
    }

    outdent(msg, data) {
        if (state.selectedItemSubitemId === null) {
            return;
        }
        if (this.isModeEditing()) {
            return;
        }
        data.evt.preventDefault();
        data.evt.stopPropagation();
        PubSub.publish(EVT_OUTDENT, {
            itemSubitemId: state.selectedItemSubitemId
        });
    }

    subscribeToPubSubEvents() {

        //TODO: seems there is a lot of duplicated logic here...



        PubSub.subscribe(EVT_CTRL_V, (msg, data) => {
            if (state.selectedItemSubitemId === null) {
                alert('nothing selected to paste under');
                //or, should we paste at very top by default?
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            alert('Paste subitem/s todo...');
        });

        PubSub.subscribe(EVT_CTRL_C, (msg, data) => {
            if (state.selectedItemSubitemId === null) {
                alert('nothing selected to copy from');
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            alert('Copy subitem/s todo...');
        });

        PubSub.subscribe(EVT_CTRL_Z, (msg, data) => {
            if (this.isModeSearching()) {
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            alert('UNDO todo...');
        });

        PubSub.subscribe(EVT_CTRL_Y, (msg, data) => {
            if (this.isModeSearching()) {
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            alert('REDO todo...');
        });

        PubSub.subscribe(EVT_ENTER, (msg, data) => {
            if (state.selectedItemSubitemId === null) {
                let topItemSubitemId = -1;
                PubSub.publish( EVT_ADD_ITEM_TOP, {
                    topItemSubitemId: topItemSubitemId
                });
            }
            else {
                if (this.isModeEditing()) {
                    return;
                }
                else {
                    PubSub.publish( EVT_ADD_SUBITEM_NEXT, {
                        itemSubitemId: state.selectedItemSubitemId
                    });
                }
            }
        });

        PubSub.subscribe(EVT_ESCAPE, (msg, data) => {
            if (state.selectedItemSubitemId === null) {
                return;
            }
            else {
                this.deselect();
            }
        });

        PubSub.subscribe(EVT_DELETE, (msg, data) => {
            if (state.selectedItemSubitemId === null) {
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            PubSub.publish(EVT_DELETE_SUBITEM, {itemSubitemId: state.selectedItemSubitemId});
        });

        PubSub.subscribe(EVT_UP, (msg, data) => {
            if (state.selectedItemSubitemId === null) {
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            PubSub.publish(EVT_MOVE_UP, {
                itemSubitemId: state.selectedItemSubitemId
            });
        });

        PubSub.subscribe(EVT_DOWN, (msg, data) => {
            if (state.selectedItemSubitemId === null) {
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            PubSub.publish(EVT_MOVE_DOWN, {
                itemSubitemId: state.selectedItemSubitemId
            });
        });

        PubSub.subscribe(EVT_RIGHT, (msg, data) => {
            console.log('items-list.js EVT_RIGHT');
            this.indent(msg, data);
        });

        PubSub.subscribe(EVT_LEFT, (msg, data) => {
            this.outdent(msg, data);
        });

        PubSub.subscribe(EVT_TAB, (msg, data) => {
            this.indent(msg, data);
        });

        PubSub.subscribe(EVT_SHIFT_TAB, (msg, data) => {
            this.outdent(msg, data);
        });

        PubSub.subscribe(EVT_SPACE, (msg, data) => {
            if (state.selectedItemSubitemId === null) {
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            PubSub.publish( EVT_TOGGLE_OUTLINE, {
                itemSubitemId: state.selectedItemSubitemId
            });
        });

        PubSub.subscribe(EVT_T, (msg, data) => {
            if (state.selectedItemSubitemId === null) {
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            PubSub.publish( EVT_TOGGLE_TODO, {
                itemSubitemId: state.selectedItemSubitemId
            });
        });

        PubSub.subscribe(EVT_NUM, (msg, data) => {
            if (state.selectedItemSubitemId === null) {
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            alert('toggle numbered list todo')
        });

        PubSub.subscribe(EVT_STAR, (msg, data) => {
            if (state.selectedItemSubitemId === null) {
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            alert('toggle bulleted list todo')
        });

        PubSub.subscribe(EVT_SEARCH_FOCUS, (msg, data) => {
            this.deselect();
        });

        PubSub.subscribe(EVT_SEARCH_UPDATED, (msg, data) => {
            state.modeShowMoreResults = false;
            this.deselect();
        });

        PubSub.subscribe(EVT_SEARCH_RETURN, (msg, searchResults) => {
            let totalResults = searchResults['total_results']
            let itemsWindow = searchResults['items_window'];
            this.renderItems(itemsWindow, totalResults);
            //TODO asdfasdf can use genericUpdateFromServer here
            //this.genericUpdateFromServer(data);
        });

        PubSub.subscribe(EVT_TOGGLE_OUTLINE_RETURN, (msg, data) => {
            this.genericUpdateFromServer(data);
        });

        PubSub.subscribe(EVT_DELETE_SUBITEM_RETURN, (msg, data) => {
            this.deselect();
            this.genericUpdateFromServer(data);
        })

        PubSub.subscribe(EVT_TOGGLE_TODO_RETURN, (msg, data) => {
            this.genericUpdateFromServer(data);
        });

        PubSub.subscribe(EVT_MOVE_DOWN_RETURN, (msg, data) => {
            alert('move down return todo');
            //this.genericUpdateFromServer(data);
        });

        PubSub.subscribe(EVT_MOVE_UP_RETURN, (msg, data) => {
            alert('move up return todo');
            //this.genericUpdateFromServer(data);
        });

        PubSub.subscribe(EVT_INDENT_RETURN, (msg, data) => {
            alert('indent return todo');
            //this.genericUpdateFromServer(data);
        });

        PubSub.subscribe(EVT_OUTDENT_RETURN, (msg, data) => {
            alert('outdent return todo');
            //this.genericUpdateFromServer(data);
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

    genericUpdateFromServer(data) {
        //TODO: asdfasdf make this even more generic to just use items list and do comparisons
        if (data.deleted_items && data.deleted_items.length > 0) {
            //TODO remove items from cache?
            this.removeItemsFromDom(data.deleted_items);
        }
        if (data.updated_items && data.updated_items.length > 0) {
            this.updateItemCache(data.updated_items);
            this.replaceItemsInDom(data.updated_items);
        }
    }

    replaceItemsInDom(items) {
        for (let item of items) {
            let currentNode = document.querySelector(`[id="${item.id}"]`);
            //if the item has no matched subitems, remove the item from the DOM completely
            if (item['subitems'][0]['_match'] === undefined) {
                currentNode.remove();
                continue;
            }
            let newNode = document.createElement('div');
            newNode.innerHTML = itemFormatter(item, state.selectedItemSubitemId);
            currentNode.replaceWith(newNode);
            this.addEventHandlersToItems(newNode);
            this.filterSelectedSubitems(item);
            this.refreshSelectionHighlights();
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
                if (state.selectedItemSubitemId === id) {
                    console.log(
                        `removing ${id} from selected because entire item has been removed`);
                    state.selectedItemSubitemId = null;
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