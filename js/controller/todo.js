"use strict";

let $todo = (function () {

    let SORT;

    (function (SORT) {
        SORT["priority"] = "priority";
        SORT["time"] = "time";
    })(SORT || (SORT = {}));

    let selected_item = null;
    let selectedSubitemPath = null;
    let itemOnClick = null;
    let itemOnRelease = null;
    let mousedItemId = null;
    let mousedTag = null;

    let mode_backspace_key = false;
    let mode_skipped_a_render = false;
    let mode_show_backup = false;
    let mode_collapse = true;
    let mode_sort = SORT.priority;
    let mode_more_results = false;

    let items = [];
    let item_cache = {};

    function getItems() {
        return items;
    }

    function setItems(new_items) {
        items = new_items;
        //clean ununsed properties
        for (let item of items) {
            if (item._dirty_tags != undefined) {
                delete item._dirty_tags;
            }
            if (item._last_update != undefined) {
                delete item._last_update;
            }
        }

        item_cache = {};
        for (let item of items) {
            item_cache[item.id] = item;
        }
        $model.recalculateAllTags(items);
    }

    function getItemById(id) {
        if (item_cache[id] !== undefined) {
            return item_cache[id];
        }
        else {
            for (let i = 0; i < items.length; i++) { //TODO
                item_cache[items[i].id] = items[i];
                if (items[i].id == id) {
                    break;
                }
            }
            if (item_cache[id] !== undefined) {
                return item_cache[id];
            }
            else {
                return null;
            }
        }
    }

    function clearSelection() {
        selected_item = null;
        selectedSubitemPath = null;
        itemOnClick = null;
        itemOnRelease = null;
        mousedItemId = null;
        mousedTag = null;
    }

    function actionAdd(event) {
        event.stopPropagation();
        let items = getItems();
        if (selected_item != null) {
            if (selectedSubitemPath != null) {
                selectedSubitemPath = $model.addNextSubItem(selected_item, selectedSubitemPath);
                let item = getItemById(selected_item);
                $filter.fullyIncludeItem(item);
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusSubItem(selected_item, selectedSubitemPath);
            }
            else {
                selected_item = $model.addNextItem(items, selected_item);
                $filter.fullyIncludeItem(selected_item);
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusItem(selected_item);
            }
        }
        else {
            mode_more_results = false;
            let current_search_string = document.getElementById('search_input').value;
            let items = getItems();
            let parse_results = $parseSearch(items, current_search_string);
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
            selected_item = $model.addItem(items, tags);
            $filter.fullyIncludeItem(selected_item);
            $auto_complete.refreshParse(items);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusItem(selected_item);
        }
        $persist.save(items);
        if (selected_item != null) {
            $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
        }
    }

    function actionAddSubItem(event) {
        event.stopPropagation();
        let items = getItems();

        if (selectedSubitemPath != null) {
            selectedSubitemPath = $model.addSubItem(selected_item, selectedSubitemPath);
        }
        else {
            selectedSubitemPath = $model.addSubItem(selected_item, null);
        }
        $persist.save(items);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        focusSubItem(selected_item, selectedSubitemPath);
    }

    function actionDeleteButton(event) {
        event.stopPropagation();
        if (!confirm('Are you sure you want to delete this item?')) {
            return;
        }
        actionDelete();
    }

    function actionDelete() {
        if (selected_item == null) {
            return;
        }
        let items = getItems();
        if (selectedSubitemPath != null) {
            $model.removeSubItem(selected_item, selectedSubitemPath);
            $ontology.maybeRecalculateOntology(items);
            selectedSubitemPath = null;
        }
        else {
            delete item_cache[selected_item.id];
            $model.deleteItem(items, selected_item);
            $ontology.maybeRecalculateOntology(items);
            selected_item = null;
            selectedSubitemPath = null;
            mousedItemId = null;
        }
        $auto_complete.refreshParse(items);
        $persist.save(items);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function focusItem(item) {
    	//TODO refactor into view?
        let $div = $(".item[data-item-id='" + item.id + "'] > .itemdata");
        $div.focus();
    }

    function focusSubItem(item, path) {
    	//TODO refactor into view?
        let $div = $("[data-item-id='" + item.id + "'][data-subitem-path='" + path + "']");
        $div.focus();
    }

    function actionUp(event) {
        console.log('----------------------------------------------------');
        console.log('actionUp()');
        event.stopPropagation();
        let items = getItems();
        if (selectedSubitemPath != null) {
            selectedSubitemPath = $model.moveUpSubitem(selected_item, selectedSubitemPath);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selected_item, selectedSubitemPath);
        }
        else {
            $model.moveUp(items, selected_item);
            $persist.save(items);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusItem(selected_item);
        }
        if (selected_item != null) {
        	//TODO refactor into view?
            $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
            console.log('DEBUG: item mouse selected');
        }
        console.log('-----------------------------------------------------');
    }

    function actionDown(event) {
        event.stopPropagation();
        let items = getItems();
        if (selectedSubitemPath != null) {
            selectedSubitemPath = $model.moveDownSubitem(selected_item, selectedSubitemPath);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selected_item, selectedSubitemPath);
        }
        else {
            $model.moveDown(items, selected_item);
            $persist.save(items);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusItem(selected_item);
        }
        if (selected_item != null) {
        	//TODO refactor into view?
            $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
        }
    }

    function onDblClickItem(event) {
        event.stopPropagation();
        let do_select = false;
        let items = getItems();
        if (selected_item != null) {
            if (selected_item.id == this.dataset.itemId) {
                closeSelectedItem();
                let items = getItems();
                $auto_complete.refreshParse(items);
                $view.render(items, null, null, null, mode_sort, mode_more_results);
            }
            else {
                do_select = true;
            }
        }
        else {
            do_select = true;
        }
        if (do_select) {
            selected_item = getItemById(this.dataset.itemId);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            mousedItemId = selected_item.id;
            focusItem(selected_item);
            console.log(selected_item);
        }
    }

    function onDblClickDocument(event) {
        event.stopPropagation();
        let items = getItems();
        if (selected_item != null) {
            closeSelectedItem();
            let items = getItems();
            $auto_complete.refreshParse(items);
            $view.render(items, null, null, null, mode_sort, mode_more_results);
        }
    }

    function closeSelectedItem() {
        if (selected_item == null) {
            console.log('selectedId is null, do nothing');
            return;
        }
        let items = getItems();
        $ontology.maybeRecalculateOntology(items);
        deselect();
        $persist.save(items);
    }

    function deselect() {
        selected_item = null;
        selectedSubitemPath = null;
        itemOnClick = null;
        itemOnRelease = null;
        mousedItemId = null;
    }

    function onEditItem(event) {
        if (selected_item != null) {
        	//TODO refactor into view?
            let text = $('[data-item-id="' + selected_item.id + '"]').find('.data')[0].innerHTML;
            $model.updateData(selected_item, text);
        }
    }

    function onEditSubitem(event) {
        if (selected_item != null) {
            let text = event.target.innerHTML;
            //TODO refactor into view?
            let path = $(event.target).attr('data-subitem-path');
            $model.updateSubitemData(selected_item, path, text);
        }
    }

    function onFocusItem(event) {
        $auto_complete_tags.hideOptions();
        if (selected_item == null) {
            return;
        }
        selectedSubitemPath = null;
        //TODO refactor into view?
        $('.data').removeClass('selected-item');
        $('[data-item-id="' + selected_item.id + '"] .itemdata').addClass('selected-item');
        $('[data-item-id="' + selected_item.id + '"]').find('.tag')[0].value = selected_item.tags;
    }

    function onFocusSubitem(event) {
        $auto_complete_tags.hideOptions();
        if (selected_item == null) {
            return;
        }
        selectedSubitemPath = $(event.target).attr('data-subitem-path');
        //TODO refactor into view?
        $('.data').removeClass('selected-item');
        $('[data-item-id="' + selected_item.id + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]').addClass('selected-item');
        $('[data-item-id="' + selected_item.id + '"]').find('.tag')[0].value = $model.getSubItemTags(selected_item, selectedSubitemPath);
    }

    function actionEditTime(event) {
        if (selected_item == null) {
            throw "Unexpected, no selected item...";
        }
        //TODO refactor into view?
        let text = $('[data-item-id="' + selected_item.id + '"]').find('.time')[0].value;
        let utc_date = new Date(text);
        let timestamp = utc_date.getTime() + utc_date.getTimezoneOffset() * 60 * 1000;
        let date2 = new Date(timestamp);
        console.log(date2);
        $model.updateTimestamp(selected_item, timestamp);
        $persist.save(items);
    }

    function actionFocusEditTag(event) {
        let items = getItems();
        $auto_complete_tags.onChange(items, selected_item, selectedSubitemPath);
        $auto_complete_tags.showOptions();
    }
    
    function actionEditTag(event) {
        if (selected_item == null) {
            throw "Unexpected, no selected item...";
        }
        //TODO refactor into view?
        let text = $('[data-item-id="' + selected_item.id + '"]').find('.tag')[0].value;
        if (selectedSubitemPath != null) {
            $model.updateSubTag(selected_item, selectedSubitemPath, text);
        }
        else {
            $model.updateTag(selected_item, text);
        }
        let items = getItems();
        $auto_complete_tags.onChange(items, selected_item, selectedSubitemPath);
        $auto_complete_tags.showOptions();
    }

    function actionEditSearch(event) {
        let items = getItems();
        if (selected_item != null) {
            //not sure it should ever make it here
            closeSelectedItem();
            let items = getItems();
            $auto_complete.refreshParse(items);
            $view.render(items, null, null, null, mode_sort, mode_more_results);
        }
        //TODO refactor into view?
        let $el = $('.action-edit-search')[0]; //TODO: don't use class here!
        let text = $el.value;
        localStorage.setItem('search', text);
        function eqSet(as, bs) {
            if (as.size !== bs.size)
                return false;
            for (let _i = 0, as_1 = as; _i < as_1.length; _i++) {
                let a = as_1[_i];
                if (!bs.has(a))
                    return false;
            }
            return true;
        }

        mode_more_results = false;

        $auto_complete.onChange(items);

        if (mode_backspace_key == false) {
            window.scrollTo(0, 0);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        }
        else {
            mode_skipped_a_render = true;
        }
    }

    function backup() {
        let data = JSON.stringify(getItems());
        $('#ta_data').val(data);
    }

    function restore(items) {
        setItems(items);
        $persist.save(items);
        window.scrollTo(0, 0);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionMouseover() {
    	//TODO refactor into view?
        mousedItemId = $(this).attr('data-item-id');
        if (selected_item != null && mousedItemId == selected_item.id) {
            $(this).addClass('moused-selected');
        }
        else {
            $(this).addClass('moused');
            $auto_complete_tags.hideOptions();
        }
        if (itemOnClick != null && itemOnClick.id != mousedItemId) {
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
        itemOnClick = getItemById(mousedItemId);
    }

    function actionMouseup() {
        itemOnRelease = getItemById(mousedItemId);
        let items = getItems();
        if (itemOnClick != null && itemOnRelease != null && itemOnClick.id != itemOnRelease.id) {
            if (mode_sort == SORT.priority) {
                $model.drag(items,itemOnClick, itemOnRelease);
                $persist.save(items);
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                if (selected_item != null) {
                	//TODO refactor into view?
                    $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
                }
            }
            else if (mode_sort == SORT.time) {
                alert('Cannot reorder items when sorting by time.');
            }
            else {
                throw "Unhandled sort mode: " + mode_sort;
            }
        }
        itemOnClick = null;
        itemOnRelease = null;
    }

    function onBackspaceUp() {
        //TODO: confirm we are in the search input box
    	mode_backspace_key = false;
        let items = getItems();
        if (mode_skipped_a_render == true) {
            window.scrollTo(0, 0);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            mode_skipped_a_render = false;
        }
    }

    function onBackspaceDown() {
    	mode_backspace_key = true;
    }

    function onWindowFocus() {
        items = getItems();
        let reload = $persist.maybeReload(items);
        if (reload) {
            items = $persist.load(items);
            setItems(items);
            $ontology.maybeRecalculateOntology(items);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        }
    }

    //TODO refactor this into modes
    function onEnterOrTab() {
    	if ($auto_complete.getModeHidden() == false) {
            $auto_complete.selectSuggestion();
            actionEditSearch();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            let items = getItems();
            $auto_complete_tags.selectSuggestion(items, selected_item, selectedSubitemPath);
        }
    }

    function onClickTagSuggestion() {        
        let items = getItems();
    	$auto_complete_tags.selectSuggestion(items, selected_item, selectedSubitemPath);
        $auto_complete_tags.onChange(items, selected_item, selectedSubitemPath);
    }

    function onSearchClick(e) {
        $auto_complete.showOptions();
        let items = getItems();
        if (selected_item != null) {
            closeSelectedItem();
            let items = getItems();
            $auto_complete.refreshParse(items);
            $view.render(items, null, null, null, mode_sort, mode_more_results);
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
        if (selected_item != null) {
            closeSelectedItem();
            let items = getItems();
            $auto_complete.refreshParse(items);
            $view.render(items, null, null, null, mode_sort, mode_more_results);
        }
    }

    function actionMoreResults() {
        let items = getItems();
        if (selected_item != null) {
            closeSelectedItem(); 
            $auto_complete.refreshParse(items);
        }
        mode_more_results = true;
        $view.render(items, null, null, null, mode_sort, mode_more_results);
    }

    function itemIsSelected() {
        if (selected_item == null) {
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
        let items = getItems();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        $persist.saveToFileSystem(items);
    }

    function testLocalStorage() {
        let test = 'test';
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
        let items = getItems();
        $persist.save(items);
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

    function updateSelectedSearchSuggestion(id) {
        if (id == undefined) {
            $auto_complete.updateSelectedSearchSuggestion();
        }
        else {
            $auto_complete.updateSelectedSearchSuggestion(id);
        }
    }

    function updateSelectedTagSuggestion(id) {
        if (id == undefined) {
            $auto_complete_tags.updateSelectedTagSuggestion();
        }
        else {
            $auto_complete_tags.updateSelectedTagSuggestion(id);
        }
    }

    function setMoreResults(value) {
        mode_more_results = value;
    }
    
    function init() {

        if (testLocalStorage() == false) {
            window.location.replace('error-pages/error-local-storage.html');
        }

        //restore saved search
        let search = localStorage.getItem('search');
        if (search != null && search != 'null') {
            $('.action-edit-search')[0].value = search;
        }
        else {
            localStorage.setItem('search', null);
            $('.action-edit-search')[0].value = '';
        }

        let items = $persist.load();
        setItems(items);

        $ontology.maybeRecalculateOntology(items);
        
        $auto_complete.onChange(items);

        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);

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
        onEscape: onEscape,
		onBackspaceUp: onBackspaceUp,
		onBackspaceDown: onBackspaceDown,
		onWindowFocus: onWindowFocus,
		onEnterOrTab: onEnterOrTab,
		onClickTagSuggestion: onClickTagSuggestion,
        onCheck: onCheck,
        onUncheck: onUncheck,
        onSearchClick: onSearchClick,
        onSearchFocusOut: onSearchFocusOut,
        onClickSelectSearchSuggestion: onClickSelectSearchSuggestion,
        onBeforeUnload: onBeforeUnload,
        onUpArrow: onUpArrow,
        onDownArrow: onDownArrow,
        itemIsSelected: itemIsSelected,
        updateSelectedSearchSuggestion: updateSelectedSearchSuggestion,
        updateSelectedTagSuggestion: updateSelectedTagSuggestion,
        setMoreResults: setMoreResults
    };
})();
$todo.init();
