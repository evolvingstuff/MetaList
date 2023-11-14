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
        debugger;
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
