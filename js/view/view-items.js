"use strict";

let MAX_DEFAULT_RESULTS = 50;

let $view_items = (function () {
    
    function renderItems(mode_sort, item, mode_more_results) {

        count_cached_render = 0;
        let timer = new Timer('renderItems()');

        //get filtered results
        let filtered_items = $model.getFilteredItems();

        let tot1 = filtered_items.length;

        console.log('rendering ' + filtered_items.length + ' items');

        if (item != null) {
            $model.fullyIncludeItem(item);
        }

        $render.renderTotalResults(filtered_items);
        $render.renderFilteredSortedItems(filtered_items, item, mode_more_results);

        if (filtered_items.length > 0) {
            if (mode_more_results == false) {
                console.log('items cached/new = '+count_cached_render+'/'+Math.min(MAX_DEFAULT_RESULTS, filtered_items.length));
            }
            else {
                console.log('items cached/new = '+count_cached_render+'/'+filtered_items.length);
            }
        }
        timer.end();
    }

    return {
        renderItems: renderItems
    };
})();
