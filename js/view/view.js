"use strict";



let $view = (function () {

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
        $filter.filterItemsWithParse(parse_results, allow_prefix_matches);

        $filter.fullyIncludeItem(selected_item);

        $view_items.renderItems(mode_sort, selected_item, mode_more_results);
        
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

        $view_items.renderItems(mode_sort, item, mode_more_results);

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

    return {
        render: render,
        renderWithoutRefilter: renderWithoutRefilter,
        updateTag: updateTag,
        legalTag: legalTag,
        illegalTag: illegalTag
    };
})();
