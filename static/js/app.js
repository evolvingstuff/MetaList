"use strict";

import {
    EVT_EDIT_SUBITEM,
    EVT_TOGGLE_OUTLINE,
    EVT_TOGGLE_TODO,
    EVT_TOGGLE_OUTLINE_RETURN,
    EVT_TOGGLE_TODO_RETURN,
    EVT_ADD_ITEM_TOP,
    EVT_ADD_ITEM_TOP_RETURN,
    EVT_ADD_ITEM_SIBLING,
    EVT_ADD_ITEM_SIBLING_RETURN,
    EVT_ADD_SUBITEM_SIBLING,
    EVT_ADD_SUBITEM_SIBLING_RETURN,
    EVT_ADD_SUBITEM_CHILD,
    EVT_ADD_SUBITEM_CHILD_RETURN,
    EVT_DELETE_SUBITEM,
    EVT_DELETE_SUBITEM_RETURN,
    EVT_MOVE_ITEM_UP,
    EVT_MOVE_ITEM_UP_RETURN,
    EVT_MOVE_ITEM_DOWN,
    EVT_MOVE_ITEM_DOWN_RETURN,
    EVT_MOVE_SUBITEM_UP,
    EVT_MOVE_SUBITEM_UP_RETURN,
    EVT_MOVE_SUBITEM_DOWN,
    EVT_MOVE_SUBITEM_DOWN_RETURN,
    EVT_INDENT,
    EVT_INDENT_RETURN,
    EVT_OUTDENT,
    EVT_OUTDENT_RETURN,
    EVT_PASTE_SIBLING,
    EVT_PASTE_SIBLING_RETURN,
    EVT_PASTE_CHILD,
    EVT_PASTE_CHILD_RETURN,
    EVT_PAGINATION_UPDATE,
    EVT_PAGINATION_UPDATE_RETURN
} from './components/items-list.js';

import {
    EVT_SEARCH_UPDATED,
    EVT_SEARCH_RETURN
} from './components/search-bar.js';

export const state = {
    pendingQuery: null,
    mostRecentQuery: null,
    serverIsBusy: false,
    modeLocked: false
}

export const EVT_T = 'evt-t';  //Toggles todo/done
export const EVT_STAR = 'evt-star';  //Bulleted list
export const EVT_NUM = 'evt-num';  //Numbered list
export const EVT_CTRL_C = 'evt-ctrl-c';  //copy
export const EVT_CTRL_V = 'evt-ctrl-v';  //paste sibling
export const EVT_CTRL_X = 'EVT_CTRL_X';  //cut
export const EVT_CTRL_SHIFT_V = 'EVT_CTRL_SHIFT_V'; //paste child
export const EVT_CTRL_Z = 'evt-ctrl-z';  //undo
export const EVT_CTRL_Y = 'evt-ctrl-y';  //redo
export const EVT_CTRL_SHIFT_ENTER = 'evt-ctrl-shift-enter';  //new child
export const EVT_CTRL_ENTER = 'evt-ctrl-enter'; //new sibling
export const EVT_SHIFT_TAB = 'evt-shift-tab';  //outdent
export const EVT_SPACE = 'evt-space';  //toggle outline
export const EVT_TAB = 'evt-tab';  //indent
export const EVT_ENTER = 'evt-enter';  //add new item?
export const EVT_ESCAPE = 'evt-escape';  //exit selection
export const EVT_DELETE = 'evt-delete';  //delete selection
export const EVT_UP = 'evt-up';  //move selection up
export const EVT_DOWN = 'evt-down';  //move selection down
export const EVT_LEFT = 'evt-left';  //dedent selection
export const EVT_RIGHT = 'evt-right';  //indent selection
export const EVT_SCROLL = 'EVT_SCROLL';
export const EVT_RESIZE = 'EVT_RESIZE';

const debugShowLocked = false;
const hideImpliesTagByDefault = true;


window.onload = function(event) {
    console.log('$server_proxy: window.onload');

    PubSub.subscribe(EVT_ADD_ITEM_TOP, (msg, data) => {
        genericRequest(data.state,
            "/add-item-top", EVT_ADD_ITEM_TOP_RETURN);
    });

    PubSub.subscribe(EVT_ADD_ITEM_SIBLING, (msg, data) => {
        genericRequest(data.state,
            "/add-item-sibling", EVT_ADD_ITEM_SIBLING_RETURN);
    });

    PubSub.subscribe(EVT_ADD_SUBITEM_SIBLING, (msg, data) => {
        genericRequest(data.state,
            "/add-subitem-sibling", EVT_ADD_SUBITEM_SIBLING_RETURN);
    });

    PubSub.subscribe(EVT_ADD_SUBITEM_CHILD, (msg, data) => {
        genericRequest(data.state,
            "/add-subitem-child", EVT_ADD_SUBITEM_CHILD_RETURN);
    });

    PubSub.subscribe(EVT_EDIT_SUBITEM, (msg, data) => {
        //TODO 2023.03.05: this is very naive because it sends an update on every keystroke
        genericRequest(data.state,
            "/update-subitem-content", null);
    });

    //TODO fix this signature to fit with other stuff
    PubSub.subscribe(EVT_SEARCH_UPDATED, (msg, searchFilter) => {
        state.mostRecentQuery = searchFilter;
        if (state.serverIsBusy) {
            console.log('server is busy, saving pending query');
            state.pendingQuery = searchFilter;
        }
        else {
            state.pendingQuery = null;
            state.serverIsBusy = true;
            search(searchFilter);
        }
    });

    PubSub.subscribe(EVT_SEARCH_RETURN, (msg, items) => {
        state.serverIsBusy = false;
        if (state.pendingQuery !== null) {
            console.log('server is no longer busy, sending pending query');
            state.pendingQuery = null;
            state.serverIsBusy = true;
            search(state.pendingQuery);
        }
    });

    PubSub.subscribe(EVT_TOGGLE_OUTLINE, (msg, data) => {
        genericRequest(data.state,
            "/toggle-outline", EVT_TOGGLE_OUTLINE_RETURN);
    });

    PubSub.subscribe(EVT_TOGGLE_TODO, (msg, data) => {
        genericRequest(data.state,
            "/toggle-todo", EVT_TOGGLE_TODO_RETURN);
    });

    PubSub.subscribe(EVT_DELETE_SUBITEM, (msg, data) => {
       genericRequest(data.state,
            "/delete-subitem", EVT_DELETE_SUBITEM_RETURN);
    });

    PubSub.subscribe(EVT_MOVE_ITEM_UP, (msg, data) => {
        genericRequest(data.state,
            "/move-item-up", EVT_MOVE_ITEM_UP_RETURN);
    });

    PubSub.subscribe(EVT_MOVE_ITEM_DOWN, (msg, data) => {
        genericRequest(data.state,
            "/move-item-down", EVT_MOVE_ITEM_DOWN_RETURN);
    });

    PubSub.subscribe(EVT_MOVE_SUBITEM_UP, (msg, data) => {
        genericRequest(data.state,
            "/move-subitem-up", EVT_MOVE_SUBITEM_UP_RETURN);
    });

    PubSub.subscribe(EVT_MOVE_SUBITEM_DOWN, (msg, data) => {
        genericRequest(data.state,
            "/move-subitem-down", EVT_MOVE_SUBITEM_DOWN_RETURN);
    });

    PubSub.subscribe(EVT_INDENT, (msg, data) => {
        genericRequest(data.state,
            "/indent", EVT_INDENT_RETURN);
    });

    PubSub.subscribe(EVT_OUTDENT, (msg, data) => {
        genericRequest(data.state,
            "/outdent", EVT_OUTDENT_RETURN);
    });

    PubSub.subscribe(EVT_PASTE_SIBLING, (msg, data) => {
        genericRequest(data.state,
            "/paste-sibling", EVT_PASTE_SIBLING_RETURN);
    });

    PubSub.subscribe(EVT_PASTE_CHILD, (msg, data) => {
        genericRequest(data.state,
            "/paste-child", EVT_PASTE_CHILD_RETURN);
    });

    PubSub.subscribe(EVT_PAGINATION_UPDATE, (msg, data) => {
        genericRequest(data.state,
            "/pagination-update", EVT_PAGINATION_UPDATE_RETURN);
    });

    //TODO want a centralized place to handle keyboard events
    document.onkeydown = function(evt) {

        console.log(evt.key);

        // These are all published synchronously so that the subscribers can
        // handle/cancel the default events.

        //TODO: how to make this compatible with keyboard reconfig in the future?

        if (evt.ctrlKey) {
            if (evt.shiftKey) {
                if (evt.key === 'Enter') {
                    PubSub.publishSync(EVT_CTRL_SHIFT_ENTER, {evt: evt});
                }
                else if (evt.key === 'V') {
                    PubSub.publishSync(EVT_CTRL_SHIFT_V, {evt:evt});
                }
            }
            else {
                if (evt.key === 'c') {
                    PubSub.publishSync(EVT_CTRL_C, {evt:evt});
                }
                else if (evt.key === 'v') {
                    PubSub.publishSync(EVT_CTRL_V, {evt:evt});
                }
                else if (evt.key === 'x') {
                    PubSub.publishSync(EVT_CTRL_X, {evt:evt});
                }
                else if (evt.key === 'z') {
                    PubSub.publishSync(EVT_CTRL_Z, {evt:evt});
                }
                else if (evt.key === 'y') {
                    PubSub.publishSync(EVT_CTRL_Y, {evt: evt});
                }
                else if (evt.key === 'Enter') {
                    PubSub.publishSync(EVT_CTRL_ENTER, {evt: evt});
                }
            }
        }
        else if (evt.shiftKey) {
            if (evt.key === 'Tab') {
                PubSub.publishSync(EVT_SHIFT_TAB, {evt:evt});
            }
            else if (evt.key === '*') {
                PubSub.publishSync(EVT_STAR, {evt:evt});
            }
            else if (evt.key === '#') {
                PubSub.publishSync(EVT_NUM, {evt:evt});
            }
        }
        else if (evt.key === 'Tab') {
            PubSub.publishSync(EVT_TAB, {evt:evt});
        }
        else if (evt.key === ' ') {
            PubSub.publishSync(EVT_SPACE, {evt:evt});
        }
        else if (evt.key === 't') {
            PubSub.publishSync(EVT_T, {evt:evt});
        }
        else if (evt.key === "Enter") {
            PubSub.publishSync(EVT_ENTER, {evt:evt});
        }
        else if (evt.key === "Escape") {
            PubSub.publishSync(EVT_ESCAPE, {evt:evt});
        }
        else if (evt.key === "Delete" || evt.key === "Backspace") {
            PubSub.publishSync(EVT_DELETE, {evt:evt});
        }
        else if (evt.key === 'ArrowUp') {
            PubSub.publishSync(EVT_UP, {evt:evt});
        }
        else if (evt.key === 'ArrowDown') {
            PubSub.publishSync(EVT_DOWN, {evt:evt});
        }
        else if (evt.key === 'ArrowLeft') {
            PubSub.publishSync(EVT_LEFT, {evt:evt});
        }
        else if (evt.key === 'ArrowRight') {
            PubSub.publishSync(EVT_RIGHT, {evt:evt});
        }
    };

    window.addEventListener('resize', function(evt) {
        PubSub.publishSync(EVT_RESIZE, {evt: evt});
    });

    window.addEventListener('scroll', function(evt) {
        PubSub.publishSync(EVT_SCROLL, {evt: evt});
    });
}


//TODO: refactor to be part of generic search?
let search = async function(filter) {
    if (hideImpliesTagByDefault) {
        if (!filter.negated_tags.includes('@implies') &&
            !filter.tags.includes('@implies') &&
            filter.partial_tag !== '@implies') {
            console.log('adding @implies to negated tags');
            filter.negated_tags.push('@implies');
        }
    }
    try {
        let request = {
            searchFilter: filter
        }
        let response = await fetch("/search", {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });
        let searchResults = await response.json();
        PubSub.publish(EVT_SEARCH_RETURN, searchResults);
    } catch (error) {
        console.log(error);
        //TODO publish the error
    }
}

let genericRequest = async function(itemsListState, endpoint, returnEvent){
    try {
        if (state.modeLocked) {
            console.log('mode locked, ignoring request');
            return;
        }
        state.modeLocked = true;
        if (debugShowLocked) {
            document.body.style['background-color'] = 'red';
        }
        let request = {
            itemsListState: itemsListState,
            searchFilter: state.mostRecentQuery
        }
        let response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });
        let result = await response.json();
        state.modeLocked = false;
        if (debugShowLocked) {
            document.body.style['background-color'] = 'white';
        }
        if (returnEvent !== null) {
            PubSub.publish(returnEvent, result);
        }
    } catch (error) {
        console.log(error);
        //TODO publish the error
    }
}
