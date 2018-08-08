"use strict";

let $todo = (function () {

    let ENABLE_RICH_EDITING = false;

    let CHECK_FOR_UPDATES_FREQ_MS = 100;

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

    let mode_focus = null;

    let items = [];

    let item_cache = {};

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
        $ontology.maybeRecalculateOntology(items);
        $auto_complete.onChange(items);
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
    }

    function actionAdd(event) {
        if (mode_modal) {
            return;
        }
        event.stopPropagation();
        if (selected_item != null) {
            if (selectedSubitemPath != null) {
                selectedSubitemPath = $model.addNextSubItem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?
                let item = getItemById(selected_item);
                $filter.fullyIncludeItem(item);
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusSubItem(selected_item, selectedSubitemPath);
                possiblyEnableRichEditing();
            }
            else {
                selected_item = $model.addNextItem(items, selected_item); //TODO: get back new ref to items?
                $filter.fullyIncludeItem(selected_item);
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                focusItem(selected_item);
                possiblyEnableRichEditing();
            }
        }
        else {
            mode_more_results = false;
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
            selected_item = $model.addItemFromSearchBar(items, tags); //TODO: get back new ref to items?
            $filter.fullyIncludeItem(selected_item);
            $auto_complete.refreshParse(items);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusItem(selected_item);
            possiblyEnableRichEditing();
        }
        $persist.save(items);
        if (selected_item != null) {
            $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
        }
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
            selectedSubitemPath = $model.addSubItem(selected_item, null); //TODO: get back new ref to items?
        }
        $persist.save(items);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
        focusSubItem(selected_item, selectedSubitemPath);
        possiblyEnableRichEditing();
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
            $model.removeSubItem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?
            $ontology.maybeRecalculateOntology(items);
            selectedSubitemPath = null;
        }
        else {
            delete item_cache[selected_item.id];
            $model.deleteItem(items, selected_item); //TODO: get back new ref to items?
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
        mode_focus = 'item';
    }

    function focusSubItem(item, path) {
    	//TODO refactor into view?
        let $div = $("[data-item-id='" + item.id + "'][data-subitem-path='" + path + "']");
        $div.focus();
        mode_focus = 'subitem';
    }

    function focusTag(item) {
        $('[data-item-id="' + selected_item.id + '"]').find('.tag')[0].focus();
        actionFocusEditTag();
        mode_focus = 'tag';
    }

    function actionFullUp(event) {
        //TODO: refactor some of this logic into model
        let last_filtered_item = null;
        for (let item of items) {
            if (item._include == false) {
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
        $persist.save(items);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);   
    }

    function actionFullDown(event) {
        //TODO: refactor some of this logic into model
        let first_filtered_item = null;
        for (let item of items) {
            if (item._include == false) {
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
        $persist.save(items);
        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
    }

    function actionUp(event) {
        event.stopPropagation();
        if (selectedSubitemPath != null) {
            selectedSubitemPath = $model.moveUpSubitem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selected_item, selectedSubitemPath);
        }
        else {
            $model.moveUp(items, selected_item); //TODO: get back new ref to items?
            $persist.save(items);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusItem(selected_item);
        }
        possiblyEnableRichEditing();
        if (selected_item != null) {
        	//TODO refactor into view?
            $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
        }
    }

    function actionDown(event) {
        event.stopPropagation();
        if (selectedSubitemPath != null) {
            selectedSubitemPath = $model.moveDownSubitem(selected_item, selectedSubitemPath); //TODO: get back new ref to items?           
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusSubItem(selected_item, selectedSubitemPath);
        }
        else {
            $model.moveDown(items, selected_item); //TODO: get back new ref to items?
            $persist.save(items);
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            focusItem(selected_item);
        }
        possiblyEnableRichEditing();
        if (selected_item != null) {
        	//TODO refactor into view?
            $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
        }
    }

    function onDblClickItem(event) {
        event.stopPropagation();
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
            $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
            mousedItemId = selected_item.id;
            focusItem(selected_item);
            possiblyEnableRichEditing();
            console.log(selected_item);
        }
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
        if (selected_item == null) {
            console.log('selectedId is null, do nothing');
            return;
        }
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
        mode_focus = null;
    }

    function onEditItem(event) {
        if (selected_item != null) {
            let text = $('[data-item-id="' + selected_item.id + '"]').find('.data')[0].innerHTML;
            $model.updateData(selected_item, text); //TODO: get back new ref to items?
        }
    }

    function onRichEditItem(item, new_text) {
        $model.updateData(item, new_text);
    }

    function onEditSubitem(event) {
        if (selected_item != null) {
            let text = event.target.innerHTML;
            //TODO refactor into view?
            let path = $(event.target).attr('data-subitem-path');
            $model.updateSubitemData(selected_item, path, text); //TODO: get back new ref to items?
        }
    }

    function onRichEditSubitem(item, selectedSubitemPath, new_text) {
        $model.updateSubitemData(item, selectedSubitemPath, new_text);
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

        possiblyEnableRichEditing();
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
    
        possiblyEnableRichEditing();
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
        $persist.save(items);
    }

    function actionFocusEditTag() {
        $auto_complete_tags.onChange(items, selected_item, selectedSubitemPath);
        $auto_complete_tags.showOptions();
        mode_focus = 'tag';
    }
    
    function actionEditTag(event) {
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

    function restoreFromFile(obj) {
        if (obj.encryption.encrypted == false) {
            items = obj.data;
            setItems(items);
            $persist.save(items);
            window.scrollTo(0, 0);
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
                            items = loaded_items;
                            setItems(items);
                            $persist.save(items);
                            window.scrollTo(0, 0);
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
    }

    function actionMouseup() {
        itemOnRelease = getItemById(mousedItemId);
        if (itemOnClick != null && itemOnRelease != null && itemOnClick.id != itemOnRelease.id) {
            if (mode_sort == 'priority') {
                $model.drag(items,itemOnClick, itemOnRelease); //TODO: get back new ref to items?
                $persist.save(items);
                $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);
                if (selected_item != null) {
                	//TODO refactor into view?
                    $('.item[data-item-id="' + selected_item.id + '"]').addClass('moused-selected');
                }
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
        if (selected_item != null) {
            $persist.save(items);
        }
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
        $('.action-edit-search').val('');
        window.scrollTo(0, 0);
        actionEditSearch();
        $auto_complete.hideOptions();
    }

    function actionSaveView(e) {
        e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);
        $persist.saveViewToFileSystem(items);
    }

    function actionSave(e) {
        e.preventDefault();
        closeSelectedItem();
        $auto_complete.refreshParse(items);
        $view.render(items, null, null, null, mode_sort, mode_more_results);

        picoModal({
            content: 
                "<p>Save as a plaintext file:</p>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok-plaintext'>Save Plaintext</button>" +
                "</div>" +
                "<hr>" +
                "<p>Enter your password to encrypt the result:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='passphrase1' type='password'></input></p>" + 
                "<p><input id='passphrase2' type='password'></input></p>" + 
                "</div>" +
                "<div' style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok-encrypted'>Save Encrypted</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            
            mode_modal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok-encrypted")) {
                    let passphrase1 = $('#passphrase1').val();
                    let passphrase2 = $('#passphrase2').val();
                    if (passphrase1 != passphrase2) {
                        alert('Passphrases must match');
                        return;
                    }
                    if (passphrase1 == '') {
                        alert('Must enter a non-empty passphrase');
                        return;
                    }
                    $persist.saveToFileSystemEncrypted(items, passphrase1);
                    modal.close();
                    
                } else if (evt.target && evt.target.matches(".ok-plaintext")) {
                    $persist.saveToFileSystem(items);
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

    //TODO: this is an ugly way to set state.
    function setMoreResults(value) {
        mode_more_results = value;
    }

    function possiblyEnableRichEditing() {
        if (ENABLE_RICH_EDITING == false) {
            return;
        }

        //BUG: this doesn't appear to work
        $('.summernote').each(function(index) {
            $(this).summernote('destroy');
        });

        if (selected_item == null) {
            return;
        }
        
        let $editable_area = null;
        if (selectedSubitemPath == null) { 
            $editable_area = $('[data-item-id="' + selected_item.id + '"] .itemdata')[0];
            $($editable_area).summernote({
              callbacks: {
                onChange: function(contents) {
                  console.log('onChange:', contents);
                  onRichEditItem(selected_item, contents);
                }
              }
            });
        }
        else {
            $editable_area = $('[data-item-id="' + selected_item.id + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]')[0];
            $($editable_area).summernote({
              callbacks: {
                onChange: function(contents) {
                  console.log('onChange:', contents);
                  onRichEditSubitem(selected_item, selectedSubitemPath, contents);
                }
              }
            });
        }
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
    
    function init() {

        if (testLocalStorage() == false) {
            window.location.replace('error-pages/error-local-storage.html');
        }

        //Blocking in code for handling schema versioning.
        //This doesn't do anything useful just yet
        localStorage.setItem('DATA_SCHEMA_VERSION', DATA_SCHEMA_VERSION);
        let loaded_schema_version = localStorage.getItem('DATA_SCHEMA_VERSION');
        console.log('DATA_SCHEMA_VERSION = ' + loaded_schema_version);

        //restore saved search
        let search = localStorage.getItem('search');
        if (search != null && search != 'null') {
            $('.action-edit-search')[0].value = search;
        }
        else {
            localStorage.setItem('search', null);
            $('.action-edit-search')[0].value = '';
        }

        setItems($persist.load());
        clearSelection();

        $view.render(items, selected_item, mousedItemId, selectedSubitemPath, mode_sort, mode_more_results);

        $events.registerEvents();

        $auto_complete.hideOptions();

        document.activeElement.blur();

        setInterval(checkForUpdates, CHECK_FOR_UPDATES_FREQ_MS);


    }

    return {
        init: init,
        backup: backup,
        restoreFromFile: restoreFromFile,
        onHotkeyToFromTags: onHotkeyToFromTags,
        onDblClickItem: onDblClickItem,
		onDblClickDocument: onDblClickDocument,
		onEditItem: onEditItem,
        onRichEditItem: onRichEditItem,
		onEditSubitem: onEditSubitem,
        onRichEditSubitem: onRichEditSubitem,
		onFocusItem: onFocusItem,
		onFocusSubitem: onFocusSubitem,
		actionUp: actionUp,
		actionDown: actionDown,
        actionFullUp: actionFullUp,
        actionFullDown: actionFullDown,
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
        actionSaveView: actionSaveView,
		focusSubItem: focusSubItem,
		actionDelete: actionDelete,
        onCopy: onCopy,
        onEscape: onEscape,
		onBackspaceUp: onBackspaceUp,
		onBackspaceDown: onBackspaceDown,
		onWindowFocus: onWindowFocus,
        onWindowBlur: onWindowBlur,
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
        setMoreResults: setMoreResults,
        getItems: getItems
    };
})();
$todo.init();
