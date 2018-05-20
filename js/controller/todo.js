"use strict";
var SORT;

(function (SORT) {
    SORT["priority"] = "priority";
    SORT["time"] = "time";
})(SORT || (SORT = {}));

let $todo = (function () {

    var selectedItemId = null;
    var selectedSubitemPath = null;
    var itemIdOnClick = null;
    var itemIdOnRelease = null;
    var mousedItemId = null;
    var mousedTag = null;

    var mode_shift_key = false;
    var mode_backspace_key = false;
    let mode_skipped_a_render = false;
    var mode_show_backup = false;
    var mode_collapse = true;
    var mode_sort = SORT.priority;
    let mode_more_results = false;

    function clearSelection() {
        selectedItemId = null;
        selectedSubitemPath = null;
        itemIdOnClick = null;
        itemIdOnRelease = null;
        mousedItemId = null;
        mousedTag = null;
    }

    function actionAdd(event) {
        event.stopPropagation();
        if (selectedItemId != null) {
            if (selectedSubitemPath != null) {
                selectedSubitemPath = $model.addNextSubItem(selectedItemId, selectedSubitemPath);
                let item = $model.getItemById(selectedItemId);
                $filter.fullyIncludeItem(item);
                $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusSubItem(selectedItemId, selectedSubitemPath);
            }
            else {
                selectedItemId = $model.addNextItem(selectedItemId);
                let item = $model.getItemById(selectedItemId);
                $filter.fullyIncludeItem(item);
                $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusItem(selectedItemId);
            }
        }
        else {
            mode_more_results = false;
            let current_search_string = document.getElementById('search_input').value;
            let parse_results = $parseSearch(current_search_string);
            if (parse_results == null) {
                console.log('invalid parse, will not add new');
                return;
            }

            let arr = []
            for (let result of parse_results) {
                if (result.type == 'tag' && result.negated == undefined && result.valid_exact_tag_matches.length > 0) {
                    if (arr.includes(result.valid_exact_tag_matches[0]) == false) {
                        arr.push(result.valid_exact_tag_matches[0])
                    }
                }
                //Need this to add new, non-existing tags
                if (result.type == 'tag' && result.negated == undefined && result.partial == true) {
                    if (arr.includes(result.text) == false) {
                        arr.push(result.text);
                    }
                }
            }
            let tags = arr.join(' ');

            selectedItemId = $model.addItem(tags);
            let item = $model.getItemById(selectedItemId);
            $filter.fullyIncludeItem(item);
            $auto_complete.refreshParse();
            $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusItem(selectedItemId);
        }
        $persist.save();
        if (selectedItemId != null) {
            $('.item[data-item-id="' + selectedItemId + '"]').addClass('moused-selected');
        }
    }

    function actionAddSubItem(event) {
        event.stopPropagation();

        if (selectedSubitemPath != null) {
            selectedSubitemPath = $model.addSubItem(selectedItemId, selectedSubitemPath);
        }
        else {
            selectedSubitemPath = $model.addSubItem(selectedItemId, null);
        }
        $persist.save();
        $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        focusSubItem(selectedItemId, selectedSubitemPath);
    }

    function actionDeleteButton(event) {
        event.stopPropagation();
        if (!confirm('Are you sure you want to delete this item?')) {
            return;
        }
        actionDelete();
    }

    function actionDelete() {
        if (selectedItemId == null) {
            return;
        }
        if (selectedSubitemPath != null) {
            $model.removeSubItem(selectedItemId, selectedSubitemPath);
            $ontology.maybeRecalculateOntology();
            selectedSubitemPath = null;
        }
        else {
            $model.deleteItem(selectedItemId);
            $ontology.maybeRecalculateOntology();
            selectedItemId = null;
            selectedSubitemPath = null;
            mousedItemId = null;
        }
        $auto_complete.refreshParse();
        $persist.save();
        $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function focusItem(id) {
    	//TODO refactor into view?
        var $div = $(".item[data-item-id='" + id + "'] > .itemdata");
        $div.focus();
    }

    function focusSubItem(id, path) {
    	//TODO refactor into view?
        var $div = $("[data-item-id='" + id + "'][data-subitem-path='" + path + "']");
        $div.focus();
    }

    function actionUp(event) {
        console.log('----------------------------------------------------');
        console.log('actionUp()');
        event.stopPropagation();
        if (selectedSubitemPath != null) {
            selectedSubitemPath = $model.moveUpSubitem(selectedItemId, selectedSubitemPath);
            $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selectedItemId, selectedSubitemPath);
        }
        else {
            $model.moveUp(selectedItemId);
            $persist.save();
            $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusItem(selectedItemId);
        }
        if (selectedItemId != null) {
        	//TODO refactor into view?
            $('.item[data-item-id="' + selectedItemId + '"]').addClass('moused-selected');
            console.log('DEBUG: item mouse selected');
        }
        console.log('-----------------------------------------------------');
    }

    function actionDown(event) {
        event.stopPropagation();
        if (selectedSubitemPath != null) {
            selectedSubitemPath = $model.moveDownSubitem(selectedItemId, selectedSubitemPath);
            $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selectedItemId, selectedSubitemPath);
        }
        else {
            $model.moveDown(selectedItemId);
            $persist.save();
            $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusItem(selectedItemId);
        }
        if (selectedItemId != null) {
        	//TODO refactor into view?
            $('.item[data-item-id="' + selectedItemId + '"]').addClass('moused-selected');
        }
    }

    function onDblClickItem(event) {
        event.stopPropagation();
        var do_select = false;
        if (selectedItemId != null) {
            if (selectedItemId == this.dataset.itemId) {
                closeSelectedItem();
                $auto_complete.refreshParse();
                $view.render(null, null, null, mode_sort, mode_more_results);
            }
            else {
                do_select = true;
            }
        }
        else {
            do_select = true;
        }
        if (do_select) {
            selectedItemId = this.dataset.itemId;
            $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            mousedItemId = selectedItemId;
            focusItem(selectedItemId);
            console.log($model.getItemById(selectedItemId));
        }
    }

    function onDblClickDocument(event) {
        event.stopPropagation();
        if (selectedItemId != null) {
            closeSelectedItem();
            $auto_complete.refreshParse();
            $view.render(null, null, null, mode_sort, mode_more_results);
        }
    }

    function closeSelectedItem() {
        if (selectedItemId == null) {
            console.log('selectedId is null, do nothing');
            return;
        }
        $ontology.maybeRecalculateOntology();
        deselect();
        $persist.save();
    }

    function deselect() {
        selectedItemId = null;
        selectedSubitemPath = null;
        itemIdOnClick = null;
        itemIdOnRelease = null;
        mousedItemId = null;
    }

    function onEditItem(event) {
        if (selectedItemId != null) {
        	//TODO refactor into view?
            var text = $('[data-item-id="' + selectedItemId + '"]').find('.data')[0].innerHTML;
            $model.updateData(selectedItemId, text);
        }
    }

    function onEditSubitem(event) {
        if (selectedItemId != null) {
            var text = event.target.innerHTML;
            //TODO refactor into view?
            var path = $(event.target).attr('data-subitem-path');
            $model.updateSubitemData(selectedItemId, path, text);
        }
    }

    function onFocusItem(event) {
        $auto_complete_tags.hideOptions();
        if (selectedItemId == null) {
            return;
        }
        selectedSubitemPath = null;
        //TODO refactor into view?
        $('.data').removeClass('selected-item');
        $('[data-item-id="' + selectedItemId + '"] .itemdata').addClass('selected-item');
        var item = $model.getItemById(selectedItemId);
        $('[data-item-id="' + selectedItemId + '"]').find('.tag')[0].value = item.tags;
    }

    function onFocusSubitem(event) {
        $auto_complete_tags.hideOptions();
        if (selectedItemId == null) {
            return;
        }
        selectedSubitemPath = $(event.target).attr('data-subitem-path');
        //TODO refactor into view?
        $('.data').removeClass('selected-item');
        $('[data-item-id="' + selectedItemId + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]').addClass('selected-item');
        var item = $model.getItemById(selectedItemId);
        $('[data-item-id="' + selectedItemId + '"]').find('.tag')[0].value = $model.getSubItemTags(item, selectedSubitemPath);
    }

    function actionEditTime(event) {
        if (selectedItemId == null) {
            throw "Unexpected, no selected item...";
        }
        //TODO refactor into view?
        var text = $('[data-item-id="' + selectedItemId + '"]').find('.time')[0].value;
        var utc_date = new Date(text);
        var timestamp = utc_date.getTime() + utc_date.getTimezoneOffset() * 60 * 1000;
        var date2 = new Date(timestamp);
        console.log(date2);
        $model.updateTimestamp(selectedItemId, timestamp);
        $persist.save();
    }

    function actionFocusEditTag(event) {
        $auto_complete_tags.onChange(selectedItemId, selectedSubitemPath);
        $auto_complete_tags.showOptions();
    }
    
    function actionEditTag(event) {
        if (selectedItemId == null) {
            throw "Unexpected, no selected item...";
        }
        //TODO refactor into view?
        var text = $('[data-item-id="' + selectedItemId + '"]').find('.tag')[0].value;
        let item = $model.getItemById(selectedItemId);
        if (selectedSubitemPath != null) {
            $model.updateSubTag(selectedItemId, selectedSubitemPath, text);
        }
        else {
            $model.updateTag(selectedItemId, text);
        }
        $auto_complete_tags.onChange(selectedItemId, selectedSubitemPath);
        $auto_complete_tags.showOptions();
    }

    function actionEditSearch(event) {
        if (selectedItemId != null) {
            //not sure it should ever make it here
            closeSelectedItem();
            $auto_complete.refreshParse();
            $view.render(null, null, null, mode_sort, mode_more_results);
        }
        //TODO refactor into view?
        var $el = $('.action-edit-search')[0]; //TODO: don't use class here!
        var text = $el.value;
        localStorage.setItem('search', text);
        function eqSet(as, bs) {
            if (as.size !== bs.size)
                return false;
            for (var _i = 0, as_1 = as; _i < as_1.length; _i++) {
                var a = as_1[_i];
                if (!bs.has(a))
                    return false;
            }
            return true;
        }

        $auto_complete.onChange();

        if (mode_backspace_key == false) {
            window.scrollTo(0, 0);
            $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        }
        else {
            mode_skipped_a_render = true;
        }
    }

    function backup() {
        var data = JSON.stringify($model.getItems());
        $('#ta_data').val(data);
    }

    function restore(data) {
        $model.setItems(data);
        $persist.save();
        var success = $persist.load();
        if (!success) {
            alert('Problems during restoration. Aborting.');
            return;
        }
        window.scrollTo(0, 0);
        $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionMouseover() {
    	//TODO refactor into view?
        mousedItemId = $(this).attr('data-item-id');
        if (mousedItemId == selectedItemId) {
            $(this).addClass('moused-selected');
        }
        else {
            $(this).addClass('moused');
            $auto_complete_tags.hideOptions();
        }
        if (itemIdOnClick != null && itemIdOnClick != mousedItemId) {
            document.getSelection().removeAllRanges();
        }
        $auto_complete.hideOptions();
    }

    function actionMouseoff() {
    	//TODO refactor into view?
        $(this).removeClass('moused');
        $(this).removeClass('moused-selected');
        mousedItemId = null;
    }

    function actionMousedown() {
        itemIdOnClick = mousedItemId;
    }

    function actionMouseup() {
        itemIdOnRelease = mousedItemId;
        if (itemIdOnClick != null && itemIdOnRelease != null && itemIdOnClick != itemIdOnRelease) {
            if (mode_sort == SORT.priority) {
                $model.drag(itemIdOnClick, itemIdOnRelease);
                $persist.save();
                $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                if (selectedItemId != null) {
                	//TODO refactor into view?
                    $('.item[data-item-id="' + selectedItemId + '"]').addClass('moused-selected');
                }
            }
            else if (mode_sort == SORT.time) {
                alert('Cannot reorder items when sorting by time.');
            }
            else {
                throw "Unhandled sort mode: " + mode_sort;
            }
        }
        itemIdOnClick = null;
        itemIdOnRelease = null;
    }

    function onShiftUp() {
    	mode_shift_key = false;
    }

    function onShiftDown() {
    	mode_shift_key = true;
    }

    function onBackspaceUp() {
        //TODO: confirm we are in the search input box
    	mode_backspace_key = false;
        if (mode_skipped_a_render == true) {
            window.scrollTo(0, 0);
            $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            mode_skipped_a_render = false;
        }
    }

    function onBackspaceDown() {
    	mode_backspace_key = true;
    }

    function onWindowFocus() {
        var reload = $persist.maybeReload();
        if (reload) {
            var success = $persist.load();
            if (!success) {
                alert('Problems during loading. Aborting.');
                return;
            }
            $ontology.maybeRecalculateOntology();
            $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        }
    }

    //TODO refactor this into modes
    function onEnterOrTab() {
    	if ($auto_complete.getModeHidden() == false) {
            $auto_complete.selectSuggestion();
            actionEditSearch();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.selectSuggestion(selectedItemId, selectedSubitemPath);
        }
    }

    function onClickTagSuggestion() {        
    	$auto_complete_tags.selectSuggestion(selectedItemId, selectedSubitemPath);
        $auto_complete_tags.onChange(selectedItemId, selectedSubitemPath);
    }

    function onSearchFocus(e) {
        $auto_complete.selectSuggestion();
        if (selectedItemId != null) {
            closeSelectedItem();
            $auto_complete.refreshParse();
            $view.render(null, null, null, mode_sort, mode_more_results);
        }
    }

    function onSearchFocusOut(e) {
        e.preventDefault();
        $auto_complete.hideOptions();
        $auto_complete_tags.hideOptions();
    }

    function onEscape() {
        if ($auto_complete.getModeHidden() == false) {
            $auto_complete.hideOptions();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.hideOptions();
        }
        if (selectedItemId != null) {
            closeSelectedItem();
            $auto_complete.refreshParse();
            $view.render(null, null, null, mode_sort, mode_more_results);
        }
    }

    function actionMoreResults() {
        if (selectedItemId != null) {
            closeSelectedItem(); 
            $auto_complete.refreshParse();
        }
        mode_more_results = true;
        $view.render(null, null, null, mode_sort, mode_more_results);
    }

    function setMoreResults(value) {
        mode_more_results = value;
    }

    function itemIsSelected() {
        if (selectedItemId == null) {
            return false;
        }
        return true;
    }

    function actionHome() {
        $('.action-edit-search').val('');
        window.scrollTo(0, 0);
        actionEditSearch();
        $auto_complete.hideOptions();
    }

    function actionSave(e) {
        e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse();
        $view.render(null, null, null, mode_sort, mode_more_results);
        $persist.saveToFileSystem();
    }

    function testLocalStorage() {
        var test = 'test';
        try {
            localStorage.setItem(test, test);
            localStorage.removeItem(test);
            return true;
        } catch(e) {
            return false;
        }
    }

    function onCopy(e) {
        let text = e.target.innerText;
        console.log(text);
        let textarea = document.getElementById('text_area_copy');
        textarea.style='';
        textarea.innerText = text;
        textarea.select();
        document.execCommand('copy');
        textarea.style='display:none;';
    }

    function onCheck(e) {
        //TODO: take action here
        let parent = $(e.target).parent().parent();
        console.log(parent);
        let id = $(parent).attr('data-item-id');
        let path = $(parent).attr('data-subitem-path');
        console.log(id + ' / ' + path);
        //alert('check');
    }

    function onUncheck(e) {
        //TODO: take action here
        //alert('uncheck');
    }

    function onClickSelectSearchSuggestion(e) {
        e.preventDefault();
        $auto_complete.selectSuggestion();
        actionEditSearch();
    }

    function onBeforeUnload(e) {
        $persist.save();
    }

    function onUpArrow(e) {
        if ($auto_complete.getModeHidden() == false) {
            $auto_complete.arrowUp();
            e.preventDefault();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.arrowUp(); 
            e.preventDefault();
        }
    }

    function onDownArrow(e) {
        if ($auto_complete.getModeHidden() == false) {
            $auto_complete.arrowDown(); 
            e.preventDefault();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.arrowDown(); 
            e.preventDefault();
        }
    }
    
    function init() {

        if (testLocalStorage() == false) {
            window.location.replace('error-pages/error-local-storage.html');
        }

        //restore saved search
        var search = localStorage.getItem('search');
        if (search != null && search != 'null') {
            $('.action-edit-search')[0].value = search;
        }
        else {
            localStorage.setItem('search', null);
            $('.action-edit-search')[0].value = '';
        }

        var success = $persist.load();
        if (!success) {
            alert('Problems during loading. Aborting.');
            return;
        }

        $ontology.maybeRecalculateOntology();

        $auto_complete.onChange();

        $view.render(selectedItemId, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);

        $events.registerEvents();

        $auto_complete.hideOptions();

        document.activeElement.blur();
    }

    return {
        init: init,
        backup: backup,
        restore: restore,
        onDblClickItem: onDblClickItem,
		onDblClickDocument: onDblClickDocument,
		onEditItem: onEditItem,
		onEditSubitem: onEditSubitem,
		onFocusItem: onFocusItem,
		onFocusSubitem: onFocusSubitem,
		actionUp: actionUp,
		actionDown: actionDown,
		actionDeleteButton: actionDeleteButton,
		actionAdd: actionAdd,
		actionEditTag: actionEditTag,
		actionEditTime: actionEditTime,
		actionEditSearch: actionEditSearch,
		actionAddSubItem: actionAddSubItem,
		actionMouseover: actionMouseover,
		actionMouseoff: actionMouseoff,
		actionMousedown: actionMousedown,
		actionMouseup: actionMouseup,
		actionFocusEditTag: actionFocusEditTag,
        actionMoreResults: actionMoreResults,
        actionHome: actionHome,
        actionSave: actionSave,
		focusSubItem: focusSubItem,
		actionDelete: actionDelete,
        onCopy: onCopy,
		onShiftUp: onShiftUp,
		onShiftDown: onShiftDown,
        onEscape: onEscape,
		onBackspaceUp: onBackspaceUp,
		onBackspaceDown: onBackspaceDown,
		onWindowFocus: onWindowFocus,
		onEnterOrTab: onEnterOrTab,
		onClickTagSuggestion: onClickTagSuggestion,
        onCheck: onCheck,
        onUncheck: onUncheck,
        onSearchFocus: onSearchFocus,
        onSearchFocusOut: onSearchFocusOut,
        onClickSelectSearchSuggestion: onClickSelectSearchSuggestion,
        onBeforeUnload: onBeforeUnload,
        onUpArrow: onUpArrow,
        onDownArrow: onDownArrow,
        itemIsSelected: itemIsSelected,
        setMoreResults: setMoreResults
    };
})();
$todo.init();
