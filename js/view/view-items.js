"use strict";

let MAX_DEFAULT_RESULTS = 50;

let $view_items = (function () {
    
    function renderItems(mode_sort, item, mode_more_results) {

        count_cached_render = 0;
        let timer = new Timer('renderItems()');

        //get filtered results
        const filtered_items = $model.getFilteredItems();

        console.log('rendering ' + filtered_items.length + ' items');

        if (item != null) {
            $model.fullyIncludeItem(item);
        }

        //TODO: Immer - should we handle this in model?
        if (mode_sort == 'priority') {
            filtered_items.sort(function (a, b) {
                if (a.priority > b.priority) return 1;
                if (a.priority < b.priority) return -1;
                return 0;
            });
        }
        else {
            throw "Unknown mode_sort value: " + mode_sort;
        }

        /*
        else if (mode_sort == 'reverse-priority') {
            filtered_items.sort(function (a, b) {
                if (a.priority > b.priority) return -1;
                if (a.priority < b.priority) return 1;
                return 0;
            });
        }
        else if (mode_sort == 'date') {
            filtered_items.sort(function (a, b) {
                if (a.timestamp > b.timestamp) return -1;
                if (a.timestamp < b.timestamp) return 1;
                return 0;
            });
        }
        else if (mode_sort == 'reverse-date') {
            filtered_items.sort(function (a, b) {
                if (a.timestamp > b.timestamp) return 1;
                if (a.timestamp < b.timestamp) return -1;
                return 0;
            });
        }
        else {
            alert('ERROR: unknown sort mode "'+mode_sort+'"');
        }
        */

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
