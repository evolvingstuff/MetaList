'use strict';

import {
    itemFormatter,
    copyHtmlToClipboard
} from '../misc/item-formatter';

import { genericRequest } from '../misc/server-proxy';
import { vdomUpdate } from '../misc/vdom';

import {
    EVT_SEARCH_UPDATED,
    EVT_SEARCH_FOCUS,
    EVT_DESELECT_ITEMSUBITEM,
    EVT_SELECT_ITEMSUBITEM,
    EVT_RESELECT_ITEMSUBITEM,
    EVT_TAGS_UPDATED,
    EVT_TAGS_UPDATED_SUGGESTIONS,
    EVT_SELECT_CITATION,
} from '../pub-sub-events';

import {
    state,
    state2
} from '../app-state';

import {
    initialItemsToReturn,
    infiniteScrolling,
    paginationBuffer,
    paginationExpandBy,
    checkPaginationMs
} from '../config';

let itemsCache = {};

const bouncePixelsTop = 85;
const bouncePixelsBottom = 85;


class ItemsList extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }

    connectedCallback() {
        this.myId = this.getAttribute('id');
        this.subscribeToPubSubEvents();
        if (infiniteScrolling) {
                setInterval(() => {
                this.paginationCheck();
            }, checkPaginationMs);
        }
        let container = document.getElementById('my-items-list');
        this.addEventToActionMap(container);
        state.totalItemsToReturn = initialItemsToReturn;
        PubSub.publishSync(EVT_SEARCH_UPDATED, null);
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
        if (this.isModeTextSearching()) {
            alert('Cannot add items while quote text searching');
            return;
        }
        genericRequest(evt, "/add-item-top", state, this.reactionAddItemTop);
    }

    reactionAddItemTop = (result) =>  {
        this.genericUpdateFromServer(result, {
            'enterEditingMode': true,
            'scrollToTop': true
        });
    };

    actionAddSubitemChild(evt) {
        if (this.isModeTextSearching()) {
            //TODO: technically this should always work, but I'm adding for consistency
            alert('Cannot add items while quote text searching');
            return;
        }
        genericRequest(evt, "/add-subitem-child", state, this.reactionAddSubitemChild);
    }

    reactionAddSubitemChild = (result) =>  {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true,
            'enterEditingMode': true
        });
    };

    actionPasteChild(evt) {
        genericRequest(evt, "/paste-child", state, this.reactionPasteChild);
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
        genericRequest(evt, "/paste-sibling", state, this.reactionPasteSibling);
    }

    reactionPasteSibling = (result) =>  {
        this.genericUpdateFromServer(result, {});
    };

    actionDeleteSubitem(evt) {
        genericRequest(evt, "/delete-subitem", state, this.reactionDeleteSubitem);
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

        genericRequest(evt, "/delete-subitem", state, this.reactionCutSubitem);
    }

    reactionCutSubitem = (result) =>  {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionAddItemSibling(evt) {
        if (this.isModeTextSearching()) {
            alert('Cannot add items while quote text searching');
            return;
        }
        genericRequest(evt, "/add-item-sibling", state, this.reactionAddItemSibling);
    }

    reactionAddItemSibling = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true,
            'enterEditingMode': true
        });
    };

    actionAddSubitemSibling(evt) {
        if (this.isModeTextSearching()) {
            alert('Cannot add items while quote text searching');
            return;
        }
        genericRequest(evt, "/add-subitem-sibling", state, this.reactionAddSubitemSibling);
    }

    reactionAddSubitemSibling = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true,
            'enterEditingMode': true
        });
    };

    actionMoveItemUp(evt) {
        genericRequest(evt, "/move-item-up", state, this.reactionMoveItemUp);
    }

    reactionMoveItemUp = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionMoveSubitemUp(evt) {
        genericRequest(evt, "/move-subitem-up", state, this.reactionMoveSubitemUp);
    }

    reactionMoveSubitemUp = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionMoveItemDown(evt) {
        genericRequest(evt, "/move-item-down", state, this.reactionMoveItemDown);
    }

    reactionMoveItemDown = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionMoveSubitemDown(evt) {
        genericRequest(evt, "/move-subitem-down", state, this.reactionMoveSubitemDown);
    }

    reactionMoveSubitemDown = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionOutdent(evt) {
        genericRequest(evt, "/outdent", state, this.reactionOutdent);
    }

    reactionOutdent = (result) => {
        this.genericUpdateFromServer(result, {});
    };

    actionIndent(evt) {
        genericRequest(evt, "/indent", state, this.reactionIndent);
    }

    reactionIndent = (result) => {
        this.genericUpdateFromServer(result, {});
    };

    actionClickLink(evt) {
        this.handleEvent(evt);
        let url = evt.target.href;
        console.log(`Opening link in new tab: ${url}`);
        window.open(url, '_blank');
    }

    actionMousedownSubitem(evt, subEl) {
        let itemSubitemId = subEl.getAttribute('data-id');
        if (state.selectedItemSubitemId === null || state.selectedItemSubitemId !== itemSubitemId) {
            this.handleEvent(evt);
            this.actionSelect(itemSubitemId);
        }
        else if (state.selectedItemSubitemId === itemSubitemId) {
            console.log('Enter edit mode');
            subEl.classList.add('subitem-editing');
            state.modeEditing = true;
        }
        evt.stopPropagation();
    }

    actionTodo(evt) {
        let itemSubitemId = evt.target.parentElement.getAttribute('data-id');
        this.actionSelect(itemSubitemId);
        genericRequest(evt, "/todo", state, this.reactionTodo);
    }

    reactionTodo = (result) => {
        this.genericUpdateFromServer(result, {
            'reselectAfter': true
        });
    };

    actionDone(evt) {
        let itemSubitemId = evt.target.parentElement.getAttribute('data-id');
        this.actionSelect(itemSubitemId);
        genericRequest(evt, "/done", state, this.reactionDone);
    }

    reactionDone = (result) => {
        this.genericUpdateFromServer(result, {
            'reselectAfter': true
        });
    };

    actionExpand(evt) {
        let itemSubitemId = evt.target.parentElement.getAttribute('data-id');
        this.actionSelect(itemSubitemId);
        genericRequest(evt, "/expand", state, this.reactionExpand);
    }

    reactionExpand = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    };

    actionCollapse(evt) {
        let itemSubitemId = evt.target.parentElement.getAttribute('data-id');
        this.actionSelect(itemSubitemId);
        genericRequest(evt, "/collapse", state, this.reactionCollapse);
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
        genericRequest(evt, "/update-subitem-content", state, null);
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
            PubSub.publishSync(EVT_DESELECT_ITEMSUBITEM, null);
        }
    }

    actionSelect = (newItemSubitemId) => {
        if (state.selectedItemSubitemId === newItemSubitemId) {
            console.log('already selected...');
            return;
        }
        let prevItemSubitemId = state.selectedItemSubitemId;
        let toReplace = this.itemsToUpdateBasedOnSelectionChange(prevItemSubitemId, newItemSubitemId);
        state.selectedItemSubitemId = newItemSubitemId;
        state.modeEditing = false;
        this.replaceItemsInDom(toReplace);
        if (state.selectedItemSubitemId !== null) {
            let itemId = parseInt(state.selectedItemSubitemId.split(':')[0]);
            this.refreshSelectionHighlights(); //redundant?
            console.log(itemsCache[itemId]);
            PubSub.publishSync(EVT_SELECT_ITEMSUBITEM, {
                'item': itemsCache[itemId],
                'itemSubitemId': state.selectedItemSubitemId
            });
        }
    }

    actionReselect = () => {
        if (state.selectedItemSubitemId === null) {
            console.log('nothing selected?');
            return;
        }
        let itemId = parseInt(state.selectedItemSubitemId.split(':')[0]);
        PubSub.publishSync(EVT_RESELECT_ITEMSUBITEM, {
            'item': itemsCache[itemId],
            'itemSubitemId': state.selectedItemSubitemId
        });
    }

    actionUpdateTags(data) {
        if (state.selectedItemSubitemId === null) {
            console.error('no selected subitem?');
            return;
        }
        genericRequest(null, "/update-tags", state, this.reactionUpdateTags);
    }

    reactionUpdateTags = (result) => {
        this.genericUpdateFromServer(result, {});
        console.log('reactionUpdateTags()');
        PubSub.publishSync(EVT_TAGS_UPDATED_SUGGESTIONS, null);
    };

    async actionUpdateSearch() {
        state.totalItemsToReturn = initialItemsToReturn;
        this.actionDeselect();
        await genericRequest(null, '/search', state, this.reactionUpdateSearch);
        await genericRequest(null, '/search-suggestions', state, this.reactionSearchSuggestions);
    }

    reactionUpdateSearch = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollToTop': true
        });
    };

    reactionSearchSuggestions = (result) => {
        const suggestionsList = document.getElementById('my-search-suggestions');
        suggestionsList.updateSuggestions(result['searchSuggestions']);
    }

    actionUndo(evt) {
        if (this.isModeEditing()) {
            //use default undo
            return;
        }
        genericRequest(evt, "/undo", state, this.reactionUndo);
    }

    reactionUndo = (result) => {
        if ('noop' in result) {
            return;
        }
        this.actionDeselect();
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    }

    actionRedo(evt) {
        if (this.isModeEditing()) {
            //use default undo for contentEditable
            return;
        }
        genericRequest(evt, "/redo", state, this.reactionRedo);
    }

    reactionRedo = (result) => {
        if ('noop' in result) {
            return;
        }
        this.actionDeselect();
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true
        });
    }

    actionOpenTo(itemSubitemId) {
        this.actionDeselect();
        state.selectedItemSubitemId = itemSubitemId;
        genericRequest(null, "/open-to", state, this.reactionOpenTo);
    }

    reactionOpenTo = (result) => {
        this.genericUpdateFromServer(result, {
            'scrollIntoView': true,
            'highlightSelected': true
        });
    }

    async actionCopyable(evt) {
        this.handleEvent(evt);
        function getTextWithNewlines(element) {
            let text = '';
            for (const node of element.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    text += node.nodeValue;
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.nodeName === 'BR') {
                        text += '\n';
                    } else if (node.nodeName === 'DIV') {
                        text += '\n' + getTextWithNewlines(node) + '\n';
                    } else {
                        text += getTextWithNewlines(node);
                    }
                }
            }
            return text;
        }
        const subitemData = getTextWithNewlines(evt.target);
        try {
            await navigator.clipboard.writeText(subitemData);
            console.log('Subitem data copied to clipboard.');
            evt.target.classList.add('copyable-clicked');
            setTimeout(() => {
                evt.target.classList.remove('copyable-clicked');
            }, 300);
        } catch (err) {
            console.error('Error in copying text: ', err);
        }
    }

    ////////////////////////////////////////////////////

    addEventToActionMap(container) {

        container.addEventListener('mousedown', function(evt) {
            if (evt.target.matches('a')) {
                this.actionClickLink(evt);
                this.handleEvent(evt);
            }
        }, true); // true here sets the listener in the capturing phase

        container.addEventListener('click', function(evt) {
            if (evt.target.matches('a')) {
                this.handleEvent(evt);
            }
        }, true); // true here sets the listener in the capturing phase

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
                            //alert('nothing selected to copy from');
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
                    else if (evt.key === 'z') {
                        this.actionUndo(evt);
                    }
                    else if (evt.key === 'y') {
                        this.actionRedo(evt);
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

            if (evt.target.matches('.copyable')) {
                this.actionCopyable(evt);
                return;
            }

            let subEl = this.getSubitemElement(evt);
            if (subEl) {
                this.actionMousedownSubitem(evt, subEl);
            }
        });

        document.body.addEventListener('mousedown', (evt) => {
            console.log(`document.body: evt.target ${evt.target} | evt.currentTarget ${evt.currentTarget}`)
            this.actionDeselect(evt);
        });
    }

    getSubitemElement(evt) {
        let targetElement = evt.target.closest('.subitem');
        if (targetElement) {
            if (targetElement.classList.contains("subitem-redacted")) {
                alert('Cannot select a redacted subitem.');
                this.handleEvent(evt);
                return null;
            }
            return targetElement;
        }
        return null;
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

    renderItems(newItems) {
        let t1 = Date.now();
        let formatter = (item) => {
            return itemFormatter(item, state.selectedItemSubitemId, state.modeEditing);
        }
        const container = document.querySelector('#my-items-list');
        vdomUpdate(state2.recentItems, newItems, formatter, container);
        state2.recentItems = newItems;
        this.updateItemsCache(newItems);
        let t2 = Date.now();
        console.log(`updated/rendered ${newItems.length} items in ${(t2 - t1)}ms`);
    }

    itemsToUpdateBasedOnSelectionChange(oldSelectedItemSubitemId, newSelectedItemSubitemId) {
        let unionSub = new Set();
        if (oldSelectedItemSubitemId !== null) {
            unionSub.add(oldSelectedItemSubitemId);
        }
        if (newSelectedItemSubitemId !== null) {
            unionSub.add(newSelectedItemSubitemId);
        }
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

    updateItemsCache(newItems) {
        if (newItems.length == 0) {
            itemsCache = {};
        }
        else {
            for (let item of newItems) {
                itemsCache[item.id] = item;
            }
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

    isModeTextSearching() {
        if (state.searchFilter['texts'].length > 0 ||
            state.searchFilter['partial_text'] !== null ||
            state.searchFilter['negated_texts'].length > 0 ||
            state.searchFilter['negated_partial_text'] !== null
        ) {
            return true;
        }
        return false;
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
        for (let i = state2.recentItems.length-1; i >= 0; i--) {
            if (state2.recentItems[i].id === lowestItemId) {
                break;
            }
            lowBuffer++;
        }

        if (lowBuffer < paginationBuffer) {
            console.log(`pagination: lowBuffer = ${lowBuffer}`);
            state.totalItemsToReturn += paginationExpandBy; ///TODO: we do not want to return
            //state.totalItemsToReturn = lowBuffer + paginationExpandBy;
            genericRequest(null, "/pagination-update", state, this.reactionPagination);
        }
    }

    reactionPagination = (result) =>  {
        this.genericUpdateFromServer(result, {
                'scrollIntoView': false,
                'enterEditingMode': false
            });
    };

    subscribeToPubSubEvents() {

        PubSub.subscribe(EVT_SELECT_CITATION, (msg, data) => {
            this.actionOpenTo(data);
        });

        PubSub.subscribe(EVT_TAGS_UPDATED, (msg, data) => {
            this.actionUpdateTags(data);
        });

        PubSub.subscribe(EVT_SEARCH_FOCUS, (msg, data) => {
            this.actionDeselect();
        });

        PubSub.subscribe(EVT_SEARCH_UPDATED,  (msg, data) => {
            this.actionUpdateSearch();
        });
    }


    genericUpdateFromServer(data, postInstructions) {
        if (!data) {
            throw new Error('data is null or undefined');
        }
        if ('error' in data) {
            throw new Error(`ERROR: ${data['error']}`);
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

            if (postInstructions['enterEditingMode']) {
                this.selectItemSubitemIntoEditMode(state.selectedItemSubitemId);
            }
            if (postInstructions['scrollIntoView'] && state.selectedItemSubitemId !== null) {
                const el = document.querySelector(`.subitem[data-id="${state.selectedItemSubitemId}"]`);
                if (el === null) {
                    alert('error: el is null');
                    return;
                }
                console.log('begin autoscrolling');
                const originalScrollY = window.scrollY;
                el.scrollIntoView({behavior: "auto", block: "nearest", inline: "nearest"});
                const newScrollY = window.scrollY;
                if (newScrollY > originalScrollY) {
                    console.log("Scrolled Downwards");
                    window.scrollTo(0, newScrollY + bouncePixelsTop);
                } else if (newScrollY < originalScrollY) {
                    console.log("Scrolled Upwards");
                    window.scrollTo(0, newScrollY - bouncePixelsBottom);
                } else {
                    console.log("No Scrolling Occurred");
                }
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
        if (postInstructions['highlightSelected'] && state.selectedItemSubitemId !== null) {
            const subitem = document.querySelector(`.subitem[data-id="${state.selectedItemSubitemId}"]`);
            if (subitem) {
                subitem.classList.add('highlight');
            }
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
            newNode.outerHTML = itemFormatter(item, state.selectedItemSubitemId, state.modeEditing);
            newNode = document.getElementById(item.id); // Re-target the new element
            this.filterSelectedSubitems(item);
            this.refreshSelectionHighlights();
        }
    }
}

customElements.define('items-list', ItemsList);