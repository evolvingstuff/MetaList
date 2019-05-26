"use strict";

let $todo = (function () {

    let FANCY_MERGE = false;
    let ENABLE_CHECK_FOR_UPDATES = true;
    let CHECK_FOR_UPDATES_FREQ_MS = 1000;
    let ENABLE_CHECK_FOR_IDLE = true;
    let CHECK_FOR_IDLE_FREQ_MS = 1000;
    let SAVE_AFTER_MS_OF_IDLE = 30000;
    let ONLY_PERSIST_ON_BEFORE_UNLOAD = true;
    let UPDATE_SIDEBAR_ON_EDIT_ITEM_DATA = false;
    let MAX_SHADOW_ITEMS_ON_MOVE = 0;

    let selected_item = null;
    let selectedSubitemPath = null;
    let itemOnClick = null;
    let itemOnRelease = null;
    let mousedItemId = null;
    let recentClickedSubitem = null;
    let copy_of_selected_item_before_editing = null;

    let mode_backspace_key = false;
    let mode_skipped_a_render = false;
    let mode_show_backup = false;
    let mode_collapse = true;
    let mode_sort = 'priority';
    let mode_more_results = false;
    let mode_modal = false;
    let mode_encrypt_save = true;
    let mode_already_idle_saved = false;
    let mode_mousedown = false;
    let mode_advanced_view = false;
    let mode_editing_subitem = false;
    let mode_editing_subitem_initial_state = null;
    let mode_clipboard_text = null;

    let timestamp_focused = Date.now();
    let MIN_FOCUS_TIME_TO_EDIT = 300;

    let subsection_clipboard = null;
    let last_active_timestamp = Date.now();

    let items = [];
    let item_cache = {};

    let mode_disconnected = false;

    let mode_focus = null;

    

    function getItems() {
        return items;
    }

    function setItems(new_items) {
        items = new_items;
        item_cache = {};
        for (let item of items) {
            item_cache[item.id] = item;
        }
        $model.recalculateAllTags(items);
        $auto_complete.onChange(items);
        let updated_ontology = $ontology.maybeRecalculateOntology(items);
        let updated_macros = $macros.loadMacros(items);
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
        $model.resetTagCountsCache();
        $model.resetCachedNumericTags();
        clearSidebar();
    }

    function actionAddNewItem(event) {
        closeAnyOpenMenus();
        deselect();
        actionAdd(event);
    }

    function actionAdd(event) {
        if (mode_modal) {
            return;
        }
        closeAnyOpenMenus();
        if (event != undefined) {
            event.stopPropagation();
            event.preventDefault();
        }
        if (selected_item != null) {
            onExitEditingSubitem();
            let subitem_index = getSubitemIndex();
            let extra_indent = false;
            selectedSubitemPath = $model.addSubItem(selected_item, subitem_index, extra_indent); //TODO: get back new ref to items?
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            clearSidebar();
            focusSubItem(selectedSubitemPath);
        }
        else {
            mode_more_results = false;
            let tags = getTagsFromSearch();
            selected_item = $model.addItemFromSearchBar(items, tags); //TODO: get back new ref to items?
            $effects.temporary_highlight(selected_item.id);
            selectedSubitemPath = selected_item.id+':0';
            $filter.fullyIncludeItem(selected_item);
            $auto_complete.refreshParse(items);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            clearSidebar();
            focusSubItem(selectedSubitemPath);
        }
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        if (selected_item != null) {
            $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
        }
        $searchHistory.addActivatedSearch();
    }

    function getTagsFromSearch() {
        let current_search_string = document.getElementById('search_input').value;
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
        return tags;
    }

    function actionAddSubItem(event) {
        if (mode_modal) {
            return;
        }
        event.stopPropagation();
        onExitEditingSubitem();
        let extra_indent = true;
        let subitem_index = getSubitemIndex();
        selectedSubitemPath = $model.addSubItem(selected_item, subitem_index, extra_indent); //TODO: get back new ref to items?
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        clearSidebar();
        focusSubItem(selectedSubitemPath);
    }

    function actionDeleteButton(event) {
        event.stopPropagation();
        event.preventDefault();
        let subitem_index = getSubitemIndex();
        if (subitem_index == 0) {
            if (!confirm('Are you sure you want to delete this item?')) {
                return;
            }
        }
        else {
            if (!confirm('Are you sure you want to delete this subitem?')) {
                return;
            }
        }
        actionDelete();
    }

    function actionDelete(e) {
        if (selected_item == null) {
            return;
        }
        if (e != undefined) {
            e.preventDefault();
            e.stopPropagation();
        }

        let subitem_index = getSubitemIndex();
        if (subitem_index == 0) {
            delete item_cache[selected_item.id];
            $model.deleteItem(items, selected_item); //TODO: get back new ref to items?
            deselect();
        }
        else {
            let indent = selected_item.subitems[subitem_index].indent;
            let new_subitem_index = 0;
            if (selected_item.subitems.length > subitem_index+1 && selected_item.subitems[subitem_index+1].indent == indent) {
                //Use next
                new_subitem_index = subitem_index; //it will inherit current subitem index
                console.log('choose next subitem');
            }
            else {
                //Find previous
                console.log('choose previous subitem');
                for (let i = subitem_index-1; i >= 0; i--) {
                    if (selected_item.subitems[i].indent <= indent) {
                        new_subitem_index = i;
                        break;
                    }
                }
            }
            
            $model.removeSubItem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?
            selectedSubitemPath = selected_item.id+':'+new_subitem_index;
        }

        let recalculated = $ontology.maybeRecalculateOntology(items);
        if (recalculated) {
            resetAllCache();
        }
        $auto_complete.refreshParse(items);
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        clearSidebar();
        $searchHistory.addActivatedSearch();
        if (selectedSubitemPath != null) {
            focusSubItem(selectedSubitemPath);
        }
    }

    function focusSubItem(path) {
        if (path == null) {
            console.log('WARNING: subitem path is null, cannot focus');
            return;
        }
    	let $div = $("[data-subitem-path='" + path + "']");
        $div.focus();
        placeCaretAtEndContentEditable($div.get(0));
        onEnterEditingSubitem();
    }

    function focusTag(item) {
        let $el = $('[data-item-id="' + selected_item.id + '"]').find('.tag')[0];
        $el.focus();
        actionFocusEditTag();
        let subitem_index = 0;
        if (selectedSubitemPath == null) { //TODO: refactor this
            subitem_index = 0;
        }
        else {
            subitem_index = parseInt(selectedSubitemPath.split(':')[1]);
        }
        let tags = item.subitems[subitem_index].tags;

        //add space at end if not there to trigger suggestions
        if (tags.endsWith(' ') == false && tags.length > 0) {
            $('[data-item-id="' + selected_item.id + '"]').find('.tag')[0].value += ' ';
            actionEditTag();
        }
        placeCaretAtEndInput($el);

        mode_focus = 'tag';
    }

    function actionFullUp(event) {
        event.stopPropagation();
        if (selected_item == null) {
            return;
        }
        //TODO: refactor some of this logic into model
        let last_filtered_item = null;
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            if (item.subitems[0]._include == false) {
                continue;
            }
            if (last_filtered_item == null || last_filtered_item.priority > item.priority) {
                last_filtered_item = item;
            }
        }
        if (last_filtered_item.id == selected_item.id) {
            console.log('at top, do nothing');
            return;
        }
        $effects.temporary_highlight(selected_item.id);
        let migrated = $model.drag(items, selected_item, last_filtered_item); //TODO: get back new ref to items?
        if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
            for (let id of migrated) {
                $effects.temporary_shadow(id);
            }
        }
        console.log('cp1');
        deselect();
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);   
    }

    function actionFullDown(event) {
        event.stopPropagation();
        if (selected_item == null) {
            return;
        }
        //TODO: refactor some of this logic into model
        let first_filtered_item = null;
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            if (item.subitems[0]._include == false) {
                continue;
            }
            if (first_filtered_item == null || first_filtered_item.priority < item.priority) {
                first_filtered_item = item;
            }
        }
        if (first_filtered_item.id == selected_item.id) {
            console.log('at bottom, do nothing');
            return;
        }
        $effects.temporary_highlight(selected_item.id);
        let migrated = $model.drag(items, selected_item, first_filtered_item); //TODO: get back new ref to items?
        if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
            for (let id of migrated) {
                $effects.temporary_shadow(id);
            }
        }
        deselect();
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionUp(event) {
        event.stopPropagation();
        let subitem_index = getSubitemIndex();
        if (subitem_index > 0) {
            selectedSubitemPath = $model.moveUpSubitem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?
            //Choose not to save while in editing mode
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selectedSubitemPath);
        }
        else {
            if (mode_sort == 'priority') {
                $effects.temporary_highlight(selected_item.id);
                let migrated = $model.moveUp(items, selected_item); //TODO: get back new ref to items?
                if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                    for (let id of migrated) {
                        $effects.temporary_shadow(id);
                    }
                }
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items, 
                        function saveSuccess() {}, 
                        function saveFail() {
                            alert('Failed saving file');
                        });
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusSubItem(selectedSubitemPath);
            }
            else if (mode_sort == 'reverse-priority') {
                $effects.temporary_highlight(selected_item.id);
                let migrated = $model.moveDown(items, selected_item); //TODO: get back new ref to items?
                if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                    for (let id of migrated) {
                        $effects.temporary_shadow(id);
                    }
                }
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items, 
                        function saveSuccess() {}, 
                        function saveFail() {
                            alert('Failed saving file');
                        });
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusSubItem(selectedSubitemPath);
            }
            else {
                alert('Cannot manually change order of items when sorted by date.');
            }
            
        }
        if (selected_item != null) {
        	//TODO refactor into view?
            $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
        }
    }

    function actionDown(event) {
        event.stopPropagation();
        let subitem_index = getSubitemIndex();
        if (subitem_index > 0) {
            selectedSubitemPath = $model.moveDownSubitem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?           
            //Choose not to save while in editing mode
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selectedSubitemPath);
        }
        else {
            if (mode_sort == 'priority') {
                $effects.temporary_highlight(selected_item.id);
                let migrated = $model.moveDown(items, selected_item); //TODO: get back new ref to items?
                if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                    for (let id of migrated) {
                        $effects.temporary_shadow(id);
                    }
                }
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items, 
                        function saveSuccess() {}, 
                        function saveFail() {
                            alert('Failed saving file');
                        });
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusSubItem(selectedSubitemPath);
            }
            else if (mode_sort == 'reverse-priority') {
                $effects.temporary_highlight(selected_item.id);
                let migrated = $model.moveUp(items, selected_item); //TODO: get back new ref to items?
                if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                    for (let id of migrated) {
                        $effects.temporary_shadow(id);
                    }
                }
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items, 
                        function saveSuccess() {}, 
                        function saveFail() {
                            alert('Failed saving file');
                        });
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusSubItem(selectedSubitemPath);
            }
            else {
                alert('Cannot manually change order of items when sorted by date.');
            }
        }
        if (selected_item != null) {
        	//TODO refactor into view?
            $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
        }
    }

    function actionIndent() {
        let subitem_index = getSubitemIndex();
        if (subitem_index > 0) {
            $model.indentSubitem(selected_item, selectedSubitemPath);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            clearSidebar();
            focusSubItem(selectedSubitemPath);
            if (selected_item != null) {
                //TODO refactor into view?
                $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
            }
        }
    }

    function actionOutdent() {
        let subitem_index = getSubitemIndex();
        if (subitem_index > 0) {
            $model.outdentSubitem(selected_item, selectedSubitemPath);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            clearSidebar();
            focusSubItem(selectedSubitemPath);
            if (selected_item != null) {
                //TODO refactor into view?
                $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
            }
        }
    }

    function expandRedacted() {
        if (mousedItemId == null ) {
            return;
        }
        let item = getItemById(mousedItemId);
        for (let subitem of item.subitems) {
            subitem._include = 1;
        }
        $view.renderWithoutRefilter(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function onClickEditBar(event) {
        event.stopPropagation();
    }

    function onClickSubitem(event) {
        closeAnyOpenMenus();
        //Do not want to immediately go into editing mode if not already interacting with window?
        let now = Date.now();
        if (now - timestamp_focused < MIN_FOCUS_TIME_TO_EDIT) {
            console.log('SKIPPING');
            return;
        }
        else {
            console.log('NOT SKIPPING delay = ' + (now-timestamp_focused));
        }
        console.log('+++++++++++++++++++++++++++++++++++');
        console.log('onClickSubitem()');
        let path = $(this).attr('data-subitem-path');
        recentClickedSubitem = path;
        event.stopPropagation();
        let do_select = false;
        if (selected_item != null) {
            let item_id = parseInt(path.split(':')[0]);
            if (selected_item.id != item_id) {
                do_select = true;
            }
        }
        else {
            do_select = true;
        }
        if (do_select) {

            if (selected_item != null) {
                closeSelectedItem();
            }

            let item_id = parseInt(this.dataset.subitemPath.split(':')[0]);
            selected_item = getItemById(item_id);
            //$effects.temporary_highlight(selected_item.id);
            copy_of_selected_item_before_editing = copyJSON(selected_item);
            $model.expand(selected_item);
            selectedSubitemPath = recentClickedSubitem;
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            clearSidebar();
            mousedItemId = selected_item.id;
            console.log('\tfocus selectedSubitemPath = ' + selectedSubitemPath);
            focusSubItem(selectedSubitemPath);
            console.log(selected_item);
        }
        recentClickedSubitem = null;
        $searchHistory.addActivatedSearch();
    }

    function closeAnyOpenMenus() {
        //This is hacky but works for now
        //It is because I am capturing events to stop them from bubbling up to the document
        if ($('.dropdown-menu').hasClass('show')) {
            $('.dropdown-toggle').dropdown('toggle');
        }
    }

    function onClickItem(event) {
        console.log('onClickItem()');
        closeAnyOpenMenus();
        event.stopPropagation();
    }

    function onClickDocument(event) {
        console.log('onClickDocument()');
        //event.stopPropagation();
        if (selected_item != null) {
            closeSelectedItem();
            $auto_complete.refreshParse(items);
            $view.render(items, null, null, null, mode_sort, mode_more_results);
            clearSidebar();
        }
    }

    function closeSelectedItem() {
        console.log('close selected item');
        let start = Date.now();
        //TODO: this is very slow!!
        if (selected_item == null) {
            console.log('selectedId is null, do nothing');
            return;
        }
        if (JSON.stringify(copy_of_selected_item_before_editing) != JSON.stringify(selected_item)) {
            //Only highlight if an update was made
            $effects.temporary_highlight(selected_item.id);
        }
        let recalculated = $ontology.maybeRecalculateOntology(items);
        if (recalculated) {
            resetAllCache();
        }
        else {
            $model.resetTagCountsCache();
            $model.resetCachedNumericTags();
        }
        deselect();
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        let end = Date.now();
        clearSidebar();
        console.log('closeSelectedItem() took ' + (end-start) + 'ms');
    }

    function onEnterEditingSubitem() {
        if (selected_item == null || selectedSubitemPath == null) {
            console.log('WARNING: expected subitem and item to be selected');
            return;
        }
        mode_editing_subitem = true;
        let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
        mode_editing_subitem_initial_state = subitem.data;
    }

    function onExitEditingSubitem() {
        if (mode_editing_subitem = true) {
            let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
            if (subitem != null) {
                let new_data = subitem.data;
                if (new_data != mode_editing_subitem_initial_state) {
                    autoformat(items, selected_item, selectedSubitemPath, mode_editing_subitem_initial_state, new_data);
                }
                mode_editing_subitem = false;
                mode_editing_subitem_initial_state = null;
            }
        }
    }

    function deselect() {
        if (selectedSubitemPath != null) {
            onExitEditingSubitem();
        }
        selected_item = null;
        selectedSubitemPath = null;
        itemOnClick = null;
        itemOnRelease = null;
        mousedItemId = null;
        mode_focus = null;
        clearSidebar();
    }

    function onEditSubitem(event) {
        if (selected_item != null) {
            let text = event.target.innerHTML;
            let path = $(event.target).attr('data-subitem-path');
            $model.updateSubitemData(selected_item, path, text); //TODO: get back new ref to items?
            if (UPDATE_SIDEBAR_ON_EDIT_ITEM_DATA) {
                setSidebar();
            }
        }
    }

    function onFocusSubitem(event) {
        $auto_complete_tags.hideOptions();
        if (selected_item == null) {
            return;
        }

        if (selectedSubitemPath != null && mode_editing_subitem == true) {
            onExitEditingSubitem();
        }

        selectedSubitemPath = $(event.target).attr('data-subitem-path');
        //TODO refactor into view?
        $('.data').removeClass('selected-item');
        $('[data-item-id="' + selected_item.id + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]').addClass('selected-item');
        $('[data-item-id="' + selected_item.id + '"]').find('.tag')[0].value = $model.getSubItemTags(selected_item, selectedSubitemPath);

        mode_focus = 'subitem';

        setSidebar();
        onEnterEditingSubitem();
    }

    function actionEditTime(event) {

        if (selected_item == null) {
            throw "Unexpected, no selected item...";
        }

        //TODO refactor into view?
        //let text = $('[data-item-id="' + selected_item.id + '"]').find('.time')[0].value;
        let text = $(this).val();
        let utc_date = new Date(text);
        let timestamp = utc_date.getTime() + utc_date.getTimezoneOffset() * 60 * 1000;
        let date2 = new Date(timestamp);

        //TODO: update sidebar in real time?

        $model.updateTimestamp(selected_item, timestamp); //TODO: get back new ref to items?

        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
    }

    function actionFocusEditTag() {
        $auto_complete_tags.onChange(items, selected_item, selectedSubitemPath);
        $auto_complete_tags.showOptions();
        mode_focus = 'tag';

        if (mode_advanced_view) {
            let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
            $sidebar.updateSidebar(items, selected_item, subitem, true);
        }
    }
    
    function actionEditTag() {
        console.log('--------------------------------');
        if (selected_item == null) {
            throw "Unexpected, no selected item...";
        }
        //TODO refactor into view?
        let text = $('[data-item-id="' + selected_item.id + '"]').find('.tag')[0].value;
        $model.updateSubTag(selected_item, selectedSubitemPath, text); //TODO: get back new ref to items?
        $auto_complete_tags.onChange(items, selected_item, selectedSubitemPath);
        $auto_complete_tags.showOptions();
        
        if (mode_advanced_view) {
            let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
            $sidebar.updateSidebar(items, selected_item, subitem, true);
        }

        console.log('_______________________________');
    }

    function actionEditSearch(event) {
        console.log('>>> actionEditSearch()');
        if (selected_item != null) {
            //not sure it should ever make it here
            closeSelectedItem();
            $auto_complete.refreshParse(items);
            $view.render(items, null, null, null, mode_sort, mode_more_results);
            clearSidebar();
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
            clearSidebar();
        }
        else {
            mode_skipped_a_render = true;
        }

    }

    function backup() {
        let data = JSON.stringify(items);
        $('#ta_data').val(data);
    }

    function maybeResetSearch() {
        let current_search_string = $('.action-edit-search')[0].value;
        if (current_search_string != null && current_search_string != '') {
            let parse_results = $parseSearch(items, current_search_string);
            $filter.filterItemsWithParse(items, parse_results, false);
            let tot = 0;
            for (let item of items) {
                if (item.deleted != undefined) {
                    continue;
                }
                if (item.subitems[0]._include == 1) {
                    tot++;
                }
            }
            if (tot == 0) {
                localStorage.setItem('search', null);
                $('.action-edit-search')[0].value = '';
                parse_results = [];
                $filter.filterItemsWithParse(items, parse_results, false);
            }
            else {
                //alert('no reset search');
            }
        }
        $auto_complete.onChange(items);
    }

    function restoreFromFile(obj) {
        if (obj.encryption.encrypted == false) {
            try {
                let new_items = $schema.checkSchemaUpdate(obj.data, obj.data_schema_version);
                if (FANCY_MERGE) {
                    items = $model.merge(new_items, items);
                }
                else {
                    items = new_items;
                }
                setItems(items);
                $persist.save(items, 
                    function saveSuccess() {}, 
                    function saveFail() {
                        alert('Failed saving file');
                    });
                window.scrollTo(0, 0);
                maybeResetSearch();
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                clearSidebar();
            }
            catch (e) {
                alert(e);
            }
        }
        else {
            picoModal({
            content: 
                "<p>Enter passphrase:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='reload_passphrase' type='password'></input></p>" + 
                "</div>" +
                "<div' style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Ok</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            mode_modal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let passphrase = $('#reload_passphrase').val();
                    if (passphrase == '') {
                        alert('Must enter a non-empty passphrase');
                        return;
                    }
                    //TODO: handle failure here
                    $persist.unencryptFromFileObject(passphrase, obj, 
                        function success(loaded_items) {
                            try {
                                let new_items = $schema.checkSchemaUpdate(loaded_items, obj.data_schema_version);
                                if (FANCY_MERGE) {
                                    items = $model.merge(new_items, items);
                                }
                                else {
                                    items = new_items;
                                }
                                setItems(items);
                                $persist.save(items, 
                                    function saveSuccess() {}, 
                                    function saveFail() {
                                        alert('Failed saving file');
                                    });
                                window.scrollTo(0, 0);
                                maybeResetSearch();
                                resetAllCache();
                                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                                clearSidebar();
                            }
                            catch (e) {
                                alert(e);
                            }
                        },
                        function failure() {
                            alert('Incorrect passphrase.');
                        });
                    modal.close();
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterClose((modal, event) => {
            mode_modal = false;
            modal.destroy();
        }).show();
            
        }
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

    function actionMousedown(e) {
        itemOnClick = getItemById(mousedItemId);
        if (itemOnClick != null) {
            //don't add to search unless an actual item is clicked
            $searchHistory.addActivatedSearch();
            if (selected_item == null) {
                document.body.style.cursor = "grab";
            }
            else {
                if (selected_item.id != itemOnClick.id) {
                    document.body.style.cursor = "grab";
                }
            }
        }
        
        mode_mousedown = true;
    }

    function actionMouseup(e) {

        e.stopPropagation();

        mode_mousedown = false;

        document.body.style.cursor = "auto";

        itemOnRelease = null;
        if (mousedItemId != null) {
            itemOnRelease = getItemById(mousedItemId);
        }

        //TODO: This is spaghetti
        if (itemOnRelease != null && selected_item != null && selected_item.id == itemOnRelease.id) {
            //Released inside the item we are editing
            itemOnClick = null;
            itemOnRelease = null;
            return;
        }

        if (itemOnClick != null && itemOnRelease != null && itemOnClick.id != itemOnRelease.id) {
            if (mode_sort == 'priority') {
                $effects.temporary_highlight(itemOnClick.id);
                let migrated = $model.drag(items, itemOnClick, itemOnRelease);
                if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                    for (let id of migrated) {
                        $effects.temporary_shadow(id);
                    }
                }
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items, 
                    function saveSuccess() {}, 
                    function saveFail() {
                        alert('Failed saving file');
                    });
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                clearSidebar();
                if (selected_item != null) {
                	//TODO refactor into view?
                    $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
                }
                $searchHistory.addActivatedSearch();
            }
            else if (mode_sort == 'reverse-priority') {
                $effects.temporary_highlight(selected_item.id);
                let migrated = $model.drag(items, itemOnRelease, itemOnClick);
                if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                    for (let id of migrated) {
                        $effects.temporary_shadow(id);
                    }
                }
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items, 
                        function saveSuccess() {}, 
                        function saveFail() {
                            alert('Failed saving file');
                        });
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                clearSidebar();
                if (selected_item != null) {
                    //TODO refactor into view?
                    $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
                }
                $searchHistory.addActivatedSearch();
            }
            else {
                alert('Cannot manually change order of items when sorted by date.');
            }
        }
        itemOnClick = null;
        itemOnRelease = null;
    }

    function onBackspaceUp() {
        //TODO: confirm we are in the search input box
    	mode_backspace_key = false;
        if (mode_skipped_a_render == true) {
            window.scrollTo(0, 0);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            clearSidebar();
            mode_skipped_a_render = false;
        }
    }

    function onBackspaceDown() {
    	mode_backspace_key = true;
    }

    function checkForUpdates() {
        if ($persist.maybeReload(items) == true) {
            $persist.load(
                function success(items_) {
                    setItems(items_);
                    clearSelection();
                    $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                    clearSidebar();
                }, 
                function failure() {
                    alert('ERROR: failed to reload');
                });
        }
    }

    function checkForIdle() {
        let now = Date.now();
        let elapsed = now - last_active_timestamp;
        if (elapsed > SAVE_AFTER_MS_OF_IDLE) {
            if (mode_already_idle_saved) {
                console.log('already idle saved, do nothing');
            }
            else {
                console.log(parseInt(SAVE_AFTER_MS_OF_IDLE/1000) + ' seconds have passed...auto-saving.');
                $persist.save(items, 
                    function saveSuccess() {}, 
                    function saveFail() {
                        alert('Failed saving file');
                    });
                mode_already_idle_saved = true;
            } 
        }
    }

    function onWindowFocus() {
        console.log('>>>>>>>>>>>>>>>>>>>>>');
        console.log('Focused');
        timestamp_focused = Date.now();
        checkForUpdates();
    }

    function onWindowBlur() {
        console.log('onWindowBlur()');
        $persist.save(items, 
            function saveSuccess() {}, 
            function saveFail() {
                alert('Failed saving file');
            });
        resetInactivityTimer();
    }

    //TODO refactor this into modes
    function onEnterOrTab(e) {
    	if ($auto_complete.getModeHidden() == false) {
            $auto_complete.selectSuggestion();
            actionEditSearch();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.selectSuggestion(items, selected_item, selectedSubitemPath);

            if (mode_advanced_view) {
                let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
                let editing = false;
                if (selected_item != null) {
                    editing = true;
                }
                $sidebar.updateSidebar(items, selected_item, subitem, editing);
            }
        }
        else if (selected_item == null) {
            actionAdd(e);
        }
    }

    function onSpace(e) {

        //TODO: currently a bug with this that makes search more difficult to do

    }

    function onClickTagSuggestion() {
    	$auto_complete_tags.selectSuggestion(items, selected_item, selectedSubitemPath);
        $auto_complete_tags.onChange(items, selected_item, selectedSubitemPath);
    }

    function onSearchClick(e) {
        $auto_complete.showOptions();
        if (selected_item != null) {
            closeSelectedItem();
            $auto_complete.refreshParse(items);
            $view.render(items, null, null, null, mode_sort, mode_more_results);
            clearSidebar();
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
            $auto_complete.refreshParse(items);
            $view.render(items, null, null, null, mode_sort, mode_more_results);
            clearSidebar();
        }
    }

    function actionMoreResults() {
        if (selected_item != null) {
            closeSelectedItem(); 
            $auto_complete.refreshParse(items);
        }
        mode_more_results = true;
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        clearSidebar();
    }

    function itemIsSelected() {
        if (selected_item == null) {
            return false;
        }
        return true;
    }

    function actionHome() {
        let was_empty = false;
        if ($('.action-edit-search').val() != '') {
            $('.action-edit-search').val('');
        }
        else {
            was_empty = true;
        }
        window.scrollTo(0, 0);
        actionEditSearch();
        if (was_empty) {
            $auto_complete.showOptions();
        }
        else {
            $auto_complete.hideOptions();
        }
    }


    function actionSave(e) {
        if (mode_modal) {
            return;
        }
        e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $persist.save(items, 
            function saveSuccess() {}, 
            function saveFail() {
                alert('Failed saving file');
            });
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        clearSidebar();

        picoModal({
            content: 
                "<select id='sel_save_scope'>" +
                "<option value='all'>Complete backup</option>" +
                "<option value='view'>Save current view</option>" +
                "</select>" +
                "<br>" + 
                "<select id='sel_save_format'>" +
                "<option value='json'>JSON format</option>" +
                "<option value='text'>Plain text format</option>" +
                "</select>" +
                "<div style='width:300px;'><input id='cb_encrypt' type='checkbox' checked> Encrypted</div>" +
                "<div id='inputs_pw' style='margin-left: 25px;'>" +
                "<p>Enter your password to encrypt the result:</p>" +
                "<br>" + 
                "<p><input id='passphrase1' type='password'></input></p>" + 
                "<p><input id='passphrase2' type='password'></input></p>" + 
                "<div id='pwstrength' style='width:400px; height:80px;'>&nbsp;</div>" +
                "</div>" +
                "<div>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Save</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {

            actionToggleEncryptSave();

            $(document).on('keyup','#passphrase1', function(e) {
                let passphrase = $('#passphrase1').val();
                if (passphrase == '') {
                    $('#pwstrength').html('&nbsp;');
                    return;
                }
                let result = zxcvbn(passphrase);
                if (result.feedback.warning != "" || result.feedback.suggestions.length > 0) {
                    let statements = [];
                    if (result.feedback.warning != '') {
                        statements.push('<span style="color:red;font-weight:bold;">'+result.feedback.warning+'</span>');
                    }
                    for (let suggestion of result.feedback.suggestions) {
                        statements.push('<span style="color:red">'+suggestion+'</span>');
                    }
                    $('#pwstrength').html(statements.join('<br>'));
                }
                else {
                    $('#pwstrength').html('<br><span class="glyphicon glyphicon-ok" style="color:green;"></span> Strong password');
                    console.log('okay');
                }
            });
            
            mode_modal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {

                    let format = $('#sel_save_format').val();
                    let scope = $('#sel_save_scope').val();

                    let passphrase1 = null;

                    if (mode_encrypt_save) {

                        if (format == 'text') {
                            alert('Not able to encrypt a plain text format.');
                            return;
                        }

                        passphrase1 = $('#passphrase1').val();
                        let passphrase2 = $('#passphrase2').val();
                        if (passphrase1 != passphrase2) {
                            alert('Passphrases must match');
                            return;
                        }
                        if (passphrase1 == '') {
                            alert('Must enter a non-empty passphrase');
                            return;
                        }


                    }

                    $persist.saveToFileSystem(items, format, scope, mode_encrypt_save, passphrase1);
                    
                    modal.close();
                    
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#passphrase1').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            mode_modal = false;
        }).show();
    }

    //TODO: only if serving from local html file directly
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

    function onExec(e) {
        e.stopPropagation();
        let text = e.currentTarget.innerHTML;
        text = text
            .replace(/<br><\/div><div>/g, '\n') //this is a hack, not sure by br and div combine
            .replace(/<br><div>/g,'\n')
            .replace(/<br><\/div>/g,'\n')
            .replace(/<div>/g,'\n')
            .replace(/<\/div>/g,'')
            .replace(/<span.*?>/g,'')
            .replace(/<\/span>/g,'')
            .replace(/<br>/g,'\n')
            .replace(/&nbsp;/g,' ')
            .replace(/&gt;/g,'>')
            .replace(/&lt;/g,'<')
            .replace(/<code.*?>/g, '')
            .replace(/<\/code>/g, '');

        //TODO: basic checks here

        if (text.includes(CLIPBOARD_ESCAPE_SEQUENCE)) {
            if (mode_clipboard_text == null || mode_clipboard_text.trim() == '') {
                alert("Nothing in clipboard. Ignoring command.");
                return;
            }
            text = text.replace(CLIPBOARD_ESCAPE_SEQUENCE, mode_clipboard_text);
        }

        $('#div_spinner').show();

        function onFnSuccess(message) {
            console.log('-----------------------------');
            console.log(message)
            console.log('-----------------------------');
            if (message != null && message != '') {
                function after() {
                    mode_modal = false;
                }
                mode_modal = true;
                $cli_response.open_dialog(text, message, after);
            }
            $('#div_spinner').hide();
        }

        function onFnFailure() {
            $('#div_spinner').hide();
            alert('FAILED');
        }

        let obj = {
            command: text
        }

        $.ajax({
            url: '/exec',
            type: 'post',
            dataType: 'json',
            contentType: 'application/json',
            success: function (json) {
                onFnSuccess(json.message);
            },
            fail: function(xhr, textStatus, errorThrown){
                onFnFailure();
            },
            error: function(request, status, error) {
                onFnFailure();
            },
            data: JSON.stringify(obj)
        });
    }

    function onCopy(e) {
        e.stopPropagation();
        let text = e.currentTarget.innerHTML;
        text = text
            .replace(/<br><\/div><div>/g, '\n') //this is a hack, not sure by br and div combine
            .replace(/<br><div>/g,'\n')
            .replace(/<br><\/div>/g,'\n')
            .replace(/<div>/g,'\n')
            .replace(/<\/div>/g,'')
            .replace(/<span.*?>/g,'')
            .replace(/<\/span>/g,'')
            .replace(/<br>/g,'\n')
            .replace(/&nbsp;/g,' ')
            .replace(/&gt;/g,'>')
            .replace(/&lt;/g,'<')
            .replace(/&amp;/g,'&')
            .replace(/<code.*?>/g, '')
            .replace(/<\/code>/g, '');
        console.log('----------------');
        console.log('COPY TEXT:');
        console.log(text);
        console.log('----------------');
        mode_clipboard_text = text;
        let _onCopy = function(e) {
          e.clipboardData.setData('text/plain', text);
          e.preventDefault();
        };
        document.addEventListener('copy', _onCopy);
        document.execCommand('copy');
        document.removeEventListener('copy', _onCopy);

        /*
        //asdf, possibly rerender if there is an @exec visible
        console.log('possibly rerender due to @exec updates');
        for (let item of items) {
            for (let subitem of item.subitems) {

            }
        }
        */

        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        clearSidebar();

    }

    function actionGotoSearch(e) {
        e.stopPropagation();
        let text = e.target.innerText;
        $('.action-edit-search')[0].value = text;
        actionEditSearch();
    }

    function onCheck(e) {
        e.stopPropagation();
        let parent = $(e.target).parents('[data-subitem-path]');
        let path = $(parent).attr('data-subitem-path');
        let id = parseInt(path.split(':')[0]);
        let item = getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace('@todo','@done'); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        clearSidebar();
    }

    function onUncheck(e) {
        e.stopPropagation();
        let parent = $(e.target).parents('[data-subitem-path]');
        let path = $(parent).attr('data-subitem-path');
        let id = parseInt(path.split(':')[0]);
        let item = getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace('@done','@todo'); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        clearSidebar();
    }

    function onFold(e) {
        e.stopPropagation();
        let parent = $(e.target).parents('[data-subitem-path]');
        let path = $(parent).attr('data-subitem-path');
        let id = parseInt(path.split(':')[0]);
        let item = getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace('@+','@-'); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        clearSidebar();
    }

    function onUnfold(e) {
        e.stopPropagation();
        let parent = $(e.target).parents('[data-subitem-path]');
        let path = $(parent).attr('data-subitem-path');
        let id = parseInt(path.split(':')[0]);
        let item = getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace('@-','@+'); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        clearSidebar();
    }

    function onClickSelectSearchSuggestion(e) {
        e.preventDefault();
        $auto_complete.selectSuggestion();
        actionEditSearch();
    }

    function onBeforeUnload(e) {
        $persist.save(items, 
            function saveSuccess() {}, 
            function saveFail() {
                alert('Failed saving file');
            });
    }

    function navigate(newSubitemPath) {
        if (selected_item != null && newSubitemPath != selectedSubitemPath) {
            selectedSubitemPath = newSubitemPath;
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            clearSidebar();
            focusSubItem(selectedSubitemPath);
        }
    }

    function onUpArrow(e) {
        if ($auto_complete.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete.arrowUp();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete_tags.arrowUp();
        }
        else if (selected_item != null) {
            e.stopPropagation();
            let $div = $('.selected-item')[0];
            let pos = getCaretPosition($div);
            if (pos.location == 0) {
                navigate($model.getPrevSubitemPath(selected_item, selectedSubitemPath));
                let $div = $('.selected-item')[0];
                placeCaretAtStartContentEditable($div);
                //e.preventDefault();
            }
        }
    }

    function onDownArrow(e) {
        if ($auto_complete.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete.arrowDown();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete_tags.arrowDown();
        }
        else if (selected_item != null) {
            e.stopPropagation();
            let $div = $('.selected-item')[0];
            let pos = getCaretPosition($div);
            if (pos.location == pos.textLength) {
                navigate($model.getNextSubitemPath(selected_item, selectedSubitemPath));
            }
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

    //TODO: this is an ugly way to set state.
    function setMoreResults(value) {
        mode_more_results = value;
    }

    function onHotkeyToFromTags(e) {
        if (selected_item == null) {
            return;
        }

        //TODO: keep track of caret position and move back to that

        e.preventDefault();
        
        if (mode_focus == 'tag') {
            focusSubItem(selectedSubitemPath);
        }
        else {
            focusTag(selected_item);
        }
        
        if (mode_advanced_view) {
            let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
            let editing = false;
            if (selected_item != null) {
                editing = true;
            }
            $sidebar.updateSidebar(items, selected_item, subitem, editing);
        }
    }

    function onClickMenu() {
        //TODO: this pattern exists in a lot of places
        if (selected_item != null) {
            closeSelectedItem();
            $auto_complete.refreshParse(items);
            $view.render(items, null, null, null, mode_sort, mode_more_results);
            clearSidebar();
        }
    }

    function actionRenameTag(e) {
        if (mode_modal) {
            return;
        }
        e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        clearSidebar();

        picoModal({
            content: 
                "<p>Rename tag:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='tagname1'></input></p>" + 
                "<p><input id='tagname2'></input></p>" + 
                "</div>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Rename Tag</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            mode_modal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let tag1 = $('#tagname1').val();
                    let tag2 = $('#tagname2').val();
                    if (tag1 == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    if (tag2 == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    //TODO: check for valid tag name
                    $model.renameTag(items, tag1, tag2);
                    if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                        $persist.save(items, 
                            function saveSuccess() {}, 
                            function saveFail() {
                                alert('Failed saving file');
                            });
                    }
                    
                    let current_search = $('.action-edit-search')[0].value;
                    let updated_search = current_search.replace(tag1, tag2);
                    if (current_search != updated_search) {
                        $('.action-edit-search')[0].value = updated_search;
                        actionEditSearch();
                    }
                    
                    // $auto_complete.refreshParse(items);
                    $view.render(items, null, null, null, mode_sort, mode_more_results);
                    clearSidebar();
                    
                    modal.close();
                    
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#tagname1').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            mode_modal = false;
        }).show();
    }

    function actionDeleteTag(e) {
        if (mode_modal) {
            return;
        }
        e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        clearSidebar();

        picoModal({
            content: 
                "<p>Remove tag:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='tagname'></input></p>" + 
                "</div>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Delete Tag</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            mode_modal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let tag = $('#tagname').val();
                    if (tag == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    $model.deleteTag(items, tag);
                    if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                        $persist.save(items, 
                            function saveSuccess() {}, 
                            function saveFail() {
                                alert('Failed saving file');
                            });
                    }
                    //$auto_complete.refreshParse(items);
                    $view.render(items, null, null, null, mode_sort, mode_more_results);
                    clearSidebar();
                    modal.close();
                    
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#tagname1').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            mode_modal = false;
        }).show();
    }

    function actionSetPasswordProtection() {
        alert('set passowrd protection TODO...');
    }

    function actionSetSortingMode() {
        alert('set sorting mode TODO...');
    }

    function actionRestoreFromText() {
        alert('restore from text backup TODO...');
    }

    function actionRestoreFromJSON() {
        alert('restore from JSON backup TODO...');
    }

    function actionAddMetaRule() {
        if (mode_modal) {
            return;
        }
        //TODO: maybe leave item open in background?
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        clearSidebar();

        picoModal({
            content: 
                "<div style='margin-left: 15px;'>" +
                "<p>" +
                "<table>" +
                "<tr><th id='th_lhs' style='text-align:center'>specific tag</th>" + 
                "<th style='text-align:center'>" + 
                "<select id='sel_relation' data-show-icon='true'>" +
                "<option value='gt'>implies</option>" +
                "<option value='eq'>is equal to</option>" +
                "</select> " +
                "</th>" + 
                "<th id='th_rhs' style='text-align:center'>general tag</th></tr>" +
                "<tr>" +
                "<td>" +
                "<input id='tagname_lhs' size='15'></input> " + 
                "</td>" +
                "<td id='td_relation' style='text-align:center;'>" +
                "<small><span class='glyphicon glyphicon-arrow-right'></span></small>" +
                "</td>" +
                "<td>" + 
                "<input id='tagname_rhs' size='15'></input>" +
                "</td>"+
                "<tr>" +
                "</table>"+
                "</p>" +
                "</div>" +
                "<div style='margin-left:15px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Add @meta rule</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            mode_modal = true;
            $('body').on('change', '#sel_relation', function(e) {
                let relation = $(e.target).val();
                if (relation == 'eq') {
                    $('#th_lhs').html('tag');
                    $('#th_rhs').html('tag');
                    $('#td_relation').html("<span style='font-weight:bold;'>=</span>");
                }
                else if (relation == 'gt') {
                    $('#th_lhs').html('specific tag');
                    $('#th_rhs').html('general tag');
                    $('#td_relation').html("<small><span class='glyphicon glyphicon-arrow-right'></span></small>");
                }
                else {
                    alert('ERROR: unknown relation');
                }
            })

            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    
                    let tags_lhs = $('#tagname_lhs').val().trim();
                    if (tags_lhs == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    for (let tag_lhs of tags_lhs.split(' ')) {
                        if ($model.isValidTag(tag_lhs) == false) {
                            alert('Left hand side tag "'+tag_lhs+'" was invalid'); //TODO: this is crude feedback
                            return;
                        }
                    }

                    let tags_rhs = $('#tagname_rhs').val().trim();
                    if (tags_rhs == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    for (let tag_rhs of tags_rhs.split(' ')) {
                        if ($model.isValidTag(tag_rhs) == false) {
                            alert('Right hand side tag "'+tag_rhs+'" was invalid'); //TODO: this is crude feedback
                            return;
                        }
                    }

                    let relation = '';
                    if ($('#sel_relation').val() == 'gt') {
                        relation = '=>';
                    }
                    else if ($('#sel_relation').val() == 'eq') {
                        relation = '=';
                    }
                    else {
                        alert('ERROR: unknown logical relationship "'+relation+'"');
                        return;
                    }

                    //Add tags from search context
                    let tags = '@meta';
                    let valid_search_tags = getValidSearchTags();
                    if (valid_search_tags. length > 0) {
                        tags += ' ' + valid_search_tags.join(' ');
                    }
                    let new_meta_item = $model.addItemFromSearchBar(items, tags);
                    let text = tags_lhs + ' ' + relation + ' ' + tags_rhs;
                    //$model.updateData(new_meta_item, text);
                    $model.updateSubitemData(new_meta_item, new_meta_item.id+':0', text);
                    $model.recalculateAllTags(items);
                    let recalculated = $ontology.maybeRecalculateOntology(items);
                    if (recalculated) {
                        resetAllCache();
                    }
                    $view.render(items, null, null, null, mode_sort, mode_more_results);
                    clearSidebar();
                    modal.close();
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#tagname_lhs').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            mode_modal = false;
        }).show();
    }

    function getValidSearchTags() {
        let search_string = $('.action-edit-search')[0].value.trim();
        let result = [];
        let parts = search_string.split(' ');
        let valid_search_tags = ''
        for (let part of parts) {
            part = part.trim();
            if (part == '') {
                continue;
            }
            if (part.startsWith('-')) {
                part = part.substr(1);
            }
            if ($model.isValidTag(part)) {
                result.push(part)
            }
        }
        return result;
    }

    function actionAddTagCurrentView() {
        if (mode_modal) {
            return;
        }
        //e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        clearSidebar();

        picoModal({
            content: 
                "<p>Add tag to all items in current view:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='tagname'></input></p>" + 
                "</div>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Add Tag</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            mode_modal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let tag = $('#tagname').val();
                    if (tag == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    //TODO: check for valid tag name
                    $model.addTagToCurrentView(items, tag);
                    if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                        $persist.save(items, 
                            function saveSuccess() {}, 
                            function saveFail() {
                                alert('Failed saving file');
                            });
                    }
                    $view.render(items, null, null, null, mode_sort, mode_more_results);
                    clearSidebar();
                    modal.close();
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#tagname1').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            mode_modal = false;
        }).show();
    }

    function actionPasswordProtectionSettings() {
        alert("Password Protection todo");
    }

    function actionRemoveTagCurrentView() {
        if (mode_modal) {
            return;
        }
        //e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        clearSidebar();

        picoModal({
            content: 
                "<p>Remove tag from all items in current view:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='tagname'></input></p>" + 
                "</div>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Remove Tag</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            mode_modal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let tag = $('#tagname').val();
                    if (tag == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    $model.removeTagFromCurrentView(items, tag);
                    if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                        $persist.save(items, 
                            function saveSuccess() {}, 
                            function saveFail() {
                                alert('Failed saving file');
                            });
                    }
                    $view.render(items, null, null, null, mode_sort, mode_more_results);
                    clearSidebar();
                    modal.close();
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#tagname1').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            mode_modal = false;
        }).show();
    }

    function deleteEverything() {
        items = [];
        setItems(items);
        //TODO: call $model
        $persist.save(items, 
            function saveSuccess() {}, 
            function saveFail() {
                alert('Failed saving file');
            });
        localStorage.removeItem('items'); //TODO: don't assume localStorage
        location.reload();
    }

    function actionDeleteEverything() {
        if (mode_modal) {
            return;
        }
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        clearSidebar();

        picoModal({
            content: 
                "<p style='font-weight:bold; color:red;'>Are you SURE you want to delete EVERYTHING??</p>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Yes, delete it all</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            mode_modal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    modal.close();
                    deleteEverything();
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#tagname1').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            mode_modal = false;
        }).show();
    }

    function actionToggleEncryptSave() {
        if($("#cb_encrypt").is(':checked')) {
            mode_encrypt_save = true;
        }
        else {
            mode_encrypt_save = false;
        }

        if (mode_encrypt_save) {
            $('#inputs_pw').show();
        }
        else {
            $('#inputs_pw').hide();
        }
    }

    function resetAllCache() {
        $render.resetCache();
        $auto_complete_tags.resetCache();
        $ontology.maybeRecalculateOntology(items);
        $model.resetCachedNumericTags();
        $model.resetTagCountsCache();
    }

    function actionMakeLinkGoto(e) {
        e.stopPropagation();
        if (selected_item == null) {
            return;
        }
        let id = selected_item.id;
        subsection_clipboard = [{data: "@id="+id, tags: "@goto", indent:0}];
    }

    function actionMakeLinkEmbed(e) {
        e.stopPropagation();
        if (selected_item == null) {
            return;
        }
        let id = selected_item.id;
        subsection_clipboard = [{data: "@id="+id, tags: "@embed", indent:0}];
    }

    function getSubitemIndex() {
        if (selectedSubitemPath == null) {
            return 0;
        }
        return parseInt(selectedSubitemPath.split(':')[1]);
    }

    function actionCopySubsection(e) {
        e.stopPropagation();
        if (selected_item == null) {
            return;
        }

        let subitem_index = getSubitemIndex();
        let _subsection_clipboard = $model.copySubsection(selected_item, subitem_index);

        if (_subsection_clipboard.length == 1 && _subsection_clipboard[0].data == '') {
            alert('Cannot copy an empty subsection.');
            return;
        }

        subsection_clipboard = _subsection_clipboard;

        console.log(subsection_clipboard);

        //copy text version to clipboard
        let pseudo_item = new Object();
        pseudo_item.subitems = copyJSON(subsection_clipboard);
        let text = $model.getItemAsText(pseudo_item);
        let _onCopy = function(e) {
          e.clipboardData.setData('text/plain', text);
          e.preventDefault();
        };
        document.addEventListener('copy', _onCopy);
        document.execCommand('copy');
        document.removeEventListener('copy', _onCopy);
    }

    function actionPasteSubsection(e) {
        if (e != undefined) { //TODO: why this guard?
            e.stopPropagation();
        }
        if (subsection_clipboard == null) {
            alert("There is nothing in the clipboard to paste.");
            return;
        }
        if (selected_item == null) {
            let tags = getTagsFromSearch();
            selected_item = $model.addItemFromSearchBar(items, tags);
            selectedSubitemPath = selected_item.id+':0';
            $filter.fullyIncludeItem(selected_item);
        }
        let subitem_index = getSubitemIndex();
        let index_into = $model.pasteSubsection(selected_item, subitem_index, subsection_clipboard);
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        //TODO: this is yucky, we should unify notation
        if (index_into > 0) {
            selectedSubitemPath = selected_item.id+':'+index_into;
        }
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        clearSidebar();
        focusSubItem(selectedSubitemPath);
    }

    function actionCollapseAllView() {
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            if (item.subitems[0]._include == 1) {
                $model.collapse(item);
            }
        }
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        $view.renderWithoutRefilter(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionExpandAllView() {
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            if (item.subitems[0]._include == 1) {
                $model.expand(item);
            }
        }
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        $view.renderWithoutRefilter(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionCollapseItem(e) {
        e.stopPropagation();
        let parent = $(e.target).parents('[data-item-id]');
        let id = parseInt($(parent).attr('data-item-id'));
        let item = getItemById(id);
        $model.collapse(item);
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        $view.renderWithoutRefilter(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }
    
    function actionExpandItem(e) {
        e.stopPropagation();
        let parent = $(e.target).parents('[data-item-id]');
        let id = parseInt($(parent).attr('data-item-id'));
        let item = getItemById(id);
        $model.expand(item);
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items, 
                function saveSuccess() {}, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        $view.renderWithoutRefilter(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionSortByPriority() {
        mode_sort = 'priority';
        localStorage.setItem('mode_sort', mode_sort);
        $menu_sorting.init();
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionSortByReversePriority() {
        mode_sort = 'reverse-priority';
        localStorage.setItem('mode_sort', mode_sort);
        $menu_sorting.init();
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionSortByDate() {
        mode_sort = 'date';
        localStorage.setItem('mode_sort', mode_sort);
        $menu_sorting.init();
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionSortByReverseDate() {
        mode_sort = 'reverse-date';
        localStorage.setItem('mode_sort', mode_sort);
        $menu_sorting.init();
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionSortByAdvanced() {
        alert('Advanced sorting. TODO.');
    }

    function getModeSort() {
        return mode_sort;
    }

    function actionVisualizeCategorical() {
        if (mode_modal) {
            return;
        }
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        clearSidebar();
        function after() {
            mode_modal = false;
        }
        mode_modal = true;
        $visualize_categorical.open_dialog(items, after);
    }

    function actionVisualizeNumeric() {
        if (mode_modal) {
            return;
        }
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        clearSidebar();
        function after() {
            mode_modal = false;
        }
        mode_modal = true;
        $visualize_numeric.open_dialog(items, after);
    }

    function setSidebar(e) {
        if (e != undefined) {
            mousedItemId = $(e.currentTarget).attr('data-subitem-path').split(':')[0]; //TODO: this is hacky
        }

        if (selected_item != null) {
            if (mode_advanced_view) {
                let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
                $sidebar.updateSidebar(items, selected_item, subitem, true);
            }
            return;
        }
        e.stopPropagation();

        let path = $(e.currentTarget).attr('data-subitem-path')
        let id = parseInt(path.split(':')[0]);
        let item = getItemById(id);
        let subitem = $model.getSubitem(item, path);
        if (mode_advanced_view) {
            $sidebar.updateSidebar(items, item, subitem, false);
        }

        if (selected_item != null && mousedItemId == selected_item.id) {
            $(this).parents('.item').addClass('moused-selected');
        }
        else {
            $(this).parents('.item').addClass('moused');
        }
    }

    function setSidebar2(e) { //TODO: rename this function

        if (selected_item != null) {
            if (mode_advanced_view) {
                let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
                $sidebar.updateSidebar(items, selected_item, subitem, true);
            }
            return;
        }
        if (mousedItemId == null) {
            return;
        }
        e.stopPropagation();
        
        let item = getItemById(mousedItemId);
        let subitem = item.subitems[0];
        if (mode_advanced_view) {
            $sidebar.updateSidebar(items, item, subitem, false);
        }
    }

    function clearSidebar() {
        if (selected_item != null) {
            return;
        }
        if (mode_advanced_view) {
            $sidebar.clearSidebar(items);
        }
    }

    function resetInactivityTimer() {
        last_active_timestamp = Date.now();
        mode_already_idle_saved = false;
    }

    function onMouseMove(e) {

    }

    function actionToggleAdvancedView() {

        if (mode_advanced_view) {
            mode_advanced_view = false;
            $('#div_side_panel').hide();
        }
        else {
            mode_advanced_view = true;
            $('#div_side_panel').show();
        }
        localStorage.setItem('mode_advanced_view', mode_advanced_view+'');
    }

    function saveSuccess() {
        console.log('saveSuccess()');
        $('#div_spinner').hide();
        mode_disconnected = false;
        if (saveAttempt != null) {
            clearInterval(saveAttempt);
            saveAttempt = null;
        }
    }

    let saveAttempt = null;

    function saveFail() {
        console.log('saveFail()');
        if (mode_disconnected == false) {
            $('#spn_spin_message').html('<h2>Disconnected from server<br><br>Attempting to reconnect...</h2>');
            $('#div_spinner').show();
            //TODO: actual message here.
            //alert('ERROR: Failed to save to server. May be disconnected.\nTry refreshing the browser.');
            mode_disconnected = true;
            saveAttempt = setInterval(function() {
                $persist.save(items, 
                    function saveSuccess() {}, 
                    function saveFail() {
                        alert('Failed saving file');
                    });
            }, 5000);
        }
    }

    function actionPaste(e, pastedTextData, pastedHTMLData) {
        if (selectedSubitemPath == null) {
            let toPaste = null;
            if (pastedHTMLData == null || pastedHTMLData == '') {
                if (pastedTextData == null || pastedTextData == '') {
                    console.log('nothing to paste');
                    return;
                }
                toPaste = escapeHtml(pastedTextData);
                toPaste = toPaste.replace(/\n/g, '<br>');
                toPaste = toPaste.replace(/ /g, '&nbsp;');
                toPaste = toPaste.replace(/\t/g, '<span class="tab"></span>');
            }
            else {
                toPaste = pastedHTMLData;
            }
            console.log('----------------------');
            console.log(toPaste);
            console.log('----------------------');
            let tags = getTagsFromSearch();
            let new_item = $model.addItemFromSearchBar(items, tags);
            //$model.updateData(new_item, toPaste);
            selected_item = new_item;
            $effects.temporary_highlight(selected_item.id);
            selectedSubitemPath = new_item.id+':0';
            onEnterEditingSubitem();
            $model.updateSubitemData(new_item, selectedSubitemPath, toPaste);
            deselect();
            window.scrollTo(0, 0);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            clearSidebar();
            e.stopPropagation();
            e.preventDefault();
        }
    }

    function actionToggleBold(e) {
        e.stopPropagation();
        let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
        if (subitem._implied_tags.includes('@bold')) {
            return;
        }
        $model.toggleFormatTag(selected_item, selectedSubitemPath, '@bold');
        $('.tag-bar-input').val(subitem.tags);
        $sidebar.updateSidebar(items, selected_item, subitem, true);
    }

    function actionToggleItalic(e) {
        e.stopPropagation();
        let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
        if (subitem._implied_tags.includes('@italic')) {
            return;
        }
        $model.toggleFormatTag(selected_item, selectedSubitemPath, '@italic');
        $('.tag-bar-input').val(subitem.tags);
        $sidebar.updateSidebar(items, selected_item, subitem, true);
    }

    function actionToggleH1(e) {
        e.stopPropagation();
        let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
        if (subitem._implied_tags.includes('@h1')) {
            return;
        }
        $model.toggleFormatTag(selected_item, selectedSubitemPath, '@h1');
        $('.tag-bar-input').val(subitem.tags);
        $sidebar.updateSidebar(items, selected_item, subitem, true);
    }

    function actionToggleH2(e) {
        e.stopPropagation();
        let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
        if (subitem._implied_tags.includes('@h2')) {
            return;
        }
        $model.toggleFormatTag(selected_item, selectedSubitemPath, '@h2');
        $('.tag-bar-input').val(subitem.tags);
        $sidebar.updateSidebar(items, selected_item, subitem, true);
    }

    function actionToggleH3(e) {
        e.stopPropagation();
        let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
        if (subitem._implied_tags.includes('@h3')) {
            return;
        }
        $model.toggleFormatTag(selected_item, selectedSubitemPath, '@h3');
        $('.tag-bar-input').val(subitem.tags);
        $sidebar.updateSidebar(items, selected_item, subitem, true);
    }

    function actionToggleH4(e) {
        e.stopPropagation();
        let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
        if (subitem._implied_tags.includes('@h4')) {
            return;
        }
        $model.toggleFormatTag(selected_item, selectedSubitemPath, '@h4');
        $('.tag-bar-input').val(subitem.tags);
        $sidebar.updateSidebar(items, selected_item, subitem, true);
    }

    function actionToggleTodo(e) {
        e.stopPropagation();
        let subitem = $model.getSubitem(selected_item, selectedSubitemPath);
        if (subitem._implied_tags.includes('@todo')) {
            return;
        }
        $model.toggleFormatTag(selected_item, selectedSubitemPath, '@todo');
        $('.tag-bar-input').val(subitem.tags);
        $sidebar.updateSidebar(items, selected_item, subitem, true);
    }

    function onDblClickSubitem(e) {
        e.stopPropagation();
        console.log('onDblClickSubitem()');
        onEscape();
    }

    function getClipboardText() {
        return mode_clipboard_text;
    }

    function init() {

        //TODO: not if grabbing from server
        if (testLocalStorage() == false) {
            window.location.replace('error-pages/error-local-storage.html');
        }

        $persist.load(
            function success(items_) {

                //restore saved search
                let search = localStorage.getItem('search');
                if (search != null && search != 'null') {
                    $('.action-edit-search')[0].value = search;
                }
                else {
                    localStorage.setItem('search', null);
                    $('.action-edit-search')[0].value = '';
                }

                //restore saved sort
                if (localStorage.getItem('mode_sort') != null) {
                    mode_sort = localStorage.getItem('mode_sort');
                }

                if (localStorage.getItem('mode_advanced_view') != null) {
                    if (localStorage.getItem('mode_advanced_view') == 'true') {
                        actionToggleAdvancedView();
                    }
                }

                setItems(items_);
                clearSelection();
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                clearSidebar();
                $events.registerEvents();
                $auto_complete.hideOptions();
                document.activeElement.blur();

                if (ENABLE_CHECK_FOR_UPDATES) {
                    setInterval(checkForUpdates, CHECK_FOR_UPDATES_FREQ_MS);
                }

                if (ENABLE_CHECK_FOR_IDLE) {
                    setInterval(checkForIdle, CHECK_FOR_IDLE_FREQ_MS);
                }

                $('#div_spinner').hide();

            }, 
            function failure() { 
                //alert('Failed to load from server');
            });
    }

    return {
        init: init,
        backup: backup,
        restoreFromFile: restoreFromFile,
        onHotkeyToFromTags: onHotkeyToFromTags,
        onClickItem: onClickItem,
        onClickDocument: onClickDocument,
        onClickSubitem: onClickSubitem,
        onClickEditBar: onClickEditBar,
		onEditSubitem: onEditSubitem,
		onFocusSubitem: onFocusSubitem,
        onDblClickSubitem: onDblClickSubitem,
		actionUp: actionUp,
		actionDown: actionDown,
        actionIndent: actionIndent,
        actionOutdent: actionOutdent,
        actionFullUp: actionFullUp,
        actionFullDown: actionFullDown,
		actionDeleteButton: actionDeleteButton,
        actionAddNewItem: actionAddNewItem,
		actionAdd: actionAdd,
        actionMakeLinkGoto: actionMakeLinkGoto,
        actionMakeLinkEmbed: actionMakeLinkEmbed,
        actionCopySubsection: actionCopySubsection,
        actionPasteSubsection: actionPasteSubsection,
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
        actionRenameTag: actionRenameTag,
        actionDeleteTag: actionDeleteTag,
        actionSetPasswordProtection: actionSetPasswordProtection,
        actionSetSortingMode: actionSetSortingMode,
        actionRestoreFromText: actionRestoreFromText,
        actionRestoreFromJSON: actionRestoreFromJSON,
        actionAddTagCurrentView: actionAddTagCurrentView,
        actionRemoveTagCurrentView: actionRemoveTagCurrentView,
        actionDeleteEverything: actionDeleteEverything,
        actionToggleEncryptSave: actionToggleEncryptSave, 
        actionAddMetaRule: actionAddMetaRule,
        actionGotoSearch: actionGotoSearch,
        actionPasswordProtectionSettings: actionPasswordProtectionSettings,
        actionCollapseAllView: actionCollapseAllView,
        actionExpandAllView: actionExpandAllView,
        actionCollapseItem: actionCollapseItem,
        actionExpandItem: actionExpandItem,
        actionSortByPriority: actionSortByPriority,
        actionSortByReversePriority: actionSortByReversePriority,
        actionSortByDate: actionSortByDate,
        actionSortByReverseDate: actionSortByReverseDate,
        actionSortByAdvanced: actionSortByAdvanced,
        actionVisualizeNumeric: actionVisualizeNumeric,
        actionVisualizeCategorical: actionVisualizeCategorical,
        actionToggleBold: actionToggleBold,
        actionToggleItalic: actionToggleItalic,
        actionToggleTodo: actionToggleTodo,
        actionToggleH1: actionToggleH1,
        actionToggleH2: actionToggleH2,
        actionToggleH3: actionToggleH3,
        actionToggleH4: actionToggleH4,
		focusSubItem: focusSubItem,
		actionDelete: actionDelete,
        onCopy: onCopy,
        onExec: onExec,
        onEscape: onEscape,
		onBackspaceUp: onBackspaceUp,
		onBackspaceDown: onBackspaceDown,
		onWindowFocus: onWindowFocus,
        onWindowBlur: onWindowBlur,
		onEnterOrTab: onEnterOrTab,
        onSpace: onSpace,
		onClickTagSuggestion: onClickTagSuggestion,
        onCheck: onCheck,
        onUncheck: onUncheck,
        onFold: onFold,
        onUnfold: onUnfold,
        onSearchClick: onSearchClick,
        onSearchFocusOut: onSearchFocusOut,
        onClickSelectSearchSuggestion: onClickSelectSearchSuggestion,
        onBeforeUnload: onBeforeUnload,
        onUpArrow: onUpArrow,
        onDownArrow: onDownArrow,
        itemIsSelected: itemIsSelected,
        updateSelectedSearchSuggestion: updateSelectedSearchSuggestion,
        updateSelectedTagSuggestion: updateSelectedTagSuggestion,
        setMoreResults: setMoreResults,
        getItems: getItems,
        getModeSort: getModeSort,
        onClickMenu: onClickMenu,
        setSidebar: setSidebar,
        setSidebar2: setSidebar2,
        clearSidebar: clearSidebar,
        resetInactivityTimer: resetInactivityTimer,
        onMouseMove: onMouseMove,
        actionToggleAdvancedView: actionToggleAdvancedView,
        actionPaste: actionPaste,
        getItemById: getItemById,
        getClipboardText: getClipboardText
    };
})();
$todo.init();
