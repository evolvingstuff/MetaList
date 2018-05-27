"use strict";

let MAX_DEFAULT_RESULTS = 50;

let $view_items = (function () {
    
    function renderItems(items, mode_sort, item, mode_more_results) {

        count_cached_render = 0;
        let timer = new Timer('renderItems()');

        //get filtered results
        let filtered_items = [];
        for (let item of items) {
            if (item._include == 1) {
                filtered_items.push(item);
            }
        }
        console.log('rendering ' + filtered_items.length + ' items');

        if (item != null) {
            $filter.fullyIncludeItem(item);
        }

        $render.renderTotalResults(filtered_items);
        $render.renderPrioritySorted(filtered_items, item, mode_more_results);
        
        if (mode_more_results == false) {
            console.log('items cached/new = '+count_cached_render+'/'+MAX_DEFAULT_RESULTS);
        
        }
        else {
            console.log('items cached/new = '+count_cached_render+'/'+filtered_items.length);
        }
        timer.end();
    }

    return {
        renderItems: renderItems
    };
})();
