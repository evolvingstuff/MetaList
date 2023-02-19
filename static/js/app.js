"use strict";

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

        PubSub.subscribe('search.updated', (msg, searchFilter) => {
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
    }

    return {

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
                    item_subitem_id: itemSubitemId,
                    search_filter: state.mostRecentQuery
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
                    item_subitem_id: itemSubitemId,
                    search_filter: state.mostRecentQuery
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
