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

        PubSub.subscribe('items-list.edit-subitem', (msg, data) => {
            $server_proxy.editSubitemContent(data.itemSubitemId, data.updatedContent);
        });

        PubSub.subscribe('search.focus', (msg, searchFilter) => {
            if (stateNoMode() === false) {
                $server_proxy.exitAllModes();
            }
        });

        PubSub.subscribe('search.updated', (msg, searchFilter) => {
            if (stateNoMode() === false) {
                $server_proxy.exitAllModes();
            }
            sendSearch(searchFilter);
        });

        PubSub.subscribe('items-list.show-more-results', (msg, searchFilter) => {
            sendSearch(searchFilter);
        });

        PubSub.subscribe('items-list.toggle-outline', (msg, data) => {
            $server_proxy.toggleOutline(data.itemSubitemId);
        });

        PubSub.subscribe('items-list.toggle-todo', (msg, data) => {
            $server_proxy.toggleTodo(data.itemSubitemId);
        });

        PubSub.subscribe('search.results', (msg, items) => {
            state.serverIsBusy = false;
            if (state.pendingQuery !== null) {
                console.log('server is no longer busy, sending pending query');
                $server_proxy.search(state.pendingQuery);
                state.pendingQuery = null;
                state.serverIsBusy = true;
            }
        });

        PubSub.subscribe('enter-mode-edit', (msg, searchFilter) => {
            switchMode('enter-mode-edit');
        });

        PubSub.subscribe('enter-mode-move', (msg, searchFilter) => {
            switchMode('enter-mode-move');
        });

        PubSub.subscribe('enter-mode-tags', (msg, searchFilter) => {
            switchMode('enter-mode-tags');
        });

        PubSub.subscribe('enter-mode-format', (msg, searchFilter) => {
            switchMode('enter-mode-format');
        });

        PubSub.subscribe('exit-all-modes', (msg, searchFilter) => {
            $server_proxy.exitAllModes();  //TODO: this is more of a state thing
        });

        function switchMode(eventName) {
            //console.log('switchMode: ' + eventName);

            if (eventName === 'enter-mode-edit') {
                state.modeEdit = true;
            }
            else if (state.modeEdit) {
                state.modeEdit = false;
                PubSub.publish('exit-mode-edit', {});
            }

            if (eventName === 'enter-mode-move') {
                state.modeMove = true;
            }
            else if (state.modeMove) {
                state.modeMove = false;
                PubSub.publish('exit-mode-move', {});
            }

            if (eventName === 'enter-mode-tags') {
                state.modeTags = true;
            }
            else if (state.modeTags) {
                state.modeTags = false;
                PubSub.publish('exit-mode-tags', {});
            }

            if (eventName === 'enter-mode-format') {
                state.modeFormat = true;
            }
            else if (state.modeFormat) {
                state.modeFormat = false;
                PubSub.publish('exit-mode-format', {});
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
                PubSub.publish('selected-subitems-cleared', {});
            }
            //TODO: should we remove selected subitems?
            if (state.modeEdit) {
                console.log('> Escape key pressed, exiting mode edit');
                state.modeEdit = false;
                PubSub.publish('exit-mode-edit', {});
            }
            if (state.modeMove) {
                console.log('> Escape key pressed, exiting mode move');
                state.modeMove = false;
                PubSub.publish('exit-mode-move', {});
            }
            if (state.modeTags) {
                console.log('> Escape key pressed, exiting mode tags');
                state.modeTags = false;
                PubSub.publish('exit-mode-tags', {});
            }
            if (state.modeFormat) {
                console.log('> Escape key pressed, exiting mode format');
                state.modeFormat = false;
                PubSub.publish('exit-mode-format', {});
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
                PubSub.publish('search.results', searchResults);
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
                PubSub.publish('toggle-outline.result', result);
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
                PubSub.publish('toggle-todo.result', result);
            } catch (error) {
                console.log(error);
                //TODO publish the error
            }
        }
    }
})();
