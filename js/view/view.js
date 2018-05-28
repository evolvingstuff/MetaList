"use strict";

let ENABLE_RICH_EDITING = false;

let $view = (function () {

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
        
        /////////////////////////////////////////////////////////////////////////////////////////
        //TODO: refactor this out of here
        if (item != null) {
            if (selectedSubitemPath != null) {
                $('[data-item-id="' + item.id + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]').addClass('selected-item');
            }
            else {
                $('[data-item-id="' + item.id + '"] .itemdata').addClass('selected-item');
            }

            if (ENABLE_RICH_EDITING) {
                let $editable_area = null;
                if (selectedSubitemPath == null) { 
                    $editable_area = $('[data-item-id="' + item.id + '"] .itemdata')[0];
                    $($editable_area).summernote({
                      callbacks: {
                        onChange: function(contents, $editable) {
                          console.log('onChange:', contents, $editable);
                          $todo.onRichEditItem(item, contents);
                        }
                      }
                    });
                }
                else {
                    $editable_area = $('[data-item-id="' + item.id + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]')[0];
                    $($editable_area).summernote({
                      callbacks: {
                        onChange: function(contents, $editable) {
                          console.log('onChange:', contents, $editable);
                          $todo.onRichEditSubitem(item, selectedSubitemPath, contents);
                        }
                      }
                    });
                }
            }
        }
        ////////////////////////////////////////////////////////////////////////////////////////////

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
