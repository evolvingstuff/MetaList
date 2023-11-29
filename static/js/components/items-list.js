'use strict';

import {
    itemFormatter,
    copyHtmlToClipboard
} from '../misc/item-formatter.js';

import {
    genericRequestV3
} from '../misc/server-proxy.js';

import {
    vdomUpdate
} from '../misc/vdom.js';

import {
    EVT_SEARCH_UPDATED,
    EVT_SEARCH_FOCUS,
    EVT_DESELECT_ITEMSUBITEM,
    EVT_SELECT_ITEMSUBITEM,
    EVT_RESELECT_ITEMSUBITEM,
    EVT_TAGS_UPDATED
} from '../pub-sub-events.js';

import {
    state
} from "../app-state.js";

import {
    initialItemsToReturn,
    infiniteScrolling,
    paginationBuffer,
    paginationExpandBy,
    checkPaginationMs
} from '../config.js';

let itemsCache = {};
let previousItems = [];

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
        state.totalItemsToReturn = initialItemsToReturn;
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

    actionAddItemTop(evt) {
        genericRequestV3(evt, "/add-item-top", this.reactionAddItemTop);
    }

    reactionAddItemTop = (result) =>  {
        this.genericUpdateFromServer(result, {
            'enterEditingMode': true,
            'scrollToTop': true
        });
    };

    actionAddSubitemChild(evt) {
        genericRequestV3(evt, "/add-subitem-child", this.reactionAddSubitemChild);
    }

    reactionAddSubitemChild = (result) =>  {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true,
            'enterEditingMode': true
        });
    };

    actionPasteChild(evt) {
        genericRequestV3(evt, "/paste-child", this.reactionPasteChild);
    }

    reactionPasteChild = (result) =>  {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

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

    actionPasteSibling(evt) {
        genericRequestV3(evt, "/paste-sibling", this.reactionPasteSibling);
    }

    reactionPasteSibling = (result) =>  {
        this.genericUpdateFromServer(result, {});
    };

    actionDeleteSubitem(evt) {
        genericRequestV3(evt, "/delete-subitem", this.reactionDeleteSubitem);
    }

    reactionDeleteSubitem = (result) =>  {
        this.genericUpdateFromServer(result, {});
    };

    actionCutSubitem(evt) {
        const itemId = state.selectedItemSubitemId.split(':')[0]
        const subitemIndex = state.selectedItemSubitemId.split(':')[1]
        state.clipboard = {
            'item': JSON.parse(JSON.stringify(itemsCache[itemId])),
            'subitemIndex': subitemIndex
        }

        genericRequestV3(evt, "/delete-subitem", this.reactionCutSubitem);
    }

    reactionCutSubitem = (result) =>  {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionAddItemSibling(evt) {
        genericRequestV3(evt, "/add-item-sibling", this.reactionAddItemSibling);
    }

    reactionAddItemSibling = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true,
            'enterEditingMode': true
        });
    };

    actionAddSubitemSibling(evt) {
        genericRequestV3(evt, "/add-subitem-sibling", this.reactionAddSubitemSibling);
    }

    reactionAddSubitemSibling = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionMoveItemUp(evt) {
        genericRequestV3(evt, "/move-item-up", this.reactionMoveItemUp);
    }

    reactionMoveItemUp = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionMoveSubitemUp(evt) {
        genericRequestV3(evt, "/move-subitem-up", this.reactionMoveSubitemUp);
    }

    reactionMoveSubitemUp = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionMoveItemDown(evt) {
        genericRequestV3(evt, "/move-item-down", this.reactionMoveItemDown);
    }

    reactionMoveItemDown = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionMoveSubitemDown(evt) {
        genericRequestV3(evt, "/move-subitem-down", this.reactionMoveSubitemDown);
    }

    reactionMoveSubitemDown = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionOutdent(evt) {
        genericRequestV3(evt, "/outdent", this.reactionOutdent);
    }

    reactionOutdent = (result) => {
        this.genericUpdateFromServer(result, {});
    };

    actionIndent(evt) {
        genericRequestV3(evt, "/indent", this.reactionIndent);
    }

    reactionIndent = (result) => {
        this.genericUpdateFromServer(result, {});
    };

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
            state.modeEditing = true;
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

    actionTodo(evt) {
        let itemSubitemId = evt.target.parentElement.getAttribute('data-id');
        this.actionSelect(itemSubitemId);
        genericRequestV3(evt, "/todo", this.reactionTodo);
    }

    reactionTodo = (result) => {
        this.genericUpdateFromServer(result, {
            'reselectAfter': true
        });
    };

    actionDone(evt) {
        let itemSubitemId = evt.target.parentElement.getAttribute('data-id');
        this.actionSelect(itemSubitemId);
        genericRequestV3(evt, "/done", this.reactionDone);
    }

    reactionDone = (result) => {
        this.genericUpdateFromServer(result, {
            'reselectAfter': true
        });
    };

    actionExpand(evt) {
        let itemSubitemId = evt.target.parentElement.getAttribute('data-id');
        this.actionSelect(itemSubitemId);
        genericRequestV3(evt, "/expand", this.reactionExpand);
    }

    reactionExpand = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionCollapse(evt) {
        let itemSubitemId = evt.target.parentElement.getAttribute('data-id');
        this.actionSelect(itemSubitemId);
        genericRequestV3(evt, "/collapse", this.reactionCollapse);
    }

    reactionCollapse = (result) => {
        this.genericUpdateFromServer(result, {});
    };

    actionInputSubitemContentEditable(evt) {
        let itemSubitemId = evt.currentTarget.getAttribute('data-id');
        let newHtml = evt.currentTarget.innerHTML;
        let itemId = itemSubitemId.split(':')[0];
        let subitemIndex = parseInt(itemSubitemId.split(':')[1]);  //TODO: why do we need int?
        itemsCache[itemId]['subitems'][subitemIndex].data = newHtml;
        state.updatedContent = newHtml;
        genericRequestV3(evt, "/update-subitem-content", null);
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
        if (this.isModeEditing() || this.isModeSelected()) {
            let toReplace = this.itemsToUpdateBasedOnSelectionChange(state.selectedItemSubitemId, null);
            state.selectedItemSubitemId = null;
            state.modeEditing = false;
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
        state.modeEditing = false;
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

    actionUpdateTags(data) {
        if (state.selectedItemSubitemId === null) {
            console.error('no selected subitem?');
            return;
        }
        state.updatedTags = data;
        genericRequestV3(null, "/update-tags", this.reactionUpdateTags);
    }

    reactionUpdateTags = (result) => {
        this.genericUpdateFromServer(result, {});
    };

    actionNewSearch() {
        state.totalItemsToReturn = initialItemsToReturn;
        this.actionDeselect();
        genericRequestV3(null, '/search', this.reactionNewSearch);
    }

    reactionNewSearch = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollToTop': true
        });
    };

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
                this.actionDone(evt);
            }

            if (evt.target.parentElement.matches('.tag-done')) {
                this.actionTodo(evt);
            }

            if (evt.target.parentElement.matches('.expand')) {
                this.actionCollapse(evt);
            }

            if (evt.target.parentElement.matches('.collapse')) {
                this.actionExpand(evt);
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
        vdomUpdate(previousItems, items, formatter, container);
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
            return;
        }
        for (let item of items) {
            itemsCache[item.id] = item;
        }
        previousItems = items;
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
        return state.modeEditing;
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

    paginationCheck() {
        if (state.reachedScrollEnd) {
            return;
        }
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
        for (let i = previousItems.length-1; i >= 0; i--) {
            if (previousItems[i].id === lowestItemId) {
                break;
            }
            lowBuffer++;
        }

        if (lowBuffer < paginationBuffer) {
            console.log(`pagination: lowBuffer = ${lowBuffer}`);
            state.totalItemsToReturn += paginationExpandBy;
            genericRequestV3(null, "/pagination-update", this.reactionPagination);
        }
    }

    reactionPagination = (result) =>  {
        this.genericUpdateFromServer(result, {
                'scrollIntoView': false,
                'enterEditingMode': false
            });
    };

    subscribeToPubSubEvents() {

        PubSub.subscribe(EVT_TAGS_UPDATED, (msg, data) => {
            this.actionUpdateTags(data);
        });

        PubSub.subscribe(EVT_SEARCH_FOCUS, (msg, data) => {
            this.actionDeselect();
        });

        PubSub.subscribe(EVT_SEARCH_UPDATED,  (msg, data) => {
            this.actionNewSearch();
        });
    }


    genericUpdateFromServer(data, postInstructions) {
        if (!data) {
            console.log('data is null or undefined');
            return;
        }
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

        state.reachedScrollEnd = data['reachedScrollEnd'];

        const newSelectedItemSubitemId = data['newSelectedItemSubitemId']

        if (newSelectedItemSubitemId) {
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
                    console.log('debug: this.actionReselect');
                    console.log(newItemSubitemId);
                    this.actionReselect();
                }
            }

            if (postInstructions['enterEditingMode']) {
                this.selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
            }
            if (postInstructions['scrollIntoView'] && state.selectedItemSubitemId !== null) {
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
        if (postInstructions['reselectAfter']) {
            //this is a hack to refresh the tag editor if need be
            this.actionDeselect();
            this.actionSelect(newSelectedItemSubitemId);
        }
        this.refreshSelectionHighlights();  //maybe redundant, but oh well
        if (postInstructions['scrollToTop']) {
            window.scrollTo(0, 0);
        }
    }

    replaceItemsInDom(items) {
        for (let item of items) {
            let currentNode = document.querySelector(`[id="${item.id}"]`);
            //node has been deleted
            if (!currentNode) {
                continue;
            }
            //if the item has no matched subitems, remove the item from the DOM completely
            if (item === null || item['subitems'][0]['_match'] === undefined) {
                currentNode.remove();
                continue;
            }
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