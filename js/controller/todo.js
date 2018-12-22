"use strict";

let $todo = (function () {

    let ENABLE_CHECK_FOR_UPDATES = true;
    let CHECK_FOR_UPDATES_FREQ_MS = 1000;

    let ONLY_PERSIST_ON_BEFORE_UNLOAD = true;

    let MAINTAIN_EDIT_MODE = false;

    let selected_item = null;
    let selectedSubitemPath = null;
    let itemOnClick = null;
    let itemOnRelease = null;
    let mousedItemId = null;

    let mode_backspace_key = false;
    let mode_skipped_a_render = false;
    let mode_show_backup = false;
    let mode_collapse = true;
    let mode_sort = 'priority'; //Implement others later
    let mode_more_results = false;
    let mode_modal = false;

    let mode_encrypt_save = true;

    let mode_focus = null;

    let items = [];

    let item_cache = {};

    let subsection_clipboard = null;

    let recentDblClickedSubitem = null;

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
    }

    function actionAddNewItem(event) {
        deselect();
        actionAdd(event);
    }

    function actionAdd(event) {
        if (mode_modal) {
            return;
        }
        event.stopPropagation();
        if (selected_item != null) {

            if (selectedSubitemPath != null) {
                selectedSubitemPath = $model.addNextSubItem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?
            }
            else {
                selectedSubitemPath = $model.addSubItem(selected_item, selected_item.id+':0'); //TODO: get back new ref to items?
            }
            if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                $persist.save(items);
            }
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selected_item, selectedSubitemPath);
        }
        else {
            mode_more_results = false;
            let tags = getTagsFromSearch();
            selected_item = $model.addItemFromSearchBar(items, tags); //TODO: get back new ref to items?
            $filter.fullyIncludeItem(selected_item);
            $auto_complete.refreshParse(items);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusItem(selected_item);
        }
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items); //TODO redundant
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

        if (selectedSubitemPath != null) {
            selectedSubitemPath = $model.addSubItem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?
        }
        else {
            selectedSubitemPath = $model.addSubItem(selected_item, selected_item.id+':0'); //TODO: get back new ref to items?
        }
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items);
        }
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
        if (selectedSubitemPath != null) {
            let subitem_index = parseInt(selectedSubitemPath.split(':')[1]);
            let indent = selected_item.subitems[subitem_index].indent;
            let new_subitem_index = 0;
            for (let i = subitem_index-1; i >= 0; i--) {
                if (selected_item.subitems[i].indent <= indent) {
                    new_subitem_index = i;
                    break;
                }
            }
            $model.removeSubItem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?
            if (new_subitem_index == 0) {
                selectedSubitemPath = null; //TODO: REALLY need to refactor this to *:0 path
            } 
            else {
                selectedSubitemPath = selected_item.id+':'+new_subitem_index;
            }
        }
        else {
            delete item_cache[selected_item.id];
            $model.deleteItem(items, selected_item); //TODO: get back new ref to items?
            selected_item = null;
            selectedSubitemPath = null; //TODO: select prior?
            mousedItemId = null;
        }
        let recalculated = $ontology.maybeRecalculateOntology(items);
        if (recalculated) {
            resetAllCache();
        }
        $auto_complete.refreshParse(items);
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items);
        }
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        $searchHistory.addActivatedSearch();
    }

    function focusItem(item) {
    	//TODO refactor into view?
        let $div = $(".item[data-item-id='" + item.id + "'] > .itemdata");
        $div.focus();
        mode_focus = 'item';
        placeCaretAtEndContentEditable($div.get(0));
    }

    function focusSubItem(item, path) {
        if (path == null) {
            console.log('WARNING: subitem path is null, cannot focus');
            return;
        }
    	//TODO refactor into view?
        let $div = $("[data-item-id='" + item.id + "'][data-subitem-path='" + path + "']");
        $div.focus();
        mode_focus = 'subitem';
        placeCaretAtEndContentEditable($div.get(0));
    }

    function focusTag(item) {
        let $el = $('[data-item-id="' + selected_item.id + '"]').find('.tag')[0];
        $el.focus();
        actionFocusEditTag();
        mode_focus = 'tag';
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
    }

    function actionFullUp(event) {
        event.stopPropagation();
        if (selected_item == null) {
            return;
        }
        //TODO: refactor some of this logic into model
        let last_filtered_item = null;
        for (let item of items) {
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
        $model.drag(items, selected_item, last_filtered_item); //TODO: get back new ref to items?
        deselect();
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items);
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
        $model.drag(items, selected_item, first_filtered_item); //TODO: get back new ref to items?
        deselect();
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items);
        }
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionUp(event) {
        event.stopPropagation();
        if (selectedSubitemPath != null) {
            selectedSubitemPath = $model.moveUpSubitem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?
            //Choose not to save while in editing mode
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selected_item, selectedSubitemPath);
        }
        else {
            if (mode_sort == 'priority') {
                $model.moveUp(items, selected_item); //TODO: get back new ref to items?
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items);
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusItem(selected_item);
            }
            else if (mode_sort == 'reverse-priority') {
                $model.moveDown(items, selected_item); //TODO: get back new ref to items?
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items);
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusItem(selected_item);
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
        if (selectedSubitemPath != null) {
            selectedSubitemPath = $model.moveDownSubitem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?           
            //Choose not to save while in editing mode
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selected_item, selectedSubitemPath);
        }
        else {
            if (mode_sort == 'priority') {
                $model.moveDown(items, selected_item); //TODO: get back new ref to items?
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items);
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusItem(selected_item);
            }
            else if (mode_sort == 'reverse-priority') {
                $model.moveUp(items, selected_item); //TODO: get back new ref to items?
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items);
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusItem(selected_item);
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
        if (selectedSubitemPath != null) {
            $model.indentSubitem(selected_item, selectedSubitemPath);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selected_item, selectedSubitemPath);
            if (selected_item != null) {
                //TODO refactor into view?
                $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
            }
        }
    }

    function actionOutdent() {
        if (selectedSubitemPath != null) {
            $model.outdentSubitem(selected_item, selectedSubitemPath);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selected_item, selectedSubitemPath);
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

    function onClickItem(event) {
        if (mousedItemId != null) {
            if (selected_item == null) {
                if (event.ctrlKey) {
                    expandRedacted();
                }
            }
            else {
                if (MAINTAIN_EDIT_MODE && mousedItemId != selected_item.id) {
                    let new_id = mousedItemId;
                    closeSelectedItem(); //TODO: this part is very slow
                    selected_item = getItemById(new_id);
                    $model.expand(selected_item);
                    $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                    mousedItemId = selected_item.id;
                    focusItem(selected_item);
                }
            }
            console.log(getItemById(mousedItemId));

            //TODO: Here would be where we toggle item summary
        }
    }

    function onDblClickSubItem(event) {
        let path = $(this).attr('data-subitem-path');
        console.log('DblClickSubItem ' + path);
        recentDblClickedSubitem = path;
    }

    function onDblClickItem(event) {
        event.stopPropagation();
        console.log('onDblClickItem()');
        let do_select = false;
        if (selected_item != null) {
            if (selected_item.id == this.dataset.itemId) {
                closeSelectedItem();
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
            $model.expand(selected_item);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            mousedItemId = selected_item.id;
            selectedSubitemPath = recentDblClickedSubitem;
            console.log('\tfocus selectedSubitemPath = ' + selectedSubitemPath);
            if (selectedSubitemPath == null) {
                focusItem(selected_item);
            }
            else {
                focusSubItem(selected_item, selectedSubitemPath);
            }
            console.log(selected_item);
        }
        recentDblClickedSubitem = null;
        $searchHistory.addActivatedSearch();
    }

    function onDblClickDocument(event) {
        event.stopPropagation();
        if (selected_item != null) {
            closeSelectedItem();
            $auto_complete.refreshParse(items);
            $view.render(items, null, null, null, mode_sort, mode_more_results);
        }
    }

    function closeSelectedItem() {
        let start = Date.now();
        //TODO: this is very slow!!
        if (selected_item == null) {
            console.log('selectedId is null, do nothing');
            return;
        }
        let recalculated = $ontology.maybeRecalculateOntology(items);
        if (recalculated) {
            resetAllCache();
        }
        $model.resetTagCountsCache();
        deselect();
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items);
        }
        let end = Date.now();
        console.log('closeSelectedItem() took ' + (end-start) + 'ms');
    }

    function deselect() {
        selected_item = null;
        selectedSubitemPath = null;
        itemOnClick = null;
        itemOnRelease = null;
        mousedItemId = null;
        mode_focus = null;
    }

    function onEditItem(event) {
        if (selected_item != null) {
            let text = $('[data-item-id="' + selected_item.id + '"]').find('.data')[0].innerHTML;
            $model.updateData(selected_item, text); //TODO: get back new ref to items?
        }
    }

    function onEditSubitem(event) {
        if (selected_item != null) {
            let text = event.target.innerHTML;
            //TODO refactor into view?
            let path = $(event.target).attr('data-subitem-path');
            $model.updateSubitemData(selected_item, path, text); //TODO: get back new ref to items?
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
        $('[data-item-id="' + selected_item.id + '"]').find('.tag')[0].value = selected_item.subitems[0].tags;

        mode_focus = 'item';
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
    
        mode_focus = 'subitem';
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
        $model.updateTimestamp(selected_item, timestamp); //TODO: get back new ref to items?
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items);
        }
    }

    function actionFocusEditTag() {
        $auto_complete_tags.onChange(items, selected_item, selectedSubitemPath);
        $auto_complete_tags.showOptions();
        mode_focus = 'tag';
    }
    
    function actionEditTag() {
        console.log('--------------------------------');
        if (selected_item == null) {
            throw "Unexpected, no selected item...";
        }
        //TODO refactor into view?
        let text = $('[data-item-id="' + selected_item.id + '"]').find('.tag')[0].value;
        if (selectedSubitemPath != null) {
            $model.updateSubTag(selected_item, selectedSubitemPath, text); //TODO: get back new ref to items?
        }
        else {
            $model.updateTag(selected_item, text); //TODO: get back new ref to items?
        }
        $auto_complete_tags.onChange(items, selected_item, selectedSubitemPath);
        $auto_complete_tags.showOptions();
        console.log('_______________________________');
    }

    function actionEditSearch(event) {
        if (selected_item != null) {
            //not sure it should ever make it here
            closeSelectedItem();
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
            items = $schema.checkSchemaUpdate(obj.data, obj.data_schema_version);
            setItems(items);
            $persist.save(items);
            window.scrollTo(0, 0);
            maybeResetSearch();
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
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
                            items = $schema.checkSchemaUpdate(loaded_items, obj.data_schema_version);
                            setItems(items);
                            $persist.save(items);
                            window.scrollTo(0, 0);
                            maybeResetSearch();
                            resetAllCache();
                            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
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

    function actionMousedown() {
        itemOnClick = getItemById(mousedItemId);
        if (itemOnClick != null) {
            //don't add to search unless an actual item is clicked
            $searchHistory.addActivatedSearch();
        } 
    }

    function actionMouseup() {
        itemOnRelease = getItemById(mousedItemId);
        if (itemOnClick != null && itemOnRelease != null && itemOnClick.id != itemOnRelease.id) {
            if (mode_sort == 'priority') {
                $model.drag(items,itemOnClick, itemOnRelease);
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items);
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                if (selected_item != null) {
                	//TODO refactor into view?
                    $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
                }
                $searchHistory.addActivatedSearch();
            }
            else if (mode_sort == 'reverse-priority') {
                $model.drag(items, itemOnRelease, itemOnClick);
                if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
                    $persist.save(items);
                }
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
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
            mode_skipped_a_render = false;
        }
    }

    function onBackspaceDown() {
    	mode_backspace_key = true;
    }

    function checkForUpdates() {
        if ($persist.maybeReload(items) == true) {
            setItems($persist.load());
            clearSelection();
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        }
    }

    function onWindowFocus() {
        checkForUpdates();
    }

    function onWindowBlur() {
        console.log('---------------------------------');
        console.log('WINDOW BLUR');
        console.log('----------------------------------');
        $persist.save(items);
    }

    //TODO refactor this into modes
    function onEnterOrTab() {
    	if ($auto_complete.getModeHidden() == false) {
            $auto_complete.selectSuggestion();
            actionEditSearch();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.selectSuggestion(items, selected_item, selectedSubitemPath);
        }
    }

    function onSpace(e) {

        //TODO: currently a bug with this that makes search more difficult to do
        /*
        if ($("search_input").is(":focus")) {
            return;
        }

        if (selected_item == null && mousedItemId != null && $auto_complete.getModeHidden() == true) {
            e.stopPropagation();
            e.preventDefault();
            selected_item = getItemById(mousedItemId);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            mousedItemId = selected_item.id;
            focusItem(selected_item);
            console.log(selected_item);
        }
        */
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
        }
    }

    function actionMoreResults() {
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
        e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $persist.save(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);

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
            .replace(/<code>/g, '')
            .replace(/<\/code>/g, '');
        console.log('----------------');
        console.log('COPY TEXT:');
        console.log(text);
        console.log('----------------');
        let _onCopy = function(e) {
          e.clipboardData.setData('text/plain', text);
          e.preventDefault();
        };
        document.addEventListener('copy', _onCopy);
        document.execCommand('copy');
        document.removeEventListener('copy', _onCopy);
    }

    function actionGotoSearch(e) {
        let text = e.target.innerText;
        $('.action-edit-search')[0].value = text;
        actionEditSearch();
    }

    function onCheck(e) {
        let parent = $(e.target).parents('[data-subitem-path]');
        let path = $(parent).attr('data-subitem-path');
        let id = parseInt(path.split(':')[0]);
        let item = getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace('@todo','@done'); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function onUncheck(e) {
        let parent = $(e.target).parents('[data-subitem-path]');
        let path = $(parent).attr('data-subitem-path');
        let id = parseInt(path.split(':')[0]);
        let item = getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace('@done','@todo'); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function onClickSelectSearchSuggestion(e) {
        e.preventDefault();
        $auto_complete.selectSuggestion();
        actionEditSearch();
    }

    function onBeforeUnload(e) {
        $persist.save(items);
    }

    function navigate(newSubitemPath) {
        if (selected_item != null && newSubitemPath != selectedSubitemPath) {
            selectedSubitemPath = newSubitemPath;
            if (selectedSubitemPath == selected_item.id+':0') {
                selectedSubitemPath = null; //TODO: this is a hack!
            }
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            if (selectedSubitemPath == null) {
                focusItem(selected_item);
            }
            else {
                focusSubItem(selected_item, selectedSubitemPath);
            }
        }
    }

    function onUpArrow(e) {
        if ($auto_complete.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete.arrowUp();
            //e.preventDefault();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete_tags.arrowUp(); 
            //e.preventDefault();
        }
        else if (selected_item != null) {
            let $div = $('.selected-item')[0];
            let pos = getCaretPosition($div);
            if (pos.location == 0) {
                navigate($model.getPrevSubitemPath(selected_item, selectedSubitemPath));
                e.stopPropagation();
                //TODO: move caret to beginning?
            }
            //se.preventDefault();
        }
    }

    function onDownArrow(e) {
        if ($auto_complete.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete.arrowDown(); 
            //e.preventDefault();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete_tags.arrowDown(); 
            //e.preventDefault();
        }
        else if (selected_item != null) {
            let $div = $('.selected-item')[0];
            let pos = getCaretPosition($div);
            console.log(pos);
            if (pos.location == pos.textLength) {
                console.log('selectedSubitemPath == ' + selectedSubitemPath);
                navigate($model.getNextSubitemPath(selected_item, selectedSubitemPath));
                e.stopPropagation();
            }
            //e.preventDefault();
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
            if (selectedSubitemPath == null) {
                focusItem(selected_item);
            }
            else {
                focusSubItem(selected_item, selectedSubitemPath);
            }
        }
        else {
            focusTag(selected_item);
        }
    }

    function onClickMenu() {
        //TODO: this pattern exists in a lot of places
        if (selected_item != null) {
            closeSelectedItem();
            $auto_complete.refreshParse(items);
            $view.render(items, null, null, null, mode_sort, mode_more_results);
        }
    }

    function actionRenameTag(e) {

        e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);

        picoModal({
            content: 
                "<p>Rename tag:</p>" +
                //"<p>Changing the tag name will take effect globally.</p>" +
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
                        $persist.save(items);
                    }
                    //$auto_complete.refreshParse(items);
                    $view.render(items, null, null, null, mode_sort, mode_more_results);
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

        e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);

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
                        $persist.save(items);
                    }
                    //$auto_complete.refreshParse(items);
                    $view.render(items, null, null, null, mode_sort, mode_more_results);
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

        //TODO: maybe leave item open in background?
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);

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
                    
                    let tag_lhs = $('#tagname_lhs').val();
                    if (tag_lhs == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    if ($model.isValidTag(tag_lhs) == false) {
                        alert('LHS tag was invalid'); //TODO: this is crude feedback
                        return;
                    }

                    let tag_rhs = $('#tagname_rhs').val();
                    if (tag_rhs == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    if ($model.isValidTag(tag_rhs) == false) {
                        alert('RHS tag was invalid'); //TODO: this is crude feedback
                        return;
                    }

                    let relation = '';
                    if ($('#sel_relation').val() == 'gt') {
                        relation = '=>';
                    }
                    else if ($('#sel_relation').val() == 'eq') {
                        relation = '=';
                    }
                    else {
                        alert('ERROR: unknown relationship');
                        return;
                    }
                    let tags = '@meta';
                    let new_meta_item = $model.addItemFromSearchBar(items, tags);
                    let text = tag_lhs + ' ' + relation + ' ' + tag_rhs;
                    $model.updateData(new_meta_item, text);
                    $model.recalculateAllTags(items);
                    let recalculated = $ontology.maybeRecalculateOntology(items);
                    if (recalculated) {
                        resetAllCache();
                    }
                    $view.render(items, null, null, null, mode_sort, mode_more_results);
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

    function actionAddTagCurrentView() {

        //e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);

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
                        $persist.save(items);
                    }
                    $view.render(items, null, null, null, mode_sort, mode_more_results);
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

        //e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);

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
                        $persist.save(items);
                    }
                    $view.render(items, null, null, null, mode_sort, mode_more_results);
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
        $persist.save(items);
        localStorage.removeItem('items');
        location.reload();
    }

    function actionDeleteEverything() {
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);

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
    }

    function actionMakeLink() {
        if (selected_item == null) {
            return;
        }
        let id = selected_item.id;
        subsection_clipboard = [{data: "@id="+id, tags: "@goto-search", indent:0}];
    }

    function actionCopySubsection() {
        if (selected_item == null) {
            return;
        }
        let subitem_index = 0;
        if (selectedSubitemPath != null) {
            subitem_index = parseInt(selectedSubitemPath.split(':')[1]);
        }
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

    function actionPasteSubsection() {
        if (subsection_clipboard == null) {
            alert("There is nothing in the clipboard to paste.");
            return;
        }
        if (selected_item == null) {
            let tags = getTagsFromSearch();
            selected_item = $model.addItemFromSearchBar(items, tags);
            selectedSubitemPath = null;
            $filter.fullyIncludeItem(selected_item);
        }
        let subitem_index = 0;
        if (selectedSubitemPath != null) {
            subitem_index = parseInt(selectedSubitemPath.split(':')[1]);
        }
        let index_into = $model.pasteSubsection(selected_item, subitem_index, subsection_clipboard);
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items);
        }
        //TODO: this is yucky, we should unify notation
        if (index_into > 0) {
            selectedSubitemPath = selected_item.id+':'+index_into;
        }
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        focusSubItem(selected_item, selectedSubitemPath);
    }

    function actionCollapseAllView() {
        for (let item of items) {
            if (item.subitems[0]._include == 1) {
                $model.collapse(item);
            }
        }
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items);
        }
        $view.renderWithoutRefilter(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionExpandAllView() {
        for (let item of items) {
            if (item.subitems[0]._include == 1) {
                $model.expand(item);
            }
        }
        if (ONLY_PERSIST_ON_BEFORE_UNLOAD == false) {
            $persist.save(items);
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
            $persist.save(items);
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
            $persist.save(items);
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
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        function after() {
            mode_modal = false;
        }
        mode_modal = true;
        $visualize_categorical.open_dialog(items, after);
    }

    function actionVisualizeNumeric() {
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        function after() {
            mode_modal = false;
        }
        mode_modal = true;
        $visualize_numeric.open_dialog(items, after);
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

        //restore saved sort
        if (localStorage.getItem('mode_sort') != null) {
            mode_sort = localStorage.getItem('mode_sort');
        }

        setItems($persist.load());
        clearSelection();
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        $events.registerEvents();
        $auto_complete.hideOptions();
        document.activeElement.blur();

        if (ENABLE_CHECK_FOR_UPDATES) {
            setInterval(checkForUpdates, CHECK_FOR_UPDATES_FREQ_MS);
        }
    }

    return {
        init: init,
        backup: backup,
        restoreFromFile: restoreFromFile,
        onHotkeyToFromTags: onHotkeyToFromTags,
        onClickItem: onClickItem,
        onDblClickSubItem: onDblClickSubItem,
        onDblClickItem: onDblClickItem,
		onDblClickDocument: onDblClickDocument,
		onEditItem: onEditItem,
		onEditSubitem: onEditSubitem,
		onFocusItem: onFocusItem,
		onFocusSubitem: onFocusSubitem,
		actionUp: actionUp,
		actionDown: actionDown,
        actionIndent: actionIndent,
        actionOutdent: actionOutdent,
        actionFullUp: actionFullUp,
        actionFullDown: actionFullDown,
		actionDeleteButton: actionDeleteButton,
        actionAddNewItem: actionAddNewItem,
		actionAdd: actionAdd,
        actionMakeLink: actionMakeLink,
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
		focusSubItem: focusSubItem,
		actionDelete: actionDelete,
        onCopy: onCopy,
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
        onClickMenu: onClickMenu       
    };
})();
$todo.init();
