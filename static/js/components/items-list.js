'use strict';

import {
    itemFormatter,
    copyHtmlToClipboard
} from '../misc/item-formatter.js';

import {
    EVT_CTRL_C,
    EVT_CTRL_V,
    EVT_CTRL_X,
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
    EVT_CTRL_Y,
    EVT_CTRL_SHIFT_V,
    EVT_CTRL_ENTER,
    EVT_CTRL_SHIFT_ENTER,
    EVT_RESIZE,
    EVT_SCROLL
} from "../app.js";

import {
    EVT_SEARCH_RETURN,
    EVT_SEARCH_FOCUS,
    EVT_SEARCH_UPDATED
} from './search-bar.js';

export const EVT_ADD_ITEM_TOP = 'add-item-top';
export const EVT_ADD_ITEM_TOP_RETURN = 'add-item-top-return';
export const EVT_ADD_ITEM_SIBLING = 'EVT_ADD_ITEM_SIBLING';
export const EVT_ADD_SUBITEM_SIBLING = 'EVT_ADD_SUBITEM_SIBLING';
export const EVT_ADD_SUBITEM_CHILD = 'EVT_ADD_SUBITEM_CHILD';
export const EVT_ADD_ITEM_SIBLING_RETURN = 'EVT_ADD_ITEM_SIBLING_RETURN';
export const EVT_ADD_SUBITEM_SIBLING_RETURN = 'EVT_ADD_SUBITEM_SIBLING_RETURN';
export const EVT_ADD_SUBITEM_CHILD_RETURN = 'EVT_ADD_SUBITEM_CHILD_RETURN';
export const EVT_EDIT_SUBITEM = 'items-list.edit-subitem';
export const EVT_TOGGLE_TODO = 'items-list.toggle-todo';
export const EVT_TOGGLE_OUTLINE = 'items-list.toggle-outline';
export const EVT_TOGGLE_OUTLINE_RETURN = 'toggle-outline.result';
export const EVT_TOGGLE_TODO_RETURN = 'toggle-todo.result';
export const EVT_DELETE_SUBITEM = 'delete-subitem';
export const EVT_DELETE_SUBITEM_RETURN = 'delete-subitem-return';
export const EVT_MOVE_ITEM_UP = 'EVT_MOVE_ITEM_UP';
export const EVT_MOVE_ITEM_UP_RETURN = 'EVT_MOVE_ITEM_UP_RETURN';
export const EVT_MOVE_ITEM_DOWN = 'EVT_MOVE_ITEM_DOWN';
export const EVT_MOVE_ITEM_DOWN_RETURN = 'EVT_MOVE_ITEM_DOWN_RETURN';
export const EVT_MOVE_SUBITEM_UP = 'EVT_MOVE_SUBITEM_UP';
export const EVT_MOVE_SUBITEM_UP_RETURN = 'EVT_MOVE_SUBITEM_UP_RETURN';
export const EVT_MOVE_SUBITEM_DOWN = 'EVT_MOVE_SUBITEM_DOWN';
export const EVT_MOVE_SUBITEM_DOWN_RETURN = 'EVT_MOVE_SUBITEM_DOWN_RETURN';
export const EVT_INDENT = 'indent';
export const EVT_INDENT_RETURN = 'indent-return';
export const EVT_OUTDENT = 'outdent';
export const EVT_OUTDENT_RETURN = 'outdent-return';
export const EVT_PASTE_SIBLING = 'EVT_PASTE_SIBLING';
export const EVT_PASTE_SIBLING_RETURN = 'EVT_PASTE_SIBLING_RETURN';
export const EVT_PASTE_CHILD = 'EVT_PASTE_CHILD';
export const EVT_PASTE_CHILD_RETURN = 'EVT_PASTE_CHILD_RETURN';
export const EVT_PAGINATION_UPDATE = 'EVT_PAGINATION_UPDATE';
export const EVT_PAGINATION_UPDATE_RETURN = 'EVT_PAGINATION_UPDATE_RETURN';

export const state = {
    paginationTopmostItemId: null,
    paginationLowestItemId: null,
    clipboard: null,
    selectedItemSubitemId: null,
    updatedContent: null
}

const scrollToTopOnNewResults = true;
const scrollIntoView = true;
let itemsCache = {};
let _items = [];

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

    connectedCallback() {
        this.myId = this.getAttribute('id');
        this.renderItems([]);
        this.subscribeToPubSubEvents();
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

    renderItems(items) {
        console.log(`+++ rendering ${items.length} items`);
        this.updateItemsCache(items);
        let t1 = Date.now();
        let content = '<div class="items-list">';
        for (let item of items) {
            content += itemFormatter(item, state.selectedItemSubitemId);
        }
        content += '</div>';
        this.innerHTML = content;
        let t2 = Date.now();
        console.log(`rendered ${items.length} items in ${(t2 - t1)}ms`);

        t1 = Date.now();
        this.addEventHandlersToItems(this);
        t2 = Date.now();
        console.log(`added events for ${items.length} items in ${(t2 - t1)}ms`);
    }

    addEventHandlersToItems(elItems) {

        elItems.querySelectorAll('a').forEach(el => el.addEventListener('click', (e) => {
            console.log('mode edit is off, so opening link in new tab');
            let url = e.target.href;
            e.preventDefault();
            e.stopPropagation(); //do not trigger the click event on the parent element
            window.open(url, '_blank');
        }));

        elItems.querySelectorAll('.tag-todo').forEach(el => el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            state.selectedItemSubitemId = itemSubitemId;
            PubSub.publish( EVT_TOGGLE_TODO, {state: state});
        }));

        elItems.querySelectorAll('.tag-done').forEach(el => el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            state.selectedItemSubitemId = itemSubitemId;
            PubSub.publish( EVT_TOGGLE_TODO, {state: state});
        }));

        elItems.querySelectorAll('.expand').forEach(el => el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            state.selectedItemSubitemId = itemSubitemId;
            PubSub.publish( EVT_TOGGLE_OUTLINE, {state: state});
        }));

        elItems.querySelectorAll('.collapse').forEach(el => el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            state.selectedItemSubitemId = itemSubitemId;
            PubSub.publish( EVT_TOGGLE_OUTLINE, {state: state});
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
        let html = e.clipboardData.getData("text/html");
        console.log('pasting html: ' + html);
        //TODO 2023.03.05: this is where my clean up parsing code should go
        document.execCommand("insertHTML", false, html);
    }

    onInputSubitemContentEditable(e) {
        let itemSubitemId = e.currentTarget.getAttribute('data-id');
        let newHtml = e.currentTarget.innerHTML;
        let itemId = itemSubitemId.split(':')[0];
        let subitemIndex = parseInt(itemSubitemId.split(':')[1]);  //TODO: why do we need int?
        itemsCache[itemId]['subitems'][subitemIndex].data = newHtml;
        state.updatedContent = newHtml;
        PubSub.publish( EVT_EDIT_SUBITEM, {state: state});
    }

    refreshSelectionHighlights() {

        console.log('refreshSelectionHighlights()');

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

    updateItemsCache(items) {
        //TODO 2021.03.05: this does not handle deleted items
        if (items.length == 0) {
            console.log('updateItemsCache() - no items to update');
            return;
        }
        console.log('updateItemsCache() ' + items.length + ' items');
        for (let item of items) {
            itemsCache[item.id] = item;
        }
        _items = items;
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
        if (this.isModeEditing() || this.isModeSelected()) {
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

    isModeSelected() {
        if (state.selectedItemSubitemId === null) {
            return false;
        }
        if (this.isModeEditing()) {
            return false;
        }
        return true;
    }

    isModeDeselected() {
        if (state.selectedItemSubitemId === null) {
            return true;
        }
        return false;
    }

    isModeTopSubitemSelected() {
        if (state.selectedItemSubitemId === null) {
            return false;
        }
        const subitemIndex = state.selectedItemSubitemId.split(':')[1];
        if (subitemIndex !== '0') {
            return false;
        }
        return true;
    }

    //TODO move this
    isModeSearching() {
        return false;  //TODO fix this later to actually detect
    }

    indent(msg, data) {
        if (this.isModeDeselected()) {
            return;
        }
        // Allow even when editing
        // if (this.isModeEditing()) {
        //     return;
        // }
        data.evt.preventDefault();
        data.evt.stopPropagation();
        console.log('items-list.js EVT_INDENT');
        PubSub.publish(EVT_INDENT, {state: state});
    }

    outdent(msg, data) {
        if (this.isModeDeselected()) {
            return;
        }
        // Allow even when editing
        // if (this.isModeEditing()) {
        //     return;
        // }

        PubSub.publish(EVT_OUTDENT, {state: state});
    }

    paginationCheck() {
        console.log('pagination check');
        const items = document.querySelectorAll('.item');
        let topmostItemId = null;
        let lowestItemId = null;
        let topmostItemTop = Infinity;
        let lowestItemBottom = -Infinity;
        items.forEach(item => {
            const rect = item.getBoundingClientRect();
            const isVisible = (rect.top < window.innerHeight) && (rect.bottom > 0);

            // If the item is visible and higher (smaller top value) than the current topmost
            if (isVisible && rect.top < topmostItemTop) {
              topmostItemTop = rect.top;
              topmostItemId = item.id;
            }

            // If the item is visible and lower (greater bottom value) than the current lowest
            if (isVisible && rect.bottom > lowestItemBottom) {
              lowestItemBottom = rect.bottom;
              lowestItemId = item.id;
            }
        });
        if (state.paginationTopmostItemId !== topmostItemId || state.paginationLowestItemId != lowestItemId) {
            console.log('^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^')
            console.log(`top = ${topmostItemId} | bottom = ${lowestItemId}`);
            console.log('^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^')
            state.paginationTopmostItemId = topmostItemId;
            state.paginationLowestItemId = lowestItemId;
            console.log('state items-list');
            console.log(state);
            //asdfasdf only do this if we are near boundaries of our _items
            PubSub.publish(EVT_PAGINATION_UPDATE, {state: state});
        }
    }

    subscribeToPubSubEvents() {

        //TODO: seems there is a lot of duplicated logic here...

        PubSub.subscribe(EVT_PAGINATION_UPDATE_RETURN, (msg, data) => {
            this.paginationUpdateFromServer(data);
        });

        PubSub.subscribe(EVT_CTRL_C, (msg, data) => {
            if (this.isModeDeselected()) {
                alert('nothing selected to copy from');
                return;
            }
            //TODO: we probably should be able to do this in editing mode
            // or maybe just if we don't have a range of text selected?
            // (that feels esoteric...)
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();

            //add copy of current item and subitem selection to clipboard
            const itemId = state.selectedItemSubitemId.split(':')[0]
            let subitemIndex = parseInt(state.selectedItemSubitemId.split(':')[1])

            //TODO: we do not actually want to copy this entire item, unless
            // subitem index 0 is selected.
            // Otherwise, we want to select the subitem and its children,
            // remove the other subitems, normalize the indents
            const itemCopy = JSON.parse(JSON.stringify(itemsCache[itemId]));
            if (subitemIndex > 0) {
                const subitemsSubset = []
                //always include first subitem
                subitemsSubset.push(itemCopy['subitems'][subitemIndex]);
                const indent = itemCopy['subitems'][subitemIndex]['indent'];
                //add children, if any exist
                for (let i = subitemIndex+1; i < itemCopy['subitems'].length; i++) {
                    //look for siblings or eldars
                    if (itemCopy['subitems'][i]['indent'] <= indent) {
                        break
                    }
                    subitemsSubset.push(itemCopy['subitems'][i])
                }

                //normalize indents
                for (let subitem of subitemsSubset) {
                    subitem['indent'] -= indent;
                }

                //set subitemIndex = 0
                subitemIndex = 0

                //assign the subset back to the subitems of the itemCopy
                itemCopy['subitems'] = subitemsSubset
            }

            state.clipboard = {
                'item': itemCopy,  //TODO possibly rename item => fragment
                'subitemIndex': subitemIndex  //TODO subitemIndex should logically always be zero so we can remove this
            }

            //[x] confirm this doesn't break regular copy/paste functionality

            //TODO: lots of work here to get it to look like item
            //TODO: handle @todo and @done
            //TODO: handle LaTeX and markdown

            // assume node is already rendered
            // grab relevant subitems (start with item itself, not children?

            // const htmlToCopy = currentNode.innerHTML;
            // const plainText = currentNode.innerHTML; //"should show up in Sublime 2";

            const htmlToCopy = itemFormatter(itemCopy, itemId + ':0')
            const plainTextToCopy = 'Hello, Worldz3!';

            copyHtmlToClipboard(htmlToCopy, plainTextToCopy);
        });

        PubSub.subscribe(EVT_CTRL_V, (msg, data) => {
            if (this.isModeDeselected()) {
                alert('nothing selected to paste under');
                //TODO: or, should we paste at very top by default?
                return;
            }
            //TODO: may be more state options for when we allow this...
            // for example may want to paste into if there isn't already content
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();

            if (state.clipboard === null) {
                alert('no item in clipboard to paste');
                return;
            }

            PubSub.publish(EVT_PASTE_SIBLING, {state: state});
        });

        PubSub.subscribe(EVT_CTRL_X, (msg, data) => {
            if (this.isModeDeselected()) {
                alert('nothing selected to cut from');
                return;
            }
            //TODO: we probably should be able to do this in editing mode
            // or maybe just if we don't have a range of text selected?
            // (that feels esoteric...)
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();

            //add copy of current item and subitem selection to clipboard
            const itemId = state.selectedItemSubitemId.split(':')[0]
            const subitemIndex = state.selectedItemSubitemId.split(':')[1]

            state.clipboard = {
                'item': JSON.parse(JSON.stringify(itemsCache[itemId])),
                'subitemIndex': subitemIndex
            }
            
            //TODO: add html to clipboard in order to paste elsewhere

            //TODO: what situations would clear our clipboard?
            // undo?
            // copy something from another source?

            /////////////////////////////////////////////////////////////////////

            // at this point, we want to delete this item and/or subitem
            PubSub.publish(EVT_DELETE_SUBITEM, {state: state});
        });

        PubSub.subscribe(EVT_CTRL_SHIFT_V, (msg, data) => {
            if (this.isModeDeselected()) {
                alert('nothing selected to paste under');
                //TODO: or, should we paste at very top by default?
                return;
            }
            //TODO: may be more state options for when we allow this...
            // for example may want to paste into if there isn't already content
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();

            if (state.clipboard === null) {
                alert('no item in clipboard to paste');
                return;
            }

            PubSub.publish(EVT_PASTE_CHILD, {state: state});
        });

        PubSub.subscribe(EVT_CTRL_Z, (msg, data) => {
            if (this.isModeSearching() || this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            alert('UNDO todo...');
        });

        PubSub.subscribe(EVT_CTRL_Y, (msg, data) => {
            if (this.isModeSearching() || this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            alert('REDO todo...');
        });

        PubSub.subscribe(EVT_ENTER, (msg, data) => {

            if (this.isModeEditing()) {
                return;
            }

            data.evt.preventDefault();
            data.evt.stopPropagation();

            if (this.isModeDeselected()) {
                PubSub.publish( EVT_ADD_ITEM_TOP, {state: state});
            }
            else {
                if (this.isModeTopSubitemSelected()) {
                    PubSub.publish(EVT_ADD_ITEM_SIBLING, {state: state});
                }
                else {
                    PubSub.publish(EVT_ADD_SUBITEM_SIBLING, {state: state});
                }
            }
        });

        PubSub.subscribe(EVT_ESCAPE, (msg, data) => {
            if (this.isModeDeselected()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            this.deselect();
        });

        PubSub.subscribe(EVT_DELETE, (msg, data) => {
            if (this.isModeDeselected()) {
                return;
            }
            if (this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            PubSub.publish(EVT_DELETE_SUBITEM, {state: state});
        });

        PubSub.subscribe(EVT_UP, (msg, data) => {
            if (this.isModeDeselected() || this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            if (this.isModeTopSubitemSelected()) {
                PubSub.publish(EVT_MOVE_ITEM_UP, {state: state});
            }
            else {
                PubSub.publish(EVT_MOVE_SUBITEM_UP, {state: state});
            }
        });

        PubSub.subscribe(EVT_DOWN, (msg, data) => {
            if (this.isModeDeselected() || this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            if (this.isModeTopSubitemSelected()) {
                PubSub.publish(EVT_MOVE_ITEM_DOWN, {state: state});
            }
            else {
                PubSub.publish(EVT_MOVE_SUBITEM_DOWN, {state: state});
            }
        });

        PubSub.subscribe(EVT_RIGHT, (msg, data) => {
            if (this.isModeTopSubitemSelected()) {
                return;
            }
            if (this.isModeDeselected() || this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            console.log('items-list.js EVT_RIGHT');
            this.indent(msg, data);
        });

        PubSub.subscribe(EVT_LEFT, (msg, data) => {
            if (this.isModeTopSubitemSelected()) {
                return;
            }
            if (this.isModeDeselected() || this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            this.outdent(msg, data);
        });

        PubSub.subscribe(EVT_TAB, (msg, data) => {
            if (this.isModeTopSubitemSelected()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            this.indent(msg, data);
        });

        PubSub.subscribe(EVT_SHIFT_TAB, (msg, data) => {
            if (this.isModeTopSubitemSelected()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            this.outdent(msg, data);
        });

        PubSub.subscribe(EVT_SPACE, (msg, data) => {
            if (this.isModeDeselected() || this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();this.deselect();
            PubSub.publish( EVT_TOGGLE_OUTLINE, {state: state});
        });

        PubSub.subscribe(EVT_T, (msg, data) => {
            if (this.isModeDeselected() || this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            PubSub.publish( EVT_TOGGLE_TODO, {state: state});
        });

        PubSub.subscribe(EVT_NUM, (msg, data) => {
            if (this.isModeDeselected() || this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            alert('toggle numbered list todo')
        });

        PubSub.subscribe(EVT_STAR, (msg, data) => {
            if (this.isModeDeselected() || this.isModeEditing()) {
                return;
            }
            data.evt.preventDefault();
            data.evt.stopPropagation();
            alert('toggle bulleted list todo')
        });

        PubSub.subscribe(EVT_SEARCH_FOCUS, (msg, data) => {
            this.deselect();
        });

        PubSub.subscribe(EVT_SEARCH_UPDATED, (msg, data) => {
            this.deselect();
        });

        PubSub.subscribe(EVT_SEARCH_RETURN, (msg, searchResults) => {
            let items = searchResults['items'];
            this.renderItems(items);
            if (scrollToTopOnNewResults) {
                window.scrollTo(0, 0);
            }
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

        PubSub.subscribe(EVT_MOVE_ITEM_UP_RETURN, (msg, data) => {
            this.genericUpdateFromServer(data);
        });

        PubSub.subscribe(EVT_MOVE_ITEM_DOWN_RETURN, (msg, data) => {
            this.genericUpdateFromServer(data);
        });

        //TODO: below is a LOT of repeated code
        // Refactor: move all into this.genericUpdateFromServer()?

        PubSub.subscribe(EVT_MOVE_SUBITEM_UP_RETURN, (msg, data) => {
            if ('error' in data) {
                alert(`ERROR: ${data['error']}`);
                return;
            }
            if ('noop' in data) {
                console.log(data['noop']);
                return;
            }
            this.deselect();
            //set id *before* genericUpdate so as to trigger auto scroll
            state.selectedItemSubitemId = data['newSelectedItemSubitemId'];
            this.genericUpdateFromServer(data);
            this.refreshSelectionHighlights();
            // selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
        });

        PubSub.subscribe(EVT_RESIZE, (msg, data) => {
            this.paginationCheck();
        });

        PubSub.subscribe(EVT_SCROLL, (msg, data) => {
            this.paginationCheck();
        });

        PubSub.subscribe(EVT_MOVE_SUBITEM_DOWN_RETURN, (msg, data) => {
            if ('error' in data) {
                alert(`ERROR: ${data['error']}`);
                return;
            }
            if ('noop' in data) {
                console.log(data['noop']);
                return;
            }
            this.deselect();
            //set id *before* genericUpdate so as to trigger auto scroll
            state.selectedItemSubitemId = data['newSelectedItemSubitemId'];
            this.genericUpdateFromServer(data);
            this.refreshSelectionHighlights();
            // selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
        });

        PubSub.subscribe(EVT_INDENT_RETURN, (msg, data) => {
            if ('error' in data) {
                alert(`ERROR: ${data['error']}`);
                return;
            }
            if ('noop' in data) {
                console.log(data['noop']);
                return;
            }
            this.deselect();
            //set id *before* genericUpdate so as to trigger auto scroll
            state.selectedItemSubitemId = data['newSelectedItemSubitemId'];
            this.genericUpdateFromServer(data);
            this.refreshSelectionHighlights();
            // selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
        });

        PubSub.subscribe(EVT_OUTDENT_RETURN, (msg, data) => {
            if ('error' in data) {
                alert(`ERROR: ${data['error']}`);
                return;
            }
            if ('noop' in data) {
                console.log(data['noop']);
                return;
            }
            this.deselect();
            //set id *before* genericUpdate so as to trigger auto scroll
            state.selectedItemSubitemId = data['newSelectedItemSubitemId'];
            this.genericUpdateFromServer(data);
            this.refreshSelectionHighlights();
            // selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
        });

        PubSub.subscribe(EVT_PASTE_SIBLING_RETURN, (msg, data) => {
            if ('error' in data) {
                alert(`ERROR: ${data['error']}`);
                return;
            }
            if ('noop' in data) {
                console.log(data['noop']);
                return;
            }
            this.deselect();
            //set id *before* genericUpdate so as to trigger auto scroll
            state.selectedItemSubitemId = data['newSelectedItemSubitemId'];
            this.genericUpdateFromServer(data);
            this.refreshSelectionHighlights();
            // selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
        });

        PubSub.subscribe(EVT_PASTE_CHILD_RETURN, (msg, data) => {
            if ('error' in data) {
                alert(`ERROR: ${data['error']}`);
                return;
            }
            if ('noop' in data) {
                console.log(data['noop']);
                return;
            }
            this.deselect();
            //set id *before* genericUpdate so as to trigger auto scroll
            state.selectedItemSubitemId = data['newSelectedItemSubitemId'];
            this.genericUpdateFromServer(data);
            this.refreshSelectionHighlights();
            // selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
        });

        PubSub.subscribe(EVT_ADD_ITEM_TOP_RETURN, (msg, data) => {
            if ('error' in data) {
                alert(`ERROR: ${data['error']}`);
                return;
            }
            if ('noop' in data) {
                console.log(data['noop']);
                return;
            }
            this.deselect();
            this.genericUpdateFromServer(data);
            window.scrollTo(0, 0);
            //set id *after* genericUpdate so as to avoid auto scroll
            state.selectedItemSubitemId = data['newSelectedItemSubitemId'];
            this.refreshSelectionHighlights();
            selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
        });

        PubSub.subscribe(EVT_ADD_ITEM_SIBLING_RETURN, (msg, data) => {
            if ('error' in data) {
                alert(`ERROR: ${data['error']}`);
                return;
            }
            if ('noop' in data) {
                console.log(data['noop']);
                return;
            }
            this.deselect();
            //set id *before* genericUpdate so as to trigger auto scroll
            state.selectedItemSubitemId = data['newSelectedItemSubitemId'];
            this.genericUpdateFromServer(data);
            this.refreshSelectionHighlights();
            selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
        });

        PubSub.subscribe(EVT_ADD_SUBITEM_SIBLING_RETURN, (msg, data) => {
            if ('error' in data) {
                alert(`ERROR: ${data['error']}`);
                return;
            }
            if ('noop' in data) {
                console.log(data['noop']);
                return;
            }
            this.deselect();
            //set id *before* genericUpdate so as to trigger auto scroll
            state.selectedItemSubitemId = data['newSelectedItemSubitemId'];
            this.genericUpdateFromServer(data);
            this.refreshSelectionHighlights();
            selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
        });

        PubSub.subscribe(EVT_ADD_SUBITEM_CHILD_RETURN, (msg, data) => {
            if ('error' in data) {
                alert(`ERROR: ${data['error']}`);
                return;
            }
            if ('noop' in data) {
                console.log(data['noop']);
                return;
            }
            this.deselect();
            //set id *before* genericUpdate so as to trigger auto scroll
            state.selectedItemSubitemId = data['newSelectedItemSubitemId'];
            this.genericUpdateFromServer(data);
            this.refreshSelectionHighlights();
            selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
        });

        PubSub.subscribe(EVT_CTRL_ENTER, (msg, data) => {
            data.evt.preventDefault();
            data.evt.stopPropagation();

            if (this.isModeDeselected()) {
                // if nothing selected, add item at top
                PubSub.publish( EVT_ADD_ITEM_TOP, {state: state});
            }
            else {
                if (this.isModeTopSubitemSelected()) {
                    // if item-level selected, add new item underneath
                    // if item-level selected and editing, add new item underneath
                    PubSub.publish(EVT_ADD_ITEM_SIBLING, {state: state});
                }
                else {
                    // if subitem-level selected, and subitem underneath
                    // if subitem-level selected and editing, add new subitem underneath
                    PubSub.publish(EVT_ADD_SUBITEM_SIBLING, {state: state});
                }
            }
        });

        PubSub.subscribe(EVT_CTRL_SHIFT_ENTER, (msg, data) => {
            data.evt.preventDefault();
            data.evt.stopPropagation();

            if (state.selectedItemSubitemId === null) {
                // if nothing selected, add item at top (kinder default)
                PubSub.publish( EVT_ADD_ITEM_TOP, {state: state});
            }
            else {
                // if item-level selected, add new subitem child
                // if item-level selected and editing, add new subitem child
                // if subitem-level selected, add subitem child
                // if subitem-level selected and editing, add subitem child
                PubSub.publish(EVT_ADD_SUBITEM_CHILD, {state: state});
            }
        });
    }

    genericUpdateFromServer(data) {
        if ('error' in data) {
            alert(`ERROR: ${data['error']}`);
            return;
        }
        if ('noop' in data) {
            console.log(data['noop']);
            return;
        }
        let items = data['items'];
        this.renderItems(items);
        this.refreshSelectionHighlights();

        if (scrollIntoView && state.selectedItemSubitemId !== null) {
            console.log(`state.selectedItemSubitemId = ${state.selectedItemSubitemId}`)
            const itemId = state.selectedItemSubitemId.split(':')[0];
            const el = document.getElementById(itemId);

            //TODO: write custom code for this

            // not perfect, but it is a start
            if (data.items[0]['id'] === parseInt(itemId)) {
                console.log('scroll 0 0');
                window.scrollTo(0, 0);
            }
            else {
                el.scrollIntoView({behavior: "smooth", block: "nearest", inline: "nearest"});
                console.log('scrollIntoView')
            }
        }

        this.paginationCheck();
    }

    paginationUpdateFromServer(data) {
        if ('error' in data) {
            alert(`ERROR: ${data['error']}`);
            return;
        }
        if ('noop' in data) {
            console.log(data['noop']);
            return;
        }
        let items = data['items'];

        // //assume same order
        //
        // console.log('paginationUpdateFromServer() todo...')
        //
        // //this.replaceItemsInDom(new_items)
        // //this.removeItemsFromDom(old_items)
        //
        // //asdfasdf
        // // this.renderItems(items);
        // // this.refreshSelectionHighlights();
        //
        // this.updateItemsCache(items);
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