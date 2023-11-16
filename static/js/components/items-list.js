'use strict';

import {
    itemFormatter,
    copyHtmlToClipboard
} from '../misc/item-formatter.js';

import {
    genericRequestV2
} from '../misc/server-proxy.js';

import {
    vdomUpdate
} from '../misc/vdom.js';

import {
    EVT_SEARCH_RETURN,
    EVT_SEARCH_FOCUS,
    EVT_SEARCH_UPDATED
} from './search-bar.js';

export const EVT_SELECT_ITEMSUBITEM = 'EVT_SELECT_ITEMSUBITEM';
export const EVT_RESELECT_ITEMSUBITEM = 'EVT_RESELECT_ITEMSUBITEM';
export const EVT_DESELECT_ITEMSUBITEM = 'EVT_DESELECT_ITEMSUBITEM';

const initialItemsToReturn = 50;

export const state = {
    clipboard: null,
    selectedItemSubitemId: null,
    updatedContent: null,
    totalItemsToReturn: initialItemsToReturn
}

const infiniteScrolling = true;
const paginationBuffer = 25;
const paginationExpandBy = 50;
const checkPaginationMs = 250;
let itemsCache = {};
let _items = [];  //previous items list


class ItemsList extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }

    connectedCallback() {
        this.myId = this.getAttribute('id');
        this.renderItems([]);
        this.subscribeToPubSubEvents();
        if (infiniteScrolling) {
                setInterval(() => {
                this.paginationCheck();
            }, checkPaginationMs);
        }
        let container = document.getElementById('my-items-list');
        this.addEventToActionMap(container);
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

    handleEvent(evt) {
        if (evt) {
            evt.preventDefault();
            evt.stopPropagation();
        }
    }

    ////////////////////////////////////////////////////
    // ACTIONS
    ////////////////////////////////////////////////////

    async actionAddItemTop(evt) {
        let result = await genericRequestV2(evt, state, "/add-item-top");
        this.genericUpdateFromServer(result, true, true);
    }

    async actionAddSubitemChild(evt) {
        let result = await genericRequestV2(evt, state, "/add-subitem-child");
        this.genericUpdateFromServer(result, true, true);
    }

    async actionPasteChild(evt) {
        let result = await genericRequestV2(evt, state, "/paste-child");
        this.genericUpdateFromServer(result, true);
    }

    actionCopyToClipboard(evt) {
        this.handleEvent(evt);
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
    }

    async actionPasteSibling(evt) {
        let result = await genericRequestV2(evt, state, "/paste-sibling");
        this.genericUpdateFromServer(result, false);
    }

    async actionDeleteSubitem(evt) {
        let result = await genericRequestV2(evt, state, "/delete-subitem");
        this.genericUpdateFromServer(result, true);
    }

    async actionCutSubitem(evt) {
        const itemId = state.selectedItemSubitemId.split(':')[0]
        const subitemIndex = state.selectedItemSubitemId.split(':')[1]
        state.clipboard = {
            'item': JSON.parse(JSON.stringify(itemsCache[itemId])),
            'subitemIndex': subitemIndex
        }
        let result = await genericRequestV2(evt, state, "/delete-subitem");
        this.genericUpdateFromServer(result, true);
    }

    async actionAddItemSibling(evt) {
        let result = await genericRequestV2(evt, state, "/add-item-sibling");
        this.genericUpdateFromServer(result, true, true);
    }

    async actionAddSubitemSibling(evt) {
        let result = await genericRequestV2(evt, state, "/add-subitem-sibling");
        this.genericUpdateFromServer(result, true, true);
    }

    async actionMoveItemUp(evt) {
        let result = await genericRequestV2(evt, state, "/move-item-up");
        this.genericUpdateFromServer(result, true);
    }

    async actionMoveSubitemUp(evt) {
        let result = await genericRequestV2(evt, state, "/move-subitem-up");
        this.genericUpdateFromServer(result, true);
    }

    async actionMoveItemDown(evt) {
        let result = await genericRequestV2(evt, state, "/move-item-down");
        this.genericUpdateFromServer(result, true);
    }

    async actionMoveSubitemDown(evt) {
        let result = await genericRequestV2(evt, state, "/move-subitem-down");
        this.genericUpdateFromServer(result, true);
    }

    async actionOutdent(evt) {
        let result = await genericRequestV2(evt, state, "/outdent");
        this.genericUpdateFromServer(result, false);
    }

    async actionIndent(evt) {
        let result = await genericRequestV2(evt, state, "/indent");
        this.genericUpdateFromServer(result, false);
    }

    actionClickLink(evt) {
        console.log('Opening link in new tab');
        let url = evt.target.href;
        evt.preventDefault();
        window.open(url, '_blank');
    }

    //TODO: why both mousedown and click for subitem?
    actionMousedownSubitem(evt) {
        let itemSubitemId = evt.target.getAttribute('data-id');
        if (state.selectedItemSubitemId === itemSubitemId) {
            console.log('Enter edit mode');
            evt.target.classList.add('subitem-editing');
        }
        evt.stopPropagation();
    }

    actionClickSubitem(evt) {
        let itemSubitemId = evt.target.getAttribute('data-id');
        if (state.selectedItemSubitemId === null || state.selectedItemSubitemId !== itemSubitemId) {
            console.log('Select subitem');
            let itemId = parseInt(itemSubitemId.split(':')[0]);
            let item = itemsCache[itemId];
            console.log(item); //debug
            console.log(`\t[${itemId}]: "${item['subitems'][0]['data']}"`);
            this.handleEvent(evt);
            this.actionSelect(itemSubitemId);
        }
        evt.stopPropagation();
    }

    async actionToggleTodo(evt) {
        let itemSubitemId = evt.target.parentElement.getAttribute('data-id');
        this.actionSelect(itemSubitemId);
        let result = await genericRequestV2(evt, state, "/toggle-todo");
        this.genericUpdateFromServer(result, false);
    }

    async actionToggleOutline(evt) {
        let itemSubitemId = evt.target.parentElement.getAttribute('data-id');
        this.actionSelect(itemSubitemId);
        let result = await genericRequestV2(evt, state, "/toggle-outline");
        //TODO: only auto scroll if expanding, not collapsing
        this.genericUpdateFromServer(result, true);
    }

    async actionInputSubitemContentEditable(evt) {
        let itemSubitemId = evt.currentTarget.getAttribute('data-id');
        let newHtml = evt.currentTarget.innerHTML;
        let itemId = itemSubitemId.split(':')[0];
        let subitemIndex = parseInt(itemSubitemId.split(':')[1]);  //TODO: why do we need int?
        itemsCache[itemId]['subitems'][subitemIndex].data = newHtml;
        state.updatedContent = newHtml;
        let result = await genericRequestV2(evt, state,
            "/update-subitem-content");
        //ignore result
    }

    actionPasteSubitemContentEditable(evt) {
        evt.preventDefault();
        let html = evt.clipboardData.getData("text/html");
        console.log('pasting html: ' + html);
        //TODO 2023.03.05: this is where my clean up parsing code should go
        document.execCommand("insertHTML", false, html);
    }

    actionDeselect = (evt) => {
        this.handleEvent(evt);
        console.log('-----------------------------------------------');
        console.log(`DEBUG: actionDeselect`);
        if (this.isModeEditing() || this.isModeSelected()) {
            console.log('> deselecting subitem');
            let toReplace = this.itemsToUpdateBasedOnSelectionChange(state.selectedItemSubitemId, null);
            state.selectedItemSubitemId = null;
            this.replaceItemsInDom(toReplace);
            this.refreshSelectionHighlights();
            PubSub.publish(EVT_DESELECT_ITEMSUBITEM, null);
        }
    }

    actionSelect = (newItemSubitemId) => {
        if (state.selectedItemSubitemId === newItemSubitemId) {
            console.log('already selected...');
            return;
        }
        let toReplace = this.itemsToUpdateBasedOnSelectionChange(state.selectedItemSubitemId, newItemSubitemId);
        this.replaceItemsInDom(toReplace);
        state.selectedItemSubitemId = newItemSubitemId;
        let itemId = parseInt(state.selectedItemSubitemId.split(':')[0]);
        this.refreshSelectionHighlights(); //redundant?
        PubSub.publish(EVT_SELECT_ITEMSUBITEM, {
            'item': itemsCache[itemId],
            'itemSubitemId': state.selectedItemSubitemId
        });
    }

    actionReselect = () => {
        if (state.selectedItemSubitemId === null) {
            console.log('nothing selected?');
            return;
        }
        let itemId = parseInt(state.selectedItemSubitemId.split(':')[0]);
        PubSub.publish(EVT_RESELECT_ITEMSUBITEM, {
            'item': itemsCache[itemId],
            'itemSubitemId': state.selectedItemSubitemId
        });
    }

    ////////////////////////////////////////////////////

    addEventToActionMap(container) {

        //TODO: how to make this compatible with keyboard reconfig in the future?
        document.onkeydown = (evt) => {
            //console.log(evt.key);
            if (evt.ctrlKey) {
                if (evt.shiftKey) {
                    if (evt.key === 'Enter') {
                        if (state.selectedItemSubitemId === null) {
                            this.actionAddItemTop(evt);
                        }
                        else {
                            this.actionAddSubitemChild(evt);
                        }
                    }
                    else if (evt.key === 'V') {
                        if (state.selectedItemSubitemId === null) {
                            alert('nothing selected to paste under');
                            //TODO: or, should we paste at very top by default?
                            return;
                        }
                        if (state.clipboard === null) {
                            alert('no item in clipboard to paste');
                            return;
                        }
                        //TODO: may be more state options for when we allow this...
                        // for example may want to paste into if there isn't already content
                        if (this.isModeEditing()) {
                            return;
                        }
                        this.actionPasteChild(evt);
                    }
                }
                else {
                    if (evt.key === 'c') {
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
                        this.actionCopyToClipboard(evt);
                    }
                    else if (evt.key === 'v') {
                        if (this.isModeDeselected()) {
                            alert('nothing selected to paste under');
                            //TODO: or, should we paste at very top by default?
                            return;
                        }
                        if (state.clipboard === null) {
                            alert('no item in clipboard to paste');
                            return;
                        }
                        //TODO: may be more state options for when we allow this...
                        // for example may want to paste into if there isn't already content
                        if (this.isModeEditing()) {
                            return;
                        }
                        this.actionPasteSibling(evt);
                    }
                    else if (evt.key === 'x') {
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
                        this.actionCutSubitem(evt);
                    }
                    else if (evt.key === 'Enter') {

                        if (this.isModeDeselected()) {
                            this.actionAddItemTop(evt);
                        }
                        else {
                            if (this.isModeTopSubitemSelected()) {
                                this.actionAddItemSibling(evt);
                            }
                            else {
                                this.actionAddSubitemSibling(evt);
                            }
                        }
                    }
                }
            }
            else if (evt.key === "Enter") {
                if (this.isModeEditing()) {
                    return;
                }
                if (this.isModeDeselected()) {
                    this.actionAddItemTop(evt);
                }
                else {
                    if (this.isModeTopSubitemSelected()) {
                        this.actionAddItemSibling(evt);
                    }
                    else {
                        this.actionAddSubitemSibling(evt);
                    }
                }
            }
            else if (evt.key === "Escape") {
                if (this.isModeDeselected()) {
                    return;
                }
                this.actionDeselect(evt);
            }
            else if (evt.key === "Delete" || evt.key === "Backspace") {
                if (this.isModeDeselected() || this.isModeEditing()) {
                    return;
                }
                this.actionDeleteSubitem(evt);
            }
            else if (evt.key === 'ArrowUp') {
                if (this.isModeDeselected() || this.isModeEditing()) {
                    return;
                }
                if (this.isModeTopSubitemSelected()) {
                    this.actionMoveItemUp(evt);
                }
                else {
                    this.actionMoveSubitemUp(evt);
                }
            }
            else if (evt.key === 'ArrowDown') {
                if (this.isModeDeselected() || this.isModeEditing()) {
                    return;
                }
                if (this.isModeTopSubitemSelected()) {
                    this.actionMoveItemDown(evt);
                }
                else {
                    this.actionMoveSubitemDown(evt);
                }
            }
            else if (evt.key === 'ArrowLeft') {
                if (this.isModeTopSubitemSelected()) {
                    return;
                }
                if (this.isModeDeselected() || this.isModeEditing()) {
                    return;
                }
                this.actionOutdent(evt);
            }
            else if (evt.key === 'ArrowRight') {
                if (this.isModeTopSubitemSelected()) {
                    return;
                }
                if (this.isModeDeselected() || this.isModeEditing()) {
                    return;
                }
                this.actionIndent(evt);
            }
        };

        // Click event delegation
        container.addEventListener('click', function(evt) {
            if (evt.target.matches('a')) {
                this.actionClickLink(evt);
            }

            if (evt.target.matches('.subitem')) {
                if (evt.target.classList.contains("subitem-redacted")) {
                    alert('Cannot select a redacted subitem.');
                    return;
                }
                this.actionClickSubitem(evt);
            }
        });

        // Mousedown event delegation
        container.addEventListener('mousedown', function(evt) {

            if (evt.target.parentElement.matches('.tag-todo')) {
                this.actionToggleTodo(evt);
            }

            if (evt.target.parentElement.matches('.tag-done')) {
                this.actionToggleTodo(evt);
            }

            if (evt.target.parentElement.matches('.expand')) {
                this.actionToggleOutline(evt);
            }

            if (evt.target.parentElement.matches('.collapse')) {
                this.actionToggleOutline(evt);
            }

            if (evt.target.matches('.subitem')) {
                this.actionMousedownSubitem(evt);
            }
        });

        document.body.addEventListener('mousedown', (evt) => {
            console.log(`document.body: evt.target ${evt.target} | evt.currentTarget ${evt.currentTarget}`)
            this.actionDeselect(evt);
        });
    }

    selectItemSubitemIntoEditMode(itemSubitemId) {
        const subitem = document.querySelector(`.subitem[data-id="${itemSubitemId}"]`);
        // Function to simulate a click event
        const simulateClick = (element) => {
            console.log('simulateClick');
            const event = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          element.dispatchEvent(event);
        };

        const simulateMousedown = (element) => {
            console.log('simulateMousedown');
            const event = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          element.dispatchEvent(event);
        };

        // Trigger the click event twice
        if (subitem) {
            simulateClick(subitem);
            simulateMousedown(subitem); //TODO: experiment to see if this is still needed
            setTimeout(() => {
                subitem.setAttribute('contentEditable', 'true');
                subitem.focus();
                console.log("Element focused:", document.activeElement === subitem);
            }, 0);
        }
    }

    renderItems(items) {
        let t1 = Date.now();
        let formatter = (item) => {
            return itemFormatter(item, state.selectedItemSubitemId);
        }
        const container = document.querySelector('#my-items-list');
        vdomUpdate(_items, items, formatter, container);
        console.log(`+++ rendering ${items.length} items`);
        this.updateItemsCache(items);
        let t2 = Date.now();
        console.log(`updated/rendered ${items.length} items in ${(t2 - t1)}ms`);
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

    refreshSelectionHighlights() {
        let els = Array.from(document.querySelectorAll('.subitem-action'));
        els.forEach(el => el.classList.remove('subitem-action'));
        els.forEach(el => el.removeAttribute('contenteditable'));
        //add new highlights
        if (state.selectedItemSubitemId !== null) {
            let id = state.selectedItemSubitemId;
            let query = `.subitem[data-id="${id}"]`;
            let el = document.querySelector(query);
            if (el !== null) {
                el.classList.add('subitem-action');
                el.setAttribute('contenteditable', 'true');
                el.addEventListener('paste', this.actionPasteSubitemContentEditable);
                el.addEventListener('input', this.actionInputSubitemContentEditable);
            }
            else {
                console.log('selection appears to be no longer valid');
                this.actionDeselect();
            }
        }
    }

    updateItemsCache(items) {
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
                //state.selectedItemSubitemId = null;  //TODO: not sure about this
                this.actionDeselect();
            }
            subitemIndex++;
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

    async paginationCheck() {
        const itemEls = document.querySelectorAll('.item');
        let topmostItemId = null;
        let lowestItemId = null;
        let topmostItemTop = Infinity;
        let lowestItemBottom = -Infinity;
        itemEls.forEach(itemEl => {
            const rect = itemEl.getBoundingClientRect();
            const isVisible = (rect.top < window.innerHeight) && (rect.bottom > 0);

            // If the item is visible and higher (smaller top value) than the current topmost
            if (isVisible && rect.top < topmostItemTop) {
              topmostItemTop = rect.top;
              topmostItemId = parseInt(itemEl.id);
            }

            // If the item is visible and lower (greater bottom value) than the current lowest
            if (isVisible && rect.bottom > lowestItemBottom) {
              lowestItemBottom = rect.bottom;
              lowestItemId = parseInt(itemEl.id);
            }
        });

        //paginationBuffer
        let lowBuffer = 0;
        for (let i = _items.length-1; i >= 0; i--) {
            if (_items[i].id === lowestItemId) {
                break;
            }
            lowBuffer++;
        }

        if (lowBuffer < paginationBuffer) {
            console.log(`pagination: lowBuffer = ${lowBuffer}`);
            state.totalItemsToReturn += paginationExpandBy;
            let result = await genericRequestV2(null, state, "/pagination-update");
            this.genericUpdateFromServer(result, false);
        }
    }

    subscribeToPubSubEvents() {

        PubSub.subscribe(EVT_SEARCH_FOCUS, (msg, data) => {
            this.actionDeselect();
        });

        PubSub.subscribe(EVT_SEARCH_UPDATED, (msg, data) => {
            state.totalItemsToReturn = initialItemsToReturn; //reset for any new search
            this.actionDeselect();
            window.scrollTo(0, 0);
        });

        PubSub.subscribe(EVT_SEARCH_RETURN, (msg, data) => {
            this.genericUpdateFromServer(data, true);
        });
    }

    genericUpdateFromServer(data, scrollIntoView, enterEditingMode) {
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

        if (data['newSelectedItemSubitemId'] !== undefined) {
            console.log(`newSelectedItemSubitemId = ${data['newSelectedItemSubitemId']}`);
            let newItemSubitemId = data['newSelectedItemSubitemId'];
            if (newItemSubitemId !== state.selectedItemSubitemId) {
                if (newItemSubitemId === null && state.selectedItemSubitemId !== null) {
                    this.actionDeselect();
                }
                else {
                    this.actionSelect(newItemSubitemId);
                }
            }
            else {
                if (newItemSubitemId !== null) {
                    this.actionReselect();
                }
            }
            if (enterEditingMode) {
                this.selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
            }
            if (scrollIntoView && state.selectedItemSubitemId !== null) {
                const itemId = state.selectedItemSubitemId.split(':')[0];
                const el = document.getElementById(itemId);
                if (el === null) {
                    alert('error: el is null');
                    return;
                }
                console.log('begin autoscrolling');
                el.scrollIntoView({behavior: "auto", block: "nearest", inline: "nearest"});
            }
        }
        else {
            if (state.selectedItemSubitemId !== null) {
                this.actionDeselect();
            }
        }
        this.refreshSelectionHighlights();  //maybe redundant, but oh well
    }

    replaceItemsInDom(items) {
        for (let item of items) {
            //if the item has no matched subitems, remove the item from the DOM completely
            if (item === null || item['subitems'][0]['_match'] === undefined) {
                currentNode.remove();
                continue;
            }
            let currentNode = document.querySelector(`[id="${item.id}"]`);
            let newNode = document.createElement('div');
            currentNode.replaceWith(newNode);
            newNode.outerHTML = itemFormatter(item, state.selectedItemSubitemId);
            newNode = document.getElementById(item.id); // Re-target the new element
            this.filterSelectedSubitems(item);
            this.refreshSelectionHighlights();
        }
    }
}

customElements.define('items-list', ItemsList);