"use strict";
var $view_items = (function () {
    
    function renderItems(mode_sort, selectedItemId) {

        count_cached_render = 0;
        let timer = new Timer('renderItems()');
        let filtered_items = getFilteredResults();

        $render.renderTotalResults(filtered_items);
        if (mode_sort == SORT.time) {
            $render.renderDateSorted(filtered_items, selectedItemId);
        }
        else if (mode_sort == SORT.priority) {
            $render.renderPrioritySorted(filtered_items, selectedItemId);
        }
        else {
            throw "Unexpected sort mode: " + mode_sort;
        }
        
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
