"use strict";

let MAX_DEFAULT_RESULTS = 50;

let $view_items = (function () {
    
    function renderItems(items, mode_sort, item, mode_more_results) {

        count_cached_render = 0;
        let timer = new Timer('renderItems()');

        //get filtered results
        let filtered_items = [];
        for (let item of items) {
            if (item.subitems[0]._include == 1) {
                filtered_items.push(item);
            }
        }
        console.log('rendering ' + filtered_items.length + ' items');

        if (item != null) {
            $filter.fullyIncludeItem(item);
        }

        $render.renderTotalResults(filtered_items);

        if (mode_sort == 'priority') {
            filtered_items.sort(function (a, b) {
                if (a.priority > b.priority) return 1;
                if (a.priority < b.priority) return -1;
                return 0;
            });
        }
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

        $render.renderFilteredSortedItems(filtered_items, item, mode_more_results);
        
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
