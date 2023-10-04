"use strict";

import {
    state as itemsListState
} from './components/items-list.js';

import {
    EVT_EDIT_SUBITEM,
    EVT_SHOW_MORE_RETURN,
    EVT_TOGGLE_OUTLINE,
    EVT_TOGGLE_TODO,
    EVT_TOGGLE_OUTLINE_RETURN,
    EVT_TOGGLE_TODO_RETURN,
    EVT_ADD_ITEM_TOP,
    EVT_ADD_ITEM_TOP_RETURN,
    EVT_ADD_SUBITEM_NEXT,
    EVT_ADD_SUBITEM_NEXT_RETURN,
    EVT_DELETE_SUBITEM,
    EVT_DELETE_SUBITEM_RETURN
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

export const EVT_T = 'evt-t';
export const EVT_STAR = 'evt-star';
export const EVT_NUM = 'evt-num';
export const EVT_CTRL_C = 'evt-ctrl-c';
export const EVT_CTRL_Z = 'evt-ctrl-z';
export const EVT_CTRL_Y = 'evt-ctrl-y';
export const EVT_SPACE = 'evt-space';
export const EVT_CTRL_V = 'evt-ctrl-v';
export const EVT_TAB = 'evt-tab';
export const EVT_SHIFT_TAB = 'evt-shift-tab';
export const EVT_ENTER = 'evt-enter';
export const EVT_ESCAPE = 'evt-escape';
export const EVT_DELETE = 'evt-delete';
export const EVT_UP = 'evt-up';
export const EVT_DOWN = 'evt-down';
export const EVT_LEFT = 'evt-left';
export const EVT_RIGHT = 'evt-right';

const debugShowLocked = false;

//TODO convert this to a class
const $server_proxy = (function() {

    let hideImpliesTagByDefault = true;

    window.onload = function(event) {
        console.log('$server_proxy: window.onload');

        function sendSearch(searchFilter) {
            if (state.serverIsBusy) {
                console.log('server is busy, saving pending query');
                state.pendingQuery = searchFilter;
            }
            else {
                state.pendingQuery = null;
                state.serverIsBusy = true;
                $server_proxy.search(searchFilter);
            }
        }

        PubSub.subscribe(EVT_ADD_ITEM_TOP, (msg, data) => {
            alert('app.EVT_ADD_ITEM_TOP todo');
        });

        PubSub.subscribe(EVT_ADD_SUBITEM_NEXT, (msg, data) => {
            alert('app.EVT_ADD_SUBITEM_NEXT todo');
        });

        PubSub.subscribe(EVT_EDIT_SUBITEM, (msg, data) => {
            $server_proxy.editSubitemContent(data.itemSubitemId, data.updatedContent);
        });

        PubSub.subscribe(EVT_SEARCH_UPDATED, (msg, searchFilter) => {
            state.mostRecentQuery = searchFilter;
            sendSearch(searchFilter);
        });

        PubSub.subscribe(EVT_SHOW_MORE_RETURN, (msg, searchFilter) => {
            sendSearch(searchFilter);
        });

        PubSub.subscribe(EVT_TOGGLE_OUTLINE, (msg, data) => {
            $server_proxy.toggleOutline(data.itemSubitemId);
        });

        PubSub.subscribe(EVT_TOGGLE_TODO, (msg, data) => {
            $server_proxy.toggleTodo(data.itemSubitemId);
        });

        PubSub.subscribe(EVT_DELETE_SUBITEM, (msg, data) => {
           $server_proxy.deleteSubitem(data.itemSubitemId);
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

        //TODO want a centralized place to handle keyboard events
        document.onkeydown = function(evt) {

            console.log(evt.key);

            //These are all published synchronously so that the subscribers can
            // handle/cancel the default events.

            if (evt.ctrlKey) {
                if (evt.key === 'c') {
                    PubSub.publishSync(EVT_CTRL_C, {evt:evt});
                }
                else if (evt.key === 'v') {
                    PubSub.publishSync(EVT_CTRL_V, {evt:evt});
                }
                else if (evt.key === 'z') {
                    PubSub.publishSync(EVT_CTRL_Z, {evt:evt});
                }
                else if (evt.key === 'y') {
                    PubSub.publishSync(EVT_CTRL_Y, {evt:evt});
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
    }

    return {

        editSubitemContent: async function(itemSubitemId, updatedContent) {
            //TODO 2023.03.05: this is very naive because it sends an update on every keystroke
            //We should fix that later, maybe upon exiting edit mode
            try {
                let request = {
                    itemSubitemId: itemSubitemId,
                    updatedContent: updatedContent,
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
                    filter: filter,
                    show_more_results: itemsListState.modeShowMoreResults
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

        deleteSubitem: async function(itemSubitemId) {

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
                    itemSubitemId: itemSubitemId,
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

        toggleOutline: async function(itemSubitemId) {
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
                    itemSubitemId: itemSubitemId,
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

        toggleTodo: async function(itemSubitemId) {
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
                    itemSubitemId: itemSubitemId,
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
        }
    }
})();
