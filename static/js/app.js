"use strict";

const $server_proxy = (function() {

    window.onload = function(event) {
        console.log('$server_proxy: window.onload');
        PubSub.subscribe('search.updated', (msg, searchFilter) => {
            console.log('search.updated');
            console.log(searchFilter);
            $server_proxy.search(searchFilter);
            //TODO also calculate suggestions for the search filter and publish them
        });
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
            console.log(searchResults);
            PubSub.publish('search.results', searchResults);
        } catch (error) {
            console.log(error);
            //TODO publish the error
        }
    }
    return $server_proxy;
})();
