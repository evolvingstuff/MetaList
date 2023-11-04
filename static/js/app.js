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

//TODO: why do we need this wrapper?
// Refactor: Just use functions and export them as needed
const $server_proxy = (function() {

    let hideImpliesTagByDefault = true;

    window.onload = function(event) {
        console.log('$server_proxy: window.onload');

        PubSub.subscribe(EVT_ADD_ITEM_TOP, (msg, data) => {
            $server_proxy.addItemTop(data.state);
        });

        PubSub.subscribe(EVT_ADD_ITEM_SIBLING, (msg, data) => {
            $server_proxy.addItemSibling(data.state);
        });

        PubSub.subscribe(EVT_ADD_SUBITEM_SIBLING, (msg, data) => {
            $server_proxy.addSubitemSibling(data.state);
        });

        PubSub.subscribe(EVT_ADD_SUBITEM_CHILD, (msg, data) => {
            $server_proxy.addSubitemChild(data.state);
        });

        PubSub.subscribe(EVT_EDIT_SUBITEM, (msg, data) => {
            $server_proxy.editSubitemContent(data.state);
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
                $server_proxy.search(searchFilter);
            }
        });

        PubSub.subscribe(EVT_TOGGLE_OUTLINE, (msg, data) => {
            $server_proxy.toggleOutline(data.state);
        });

        PubSub.subscribe(EVT_TOGGLE_TODO, (msg, data) => {
            $server_proxy.toggleTodo(data.state);
        });

        PubSub.subscribe(EVT_DELETE_SUBITEM, (msg, data) => {
           $server_proxy.deleteSubitem(data.state);
        });

        PubSub.subscribe(EVT_MOVE_ITEM_UP, (msg, data) => {
            $server_proxy.moveItemUp(data.state);
        });

        PubSub.subscribe(EVT_MOVE_ITEM_DOWN, (msg, data) => {
            $server_proxy.moveItemDown(data.state);
        });

        PubSub.subscribe(EVT_MOVE_SUBITEM_UP, (msg, data) => {
            $server_proxy.moveSubitemUp(data.state);
        });

        PubSub.subscribe(EVT_MOVE_SUBITEM_DOWN, (msg, data) => {
            console.log('data:')
            console.log(data);
            $server_proxy.moveSubitemDown(data.state);
        });

        PubSub.subscribe(EVT_INDENT, (msg, data) => {
            $server_proxy.indent(data.state);
        });

        PubSub.subscribe(EVT_OUTDENT, (msg, data) => {
            $server_proxy.outdent(data.state);
        });

        PubSub.subscribe(EVT_PASTE_SIBLING, (msg, data) => {
            $server_proxy.pasteSibling(data.state);
        });

        PubSub.subscribe(EVT_PASTE_CHILD, (msg, data) => {
            $server_proxy.pasteChild(data.state);
        });

        PubSub.subscribe(EVT_SEARCH_RETURN, (msg, items) => {
            state.serverIsBusy = false;
            if (state.pendingQuery !== null) {
                console.log('server is no longer busy, sending pending query');
                $server_proxy.search(state.pendingQuery);
                state.pendingQuery = null;
                state.serverIsBusy = true;
            }
        });

        PubSub.subscribe(EVT_PAGINATION_UPDATE, (msg, data) => {
            $server_proxy.paginationUpdate(data.state);
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

    return {

        //TODO: lots of code duplication
        // this should all be refactored

        editSubitemContent: async function(itemsListState) {
            //TODO 2023.03.05: this is very naive because it sends an update on every keystroke
            //We should fix that later, maybe upon exiting edit mode
            try {
                let request = {
                    itemsListState: itemsListState,
                    searchFilter: state.mostRecentQuery
                }
                let response = await fetch("/update-subitem-content", {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(request)
                });
                let results = await response.json();
                console.log(results);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        search: async function(filter) {
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
        },

        moveItemUp: async function(itemsListState){
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
                let response = await fetch("/move-item-up", {
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
                PubSub.publish(EVT_MOVE_ITEM_UP_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        moveItemDown: async function(itemsListState){
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
                let response = await fetch("/move-item-down", {
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
                PubSub.publish(EVT_MOVE_ITEM_DOWN_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        moveSubitemUp: async function(itemsListState){
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
                let response = await fetch("/move-subitem-up", {
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
                PubSub.publish(EVT_MOVE_SUBITEM_UP_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        moveSubitemDown: async function(itemsListState){
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
                console.log('request:');
                console.log(request);
                let response = await fetch("/move-subitem-down", {
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
                PubSub.publish(EVT_MOVE_SUBITEM_DOWN_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        indent: async function(itemsListState) {
            try {
                if (state.modeLocked) {
                    console.log('mode locked, ignoring indent request');
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
                let response = await fetch("/indent", {
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
                PubSub.publish(EVT_INDENT_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        outdent: async function(itemsListState) {
            try {
                if (state.modeLocked) {
                    console.log('mode locked, ignoring outdent request');
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
                let response = await fetch("/outdent", {
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
                PubSub.publish(EVT_OUTDENT_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        deleteSubitem: async function(itemsListState) {

            try {
                if (state.modeLocked) {
                    console.log('mode locked, ignoring delete subitem request');
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
                let response = await fetch("/delete-subitem", {
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
                PubSub.publish(EVT_DELETE_SUBITEM_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        toggleOutline: async function(itemsListState) {
            try {
                if (state.modeLocked) {
                    console.log('mode locked, ignoring toggle-outline request');
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
                let response = await fetch("/toggle-outline", {
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
                PubSub.publish(EVT_TOGGLE_OUTLINE_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        toggleTodo: async function(itemsListState) {
            try {
                if (state.modeLocked) {
                    console.log('mode locked, ignoring toggle-todo request');
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
                let response = await fetch("/toggle-todo", {
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
                PubSub.publish(EVT_TOGGLE_TODO_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        addItemSibling: async function(itemsListState) {
            try {
                if (state.modeLocked) {
                    console.log('mode locked, ignoring addItemSibling request');
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
                let response = await fetch("/add-item-sibling", {
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
                PubSub.publish(EVT_ADD_ITEM_SIBLING_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        addSubitemSibling: async function(itemsListState) {
            try {
                if (state.modeLocked) {
                    console.log('mode locked, ignoring addSubitemSibling request');
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
                let response = await fetch("/add-subitem-sibling", {
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
                PubSub.publish(EVT_ADD_SUBITEM_SIBLING_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        addSubitemChild: async function(itemsListState) {
            try {
                if (state.modeLocked) {
                    console.log('mode locked, ignoring addSubitemChild request');
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
                let response = await fetch("/add-subitem-child", {
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
                PubSub.publish(EVT_ADD_SUBITEM_CHILD_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        addItemTop: async function(itemsListState) {
            try {
                if (state.modeLocked) {
                    console.log('mode locked, ignoring addItemTop request');
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
                let response = await fetch("/add-item-top", {
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
                PubSub.publish(EVT_ADD_ITEM_TOP_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        pasteSibling: async function(itemsListState){
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
                let response = await fetch("/paste-sibling", {
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
                PubSub.publish(EVT_PASTE_SIBLING_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        pasteChild: async function(itemsListState){
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
                let response = await fetch("/paste-child", {
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
                PubSub.publish(EVT_PASTE_CHILD_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        },

        paginationUpdate: async function(itemsListState){
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
                let response = await fetch("/pagination-update", {
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
                PubSub.publish(EVT_PAGINATION_UPDATE_RETURN, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        }
    }
})();
