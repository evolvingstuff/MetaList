"use strict";

const $server_proxy = (function() {

    let pendingQuery = null;
    let serverIsBusy = false;

    window.onload = function(event) {
        console.log('$server_proxy: window.onload');
        PubSub.subscribe('search.updated', (msg, searchFilter) => {
            if (serverIsBusy) {
                console.log('server is busy, saving query');
                pendingQuery = searchFilter;
                return;
            }
            else {
                $server_proxy.search(searchFilter);
                pendingQuery = null;
                serverIsBusy = true;
            }
        });

        PubSub.subscribe('search.results', (msg, items) => {
            serverIsBusy = false;
            if (pendingQuery !== null) {
                console.log('server is no longer busy, sending pending query');
                $server_proxy.search(pendingQuery);
                pendingQuery = null;
                serverIsBusy = true;
            }
        })
    }

    let $server_proxy = {};

    $server_proxy.search = async function(filter) {
        try {
            let request = {
                filter: filter
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
            let items = searchResults.items;
            PubSub.publish('search.results', items);
        } catch (error) {
            console.log(error);
            //TODO publish the error
        }
    }
    return $server_proxy;
})();
