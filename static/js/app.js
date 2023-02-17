"use strict";


//TODO convert this to a class
const $server_proxy = (function() {

    let hideImpliesTagByDefault = true;

    window.onload = function(event) {
        console.log('$server_proxy: window.onload');

        function sendSearch(searchFilter) {
            if (state.serverIsBusy) {
                console.log('server is busy, saving query');
                state.pendingQuery = searchFilter;
                return;
            }
            else {
                $server_proxy.search(searchFilter);
                state.pendingQuery = null;
                state.serverIsBusy = true;
            }
        }

        PubSub.subscribe('search.updated', (msg, searchFilter) => {
            sendSearch(searchFilter);
        });

        PubSub.subscribe('items-list.show-more-results', (msg, searchFilter) => {
            sendSearch(searchFilter);
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
        }
    }
})();
