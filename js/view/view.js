"use strict";
let $view = (function () {

    //let cached = [];

    function render(items, item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results) { //TODO: is mousedItemId used??
        
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
        $filter.filterItemsWithParse(items, parse_results, allow_prefix_matches);

        $filter.fullyIncludeItem(item);

        $view_items.renderItems(items, mode_sort, item, mode_more_results);
        
        //TODO: refactor this out of here, should be rendered this way
        if (item != null) {
            if (selectedSubitemPath != null) {
                $('[data-item-id="' + item.id + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]').addClass('selected-item');
            }
            else {
                $('[data-item-id="' + item.id + '"] .itemdata').addClass('selected-item');
            }
        }

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
        updateTag: updateTag,
        legalTag: legalTag,
        illegalTag: illegalTag
    };
})();
