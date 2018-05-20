"use strict";
var $view = (function () {

    //let cached = [];

    function render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results) { //TODO: is mousedItemId used??
        
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

        $filter.fullyIncludeItem($model.getItemById(selectedItemId));

        $view_items.renderItems(mode_sort, selectedItemId, mode_more_results);
        
        //TODO: refactor this out of here, should be rendered this way
        if (selectedItemId != null) {
            if (selectedSubitemPath != null) {
                $('[data-item-id="' + selectedItemId + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]').addClass('selected-item');
            }
            else {
                $('[data-item-id="' + selectedItemId + '"] .itemdata').addClass('selected-item');
            }
        }

        timer.end();
        timer.display();
    }

    function updateTag(selectedItemId, text) {
        let $input = $('[data-item-id='+selectedItemId+']').find('.action-edit-tag');
        $($input).val(text);
        $($input).focus();
    }

    function legalTag(selectedItemId) {
        $('[data-item-id='+selectedItemId+']').find('.action-edit-tag').css('color','black');
    }

    function illegalTag(selectedItemId) {
        $('[data-item-id='+selectedItemId+']').find('.action-edit-tag').css('color','red');
    }

    return {
        render: render,
        updateTag: updateTag,
        legalTag: legalTag,
        illegalTag: illegalTag
    };
})();
