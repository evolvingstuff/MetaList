"use strict";

let $todo = (function () {

    const ENABLE_CHECK_FOR_UPDATES = true; //TODO: how are we doing this for server version?
    const CHECK_FOR_UPDATES_FREQ_MS = 1000;
    const CHECK_FOR_IDLE_FREQ_MS = 250;
    const SAVE_AFTER_MS_OF_IDLE = 10000; //10 seconds
    const LOCK_AFTER_MS_OF_IDLE = 300000; //5 minutes default
    const UPDATE_SIDEBAR_ON_EDIT_ITEM_DATA = false;
    const MAX_SHADOW_ITEMS_ON_MOVE = 25;
    const MIN_FOCUS_TIME_TO_EDIT = 300;
    const ADVANCED_VIEW_BY_DEFAULT = true;

    let modeBackspaceKey = false;
    let modeSkippedRender = false;
    let modeSort = 'priority';
    let modeMoreResults = false;
    let modeModal = false;
    let modeEncryptSave = true;
    let modeAlreadyIdleSaved = false;
    let modeMousedown = false;
    let modeAdvancedView = false;
    let modeEditingSubitem = false;
    let modeEditingSubitemInitialState = null;
    let modeClipboardText = null;
    let modeDisconnected = false;
    let modeFocus = null;
    let modeAlertSafeToExit = false;

    let timestampLastIdleSaved = 0;
    let selectedItem = null;
    let selectedSubitemPath = null;
    let itemOnClick = null;
    let itemOnRelease = null;
    let mousedItemId = null;
    let recentClickedSubitem = null;
    let copyOfSelectedItemBeforeEditing = null;

    let subsectionClipboard = null;
    let timestampFocused = Date.now();
    let timestampLastActive = Date.now();

    function clearSelection() {
        selectedItem = null;
        selectedSubitemPath = null;
        itemOnClick = null;
        itemOnRelease = null;
        mousedItemId = null;
        $model.resetTagCountsCache();
        $model.resetCachedNumericTags();
    }

    function actionAddNewItem(event) {
        closeAnyOpenMenus();
        deselect();
        actionAdd(event);
    }

    function actionAdd(event) {
        if (modeModal) {
            return;
        }
        closeAnyOpenMenus();
        if (event != undefined) {
            event.stopPropagation();
            event.preventDefault();
        }
        if (selectedItem != null) {
            onExitEditingSubitem();
            let subitemIndex = getSubitemIndex();
            let extraIndent = false;
            selectedSubitemPath = $model.addSubItem(selectedItem, subitemIndex, extraIndent);
            $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
            afterRender();
        }
        else {
            modeMoreResults = false;
            let tags = getTagsFromSearch();
            selectedItem = $model.addItemFromSearchBar(tags);
            $effects.temporary_highlight(selectedItem.id);
            selectedSubitemPath = selectedItem.id+':0';
            $model.fullyIncludeItem(selectedItem);
            $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
            afterRender();
        }
        if (selectedItem != null) {
            $('.item[data-item-id="' + selectedItem.id + '"]').addClass('moused-selected');
        }
        $searchHistory.addActivatedSearch();
    }

    function getTagsFromSearch() {
        let currentSearchString = document.getElementById('search-input').value;
        let parseResults = $parseSearch.parse(currentSearchString);
        if (parseResults == null) {
            console.log('invalid parse, will not add new');
            return;
        }

        let arr = []
        for (let result of parseResults) {
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
        if (modeModal) {
            return;
        }
        event.stopPropagation();
        onExitEditingSubitem();
        let extraIndent = true;
        let subitemIndex = getSubitemIndex();
        selectedSubitemPath = $model.addSubItem(selectedItem, subitemIndex, extraIndent); //TODO: get back new ref to items?
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function actionDeleteButton(event) {
        event.stopPropagation();
        event.preventDefault();
        let subitemIndex = getSubitemIndex();
        if (subitemIndex == 0) {
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
        if (selectedItem == null) {
            return;
        }
        if (e != undefined) {
            e.preventDefault();
            e.stopPropagation();
        }

        copyOfSelectedItemBeforeEditing = copyJSON(selectedItem);

        let subitemIndex = getSubitemIndex();
        if (subitemIndex == 0) {
            $model.deleteItem(selectedItem);
            deselect();
        }
        else {
            let indent = selectedItem.subitems[subitemIndex].indent;
            let newSubitemIndex = 0;
            if (selectedItem.subitems.length > subitemIndex+1 && selectedItem.subitems[subitemIndex+1].indent == indent) {
                //Use next
                newSubitemIndex = subitemIndex; //it will inherit current subitem index
                console.log('choose next subitem');
            }
            else {
                //Find previous
                console.log('choose previous subitem');
                for (let i = subitemIndex-1; i >= 0; i--) {
                    if (selectedItem.subitems[i].indent <= indent) {
                        newSubitemIndex = i;
                        break;
                    }
                }
            }
            
            $model.removeSubItem(selectedItem, selectedSubitemPath);
            selectedSubitemPath = selectedItem.id+':'+newSubitemIndex;
        }

        if ($model.itemHasMetaTags(copyOfSelectedItemBeforeEditing)) {
            let recalculated = $ontology.maybeRecalculateOntology();
            if (recalculated) {
                resetAllCache();
            }
        }

        if ($model.itemHasNumericTags(copyOfSelectedItemBeforeEditing)) {
            $model.resetTagCountsCache();
            $model.resetCachedNumericTags();
        }

        $auto_complete.refreshParse();
        $searchHistory.addActivatedSearch();
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
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
        let $el = $('[data-item-id="' + selectedItem.id + '"]').find('.tag')[0];
        $el.focus();
        actionFocusEditTag();
        let subitemIndex = 0;
        if (selectedSubitemPath == null) { //TODO: refactor this
            subitemIndex = 0;
        }
        else {
            subitemIndex = parseInt(selectedSubitemPath.split(':')[1]);
        }
        let tags = item.subitems[subitemIndex].tags;

        //add space at end if not there to trigger suggestions
        if (tags.endsWith(' ') == false && tags.length > 0) {
            $('[data-item-id="' + selectedItem.id + '"]').find('.tag')[0].value += ' ';
            actionEditTag();
        }
        placeCaretAtEndInput($el);

        modeFocus = 'tag';
    }

    function actionFullUp(event) {
        event.stopPropagation();
        if (selectedItem == null) {
            return;
        }
        //TODO: refactor some of this logic into model
        let filteredItems = $model.getFilteredItems();
        let firstFilteredItem = filteredItems[0];
        if (firstFilteredItem.id == selectedItem.id) {
            console.log('at top, do nothing');
            return;
        }
        $effects.temporary_highlight(selectedItem.id);
        let migrated = $model.drag(selectedItem, firstFilteredItem);
        if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
            for (let id of migrated) {
                $effects.temporary_shadow(id);
            }
        }
        deselect();
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);   
        afterRender();
    }

    function actionFullDown(event) {
        event.stopPropagation();
        if (selectedItem == null) {
            return;
        }
        //TODO: refactor some of this logic into model
        let filteredItems = $model.getFilteredItems();
        let lastFilteredItem = filteredItems[filteredItems.length-1];
        if (lastFilteredItem.id == selectedItem.id) {
            console.log('at bottom, do nothing');
            return;
        }
        $effects.temporary_highlight(selectedItem.id);
        let migrated = $model.drag(selectedItem, lastFilteredItem);
        if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
            for (let id of migrated) {
                $effects.temporary_shadow(id);
            }
        }
        deselect();
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function actionUp(event) {
        event.stopPropagation();
        let subitemIndex = getSubitemIndex();
        if (subitemIndex > 0) {
            selectedSubitemPath = $model.moveUpSubitem(selectedItem, selectedSubitemPath);
        }
        else {
            //if (modeSort == 'priority') {
            $effects.temporary_highlight(selectedItem.id);
            let migrated = $model.moveUp(selectedItem);
            if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                for (let id of migrated) {
                    $effects.temporary_shadow(id);
                }
            }
        }
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function actionDown(event) {
        event.stopPropagation();
        let subitemIndex = getSubitemIndex();
        if (subitemIndex > 0) {
            selectedSubitemPath = $model.moveDownSubitem(selectedItem, selectedSubitemPath);
        }
        else {
            //if (modeSort == 'priority') {
            $effects.temporary_highlight(selectedItem.id);
            let migrated = $model.moveDown(selectedItem);
            if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                for (let id of migrated) {
                    $effects.temporary_shadow(id);
                }
            }
            //}
            /*
            else if (modeSort == 'reverse-priority') {
                $effects.temporary_highlight(selectedItem.id);
                let migrated = $model.moveUp(selectedItem);
                if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                    for (let id of migrated) {
                        $effects.temporary_shadow(id);
                    }
                }
                $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
                focusSubItem(selectedSubitemPath);
            }
            else {
                alert('Cannot manually change order of items when sorted by date.');
            }
            */
        }
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function actionIndent() {
        let subitemIndex = getSubitemIndex();
        if (subitemIndex > 0) {
            $model.indentSubitem(selectedItem, selectedSubitemPath);
            $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
            afterRender();
        }
    }

    function actionOutdent() {
        let subitemIndex = getSubitemIndex();
        if (subitemIndex > 0) {
            $model.outdentSubitem(selectedItem, selectedSubitemPath);
            $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
            afterRender();
        }
    }

    function expandRedacted() {
        if (mousedItemId == null ) {
            return;
        }
        let item = $model.getItemById(mousedItemId);
        for (let subitem of item.subitems) {
            subitem._include = 1;
        }
        $view.renderWithoutRefilter(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function onClickEditBar(event) {
        event.stopPropagation();
    }

    function onClickSubitem(event) {
        closeAnyOpenMenus();
        //Do not want to immediately go into editing mode if not already interacting with window?
        let now = Date.now();
        if (now - timestampFocused < MIN_FOCUS_TIME_TO_EDIT) {
            console.log('SKIPPING');
            return;
        }
        else {
            console.log('NOT SKIPPING delay = ' + (now-timestampFocused));
        }
        console.log('+++++++++++++++++++++++++++++++++++');
        console.log('onClickSubitem()');
        let path = $(this).attr('data-subitem-path');
        recentClickedSubitem = path;
        event.stopPropagation();
        let doSelect = false;
        if (selectedItem != null) {
            let itemId = parseInt(path.split(':')[0]);
            if (selectedItem.id != itemId) {
                doSelect = true;
            }
        }
        else {
            doSelect = true;
        }
        if (doSelect) {
            closeSelectedItem();
            let itemId = parseInt(this.dataset.subitemPath.split(':')[0]);
            selectedItem = $model.getItemById(itemId);
            copyOfSelectedItemBeforeEditing = copyJSON(selectedItem);
            $model.expand(selectedItem);
            selectedSubitemPath = recentClickedSubitem;
            mousedItemId = selectedItem.id;
            $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
            afterRender();
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
        if (selectedItem != null) {
            closeSelectedItem();
            $view.render(null, null, null, modeSort, modeMoreResults);
            afterRender();
        }
    }

    function closeSelectedItem() {
        if (selectedItem == null) {
            return;
        }
        console.log('close selected item');
        let start = Date.now();
        console.log(selectedItem);

        //TODO: this is very slow!!
        
        if (JSON.stringify(copyOfSelectedItemBeforeEditing) != JSON.stringify(selectedItem)) {
            //Only highlight if an update was made
            $effects.temporary_highlight(selectedItem.id);
        }

        if (copyOfSelectedItemBeforeEditing == null) {
            console.log('Warning: copyOfSelectedItemBeforeEditing == null');
        }

        if ($model.itemHasMetaTags(copyOfSelectedItemBeforeEditing) ||
            $model.itemHasMetaTags(selectedItem)) {

            let recalculated = $ontology.maybeRecalculateOntology();
            if (recalculated) {
                resetAllCache();
            }
        }
    
        if ($model.itemHasNumericTags(copyOfSelectedItemBeforeEditing) ||
            $model.itemHasNumericTags(selectedItem)) {

            $model.resetTagCountsCache();
            $model.resetCachedNumericTags();
        }
        deselect();
        let end = Date.now();
        console.log('closeSelectedItem() took ' + (end-start) + 'ms');
    }

    function onEnterEditingSubitem() {
        if (selectedItem == null || selectedSubitemPath == null) {
            console.log('WARNING: expected subitem and item to be selected');
            return;
        }
        copyOfSelectedItemBeforeEditing = copyJSON(selectedItem);
        modeEditingSubitem = true;
        let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
        modeEditingSubitemInitialState = subitem.data;
    }

    function onExitEditingSubitem() {
        if (modeEditingSubitem = true) {
            let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
            if (subitem != null) {
                let newData = subitem.data;
                if (newData != modeEditingSubitemInitialState) {
                    autoformat(selectedItem, selectedSubitemPath, modeEditingSubitemInitialState, newData);
                }
                modeEditingSubitem = false;
                modeEditingSubitemInitialState = null;
            }
        }
    }

    function deselect() {
        if (selectedSubitemPath != null) {
            onExitEditingSubitem();
        }
        selectedItem = null;
        selectedSubitemPath = null;
        itemOnClick = null;
        itemOnRelease = null;
        mousedItemId = null;
        modeFocus = null;
        clearSidebar();
    }

    function onEditSubitem(event) {
        if (selectedItem != null) {
            let text = event.target.innerHTML;
            let path = $(event.target).attr('data-subitem-path');
            $model.updateSubitemData(selectedItem, path, text);
            if (UPDATE_SIDEBAR_ON_EDIT_ITEM_DATA) {
                setSidebar();
            }
        }
    }

    function onFocusSubitem(event) {
        $auto_complete_tags.hideOptions();
        if (selectedItem == null) {
            return;
        }

        if (selectedSubitemPath != null && modeEditingSubitem == true) {
            onExitEditingSubitem();
        }

        selectedSubitemPath = $(event.target).attr('data-subitem-path');
        //TODO refactor into view?
        $('.subitemdata').removeClass('selected-item');
        $('[data-item-id="' + selectedItem.id + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]').addClass('selected-item');
        $('[data-item-id="' + selectedItem.id + '"]').find('.tag')[0].value = $model.getSubItemTags(selectedItem, selectedSubitemPath);

        modeFocus = 'subitem';

        setSidebar();
        onEnterEditingSubitem();
    }

    function actionEditTime(event) {

        if (selectedItem == null) {
            throw "Unexpected, no selected item...";
        }

        //TODO refactor into view?
        let text = $(this).val();
        let utcDate = new Date(text);
        let timestamp = utcDate.getTime() + utcDate.getTimezoneOffset() * 60 * 1000;

        $model.updateTimestamp(selectedItem, timestamp);
    }

    function actionFocusEditTag() {
        $auto_complete_tags.onChange(selectedItem, selectedSubitemPath);
        $auto_complete_tags.showOptions();
        modeFocus = 'tag';

        if (modeAdvancedView) {
            let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
            $sidebar.updateSidebar(selectedItem, subitem, getSubitemIndex(), true);
        }
    }
    
    function actionEditTag() {
        console.log('--------------------------------');
        if (selectedItem == null) {
            throw "Unexpected, no selected item...";
        }
        //TODO refactor into view?
        let text = $('[data-item-id="' + selectedItem.id + '"]').find('.tag')[0].value;
        $model.updateSubTag(selectedItem, selectedSubitemPath, text);
        $auto_complete_tags.onChange(selectedItem, selectedSubitemPath);
        $auto_complete_tags.showOptions();
        
        if (modeAdvancedView) {
            let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
            $sidebar.updateSidebar(selectedItem, subitem, getSubitemIndex(), true);
        }

        console.log('_______________________________');
    }

    function actionEditSearch() {
        console.log('>>> actionEditSearch()');
        //TODO refactor into view?
        let $el = $('.action-edit-search')[0]; //TODO: don't use class here!
        let text = $el.value;
        localStorage.setItem('search', text);
        modeMoreResults = false;
        if (modeBackspaceKey == false) {
            window.scrollTo(0, 0);
            $auto_complete.onChange();
            $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
            afterRender();
        }
        else {
            console.log('DEBUG: modeBackspaceKey (skipped rendering)');
            modeSkippedRender = true;
        }
    }

    function maybeResetSearch() {
        let currentSearchString = $('.action-edit-search')[0].value;
        if (currentSearchString != null && currentSearchString != '') {
            let parse_results = $parseSearch.parse(currentSearchString);
            $model.filterItemsWithParse(parse_results, false); //TODO: why is this called twice?
            let tot = 0;
            const items = $model.getItems();
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
                $filter.filterItemsWithParse(parse_results, false); //TODO: why is this called twice?
            }
            else {
                //alert('no reset search');
            }
        }
        $auto_complete.onChange();
    }

    //TODO move this function out of here, into $persist
    function restoreFromFile(obj) {
        if (obj.encryption.encrypted == false) {
            $('#div-spinner').show();
            try {
                let newItems = $schema.checkSchemaUpdate(obj.data, obj.data_schema_version);
                $model.setItems(newItems);
                $persist.save(
                    function saveSuccess() {}, 
                    function saveFail() {
                        alert('Failed saving file');
                    });
                window.scrollTo(0, 0);
                maybeResetSearch();
                $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
                afterRender();
            }
            catch (e) {
                $('#div-spinner').hide();
                alert(e);
            }
        }
        else {
            picoModal({
            content: 
                "<p>Enter password:</p>" +
                "<div style='margin-left: 10px;'>" +
                "<p><input id='reload_passphrase' type='password'></input></p>" + 
                "</div>" +
                "<div' style='margin-left:10px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Ok</button>" +
                "</div>",
            closeButton: false
            }).afterCreate(modal => {
                modeModal = true;
                modal.modalElem().addEventListener("click", evt => {
                    if (evt.target && evt.target.matches(".ok")) {
                        let passphrase = $('#reload_passphrase').val();
                        if (passphrase == '') {
                            alert('Must enter a non-empty password');
                            return;
                        }

                        $('#div-spinner').show();

                        //TODO: handle failure here
                        $persist.unencryptFromFileObject(passphrase, obj, 
                            function success(loaded_items) {
                                try {
                                    let newItems = $schema.checkSchemaUpdate(loaded_items, obj.data_schema_version);
                                    $model.setItems(newItems);
                                    $persist.save(
                                        function saveSuccess() {}, 
                                        function saveFail() {
                                            alert('Failed saving file');
                                        });
                                    window.scrollTo(0, 0);
                                    maybeResetSearch();
                                    $ontology.maybeRecalculateOntology();
                                    $model.resetCachedNumericTags();
                                    resetAllCache();
                                    $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
                                    afterRender();
                                }
                                catch (e) {
                                    $('#div-spinner').hide();
                                    alert(e);
                                }
                            },
                            function failure() {
                                $('#div-spinner').hide();
                                alert('Incorrect password.');
                            });
                        modal.close();
                    }
                    else if (evt.target && evt.target.matches(".cancel")) {
                        modal.close();
                    }
                });
            }).afterClose((modal, event) => {
                modeModal = false;
                modal.destroy();
            }).show();
            
        }
    }

    function actionMouseover() {
    	//TODO refactor into view?
        mousedItemId = $(this).attr('data-item-id');

        if (selectedItem != null && mousedItemId == selectedItem.id) {
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
        itemOnClick = $model.getItemById(mousedItemId);
        if (itemOnClick != null) {
            //don't add to search unless an actual item is clicked
            $searchHistory.addActivatedSearch();
            if (selectedItem == null) {
                document.body.style.cursor = "grab";
            }
            else {
                if (selectedItem.id != itemOnClick.id) {
                    document.body.style.cursor = "grab";
                }
            }
        }
        
        modeMousedown = true;
    }

    function actionMouseup(e) {

        e.stopPropagation();

        modeMousedown = false;

        document.body.style.cursor = "auto";

        itemOnRelease = null;
        if (mousedItemId != null) {
            itemOnRelease = $model.getItemById(mousedItemId);
        }

        //TODO: This is spaghetti
        if (itemOnRelease != null && selectedItem != null && selectedItem.id == itemOnRelease.id) {
            //Released inside the item we are editing
            itemOnClick = null;
            itemOnRelease = null;
            return;
        }

        if (itemOnClick != null && itemOnRelease != null && itemOnClick.id != itemOnRelease.id) {
            //if (modeSort == 'priority') {
            $effects.temporary_highlight(itemOnClick.id);
            let migrated = $model.drag(itemOnClick, itemOnRelease);
            if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                for (let id of migrated) {
                    $effects.temporary_shadow(id);
                }
            }
            $searchHistory.addActivatedSearch();
            $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
            afterRender();
            
            //}
            /*
            else if (modeSort == 'reverse-priority') {
                $effects.temporary_highlight(selectedItem.id);
                let migrated = $model.drag(itemOnRelease, itemOnClick);
                if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                    for (let id of migrated) {
                        $effects.temporary_shadow(id);
                    }
                }
                $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
                clearSidebar();
                if (selectedItem != null) {
                    //TODO refactor into view?
                    $('.item[data-item-id="' + selectedItem.id + '"]').addClass('moused-selected');
                }
                $searchHistory.addActivatedSearch();
            }
            else {
                alert('Cannot manually change order of items when sorted by date.');
            }
            */
        }
        itemOnClick = null;
        itemOnRelease = null;
    }

    function onBackspaceUp() {
    	modeBackspaceKey = false;
        if (modeSkippedRender == true) {
            actionEditSearch();
        }
    }

    function onBackspaceDown() {
    	modeBackspaceKey = true;
    }

    function checkForUpdates() {
        if ($persist.maybeShouldReload() == true) {
            $persist.load(
                function success() {
                    timestampLastIdleSaved = $model.getTimestampLastUpdate()
                    resetInactivityTimer();
                    clearSelection();
                    $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
                    afterRender();
                }, 
                function failure() {
                    alert('ERROR: failed to reload');
                });
        }
    }

    function checkForIdle() {
        if (mousedItemId != null && selectedItem != null && selectedItem.id == mousedItemId) {
            console.log('Skip checkForIdle() while actively editing.');
            return;
        }
        let now = Date.now();
        let elapsed = now - timestampLastActive;
        if (elapsed > SAVE_AFTER_MS_OF_IDLE) {
            if (timestampLastIdleSaved == $model.getTimestampLastUpdate()) {
                //console.log('already idle saved at '+timestampLastIdleSaved+', do nothing');
            }
            else {
                console.log(parseInt(SAVE_AFTER_MS_OF_IDLE/1000) + ' seconds have passed...auto-saving.');
                document.body.style.cursor = "progress";
                timestampLastIdleSaved = $model.getTimestampLastUpdate();
                let t1 = Date.now();
                $persist.save(
                    function saveSuccess() {
                        document.body.style.cursor = "default";
                        let t2 = Date.now();
                        console.log('Done saving. Took '+(t2-t1)+'ms');
                        if (modeAlertSafeToExit) {
                            alert('Work has been saved.\nIt is now safe to exit.');
                            modeAlertSafeToExit = false;
                        }
                    }, 
                    function saveFail() {
                        alert('Failed saving file');
                    });
                
            } 
        }

        if ($protection.getModeProtected() && 
            modeAlertSafeToExit == false &&
            elapsed > LOCK_AFTER_MS_OF_IDLE) {
            location.reload();
        }
    }

    function onWindowFocus() {
        console.log('>>>>>>>>>>>>>>>>>>>>>');
        console.log('Focused');
        timestampFocused = Date.now();
        checkForUpdates();
    }

    function onWindowBlur() {
        /*
        console.log('onWindowBlur()');
        $persist.save(
            function saveSuccess() {}, 
            function saveFail() {
                alert('Failed saving file');
            });
        resetInactivityTimer();
        */
    }

    //TODO refactor this into modes
    function onEnterOrTab(e) {
    	if ($auto_complete.getModeHidden() == false) {
            $auto_complete.selectSuggestion();
            actionEditSearch();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.selectSuggestion(selectedItem, selectedSubitemPath);

            if (modeAdvancedView) {
                let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
                let editing = false;
                if (selectedItem != null) {
                    editing = true;
                }
                $sidebar.updateSidebar(selectedItem, subitem, getSubitemIndex(), editing);
            }
        }
        else if (selectedItem == null) {
            if (e.keyCode == 9) {
                //ignore tabs
                //e.preventDefault();
                return;
            }
            actionAdd(e);
        }
    }

    function onSpace(e) {

        //TODO: currently a bug with this that makes search more difficult to do

    }

    function onClickTagSuggestion() {
    	$auto_complete_tags.selectSuggestion(selectedItem, selectedSubitemPath);
        $auto_complete_tags.onChange(selectedItem, selectedSubitemPath);
    }

    function onSearchClick(e) {
        $auto_complete.showOptions();
        if (selectedItem != null) {
            closeSelectedItem();
            $view.render(null, null, null, modeSort, modeMoreResults);
            afterRender();
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
        if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.hideOptions();
        }
        if (selectedItem != null) {
            closeSelectedItem();
            $view.render(null, null, null, modeSort, modeMoreResults);
            afterRender();
        }
    }

    function actionMoreResults() {
        closeSelectedItem();
        modeMoreResults = true;
        $view.render(null, null, null, modeSort, modeMoreResults);
        afterRender();
    }

    function itemIsSelected() {
        if (selectedItem == null) {
            return false;
        }
        return true;
    }


    function actionSave(e) {
        if (modeModal) {
            return;
        }
        e.preventDefault();
        deselect();
        $view.render(null, null, null, modeSort, modeMoreResults);
        afterRender();
        function after() {
            modeModal = false;
        }
        modeModal = true;
        $backup_dlg.open_dialog(after);
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
            if (modeClipboardText == null || modeClipboardText.trim() == '') {
                alert("Nothing in clipboard. Ignoring command.");
                return;
            }
            text = text.replace(CLIPBOARD_ESCAPE_SEQUENCE, modeClipboardText);
        }

        $('#div-spinner').show();

        function onFnSuccess(message) {
            console.log('-----------------------------');
            console.log(message)
            console.log('-----------------------------');
            if (message != null && message != '') {
                function after() {
                    modeModal = false;
                }
                modeModal = true;
                $cli_response.open_dialog(text, message, after);
            }
            $('#div-spinner').hide();
        }

        function onFnFailure() {
            $('#div-spinner').hide();
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
            .replace(/<pre.*?>/g, '')
            .replace(/<\/code>/g, '')
            .replace(/<\/pre>/g, '');
        console.log('----------------');
        console.log('COPY TEXT:');
        console.log(text);
        console.log('----------------');
        modeClipboardText = text;
        let _onCopy = function(e) {
          e.clipboardData.setData('text/plain', text);
          e.preventDefault();
        };
        document.addEventListener('copy', _onCopy);
        document.execCommand('copy');
        document.removeEventListener('copy', _onCopy);

        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
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
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace('@todo','@done'); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function onUncheck(e) {
        e.stopPropagation();
        let parent = $(e.target).parents('[data-subitem-path]');
        let path = $(parent).attr('data-subitem-path');
        let id = parseInt(path.split(':')[0]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace('@done','@todo'); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function onFold(e) {
        e.stopPropagation();
        let parent = $(e.target).parents('[data-subitem-path]');
        let path = $(parent).attr('data-subitem-path');
        let id = parseInt(path.split(':')[0]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace('@+','@-'); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function onUnfold(e) {
        e.stopPropagation();
        let parent = $(e.target).parents('[data-subitem-path]');
        let path = $(parent).attr('data-subitem-path');
        let id = parseInt(path.split(':')[0]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace('@-','@+'); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function onClickSelectSearchSuggestion(e) {
        e.preventDefault();
        $auto_complete.selectSuggestion();
        actionEditSearch();
    }

    function onBeforeUnload(e) {
        if (timestampLastIdleSaved != $model.getTimestampLastUpdate()) {
            timestampLastActive = 0; //trigger save
            modeAlertSafeToExit = true;
            return 'Changes may not be saved';
        }
    }

    function onMouseLeave(e) {

    }

    function navigate(newSubitemPath) {
        if (selectedItem != null && newSubitemPath != selectedSubitemPath) {
            selectedSubitemPath = newSubitemPath;
            $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
            afterRender();
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
        else if (selectedItem != null) {
            e.stopPropagation();
            let $div = $('.selected-item')[0];
            let pos = getCaretPosition($div);
            if (pos.location == 0) {
                navigate($model.getPrevSubitemPath(selectedItem, selectedSubitemPath));
                let $div = $('.selected-item')[0];
                placeCaretAtStartContentEditable($div);
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
        else if (selectedItem != null) {
            e.stopPropagation();
            let $div = $('.selected-item')[0];
            let pos = getCaretPosition($div);
            if (pos.location == pos.textLength) {
                navigate($model.getNextSubitemPath(selectedItem, selectedSubitemPath));
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
        modeMoreResults = value;
    }

    function onHotkeyToFromTags(e) {
        if (selectedItem == null) {
            return;
        }

        //TODO: keep track of caret position and move back to that

        e.preventDefault();
        
        if (modeFocus == 'tag') {
            focusSubItem(selectedSubitemPath);
        }
        else {
            focusTag(selectedItem);
        }
        
        if (modeAdvancedView) {
            let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
            let editing = false;
            if (selectedItem != null) {
                editing = true;
            }
            $sidebar.updateSidebar(selectedItem, subitem, getSubitemIndex(), editing);
        }
    }

    function onClickMenu() {
        //TODO: this pattern exists in a lot of places
        if (selectedItem != null) {
            closeSelectedItem();
            $view.render(null, null, null, modeSort, modeMoreResults);
            afterRender();
        }
    }

    function actionRenameTag(e) {
        if (modeModal) {
            return;
        }
        e.preventDefault();
        $view.render(null, null, null, modeSort, modeMoreResults);
        afterRender();

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
            modeModal = true;
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
                    $model.renameTag(tag1, tag2);
                    
                    let current_search = $('.action-edit-search')[0].value;
                    let updated_search = current_search.replace(tag1, tag2);
                    if (current_search != updated_search) {
                        $('.action-edit-search')[0].value = updated_search;
                        actionEditSearch();
                    }

                    $view.render(null, null, null, modeSort, modeMoreResults);
                    afterRender();
                    //asdf
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
            modeModal = false;
        }).show();
    }

    function actionDeleteTag(e) {
        if (modeModal) {
            return;
        }
        e.preventDefault();
        closeSelectedItem();
        $view.render(null, null, null, modeSort, modeMoreResults);
        afterRender();
        //asdf

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
            modeModal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let tag = $('#tagname').val();
                    if (tag == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    $model.deleteTag(tag);
                    $view.render(null, null, null, modeSort, modeMoreResults);
                    afterRender();
                    //asdf
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
            modeModal = false;
        }).show();
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
        if (modeModal) {
            return;
        }
        closeSelectedItem();
        $view.render(null, null, null, modeSort, modeMoreResults);
        afterRender();
        //asdf

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
            modeModal = true;
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
                    
                    let tagsLhs = $('#tagname_lhs').val().trim();
                    if (tagsLhs == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    for (let tagLhs of tagsLhs.split(' ')) {
                        if ($model.isValidTag(tagLhs) == false) {
                            alert('Left hand side tag "'+tagLhs+'" was invalid'); //TODO: this is crude feedback
                            return;
                        }
                    }

                    let tagsRhs = $('#tagname_rhs').val().trim();
                    if (tagsRhs == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    for (let tagRhs of tagsRhs.split(' ')) {
                        if ($model.isValidTag(tagRhs) == false) {
                            alert('Right hand side tag "'+tagRhs+'" was invalid'); //TODO: this is crude feedback
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
                    let validSearchTags = getValidSearchTags();
                    if (validSearchTags. length > 0) {
                        tags += ' ' + validSearchTags.join(' ');
                    }
                    let newMetaItem = $model.addItemFromSearchBar(tags);
                    let text = tagsLhs + ' ' + relation + ' ' + tagsRhs;
                    $model.updateSubitemData(newMetaItem, newMetaItem.id+':0', text);
                    $model.recalculateAllTags();
                    let recalculated = $ontology.maybeRecalculateOntology();
                    if (recalculated) {
                        resetAllCache();
                    }
                    $view.render(null, null, null, modeSort, modeMoreResults);
                    afterRender();
                    //asdf
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
            modeModal = false;
        }).show();
    }

    function getValidSearchTags() {
        let searchString = $('.action-edit-search')[0].value.trim();
        let result = [];
        let parts = searchString.split(' ');
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
        if (modeModal) {
            return;
        }
        //e.preventDefault();
        closeSelectedItem();
        $view.render(null, null, null, modeSort, modeMoreResults);
        afterRender();
        //asdf

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
            modeModal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let tag = $('#tagname').val();
                    if (tag == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    //TODO: check for valid tag name
                    $model.addTagToCurrentView(tag);
                    $view.render(null, null, null, modeSort, modeMoreResults);
                    afterRender();
                    //asdf
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
            modeModal = false;
        }).show();
    }

    function actionPasswordProtectionSettings() {
        if (modeModal) {
            return;
        }
        deselect();
        function after(newPassword) {
            $protection.setPassword(newPassword);
            $menu.init(); //some options may change
            modeModal = false;
            $persist.save(
                function saveSuccess() {
                    
                }, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        modeModal = true;
        $password_protection_dlg.open_dialog(after);
    }

    function actionRemoveTagCurrentView() {
        if (modeModal) {
            return;
        }
        closeSelectedItem();
        $view.render(null, null, null, modeSort, modeMoreResults);
        afterRender();

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
            modeModal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let tag = $('#tagname').val();
                    if (tag == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    $model.removeTagFromCurrentView(tag);
                    $view.render(null, null, null, modeSort, modeMoreResults);
                    afterRender();
                    //asdf
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
            modeModal = false;
        }).show();
    }

    function deleteEverything() {
        let nothing = []
        $model.setItems(nothing);
        $persist.save(
            function saveSuccess() {}, 
            function saveFail() {
                alert('Failed saving file');
            });
        localStorage.removeItem('items'); //TODO: don't assume localStorage
        location.reload();
    }

    function actionDeleteEverything() {
        if (modeModal) {
            return;
        }
        closeSelectedItem();
        $view.render(null, null, null, modeSort, modeMoreResults);
        afterRender();
        //asdf

        picoModal({
            content: 
                "<p style='font-weight:bold; color:red;'>Are you SURE you want to delete EVERYTHING??</p>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Yes, delete it all</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            modeModal = true;
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
            modeModal = false;
        }).show();
    }

    function resetAllCache() {
        $render.resetCache();
        $auto_complete_tags.resetCache();
        //$model.resetCachedNumericTags();
        $model.resetTagCountsCache();
        $sidebar.resetCache();
        $parseSearch.resetCache();
    }

    function actionMakeLinkGoto(e) {
        e.stopPropagation();
        if (selectedItem == null) {
            return;
        }
        subsectionClipboard = [{data: "@id="+selectedItem.id, tags: "@goto", indent:0}];
    }

    function actionMakeLinkEmbed(e) {
        e.stopPropagation();
        if (selectedItem == null) {
            return;
        }
        subsectionClipboard = [{data: "@id="+selectedItem.id, tags: "@embed", indent:0}];
    }

    function getSubitemIndex() {
        if (selectedSubitemPath == null) {
            return 0;
        }
        return parseInt(selectedSubitemPath.split(':')[1]);
    }

    function actionCopySubsection(e) {
        e.stopPropagation();
        if (selectedItem == null) {
            return;
        }

        let subitemIndex = getSubitemIndex();
        let _subsectionClipboard = $model.copySubsection(selectedItem, subitemIndex);

        if (_subsectionClipboard.length == 1 && _subsectionClipboard[0].data == '') {
            alert('Cannot copy an empty subsection.');
            return;
        }

        for (let i = 0; i < _subsectionClipboard.length; i++) {
            let path = selectedItem.id+':'+(subitemIndex+i);
            $effects.emphasize(path);
        }
        $effects.apply_post_render_effects(selectedItem);

        subsectionClipboard = _subsectionClipboard;

        console.log(subsectionClipboard);

        //copy text version to clipboard
        let pseudoItem = new Object();
        pseudoItem.subitems = copyJSON(subsectionClipboard);
        let text = $model.getItemAsText(pseudoItem);
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
        if (subsectionClipboard == null) {
            alert("There is nothing in the clipboard to paste.");
            return;
        }
        if (selectedItem == null) {
            let tags = getTagsFromSearch();
            selectedItem = $model.addItemFromSearchBar(tags);
            selectedSubitemPath = selectedItem.id+':0';
            $model.fullyIncludeItem(selectedItem);
        }
        let subitemIndex = getSubitemIndex();
        let indexInto = $model.pasteSubsection(selectedItem, subitemIndex, subsectionClipboard);
        
        for (let i = 0; i < subsectionClipboard.length; i++) {
            let path = selectedItem.id+':'+(indexInto+i);
            $effects.emphasize(path);
        }
        //TODO: this is yucky, we should unify notation
        if (indexInto > 0) {
            selectedSubitemPath = selectedItem.id+':'+indexInto;
        }
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function actionCollapseAllView() {
        const items = $model.getItems();
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            if (item.subitems[0]._include == 1) {
                if (item.subitems.length > 1) {
                    $model.collapse(item);
                }
                else {
                    $model.expand(item);
                }
            }
        }
        $view.renderWithoutRefilter(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function actionExpandAllView() {
        const items = $model.getItems();
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            if (item.subitems[0]._include == 1) {
                $model.expand(item);
            }
        }
        $view.renderWithoutRefilter(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function actionCollapseItem(e) {
        e.stopPropagation();
        let parent = $(e.target).parents('[data-item-id]');
        let id = parseInt($(parent).attr('data-item-id'));
        let item = $model.getItemById(id);
        $model.collapse(item);
        $view.renderWithoutRefilter(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }
    
    function actionExpandItem(e) {
        e.stopPropagation();
        let parent = $(e.target).parents('[data-item-id]');
        let id = parseInt($(parent).attr('data-item-id'));
        let item = $model.getItemById(id);
        $model.expand(item);
        $view.renderWithoutRefilter(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function actionSortByPriority() {
        modeSort = 'priority';
        localStorage.setItem('modeSort', modeSort);
        $menu_sorting.init();
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function actionSortByReversePriority() {
        modeSort = 'reverse-priority';
        localStorage.setItem('modeSort', modeSort);
        $menu_sorting.init();
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function actionSortByDate() {
        modeSort = 'date';
        localStorage.setItem('modeSort', modeSort);
        $menu_sorting.init();
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function actionSortByReverseDate() {
        modeSort = 'reverse-date';
        localStorage.setItem('modeSort', modeSort);
        $menu_sorting.init();
        $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
        afterRender();
    }

    function getModeSort() {
        return modeSort;
    }

    function actionVisualizeCategorical() {
        if (modeModal) {
            return;
        }
        // closeSelectedItem();
        // $view.render(null, null, null, modeSort, modeMoreResults);
        // afterRender();
        deselect();
        function after() {
            modeModal = false;
        }
        modeModal = true;
        $visualize_categorical.open_dialog(after);
    }

    function actionVisualizeNumeric() {
        if (modeModal) {
            return;
        }
        // closeSelectedItem();
        // $view.render(null, null, null, modeSort, modeMoreResults);
        // afterRender();
        deselect();
        function after() {
            modeModal = false;
        }
        modeModal = true;
        $visualize_numeric.open_dialog(after);
    }

    function setSidebar(e) {
        if (e != undefined) {
            mousedItemId = $(e.currentTarget).attr('data-subitem-path').split(':')[0]; //TODO: this is hacky
        }

        if (selectedItem != null) {
            if (modeAdvancedView) {
                let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
                $sidebar.updateSidebar(selectedItem, subitem, getSubitemIndex(), true);
            }
            return;
        }
        e.stopPropagation();

        let path = $(e.currentTarget).attr('data-subitem-path')
        let id = parseInt(path.split(':')[0]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        if (modeAdvancedView) {
            $sidebar.updateSidebar(item, subitem, getSubitemIndex(), false);
        }

        if (selectedItem != null && mousedItemId == selectedItem.id) {
            $(this).parents('.item').addClass('moused-selected');
        }
        else {
            $(this).parents('.item').addClass('moused');
        }
    }

    function clearSidebar() {
        if (selectedItem != null) {
            return;
        }
        if (modeAdvancedView) {
            $sidebar.clearSidebar();
        }
    }

    function resetInactivityTimer() {
        timestampLastActive = Date.now();
        modeAlreadyIdleSaved = false;
    }

    function onMouseMove(e) {

    }

    function actionToggleAdvancedView() {

        if (modeAdvancedView) {
            modeAdvancedView = false;
            $('#div-side-panel').hide();
        }
        else {
            modeAdvancedView = true;
            $('#div-side-panel').show();
        }
        localStorage.setItem('modeAdvancedView', modeAdvancedView+'');
    }

    function saveSuccess() {
        console.log('saveSuccess()');
        $('#div-spinner').hide();
        modeDisconnected = false;
        if (saveAttempt != null) {
            clearInterval(saveAttempt);
            saveAttempt = null;
        }
    }

    let saveAttempt = null;

    function saveFail() {
        console.log('saveFail()');
        if (modeDisconnected == false) {
            $('#spn-spin-message').html('<h2>Disconnected from server<br><br>Attempting to reconnect...</h2>');
            $('#div-spinner').show();
            //TODO: actual message here.
            //alert('ERROR: Failed to save to server. May be disconnected.\nTry refreshing the browser.');
            modeDisconnected = true;
            saveAttempt = setInterval(function() {
                $persist.save(
                    function saveSuccess() {}, 
                    function saveFail() {
                        alert('Failed saving file');
                    });
            }, 5000);
        }
    }

    function actionPaste(e, pastedTextData, pastedHTMLData) {
        if (selectedSubitemPath == null) {
            e.stopPropagation();
            e.preventDefault();
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
            let newItem = $model.addItemFromSearchBar(tags);
            selectedItem = newItem;
            $effects.temporary_highlight(selectedItem.id);
            selectedSubitemPath = newItem.id+':0';
            onEnterEditingSubitem();
            $model.updateSubitemData(newItem, selectedSubitemPath, toPaste);
            deselect();
            window.scrollTo(0, 0);
            $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
            afterRender();
        }
    }

    function genericToggleFormatTag(tag) {
        let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
        if (subitem._implied_tags.includes(tag)) {
            return;
        }
        $model.toggleFormatTag(selectedItem, selectedSubitemPath, tag);
        $('.tag-bar-input').val(subitem.tags);
        $sidebar.updateSidebar(selectedItem, subitem, getSubitemIndex(), true);
    }

    function actionToggleBold(e) {
        e.stopPropagation();
        genericToggleFormatTag('@bold');
    }

    function actionToggleItalic(e) {
        e.stopPropagation();
        genericToggleFormatTag('@italic');
    }

    function actionToggleH1(e) {
        e.stopPropagation();
        genericToggleFormatTag('@h1');
    }

    function actionToggleH2(e) {
        e.stopPropagation();
        genericToggleFormatTag('@h2');
    }

    function actionToggleH3(e) {
        e.stopPropagation();
        genericToggleFormatTag('@h3');
    }

    function actionToggleH4(e) {
        e.stopPropagation();
        genericToggleFormatTag('@h4');
    }

    function actionToggleExpanded(e) {
        e.stopPropagation();
        genericToggleFormatTag('@+');
    }

    function actionToggleCollapsed(e) {
        e.stopPropagation();
        genericToggleFormatTag('@-');
    }

    function actionToggleTodo(e) {
        e.stopPropagation();
        genericToggleFormatTag('@todo');
    }

    function actionToggleDone(e) {
        e.stopPropagation();
        genericToggleFormatTag('@done');
    }

    function actionToggleCode(e) {
        e.stopPropagation();
        genericToggleFormatTag('@code');
    }

    function actionToggleListBulleted(e) {
        e.stopPropagation();
        genericToggleFormatTag('@list-bulleted');
    }

    function actionToggleListNumbered(e) {
        e.stopPropagation();
        genericToggleFormatTag('@list-numbered');
    }

    function actionToggleDateHeadline(e) {
        e.stopPropagation();
        genericToggleFormatTag('@date-headline');
    }

    function onDblClickSubitem(e) {
        e.stopPropagation();
        console.log('onDblClickSubitem()');
        onEscape();
    }

    function getClipboardText() {
        return modeClipboardText;
    }

    function afterRender() {
        if (selectedSubitemPath != null) {
            focusSubItem(selectedSubitemPath);
            //TODO: do we need this?
            $('.item[data-item-id="' + selectedItem.id + '"]').addClass('moused-selected');
        }
        if (modeAdvancedView) {
            clearSidebar();
        }
        modeSkippedRender = false;
        $('#div-spinner').hide();
    }

    function onUpdateProtection() {
        deselect();
        $view.render(null, null, null, modeSort, modeMoreResults);
    }

    function actionLogOut() {
        if (timestampLastIdleSaved != $model.getTimestampLastUpdate()) {
            $('#spn-spin-message').html('<h3>SAVING AND LOGGING OUT...</h3>');
            $('#div-spinner').show();
            $persist.save(
                function saveSuccess() {
                    timestampLastIdleSaved = $model.getTimestampLastUpdate();
                    location.reload();
                }, 
                function saveFail() {
                    alert('Failed saving file');
                });
        }
        else {
            location.reload();
        }
    }

    function init() {

        //TODO: not if grabbing from server
        if (testLocalStorage() == false) {
            window.location.replace('error-pages/error-local-storage.html');
        }

        $persist.load(
            function success() {
                //restore saved search
                
                let search = localStorage.getItem('search');
                if (search != null && search != 'null') {
                    $('.action-edit-search')[0].value = search;
                }
                else {
                    localStorage.setItem('search', null);
                    $('.action-edit-search')[0].value = '';
                }

                if (localStorage.getItem('modeAdvancedView') != null) {
                    if (localStorage.getItem('modeAdvancedView') == 'true') {
                        actionToggleAdvancedView();
                    }
                }
                else {
                    if (ADVANCED_VIEW_BY_DEFAULT) {
                        actionToggleAdvancedView();
                    }
                }
                $events.registerEvents();
                $menu.init();
                if (ENABLE_CHECK_FOR_UPDATES) {
                    setInterval(checkForUpdates, CHECK_FOR_UPDATES_FREQ_MS);
                }
                setInterval(checkForIdle, CHECK_FOR_IDLE_FREQ_MS);
                clearSelection();
                $auto_complete.onChange();
                $auto_complete.hideOptions();
                document.activeElement.blur();
                $view.render(selectedItem, mousedItemId, selectedSubitemPath, modeSort, modeMoreResults);
                afterRender();
                timestampLastIdleSaved = $model.getTimestampLastUpdate();
                resetInactivityTimer();
                $('.page-app').show();
                $('#spn-spin-message').html('<h3>LOADING...</h3>');
                $('#div-spinner').hide();
            }, 
            function failure() { 
                //alert('Failed to load from server');
            });
    }

    return {
        init: init,
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
        actionSave: actionSave,
        actionRenameTag: actionRenameTag,
        actionDeleteTag: actionDeleteTag,
        actionSetSortingMode: actionSetSortingMode,
        actionRestoreFromText: actionRestoreFromText,
        actionRestoreFromJSON: actionRestoreFromJSON,
        actionAddTagCurrentView: actionAddTagCurrentView,
        actionRemoveTagCurrentView: actionRemoveTagCurrentView,
        actionDeleteEverything: actionDeleteEverything,
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
        actionVisualizeNumeric: actionVisualizeNumeric,
        actionVisualizeCategorical: actionVisualizeCategorical,
        actionToggleBold: actionToggleBold,
        actionToggleItalic: actionToggleItalic,
        actionToggleExpanded: actionToggleExpanded,
        actionToggleCollapsed: actionToggleCollapsed,
        actionToggleTodo: actionToggleTodo,
        actionToggleDone: actionToggleDone,
        actionToggleH1: actionToggleH1,
        actionToggleH2: actionToggleH2,
        actionToggleH3: actionToggleH3,
        actionToggleH4: actionToggleH4,
        actionToggleCode: actionToggleCode,
        actionToggleListBulleted: actionToggleListBulleted,
        actionToggleListNumbered: actionToggleListNumbered,
        actionToggleDateHeadline: actionToggleDateHeadline,
        actionLogOut: actionLogOut,
		focusSubItem: focusSubItem,
		actionDelete: actionDelete,
        onCopy: onCopy,
        onExec: onExec,
        onEscape: onEscape,
		onBackspaceUp: onBackspaceUp,
		onBackspaceDown: onBackspaceDown,
        onMouseLeave: onMouseLeave,
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
        getModeSort: getModeSort,
        onClickMenu: onClickMenu,
        setSidebar: setSidebar,
        clearSidebar: clearSidebar,
        resetInactivityTimer: resetInactivityTimer,
        onMouseMove: onMouseMove,
        actionToggleAdvancedView: actionToggleAdvancedView,
        actionPaste: actionPaste,
        getClipboardText: getClipboardText,
        onUpdateProtection: onUpdateProtection
    };
})();
$todo.init();
