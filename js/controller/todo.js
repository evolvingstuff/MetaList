"use strict";

let $todo = (function () {

    const ENABLE_CHECK_FOR_UPDATES = true; //TODO: how are we doing this for server version?
    const CHECK_FOR_UPDATES_FREQ_MS = 1000;
    const CHECK_FOR_IDLE_FREQ_MS = 250;
    const SAVE_AFTER_MS_OF_IDLE = 60000; //60 seconds
    const LOCK_AFTER_MS_OF_IDLE = 3600000; //60 minutes default
    const UPDATE_SIDEBAR_ON_EDIT_ITEM_DATA = false;
    const MAX_SHADOW_ITEMS_ON_MOVE = 25;
    const MIN_FOCUS_TIME_TO_EDIT = 300;
    const ADVANCED_VIEW_BY_DEFAULT = true;
    const VALID_LOCALSTORAGE_KEYS = [
        'items_bundle', 
        'items_bundle_timestamp', 
        'search', 
        'modeAdvancedView'
    ];
    const INDENT_ACTION_PIXEL_WIDTH = 10;

    let modeBackspaceKey = false;
    let modeSkippedRender = false;
    let modeMoreResults = false;
    let modeModal = false;
    let modeAlreadyIdleSaved = false;
    let modeMousedown = false;
    let modeAdvancedView = false;
    let modeEditingSubitem = false;
    let modeEditingSubitemInitialState = null;
    let modeClipboardText = null;
    let modeDisconnected = false;
    let modeFocus = null;
    let modeAlertSafeToExit = false;
    let modeForceReload = false;

    let timestampLastIdleSaved = 0;
    let selectedItem = null;
    let selectedSubitemPath = null;
    let itemOnClick = null;
    let subitemIdOnClick = null;
    let itemOnRelease = null;
    let subitemIdOnRelease = null;
    let xOnRelease = null;
    let mousedItemId = null;
    let mousedSubitemId = null;
    let recentClickedSubitem = null;
    let xOnClick = null;
    let copyOfSelectedItemBeforeEditing = null;
    let subsectionClipboard = null;
    let timestampFocused = Date.now();
    let timestampLastActive = Date.now();

    function deselect() {
        if (selectedSubitemPath != null) {
            onExitEditingSubitem();
        }
        selectedItem = null;
        selectedSubitemPath = null;
        itemOnClick = null;
        subitemIdOnClick = null;
        itemOnRelease = null;
        subitemIdOnRelease = null;
        xOnClick = null;
        xOnRelease = null;
        mousedItemId = null;
        mousedSubitemId = null;
        modeFocus = null;
        clearSidebar();
    }

    function actionAddNewItem(event) {
        $view.closeAnyOpenMenus();
        deselect();
        actionAdd(event);
    }

    function actionAdd(event) {
        if (modeModal) {
            return;
        }
        $view.closeAnyOpenMenus();
        if (event != undefined) {
            event.stopPropagation();
            event.preventDefault();
        }
        if (selectedItem != null) {
            onExitEditingSubitem();
            let subitemIndex = getSubitemIndex();
            let extraIndent = false;
            selectedSubitemPath = $model.addSubItem(selectedItem, subitemIndex, extraIndent);
            $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
            afterRender();
        }
        else {
            modeMoreResults = false;
            let tags = getTagsFromSearch();
            selectedItem = $model.addItemFromSearchBar(tags);
            $auto_complete.refreshParse();
            $effects.temporary_highlight(selectedItem.id);
            selectedSubitemPath = selectedItem.id+':0';
            $model.fullyIncludeItem(selectedItem);
            $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
            afterRender();
        }
        if (selectedItem != null) {
            let el = $view.getItemElementById(selectedItem.id);
            $view.onMouseoverAndSelected(el);
        }
        $searchHistory.addActivatedSearch();
    }

    function getTagsFromSearch() {
        let currentSearchString = $auto_complete.getSearchString();
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
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
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

        if ($model.itemHasAttributeTags(copyOfSelectedItemBeforeEditing)) {
            $model.resetTagCountsCache();
            $model.resetCachedAttributeTags();
        }

        $auto_complete.refreshParse();
        $searchHistory.addActivatedSearch();
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function focusSubItem(path) {
        if (path == null) {
            console.log('WARNING: subitem path is null, cannot focus');
            return;
        }
    	$view.focusSubitem(path);
        onEnterEditingSubitem();
    }

    function shortcutFocusTag(item) {
        let el = $view.getItemTagElementById(item.id);
        el.focus();
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
        if (tags.trim().length > 0) {
            el.value = tags.trim() + ' ';
            actionEditTag();
        }

        placeCaretAtEndInput(el);
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
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);   
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
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function actionUp(event) {
        event.stopPropagation();
        let subitemIndex = getSubitemIndex();
        if (subitemIndex > 0) {
            selectedSubitemPath = $model.moveUpSubitem(selectedItem, selectedSubitemPath);
        }
        else {
            $effects.temporary_highlight(selectedItem.id);
            let migrated = $model.moveUp(selectedItem);
            if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                for (let id of migrated) {
                    $effects.temporary_shadow(id);
                }
            }
        }
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function actionDown(event) {
        event.stopPropagation();
        let subitemIndex = getSubitemIndex();
        if (subitemIndex > 0) {
            selectedSubitemPath = $model.moveDownSubitem(selectedItem, selectedSubitemPath);
        }
        else {
            $effects.temporary_highlight(selectedItem.id);
            let migrated = $model.moveDown(selectedItem);
            if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                for (let id of migrated) {
                    $effects.temporary_shadow(id);
                }
            }
        }
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function actionIndent() {
        let subitemIndex = getSubitemIndex();
        if (subitemIndex > 0) {
            $model.indentSubitem(selectedItem, selectedSubitemPath);
            $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
            afterRender();
        }
    }

    function actionUnindent() {
        let subitemIndex = getSubitemIndex();
        if (subitemIndex > 0) {
            $model.unindentSubitem(selectedItem, selectedSubitemPath);
            $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
            afterRender();
        }
    }

    function onClickEditBar(event) {
        event.stopPropagation();
    }

    function onClickSubitem(event) {
        event.stopPropagation();
        $view.closeAnyOpenMenus();
        //Do not want to immediately go into editing mode if not already interacting with window?
        let now = Date.now();
        if (now - timestampFocused < MIN_FOCUS_TIME_TO_EDIT) {
            console.log('SKIPPING');
            return;
        }
        else {
            //console.log('NOT SKIPPING delay = ' + (now-timestampFocused));
        }
        console.log('onClickSubitem()');
        let path = $view.getSubitemPathFromEventTarget(event.currentTarget); //currentTarget
        recentClickedSubitem = path;
        let doSelect = false;
        if (selectedItem != null) {
            let itemId = parseInt(path.split(':')[0]);
            selectedSubitemPath = recentClickedSubitem;
            if (selectedItem.id != itemId) {
                doSelect = true;
            }
        }
        else {
            doSelect = true;
        }
        if (doSelect) {
            console.log('doSelect');
            closeSelectedItem();
            let itemId = parseInt(this.dataset.subitemPath.split(':')[0]);
            selectedItem = $model.getItemById(itemId);
            copyOfSelectedItemBeforeEditing = copyJSON(selectedItem);
            $model.expand(selectedItem);
            selectedSubitemPath = recentClickedSubitem;
            mousedItemId = selectedItem.id;
            mousedSubitemId = parseInt(path.split(':')[1]);
            $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
            afterRender();
        }
        if (selectedItem != null) {
            console.log(selectedItem);
        }
        recentClickedSubitem = null;
        $searchHistory.addActivatedSearch();
        setSidebar();
    }
    

    function onClickItem(event) {
        console.log('onClickItem()');
        console.log(selectedItem);
        $view.closeAnyOpenMenus();
        event.stopPropagation();
    }

    function onClickDocument(event) {
        console.log('onClickDocument()');
        if (selectedItem != null) {
            closeSelectedItem();
            $view.render(null, null, modeMoreResults);
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
    
        if ($model.itemHasAttributeTags(copyOfSelectedItemBeforeEditing) ||
            $model.itemHasAttributeTags(selectedItem)) {

            $model.resetTagCountsCache();
            $model.resetCachedAttributeTags();
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

    

    function onEditSubitem(event) {
        if (selectedItem != null) {
            let text = event.target.innerHTML;
            let path = $view.getSubitemPathFromEventTarget(event.target);
            $model.updateSubitemData(selectedItem, path, text);
            if (UPDATE_SIDEBAR_ON_EDIT_ITEM_DATA) {
                setSidebar();
            }
        }
    }

    function onFocusSubitem(event) {
        modeFocus = 'subitem';
        $auto_complete_tags.hideOptions();
        if (selectedItem == null) {
            return;
        }

        if (selectedSubitemPath != null && modeEditingSubitem == true) {
            onExitEditingSubitem();
        }
        $view.onFocusSubitem(event);
        setSidebar();
        onEnterEditingSubitem();
    }

    function actionEditTime(event) {
        if (selectedItem == null) {
            throw "Unexpected, no selected item...";
        }
        let text = $view.getSelectedTimeAsText();
        let utcDate = new Date(text);
        let timestamp = utcDate.getTime() + utcDate.getTimezoneOffset() * 60 * 1000;
        $model.updateTimestamp(selectedItem, timestamp);
    }

    function actionFocusEditTag() {
        let subitemIndex = getSubitemIndex();
        let tags = selectedItem.subitems[subitemIndex].tags;
        if (tags.trim().length > 0) {
            $view.setTagInput(tags.trim() + ' ');
        }
        else {
            $view.setTagInput('');
        }
        let tagsString = $view.getTagInput();
        modeFocus = 'tag';
        $auto_complete_tags.onChange(selectedItem, selectedSubitemPath, tagsString);
        $auto_complete_tags.showOptions();
        $sidebar.updateSidebar(selectedItem, subitemIndex, true);
    }
    
    function actionEditTag() {
        console.log('actionEditTag');
        console.log('--------------------------------');
        if (selectedItem == null) {
            throw "Unexpected, no selected item...";
        }
        //TODO refactor into view?
        let tagsString = $view.getItemTagElementById(selectedItem.id).value;
        $model.updateSubTag(selectedItem, selectedSubitemPath, tagsString);
        $auto_complete_tags.onChange(selectedItem, selectedSubitemPath, tagsString);
        $auto_complete_tags.showOptions();
        $sidebar.updateSidebar(selectedItem, getSubitemIndex(), true);

        console.log('_______________________________');
    }

    function actionEditSearch() {
        console.log('>>> actionEditSearch()');
        //TODO refactor into view?
        let text = $auto_complete.getSearchString();
        localStorage.setItem('search', text);
        modeMoreResults = false;
        if (modeBackspaceKey == false) {
            window.scrollTo(0, 0);
            $auto_complete.onChange();
            $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
            afterRender();
        }
        else {
            //console.log('DEBUG: modeBackspaceKey (skipped rendering)');
            modeSkippedRender = true;
        }
    }

    function maybeResetSearch() {
        let currentSearchString = $auto_complete.getSearchString();
        if (currentSearchString != null && currentSearchString != '') {
            let parse_results = $parseSearch.parse(currentSearchString);
            $model.filterItemsWithParse(parse_results, false); //TODO: why is this called twice?
            let tot = 0;
            const items = $model.getUnsortedItems();
            for (let item of items) {
                if (item.subitems[0]._include == 1) {
                    tot++;
                }
            }
            if (tot == 0) {
                localStorage.setItem('search', null);
                $view.setSearchText('');
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
    
    function actionMouseover(e) {
    	let subitemPath = $view.getSubitemPathFromEventTarget(e.target);
        if (subitemPath != undefined) {
            mousedItemId = parseInt(subitemPath.split(':')[0]);
            mousedSubitemId = parseInt(subitemPath.split(':')[1]);
        }
        else {
            mousedItemId = $view.getItemIdFromEventTarget(e.currentTarget);
            mousedSubitemId = 0;
        }

        if (selectedItem != null && mousedItemId == selectedItem.id) {
            $view.onMouseoverAndSelected(e.currentTarget);
        }
        else if (selectedItem == null) {
            $view.onMouseover(e.currentTarget);
            $auto_complete_tags.hideOptions();
        }
        if (itemOnClick != null && itemOnClick.id != mousedItemId) {
            $view.removeAllRanges();
        }
        $auto_complete.hideOptions();
        setSidebar();
    }

    function actionMouseoff(e) {
        $view.onMouseoff();
        mousedItemId = null;
        mousedSubitemId = null;
    }

    function actionMousedown(e) {
        itemOnClick = $model.getItemById(mousedItemId);
        subitemIdOnClick = mousedSubitemId;
        xOnClick = e.clientX;
        if (itemOnClick != null) {
            //don't add to search unless an actual item is clicked
            $searchHistory.addActivatedSearch();
            if (selectedItem == null) {
                $view.setCursor("grab");
            }
            else {
                if (selectedItem.id != itemOnClick.id) {
                    $view.setCursor("grab");
                }
            }
        }
        
        modeMousedown = true;
    }

    function actionMouseup(e) {

        e.stopPropagation();

        xOnRelease = e.clientX;

        modeMousedown = false;

        $view.setCursor("auto");

        itemOnRelease = null;
        if (mousedItemId != null) {
            itemOnRelease = $model.getItemById(mousedItemId);
        }
        subitemIdOnRelease = null;
        if (mousedSubitemId != null) {
            subitemIdOnRelease = mousedSubitemId;
        }

        if (itemOnClick == null) {
            return;
        }

        console.log('***********************************');
        console.log('onmouseup');
        console.log('\titem id:    ' + itemOnClick.id + ' -> ' + itemOnRelease.id);
        console.log('\tsubitem id: ' + subitemIdOnClick + ' -> ' + subitemIdOnRelease);
        console.log('\txOnClick: ' + xOnClick + ' / xOnRelease: ' + xOnRelease);
        console.log('***********************************');

        if (itemOnClick.id == itemOnRelease.id && 
            selectedItem == null) {
            if (subitemIdOnClick != subitemIdOnRelease) {
                let newpath = $model.dragSubitem(itemOnClick, subitemIdOnClick, subitemIdOnRelease);
                $effects.emphasizeSubitemAndChildren(itemOnClick, newpath);
                deselect();
                $view.render(selectedItem, selectedSubitemPath, modeMoreResults);   
                afterRender();
                return;
            }
            else {
                if (xOnRelease < xOnClick - INDENT_ACTION_PIXEL_WIDTH) {
                    let newpath = $model.unindentSubitem(itemOnClick, itemOnClick.id+':'+subitemIdOnClick)
                    $effects.emphasizeSubitemAndChildren(itemOnClick, newpath);
                    deselect();
                    $view.render(selectedItem, selectedSubitemPath, modeMoreResults);   
                    afterRender();
                    return;
                }
                else if (xOnRelease > xOnClick + INDENT_ACTION_PIXEL_WIDTH) {
                    let newpath = $model.indentSubitem(itemOnClick, itemOnClick.id+':'+subitemIdOnClick)
                    $effects.emphasizeSubitemAndChildren(itemOnClick, newpath);
                    deselect();
                    $view.render(selectedItem, selectedSubitemPath, modeMoreResults);   
                    afterRender();
                    return;
                }
            }
        }

        //TODO: This is spaghetti
        if (itemOnRelease != null && 
            selectedItem != null && 
            selectedItem.id == itemOnRelease.id) {
            //Released inside the item we are editing
            itemOnClick = null;
            subitemIdOnClick = null;
            itemOnRelease = null;
            return;
        }

        if (itemOnClick != null && 
            itemOnRelease != null && 
            itemOnClick.id != itemOnRelease.id) {
            $effects.temporary_highlight(itemOnClick.id);
            let migrated = $model.drag(itemOnClick, itemOnRelease);
            if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                for (let id of migrated) {
                    $effects.temporary_shadow(id);
                }
            }
            $searchHistory.addActivatedSearch();
            $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
            afterRender();
        }
        itemOnClick = null;
        subitemIdOnClick = null;
        itemOnRelease = null;
        subitemIdOnRelease = null;
        xOnClick = null;
        xOnRelease = null;
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
        function after(shouldReload) {
            if (shouldReload == false) {
                return;
            }
            console.log('triggering logout');
            modeForceReload = true;
            location.reload(); //Just make it simple for now
        }
        $persist.maybeShouldReload(after);
    }

    function checkForIdle() {
        if (mousedItemId != null && selectedItem != null && selectedItem.id == mousedItemId) {
            //console.log('Skip checkForIdle() while actively editing.');
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
                $view.setCursor("progress");
                timestampLastIdleSaved = $model.getTimestampLastUpdate();
                let t1 = Date.now();
                $persist.saveToHost(
                    function saveSuccess() {
                        $view.setCursor("default");
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
        timestampFocused = Date.now();
        checkForUpdates();
    }

    function onWindowBlur() {
        //do nothing
    }

    //TODO refactor this into modes
    function onEnterOrTab(e) {
    	if ($auto_complete.getModeHidden() == false) {
            $auto_complete.selectSuggestion();
            actionEditSearch();
        }
        else if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.selectSuggestion(selectedItem, selectedSubitemPath);

            let editing = false;
            if (selectedItem != null) {
                editing = true;
            }
            $sidebar.updateSidebar(selectedItem, getSubitemIndex(), editing);
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
        //asdfasdf
        let tagsString = selectedItem.subitems[getSubitemIndex()].tags.trim() + ' ';
        $auto_complete_tags.onChange(selectedItem, selectedSubitemPath, tagsString);
    }

    function onSearchClick(e) {
        $auto_complete.showOptions();
        if (selectedItem != null) {
            closeSelectedItem();
            $view.render(null, null, modeMoreResults);
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
            $view.render(null, null, modeMoreResults);
            afterRender();
        }
    }

    function actionMoreResults() {
        closeSelectedItem();
        modeMoreResults = true;
        $view.render(null, null, modeMoreResults);
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
        $view.render(null, null, modeMoreResults);
        afterRender();
        function afterMaybeBackup() {
            modeModal = false;
        }
        modeModal = true;

        $backup_dlg.open_dialog(afterMaybeBackup);
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

    function onShell(e) {
        e.stopPropagation();
        let text = e.currentTarget.innerHTML;
        text = $format.toText(text);

        //TODO: basic checks here

        if (text.includes(CLIPBOARD_ESCAPE_SEQUENCE)) {
            if (modeClipboardText == null || modeClipboardText.trim() == '') {
                alert("Nothing in clipboard. Ignoring command.");
                return;
            }
            text = text.replace(CLIPBOARD_ESCAPE_SEQUENCE, modeClipboardText);
        }

        function onFnSuccess(message) {
            console.log('-----------------------------');
            console.log(message)
            console.log('-----------------------------');
        }

        function onFnFailure() {
            alert('FAILED');
        }

        let obj = {
            command: text
        }

        $.ajax({
            url: '/shell',
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

        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function actionGotoSearch(e) {
        e.stopPropagation();
        let text = e.target.innerText;
        $view.setSearchText(text);
        actionEditSearch();
    }

    function onCheck(e) {
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = parseInt(path.split(':')[0]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace(META_TODO, META_DONE); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function onUncheck(e) {
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = parseInt(path.split(':')[0]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace(META_DONE, META_TODO); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function onFold(e) {
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = parseInt(path.split(':')[0]);
        let index = parseInt(path.split(':')[1]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        $model.toggleFormatTag(item, path, META_FOLDED);
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function onUnfold(e) {
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = parseInt(path.split(':')[0]);
        let index = parseInt(path.split(':')[1]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        $model.toggleFormatTag(item, path, META_UNFOLDED);
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function onClickSelectSearchSuggestion(e) {
        e.preventDefault();
        $auto_complete.selectSuggestion();
        actionEditSearch();
    }

    function onBeforeUnload(e) {
        if (timestampLastIdleSaved != $model.getTimestampLastUpdate() &&
            modeForceReload == false) {
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
            $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
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
            let pos = $view.getCaretPositionOfSelectedItem();
            if (pos.location == 0) {
                navigate($model.getPrevSubitemPath(selectedItem, selectedSubitemPath));
                placeCaretAtStartContentEditable(div);
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
            let pos = $view.getCaretPositionOfSelectedItem();
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
            shortcutFocusTag(selectedItem);
        }
        
        let editing = false;
        if (selectedItem != null) {
            editing = true;
        }
        $sidebar.updateSidebar(selectedItem, getSubitemIndex(), editing);
    }

    function onClickMenu() {
        //TODO: this pattern exists in a lot of places
        if (selectedItem != null) {
            closeSelectedItem();
            $view.render(null, null, modeMoreResults);
            afterRender();
        }
    }

    function actionRestoreFromText() {
        alert('restore from text backup TODO...');
    }

    function actionRestoreFromJSON() {
        alert('restore from JSON backup TODO...');
    }

    function getValidSearchTags() {
        let searchString = $view.getSearchText().trim();
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

    function actionPasswordProtectionSettings() {
        if (modeModal) {
            return;
        }
        deselect();
        function after(newPassword) {
            modeModal = false;
            $protection.setPassword(newPassword);
            $model.setTimestampLastUpdate(Date.now());
            actionLogOut();
        }
        modeModal = true;
        $password_protection_dlg.open_dialog(after);
    }

    function deleteEverything() {
        let nothing = []
        $model.setItems(nothing);
        $persist.saveToHost(
            function saveSuccess() {
                location.reload();
            }, 
            function saveFail() {
                alert('Failed saving file');
            });
    }

    function resetAllCache() {
        $view.resetCache();
        $auto_complete_tags.resetCache();
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
            $effects.emphasizeSubitem(path);
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
        if (e != undefined) {
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
            $effects.emphasizeSubitem(path);
        }
        //TODO: this is yucky, we should unify notation
        if (indexInto > 0) {
            selectedSubitemPath = selectedItem.id+':'+indexInto;
        }
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function actionRemoveFormatting(e) {
        if (e != undefined) {
            e.stopPropagation();
        }
        if (selectedItem == null) {
            return;
        }
        let subitemIndex = getSubitemIndex();
        $model.removeSubitemFormatting(selectedItem, subitemIndex);
        let path = selectedItem.id+':'+subitemIndex;
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
    }

    function actionCollapseAllView() {
        const items = $model.getUnsortedItems();
        for (let item of items) {
            if (item.subitems[0]._include == 1) {
                if (item.subitems.length > 1) {
                    $model.collapse(item);
                }
                else {
                    $model.expand(item);
                }
            }
        }
        $view.renderWithoutRefilter(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function actionExpandAllView() {
        const items = $model.getUnsortedItems();
        for (let item of items) {
            if (item.subitems[0]._include == 1) {
                $model.expand(item);
            }
        }
        $view.renderWithoutRefilter(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function actionCollapseItem(e) {
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = path.split(':')[0];
        let item = $model.getItemById(id);
        $model.collapse(item);
        $view.renderWithoutRefilter(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }
    
    function actionExpandItem(e) {
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = path.split(':')[0];
        let item = $model.getItemById(id);
        $model.expand(item);
        $view.renderWithoutRefilter(selectedItem, selectedSubitemPath, modeMoreResults);
        afterRender();
    }

    function actionRenameTag() {
        if (modeModal) {
            return;
        }
        deselect();
        function after() {
            modeModal = false;
            $view.render(null, null, modeMoreResults);
            afterRender();
        }
        modeModal = true;
        $dlg.renameTag(after);
    }

    function actionReplaceText() {
        if (modeModal) {
            return;
        }
        deselect();
        function after() {
            $view.resetCache();
            modeModal = false;
            $view.render(null, null, modeMoreResults);
            afterRender();
        }
        modeModal = true;
        $dlg.replaceText(after);
    }

    function actionDeleteTag(e) {
        if (modeModal) {
            return;
        }
        deselect();
        function after() {
            modeModal = false;
            $view.render(null, null, modeMoreResults);
            afterRender();
        }
        modeModal = true;
        $dlg.deleteTag(after);
    }

    function restoreFromFile(obj) {
        if ($unlock.getIsLocked() == true) {
            alert('Cannot load from a file while in locked mode.');
            return;
        }
        if (obj.encryption.encrypted == false) {
            $view.showSpinner();
            try {
                let newItems = $schema.checkSchemaUpdate(obj.data, obj.data_schema_version);
                $model.setItems(newItems);
                $persist.saveToHost(
                    function saveSuccess() {}, 
                    function saveFail() {
                        alert('Failed saving file');
                    });
                window.scrollTo(0, 0);
                maybeResetSearch();
                $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
                afterRender();
            }
            catch (e) {
                $view.hideSpinner();
                alert(e);
            }
        }
        else {
            if (modeModal) {
                return;
            }
            deselect();
            function after() {
                modeModal = false;
                window.scrollTo(0, 0);
                $view.render(null, null, modeMoreResults);
                afterRender();
            }
            modeModal = true;
            $dlg.restoreFromFile(obj, after);
        }
    }

    function actionRemoveTagCurrentView() {
        if (modeModal) {
            return;
        }
        deselect();
        function after() {
            modeModal = false;
            $view.render(null, null, modeMoreResults);
            afterRender();
        }
        modeModal = true;
        $dlg.removeTagFromCurrentView(after);
    }

    function actionDeleteEverything() {
        if (modeModal) {
            return;
        }
        deselect();
        function after() {
            modeModal = false;
            $view.render(null, null, modeMoreResults);
            afterRender();
        }
        modeModal = true;
        $dlg.deleteEverything(after);
    }

    function actionAddMetaRule() {
        if (modeModal) {
            return;
        }
        deselect();
        function after() {
            modeModal = false;
            $view.render(null, null, modeMoreResults);
            afterRender();
        }
        modeModal = true;
        $dlg.addMetaRule(after);
    }

    function actionAddTagCurrentView() {
        if (modeModal) {
            return;
        }
        deselect();
        function after() {
            modeModal = false;
            $view.render(null, null, modeMoreResults);
            afterRender();
        }
        modeModal = true;
        $dlg.addTagToCurrentView(after);
    }

    function actionVisualizeCategorical() {
        if (modeModal) {
            return;
        }
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
        deselect();
        function after() {
            modeModal = false;
        }
        modeModal = true;
        $visualize_numeric.open_dialog(after);
    }

    function setSidebar() {

        if (modeAdvancedView == false) {
            return;
        }

        if (selectedItem != null) {
            $sidebar.updateSidebar(selectedItem, getSubitemIndex(), true);
            return;
        }
        
        if (mousedItemId != null) {
            let mousedItem = $model.getItemById(mousedItemId);
            let index = 0;
            if (mousedSubitemId != null) {
                index = mousedSubitemId;
            }
            $sidebar.updateSidebar(mousedItem, index, false);
            return;
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
            $view.hideSidePanel();
        }
        else {
            modeAdvancedView = true;
            $view.showSidePanel();
        }
        localStorage.setItem('modeAdvancedView', modeAdvancedView+'');
    }

    function saveSuccess() {
        console.log('saveSuccess()');
        $view.hideSpinner();
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
            $view.setSpinnerContentDisconnected();
            $view.showSpinner();
            //TODO: actual message here.
            //alert('ERROR: Failed to save to server. May be disconnected.\nTry refreshing the browser.');
            modeDisconnected = true;
            saveAttempt = setInterval(function() {
                $persist.saveToHost(
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
            $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
            afterRender();
        }
    }

    function genericToggleFormatTag(tag) {
        let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
        if (subitem._implied_tags.includes(tag)) {
            return;
        }
        $model.toggleFormatTag(selectedItem, selectedSubitemPath, tag);
        $view.setTagInput(subitem.tags);
        $sidebar.updateSidebar(selectedItem, getSubitemIndex(), true);
        $auto_complete_tags.hideOptions();
        modeFocus = 'edit-bar';
    }

    function actionToggleBold(e) {
        e.stopPropagation();
        genericToggleFormatTag(META_BOLD);
    }

    function actionToggleItalic(e) {
        e.stopPropagation();
        genericToggleFormatTag(META_ITALIC);
    }

    function actionToggleHeading(e) {
        e.stopPropagation();
        genericToggleFormatTag(META_HEADING);
    }

    function actionToggleExpanded(e) {
        e.stopPropagation();
        genericToggleFormatTag(META_UNFOLDED);
    }

    function actionToggleCollapsed(e) {
        e.stopPropagation();
        genericToggleFormatTag(META_FOLDED);
    }

    function actionToggleTodo(e) {
        e.stopPropagation();
        genericToggleFormatTag(META_TODO);
    }

    function actionToggleDone(e) {
        e.stopPropagation();
        genericToggleFormatTag(META_DONE);
    }

    function actionToggleCode(e) {
        e.stopPropagation();
        genericToggleFormatTag(META_MONOSPACE_DARK);
    }

    function actionToggleListBulleted(e) {
        e.stopPropagation();
        genericToggleFormatTag(META_LIST_BULLETED);
    }

    function actionToggleListNumbered(e) {
        e.stopPropagation();
        genericToggleFormatTag(META_LIST_NUMBERED);
    }

    function actionToggleDateHeadline(e) {
        e.stopPropagation();
        genericToggleFormatTag(META_DATE_HEADLINE);
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
            let el = $view.getItemElementById(selectedItem.id);
            $view.onMouseoverAndSelected(el);
        }
        if (modeAdvancedView) {
            clearSidebar();
        }
        modeSkippedRender = false;
        $view.hideSpinner();
    }

    function actionLogOut() {
        if (timestampLastIdleSaved != $model.getTimestampLastUpdate()) {
            $view.setSpinnerContentSavingAndLoggingOut();
            $view.showSpinner();
            $persist.saveToHost(
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

    function cleanLocalStorage() {
        let entries = Object.entries(localStorage);
        for (let entry of entries) {
            if (VALID_LOCALSTORAGE_KEYS.includes(entry[0]) == false) {
                console.log('Removing '+ entry+' from localStorage');
                localStorage.removeItem(entry[0]);
            }
        }
    }

    function init() {

        //TODO: not if grabbing from server
        if (testLocalStorage() == false) {
            window.location.replace('error-pages/error-local-storage.html');
            return;
        }

        $persist.loadFromHost(
            function success() {
                //restore saved search
                
                let search = localStorage.getItem('search');
                if (search != null && search != 'null') {
                    $view.setSearchText(search);
                }
                else {
                    localStorage.setItem('search', null);
                    $view.setSearchText('');
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
                deselect();
                $model.resetTagCountsCache();
                $model.resetCachedAttributeTags();
                $auto_complete.onChange();
                $auto_complete.hideOptions();
                $view.blurActiveElement();
                $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
                afterRender();
                timestampLastIdleSaved = $model.getTimestampLastUpdate();
                resetInactivityTimer();
                $view.showMainApp();
                $view.setSpinnerContentLoading();
                $view.hideSpinner();
                cleanLocalStorage();
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
        actionUnindent: actionUnindent,
        actionFullUp: actionFullUp,
        actionFullDown: actionFullDown,
		actionDeleteButton: actionDeleteButton,
        actionAddNewItem: actionAddNewItem,
		actionAdd: actionAdd,
        actionMakeLinkGoto: actionMakeLinkGoto,
        actionMakeLinkEmbed: actionMakeLinkEmbed,
        actionCopySubsection: actionCopySubsection,
        actionPasteSubsection: actionPasteSubsection,
        actionRemoveFormatting: actionRemoveFormatting,
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
        actionReplaceText: actionReplaceText,
        actionDeleteTag: actionDeleteTag,
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
        actionVisualizeNumeric: actionVisualizeNumeric,
        actionVisualizeCategorical: actionVisualizeCategorical,
        actionToggleBold: actionToggleBold,
        actionToggleItalic: actionToggleItalic,
        actionToggleExpanded: actionToggleExpanded,
        actionToggleCollapsed: actionToggleCollapsed,
        actionToggleTodo: actionToggleTodo,
        actionToggleDone: actionToggleDone,
        actionToggleHeading: actionToggleHeading,
        actionToggleCode: actionToggleCode,
        actionToggleListBulleted: actionToggleListBulleted,
        actionToggleListNumbered: actionToggleListNumbered,
        actionToggleDateHeadline: actionToggleDateHeadline,
        actionLogOut: actionLogOut,
		focusSubItem: focusSubItem,
		actionDelete: actionDelete,
        onCopy: onCopy,
        onShell: onShell,
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
        onClickMenu: onClickMenu,
        setSidebar: setSidebar,
        clearSidebar: clearSidebar,
        resetInactivityTimer: resetInactivityTimer,
        onMouseMove: onMouseMove,
        actionToggleAdvancedView: actionToggleAdvancedView,
        actionPaste: actionPaste,
        getClipboardText: getClipboardText,
        getValidSearchTags: getValidSearchTags,
        resetAllCache: resetAllCache,
        deleteEverything: deleteEverything,
        maybeResetSearch: maybeResetSearch
    };
})();
