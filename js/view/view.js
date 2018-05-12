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

        //TODO: this is the source of an ongoing bug
        /*
        if (last_key_code == 32) {
            console.log('space was last key, skipping rerender'); //this is kind of a hack
            timer.end();
            timer.display();
            return;
        }
        */
        
        //TODO: there is still a bug here...
        //Commenting this out makes it render nothing if there are no search results, 
        //but I might be okay with this as it is less confusing. Going to leave it for now.
        //It certainly makes things look more "responsive"
        /*
        if (selectedItemId == null) {

        	//TODO: can remove later when rendering is made more efficient
	        if (parse_results.length > 0) {
	            let last = parse_results[parse_results.length-1];
	            if (last.type == 'tag' && last.valid_exact_tag_matches.length == 0 && last.valid_exact_tag_reverse_implications == 0) {
	                timer.end();
	                timer.display();
	                return;
	            }
	            if (last.type == 'substring' && last.partial == true) {
	                timer.end();
	                timer.display();
	                return;
	            }
	        }
    	}
        */
        
        //This may be overkill, but currently needed for Add Item button to work
        let allow_prefix_matches = false;
        $search2.filterItemsWithParse(parse_results, allow_prefix_matches);

        $search2.alwaysShowSelectedItemInFull(selectedItemId);

        $view_items.renderItems(mode_sort, selectedItemId, mode_more_results);
        
        //TODO: refactor this out of here, should be rendered this way!
        if (selectedItemId != null) {
            if (selectedSubitemPath != null) {
                $('[data-item-id="' + selectedItemId + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]').addClass('selected-item');
            }
            else {
                $('[data-item-id="' + selectedItemId + '"] .itemdata').addClass('selected-item');
            }
        }
        //#TODO: handle if selected item is not in search

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
