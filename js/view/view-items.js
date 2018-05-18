"use strict";

let MAX_DEFAULT_RESULTS = 50;

var $view_items = (function () {
    
    function renderItems(mode_sort, selectedItemId, mode_more_results) {

        count_cached_render = 0;
        let timer = new Timer('renderItems()');
        let filtered_items = getFilteredResults();

        //$todo.setMoreResults(true)

        $render.renderTotalResults(filtered_items);
        $render.renderPrioritySorted(filtered_items, selectedItemId, mode_more_results);
        /*
        if (mode_sort == SORT.time) {
            $render.renderDateSorted(filtered_items, selectedItemId, mode_more_results);
        }
        else if (mode_sort == SORT.priority) {
            $render.renderPrioritySorted(filtered_items, selectedItemId, mode_more_results);
        }
        else {
            throw "Unexpected sort mode: " + mode_sort;
        }
        */
        
        console.log('<'+count_cached_render+' items cached of '+filtered_items.length+'>');
        timer.end();
    }

    function getFilteredResults() {
        let filtered_items = [];
        for (let item of $model.getItems()) {
            if (item._include == 1) {
                filtered_items.push(item);
            }
        }
        console.log('rendering ' + filtered_items.length + ' items');
        return filtered_items;
    }

    return {
        renderItems: renderItems
    };
})();
