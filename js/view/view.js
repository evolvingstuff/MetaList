"use strict";


let $view = (function () {

    let MAX_DEFAULT_RESULTS = 50;

    function render(selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results) { //TODO: is mousedItemId used??
        
        if (selected_item != null && selectedSubitemPath == null) {
            //TODO2 this should not be needed
            debugger;
            selectedSubitemPath = selected_item.id + ':0';
        }

        let timer = new Timer('Render');

        let parse_results = $auto_complete.getParseResults();

        if (parse_results == null) {
            console.log('Illegal parse');
            timer.end();
            timer.display();
            return;
        }
        
        //This may be overkill, but currently needed for Add Item button to work
        let allow_prefix_matches = false;
        $model.filterItemsWithParse(parse_results, allow_prefix_matches);
        $model.fullyIncludeItem(selected_item);

        renderItems(selected_item, mode_more_results);
        
        /////////////////////////////////////////////////////////////////////////////////////////
        
        if (selectedSubitemPath != null) {
            $('[data-item-id="' + selected_item.id + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]').addClass('selected-item');
        }

        ////////////////////////////////////////////////////////////////////////////////////////////

        timer.end();
        timer.display();
    }


    function renderWithoutRefilter(item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results) { //TODO: is mousedItemId used??
        
        if (selectedSubitemPath != null) {
            console.log('Unexpected: selectedSubitemPath != null in renderWithoutRefilter() view.js line 48')
        }

        let timer = new Timer('Render');

        let parse_results = $auto_complete.getParseResults();

        if (parse_results == null) {
            console.log('Illegal parse');
            timer.end();
            timer.display();
            return;
        }

        renderItems(item, mode_more_results);

        timer.end();
        timer.display();
    }


    function updateTag(item, text) {
        let $input = $('[data-item-id='+item.id+']').find('.action-edit-tag');
        $($input).val(text);
        $($input).focus();
    }

    function legalTag(item) {
        $('[data-item-id='+item.id+']').find('.action-edit-tag').css('color','black');
    }

    function illegalTag(item) {
        $('[data-item-id='+item.id+']').find('.action-edit-tag').css('color','red');
    }

    function renderItems(item, mode_more_results) {

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

    function getItemElementById(id) {
        let query = '[data-item-id="'+id+'"]';
        let el = $(query)[0];
        return el;
    }

    function getSubitemElementByPath(path) {
        let query = '[data-subitem-path="'+path+'"]';
        let el = $(query)[0];
        return el;
    }

    function getItemTagSuggestionsElementById(id) {
        let div = getItemElementById(id);
        let sugg = $(div).find('.tag-suggestions')[0];
        return sugg;
    }

    function getItemTagElementById(id) {
        let div = getItemElementById(id);
        let sugg = $(div).find('.tag')[0];
        return sugg;
    }

    return {
        render: render,
        renderWithoutRefilter: renderWithoutRefilter,
        updateTag: updateTag,
        legalTag: legalTag,
        illegalTag: illegalTag,
        getItemElementById: getItemElementById,
        getSubitemElementByPath: getSubitemElementByPath,
        getItemTagSuggestionsElementById: getItemTagSuggestionsElementById,
        getItemTagElementById: getItemTagElementById
    };
})();
