"use strict";


//TODO convert this to a class
const $server_proxy = (function() {

    let pendingQuery = null;
    let mostRecentQuery = null;
    let serverIsBusy = false;
    let hideImpliesTagByDefault = true;
    let modeShowMoreResults = false;  //TODO move this to state module

    window.onload = function(event) {
        console.log('$server_proxy: window.onload');

        // PubSub.subscribe('items-list.scroll', (msg, scrollSettings) => {
        //     console.log('app: items-list.scroll');
        //     console.log(scrollSettings);
        //     if (auto_scroll === false) {
        //         return;
        //     }
        //     mostRecentScrollSettings = scrollSettings;
        //     let now = Date.now();
        //     if (now - mostRecentScrollTime > 1000) {
        //         mostRecentScrollTime = now;
        //         $server_proxy.search(mostRecentQuery, mostRecentScrollSettings);
        //     }
        // });

        PubSub.subscribe('items-list.show-more-results', (msg, showMore) => {
            console.log('app: items-list.show_more_results');
            modeShowMoreResults = showMore;
            // if (mostRecentQuery !== null && showMoreResults === false) {
            //     showMoreResults = true;
            //     console.log('showMoreResults: ' + showMoreResults);
            //     $server_proxy.search(mostRecentQuery);
            // }
            console.log(`mostRecentQuery: ${mostRecentQuery}`);
            $server_proxy.search(mostRecentQuery);
        });

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

            modeShowMoreResults = false;
            console.log('modeShowMoreResults: ' + modeShowMoreResults);
        });

        PubSub.subscribe('search.results', (msg, items) => {
            serverIsBusy = false;
            if (pendingQuery !== null) {
                console.log('server is no longer busy, sending pending query');
                $server_proxy.search(pendingQuery);
                pendingQuery = null;
                serverIsBusy = true;
            }
        });
    }

    let $server_proxy = {};

    $server_proxy.search = async function(filter) {

        mostRecentQuery = filter;

        if (hideImpliesTagByDefault) {
            if (!filter.negated_tags.includes('@implies') &&
                !filter.tags.includes('@implies') &&
                filter.partial_tag !== '@implies') {

                console.log('adding @implies to negated tags');
                filter.negated_tags.push('@implies');
            }
        }

        console.log(filter);

        try {
            let request = {
                filter: filter,
                show_more_results: modeShowMoreResults
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
    return $server_proxy;
})();
