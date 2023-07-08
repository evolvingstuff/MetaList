"use strict";

const debugShowLocked = false;

//TODO move this
function stateNoMode() {
    return state.modeEdit === false && state.modeMove === false && state.modeTags === false && state.modeFormat === false;
}

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

        PubSub.subscribe(EVT_ITEMS_LIST_EDIT_SUBITEM, (msg, data) => {
            $server_proxy.editSubitemContent(data.itemSubitemId, data.updatedContent);
        });

        PubSub.subscribe(EVT_SEARCH_FOCUS, (msg, searchFilter) => {
            if (stateNoMode() === false) {
                $server_proxy.exitAllModes();
            }
        });

        PubSub.subscribe(EVT_SEARCH_UPDATED, (msg, searchFilter) => {
            if (stateNoMode() === false) {
                $server_proxy.exitAllModes();
            }
            sendSearch(searchFilter);
        });

        PubSub.subscribe(EVT_ITEMS_LIST_SHOW_MORE__RESULTS, (msg, searchFilter) => {
            sendSearch(searchFilter);
        });

        PubSub.subscribe(EVT_ITEMS_LIST_TOGGLE_OUTLINE, (msg, data) => {
            $server_proxy.toggleOutline(data.itemSubitemId);
        });

        PubSub.subscribe(EVT_ITEMS_LIST_TOGGLE_TODO, (msg, data) => {
            $server_proxy.toggleTodo(data.itemSubitemId);
        });

        PubSub.subscribe(EVT_SEARCH__RESULTS, (msg, items) => {
            state.serverIsBusy = false;
            if (state.pendingQuery !== null) {
                console.log('server is no longer busy, sending pending query');
                $server_proxy.search(state.pendingQuery);
                state.pendingQuery = null;
                state.serverIsBusy = true;
            }
        });

        PubSub.subscribe(EVT_ENTER_MODE_EDIT, (msg, searchFilter) => {
            switchMode(EVT_ENTER_MODE_EDIT);
        });

        PubSub.subscribe(EVT_ENTER_MODE_MOVE, (msg, searchFilter) => {
            switchMode(EVT_ENTER_MODE_MOVE);
        });

        PubSub.subscribe(EVT_ENTER_MODE_TAGS, (msg, searchFilter) => {
            switchMode(EVT_ENTER_MODE_TAGS);
        });

        PubSub.subscribe(EVT_ENTER_MODE_FORMAT, (msg, searchFilter) => {
            switchMode(EVT_ENTER_MODE_FORMAT);
        });

        PubSub.subscribe(EVT_EXIT_ALL_MODES, (msg, searchFilter) => {
            $server_proxy.exitAllModes();  //TODO: this is more of a state thing
        });

        function switchMode(eventName) {
            //console.log('switchMode: ' + eventName);

            if (eventName === EVT_ENTER_MODE_EDIT) {
                state.modeEdit = true;
            }
            else if (state.modeEdit) {
                state.modeEdit = false;
                PubSub.publish(EVT_EXIT_MODE_EDIT, {});
            }

            if (eventName === EVT_ENTER_MODE_MOVE) {
                state.modeMove = true;
            }
            else if (state.modeMove) {
                state.modeMove = false;
                PubSub.publish(EVT_EXIT_MODE_MOVE, {});
            }

            if (eventName === EVT_ENTER_MODE_TAGS) {
                state.modeTags = true;
            }
            else if (state.modeTags) {
                state.modeTags = false;
                PubSub.publish(EVT_EXIT_MODE_TAGS, {});
            }

            if (eventName === EVT_ENTER_MODE_FORMAT) {
                state.modeFormat = true;
            }
            else if (state.modeFormat) {
                state.modeFormat = false;
                PubSub.publish(EVT_EXIT_MODE_FORMAT, {});
            }
        }

        // document.addEventListener("dblclick", event => {
        //     //alert("Double-click detected");
        //     document.querySelector('#edit').click();
        // });

        /* This is too aggressive
        document.addEventListener('click', event => {
            if (stateNoMode() === false) {
                $server_proxy.exitAllModes();
            }
        });
        */

        //TODO want a centralized place to handle keyboard events
        document.onkeydown = function(evt) {
            if (evt.key === "Escape" && stateNoMode() === false) {
                $server_proxy.exitAllModes();
            }
        };
    }

    return {

        exitAllModes: function() {
            if (state.selectedItemSubitemIds.size > 0) {
                console.log('> Escape key pressed, clearing selected subitems');
                state._selectedItemSubitemIds = new Set(state.selectedItemSubitemIds);
                state.selectedItemSubitemIds.clear();
                PubSub.publish(EVT_SELECTED_SUBITEMS_CLEARED, {});
            }
            //TODO: should we remove selected subitems?
            if (state.modeEdit) {
                console.log('> Escape key pressed, exiting mode edit');
                state.modeEdit = false;
                PubSub.publish(EVT_EXIT_MODE_EDIT, {});
            }
            if (state.modeMove) {
                console.log('> Escape key pressed, exiting mode move');
                state.modeMove = false;
                PubSub.publish(EVT_EXIT_MODE_MOVE, {});
            }
            if (state.modeTags) {
                console.log('> Escape key pressed, exiting mode tags');
                state.modeTags = false;
                PubSub.publish(EVT_EXIT_MODE_TAGS, {});
            }
            if (state.modeFormat) {
                console.log('> Escape key pressed, exiting mode format');
                state.modeFormat = false;
                PubSub.publish(EVT_EXIT_MODE_FORMAT, {});
            }
        },

        editSubitemContent: async function(itemSubitemId, updatedContent) {
            //TODO 2023.03.05: this is very naive because it sends an update on every keystroke
            //We should fix that later, maybe upon exiting edit mode
            try {
                let request = {
                    itemSubitemId: itemSubitemId,
                    content: updatedContent
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
                    show_more_results: state.modeShowMoreResults
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
                PubSub.publish(EVT_SEARCH__RESULTS, searchResults);
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
                PubSub.publish(EVT_TOGGLE_OUTLINE__RESULT, result);
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
                PubSub.publish(EVT_TOGGLE_TODO__RESULT, result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        }
    }
})();
