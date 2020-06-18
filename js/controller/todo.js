"use strict";

/* TODO
   - consolidate how saveSuccess and saveFail work across functions
   - all mentions of DOM elements should be handled by $view
   - all mentions of localStorage should be handled by $persist
   - introduce a state machine / pub-sub model?
     - maybe just getters/setters for all mode changes?
   - rename events without intention as on*
*/

let $todo = (function () {

    const CHECK_FOR_UPDATES_FREQ_MS = 1000;
    const CHECK_FOR_IDLE_FREQ_MS = 10;
    const SAVE_AFTER_MS_OF_IDLE = 10;
    const SAVE_AFTER_MS_OF_IDLE_EDIT_MODE = 10000;
    const LOCK_AFTER_MS_OF_IDLE = 3600000; //60 minutes default
    const UPDATE_SIDEBAR_ON_EDIT_ITEM_DATA = false;
    const MAX_SHADOW_ITEMS_ON_MOVE = 25;
    const MIN_FOCUS_TIME_TO_EDIT = 300;
    const ADVANCED_VIEW_BY_DEFAULT = true;
    const INDENT_ACTION_PIXEL_WIDTH = 10;
    const LOCALSTORAGE_MAX_MB = 5;
    const LOCALSTORAGE_WARN_ON_PERCENT = 0.9;
    const FOCUS_TAG = 'tag';
    const FOCUS_SUBITEM = 'subitem';
    const FOCUS_EDIT_BAR = 'edit-bar';
    const FOCUS_NONE = 'none';
    const WARNING_MESSAGE_IF_DISCONNECTED_FROM_SERVER = "Warning: unable to connect to server process to save. Any further updates to MetaList will not be saved until server is made available.";
    const SHOW_EVENTS = false;
    const DELETE_IF_BACKSPACE_AND_EMPTY = false;

    let modeFocus = FOCUS_NONE; //TODO re-explore logic of this; not used much yet
    let modeBackspaceKey = false;
    let modeSkippedRender = false;
    let modeMoreResults = false;
    let modeRedacted = true;
    let modeModal = false;
    let modeAlreadyIdleSaved = false;
    let modeMousedown = false;
    let modeAdvancedView = false;
    let modeEditingSubitem = false;
    let modeEditingSubitemInitialState = null;
    let modeClipboardText = null;
    let modeDisconnected = false;
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
    let saveAttempt = null; //TODO rename this / revisit logic

    function canTakeAction(context) {
        if (context == undefined) {
            context = '';
        }
        if (modeModal) {
            console.warn(context+ ' Blocked by modeModal');
            return false;
        }
        if ($persist.isMutexLocked()) {
            console.warn(context+ ' Blocked by $persist.isMutexLocked()');
            return false;
        }
        if ($unlock.getIsLocked()) {
            console.warn(context + ' blocked by $unlock.getIsLocked()');
            return false;
        }
        return true;
    }

    //TODO: most of this logic should be moved
    function getTagsFromSearch() {
        let currentSearchString = $auto_complete_search.getSearchString();
        let parseResults = $parseSearch.parse(currentSearchString);
        if (parseResults == null) {
            console.warn('invalid parse, will not add new');
            return;
        }

        let arr = []
        for (let result of parseResults) {
            if (result.type == 'tag' && 
                result.negated == undefined && 
                result.valid_exact_tag_matches.length > 0) {

                if (arr.includes(result.valid_exact_tag_matches[0]) == false) {
                    arr.push(result.valid_exact_tag_matches[0])
                }
            }
            //Need this to add new, non-existing tags
            if (result.type == 'tag' && 
                result.negated == undefined && 
                result.partial == true) {

                if (arr.includes(result.text) == false) {
                    arr.push(result.text);
                }
            }
        }
        let tags = arr.join(' ');
        return tags;
    }

    function focusOnSelectedSubItem() {
        $view.focusSubitem(selectedSubitemPath);
        onEnterEditingSubitem();
    }

    function deselect() {
        if (subitemIsSelected()) { //TODO this is hacky
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
        modeFocus = FOCUS_NONE;
        clearSidebar();
    }

    function handleEvent(event, msg) {
        if (SHOW_EVENTS) {
            console.log('$todo.handleEvent() ' + msg);
        }
        if (event != undefined) {
            event.stopPropagation();
            event.preventDefault();
        }
    }

    //TODO: why do we need this extra function instead of just actionAdd() ?
    function actionAddNewItem(event) {
        handleEvent(event, 'actionAddNewItem');
        if (canTakeAction('actionAddNewItem()') == false) {
            return;
        }
        $view.closeAnyOpenMenus();
        deselect();
        actionAdd(event);
    }

    function actionAdd(event) {
        handleEvent(event, 'actionAdd');
        if (canTakeAction('actionAdd()') == false) {
            return;
        }

        $view.closeAnyOpenMenus();

        if (itemIsSelected()) {
            onExitEditingSubitem();
            let subitemIndex = getSubitemIndex();
            let extraIndent = false;
            selectedSubitemPath = $model.addSubItem(selectedItem, subitemIndex, extraIndent);
            render();
        }
        else {
            modeMoreResults = false;
            setModeRedacted(true);
            let tags = getTagsFromSearch();
            selectedItem = $model.addItemFromSearchBar(tags);
            $auto_complete_search.refreshParse();
            $effects.temporary_highlight(selectedItem.id);
            selectedSubitemPath = selectedItem.id+':0';
            $model.fullyIncludeItem(selectedItem);
            render();
        }

        if (itemIsSelected()) {
            let el = $view.getItemElementById(selectedItem.id);
            $view.onMouseoverAndSelected(el);
        }
        //$searchHistory.addActivatedSearch();
    }

    function actionAddSubItem(event) {
        handleEvent(event, 'actionAddSubItem');
        if (canTakeAction('actionAddSubItem()') == false) {
            return;
        }
        onExitEditingSubitem();
        let extraIndent = true;
        selectedSubitemPath = $model.addSubItem(selectedItem, getSubitemIndex(), extraIndent); //TODO: get back new ref to items?
        render();
    }

    function actionDeleteButton(event) {
        handleEvent(event, 'actionDeleteButton');
        if (canTakeAction('actionDeleteButton()') == false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }
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

    //TODO: this should be merged with actionDeleteButton
    function actionDelete(e) {
        handleEvent(event, 'actionDelete');
        if (canTakeAction('actionDelete()') == false) {
            return;
        }
        if (noItemSelected()) {
            return;
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
            if (selectedItem.subitems.length > subitemIndex+1 && 
                selectedItem.subitems[subitemIndex+1].indent == indent) {
                //Use next
                newSubitemIndex = subitemIndex; //it will inherit current subitem index
            }
            else {
                //Find previous
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

        $auto_complete_search.refreshParse();
        //$searchHistory.addActivatedSearch();
        render();
    }

    function shortcutFocusTag() {
        let item = selectedItem;
        let el = $view.getItemTagElementById(item.id);
        //el.focus(); //TODO: should be part of view
        actionFocusEditTag();
        let subitemIndex = getSubitemIndex();
        let tags = item.subitems[subitemIndex].tags;

        //add space at end if not there to trigger suggestions
        if (tags.trim().length > 0) {
            el.value = tags.trim() + ' ';
            actionEditTag();
        }

        modeFocus = FOCUS_TAG;
        placeCaretAtEndInput(el);
    }

    function actionFullUp(event) {
        handleEvent(event, 'actionFullUp');
        if (canTakeAction('actionFullUp()') == false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }
        //TODO: refactor some of this logic into model
        let filteredItems = $model.getFilteredItems();
        let firstFilteredItem = filteredItems[0];
        if (firstFilteredItem.id == selectedItem.id) {
            //at top, do nothing
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
        render();   
    }

    function actionFullDown(event) {
        handleEvent(event, 'actionFullDown');
        if (canTakeAction('actionFullDown()') == false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }
        //TODO: refactor some of this logic into model
        let filteredItems = $model.getFilteredItems();
        let lastFilteredItem = filteredItems[filteredItems.length-1];
        if (lastFilteredItem.id == selectedItem.id) {
            // at bottom, do nothing
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
        render();
    }

    function actionUp(event) {
        handleEvent(event, 'actionUp');
        if (canTakeAction('actionUp()') == false) {
            return;
        }
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
        render();
    }

    function actionDown(event) {
        handleEvent(event, 'actionDown');
        if (canTakeAction('actionDown()') == false) {
            return;
        }
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
        render();
    }

    function actionIndent() {
        handleEvent(event, 'actionIndent');
        if (canTakeAction('actionIndent()') == false) {
            return;
        }
        if (getSubitemIndex() > 0) {
            $model.indentSubitem(selectedItem, selectedSubitemPath);
            render();
        }
    }

    function actionUnindent() {
        handleEvent(event, 'actionUnindent');
        if (canTakeAction('actionUnindent()') == false) {
            return;
        }
        if (getSubitemIndex() > 0) {
            $model.unindentSubitem(selectedItem, selectedSubitemPath);
            render();
        }
    }

    function onClickEditBar(event) {
        //TODO: why are we doing this?
        handleEvent(event, 'onClickEditBar');
    }

    function onClickSubitem(event) {
        handleEvent(event, 'onClickSubitem');
        if (canTakeAction('onClickSubitem()') == false) {
            return;
        }
        $view.closeAnyOpenMenus();
        //Do not want to immediately go into editing mode if not already interacting with window?
        let now = Date.now();
        if (now - timestampFocused < MIN_FOCUS_TIME_TO_EDIT) {
            //skip
            return;
        }
        let path = $view.getSubitemPathFromEventTarget(event.currentTarget); //currentTarget
        recentClickedSubitem = path;
        let doSelect = false;
        if (itemIsSelected()) {
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
            closeSelectedItem();
            let itemId = parseInt(this.dataset.subitemPath.split(':')[0]);
            selectedItem = $model.getItemById(itemId);
            copyOfSelectedItemBeforeEditing = copyJSON(selectedItem);
            $model.expand(selectedItem);
            selectedSubitemPath = recentClickedSubitem;
            mousedItemId = selectedItem.id;
            mousedSubitemId = parseInt(path.split(':')[1]);
            render();
        }
        if (itemIsSelected()) {
            console.log(selectedItem);
        }
        recentClickedSubitem = null;
        //$searchHistory.addActivatedSearch();
        setSidebar();
    }
    
    function onClickItem(event) {
        handleEvent(event, 'onClickItem');
        if (canTakeAction('onClickItem()') == false) {
            return;
        }
        console.log(selectedItem);
        $view.closeAnyOpenMenus();
    }

    function onClickDocument(event) {
        $view.closeAnyOpenMenus();
        if (itemIsSelected()) {
            closeSelectedItem();
            render();
        }
    }

    function closeSelectedItem() {
        if (canTakeAction('closeSelectedItem()') == false) {
            return;
        }

        if (noItemSelected()) {
            return;
        }

        //TODO: this is very slow!!
        if (JSON.stringify(copyOfSelectedItemBeforeEditing) != JSON.stringify(selectedItem)) {
            //Only highlight if an update was made
            $effects.temporary_highlight(selectedItem.id);
        }

        if (copyOfSelectedItemBeforeEditing == null) {
            console.warn('copyOfSelectedItemBeforeEditing == null');
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
    }

    function subitemIsSelected() {
        if (selectedSubitemPath != null) {
            return true;
        }
        return false;
    }

    function noSubitemSelected() {
        if (selectedSubitemPath == null) {
            return true;
        }
        return false;
    }

    function onEnterEditingSubitem() {
        if (canTakeAction('onEnterEditingSubitem()') == false) {
            return;
        }
        if (noItemSelected() || noSubitemSelected()) {
            console.warn('expected subitem and item to be selected');
            return;
        }
        copyOfSelectedItemBeforeEditing = copyJSON(selectedItem);
        modeEditingSubitem = true;
        let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
        modeEditingSubitemInitialState = subitem.data;
    }

    function onExitEditingSubitem() {
        if (canTakeAction('onExitEditingSubitem()') == false) {
            return;
        }
        if (modeEditingSubitem == false) {
            console.warn('Expected we were editing a subitem');
            return;
        }

        let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
        if (subitem != null) {
            let newData = subitem.data;
            if (newData != modeEditingSubitemInitialState) {
                //TODO: hacky to have this done in controller!
                autoformat(selectedItem, selectedSubitemPath, modeEditingSubitemInitialState, newData);
            }
            modeEditingSubitem = false;
            modeEditingSubitemInitialState = null;
        }
    }

    function onEditSubitem(event) {
        handleEvent(event, 'onEditSubitem');
        if (canTakeAction('onEditSubitem()') == false) {
            return;
        }
        if (noItemSelected() || noSubitemSelected()) {
            console.warn('expected we were editing a subitem');
            return;
        }
        let text = event.target.innerHTML;
        let path = $view.getSubitemPathFromEventTarget(event.target);
        $model.updateSubitemData(selectedItem, path, text);
        if (UPDATE_SIDEBAR_ON_EDIT_ITEM_DATA) {
            setSidebar();
        }
    }

    function onFocusSubitem(event) {
        handleEvent(event, 'onFocusSubitem');
        if (canTakeAction('onFocusSubitem()') == false) {
            return;
        }
        modeFocus = FOCUS_SUBITEM;
        $auto_complete_tags.hideOptions();
        if (noItemSelected()) {
            return;
        }

        if (subitemIsSelected() && modeEditingSubitem == true) {
            onExitEditingSubitem();
        }
        $view.onFocusSubitem(event);
        setSidebar();
        onEnterEditingSubitem();
    }

    function actionEditTime(event) {
        handleEvent(event, 'actionEditTime');
        if (canTakeAction('actionEditTime()') == false) {
            return;
        }
        if (noItemSelected()) {
            throw "Unexpected, no selected item...";
        }

        let text = $view.getSelectedTimeAsText();
        let utcDate = new Date(text);
        let timestamp = utcDate.getTime() + utcDate.getTimezoneOffset() * 60 * 1000;
        $model.updateTimestamp(selectedItem, timestamp);
    }

    function actionFocusEditTag() {
        if (canTakeAction('actionFocusEditTag()') == false) {
            return;
        }
        let subitemIndex = getSubitemIndex();
        let tags = selectedItem.subitems[subitemIndex].tags;

        //TODO: refactor into auto-complete-tags.js
        if (tags.trim().length > 0) {
            if (ALWAYS_ADD_SPACE_TO_TAG_SUGGESTION) {
                $view.setTagInput(tags.trim() + ' ');
            }
            else {
                $view.setTagInput(tags.trim());
            }
        }
        else {
            $view.setTagInput('');
        }
        let tagsString = $view.getTagInput();
        modeFocus = FOCUS_TAG;
        $auto_complete_tags.onChange(selectedItem, selectedSubitemPath, tagsString);
        $auto_complete_tags.showOptions();
        $sidebar.updateSidebar(selectedItem, subitemIndex, true);
    }
    
    function actionEditTag() {
        if (canTakeAction('actionEditTag()') == false) {
            return;
        }
        if (noItemSelected()) {
            throw "Unexpected, no selected item...";
        }
        //TODO refactor into view?
        let tagsString = $view.getItemTagElementById(selectedItem.id).value;
        $model.updateSubTag(selectedItem, selectedSubitemPath, tagsString);
        $auto_complete_tags.onChange(selectedItem, selectedSubitemPath, tagsString);
        $auto_complete_tags.showOptions();
        $sidebar.updateSidebar(selectedItem, getSubitemIndex(), true);
    }

    function actionEditSearch() {
        if (canTakeAction('actionEditSearch()') == false) {
            return;
        }
        //TODO refactor into view?
        let text = $auto_complete_search.getSearchString();

        localStorage.setItem('search', text); //TODO move to persist
        modeMoreResults = false;
        setModeRedacted(true);
        if (modeBackspaceKey == false) {
            $auto_complete_search.onChange();
            render();
            $view.scrollToTop();
        }
        else {
            modeSkippedRender = true;
        }
    }

    function maybeResetSearch() {
        let currentSearchString = $auto_complete_search.getSearchString();
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
        }
        $auto_complete_search.onChange();
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

        if (itemIsSelected() && mousedItemId == selectedItem.id) {
            $view.onMouseoverAndSelected(e.currentTarget);
        }
        else if (noItemSelected()) {
            $view.onMouseover(e.currentTarget);
            $auto_complete_tags.hideOptions();
        }

        if (itemOnClick != null && itemOnClick.id != mousedItemId) {
            $view.removeAllRanges();
        }
        $auto_complete_search.hideOptions();
        setSidebar();
    }

    function actionMouseoff(e) {
        $view.onMouseoff();
        mousedItemId = null;
        mousedSubitemId = null;
    }

    function actionMousedown(e) {
        if (canTakeAction('actionMousedown()') == false) {
            return;
        }
        itemOnClick = $model.getItemById(mousedItemId);
        subitemIdOnClick = mousedSubitemId;
        xOnClick = e.clientX;
        modeMousedown = true;
        if (itemOnClick != null) {
            //don't add to search unless an actual item is clicked
            //$searchHistory.addActivatedSearch();
            if (noItemSelected()) {
                $view.setCursor("grab");
            }
            else {
                if (selectedItem.id != itemOnClick.id) {
                    $view.setCursor("grab");
                }
            }
        }
    }

    function actionMouseup(e) {
        if (canTakeAction('actionMouseup()') == false) {
            return;
        }

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

        if (itemOnRelease != null && 
            itemOnClick.id == itemOnRelease.id && 
            noItemSelected()) {

            let newpath = null;

            if (subitemIdOnClick != subitemIdOnRelease) {
                newpath = $model.dragSubitem(itemOnClick, subitemIdOnClick, subitemIdOnRelease);
            }
            else if (xOnRelease < xOnClick - INDENT_ACTION_PIXEL_WIDTH) {
                newpath = $model.unindentSubitem(itemOnClick, itemOnClick.id+':'+subitemIdOnClick)
            }
            else if (xOnRelease > xOnClick + INDENT_ACTION_PIXEL_WIDTH) {
                newpath = $model.indentSubitem(itemOnClick, itemOnClick.id+':'+subitemIdOnClick)
            }

            if (newpath != null) {
                $effects.emphasizeSubitemAndChildren(itemOnClick, newpath);
                deselect();
                render();   
                return;
            }
        }

        //TODO: This is spaghetti
        if (itemOnRelease != null && 
            itemIsSelected() && 
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
            //$searchHistory.addActivatedSearch();
            render();
        }

        //TODO: deselect() here?
        itemOnClick = null;
        subitemIdOnClick = null;
        itemOnRelease = null;
        subitemIdOnRelease = null;
        xOnClick = null;
        xOnRelease = null;
    }

    function onBackspaceUp() {
        if (canTakeAction('onBackspaceUp()') == false) {
            return;
        }
    	modeBackspaceKey = false;
        if (modeSkippedRender == true) {
            actionEditSearch();
        }
    }

    function actionDeleteIfEmpty(e) {

        if (canTakeAction('actionDeleteIfEmpty()') == false) {
            return;
        }

        if (noItemSelected()) {
            return;
        }

        let index = getSubitemIndex();

        if (selectedItem.subitems[index].data != '') {
            return;
        }

        if (selectedItem.subitems.length > index+1 &&
            selectedItem.subitems[index].indent < selectedItem.subitems[index+1].indent) {
            alert('Has children, cannot delete.');
            return;
        }

        actionDelete(e);
    }

    function onBackspaceDown(e) {
        if (canTakeAction('onBackspaceDown()') == false) {
            return;
        }
    	modeBackspaceKey = true;

        if (DELETE_IF_BACKSPACE_AND_EMPTY) {
            actionDeleteIfEmpty(e);
        }
    }

    function checkForIdleWhileEditing() {
        if ($persist.isMutexLocked()) {
            return false;
        }
        if (itemIsSelected() == false) {
            return;
        }
        let now = Date.now();
        let elapsed = now - timestampLastActive;
        if (elapsed > SAVE_AFTER_MS_OF_IDLE_EDIT_MODE) {
            if (timestampLastIdleSaved == $model.getTimestampLastUpdate()) {
                //console.log('already idle saved at '+timestampLastIdleSaved+', do nothing');
            }
            else {
                $view.setCursor("progress");
                timestampLastIdleSaved = $model.getTimestampLastUpdate();
                $persist.saveToHostOnIdle(
                    saveSuccessAfterIdle, 
                    saveFail
                );
            } 
        }
    }

    function checkForIdle() {
        if ($persist.isMutexLocked()) {
            return false;
        }
        if (itemIsSelected() == true) {
            return;
        }
        let now = Date.now();
        let elapsed = now - timestampLastActive;
        if (elapsed > SAVE_AFTER_MS_OF_IDLE) {
            if (timestampLastIdleSaved == $model.getTimestampLastUpdate()) {
                //console.log('already idle saved at '+timestampLastIdleSaved+', do nothing');
            }
            else {
                $view.setCursor("progress");
                timestampLastIdleSaved = $model.getTimestampLastUpdate();
                $persist.saveToHostOnIdle(
                    saveSuccessAfterIdle, 
                    saveFail
                );
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
    }

    //TODO refactor this into modes
    function onEnter(e) {

        if ($unlock.getIsLocked()) {
            //console.warn('Pressed enter in locked state - currently not working');
            //TODO: clean this up!
            $('#ok-unlock').click();
            return;
        }

        if (canTakeAction('onEnter()') == false) {
            return;
        }

        //TODO: this sometimes does not add a new item
    	if ($auto_complete_search.getModeHidden() == false) {
            let selected = $auto_complete_search.selectSuggestion();
            actionEditSearch();
            handleEvent(e, 'onEnter');
            return;
        }
        
        if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.selectSuggestion(selectedItem, selectedSubitemPath);

            let editing = false;
            if (itemIsSelected()) {
                editing = true;
            }
            $sidebar.updateSidebar(selectedItem, getSubitemIndex(), editing);
            handleEvent(e, 'onEnter');
            return;
        }
        
        if (noItemSelected()) {
            actionAdd(e);
            handleEvent(e, 'onEnter');
            return;
        }
        
        if (NEW_SUBITEM_ON_ENTER) {
            actionAdd(e);
            handleEvent(e, 'onEnter');
            return;
        }
    }

    function onCtrlBackspace(e) {

        modeBackspaceKey = false;

        if ($unlock.getIsLocked()) {
            return;
        }

        if (canTakeAction('onCtrlBackspace()') == false) {
            return;
        }

        if (noItemSelected()) {

            $view.setSearchText('');
            actionJumpToSearchBar(e);
            handleEvent(e, 'onTab');
            return;
        }
    }

    function onTab(e) {

        if ($unlock.getIsLocked()) {
            return;
        }

        if (canTakeAction('onTab()') == false) {
            return;
        }

        ////////////////////////////////////////////////
        //Tab teleport
        if (noItemSelected()) {
            actionJumpToSearchBar(e);
            handleEvent(e, 'onTab');
            return;
        }

        //TODO: keep track of caret position and move back to that
        if (modeFocus == FOCUS_TAG && subitemIsSelected()) {
            console.log('focusOnSelectedSubItem');
            focusOnSelectedSubItem();
        }
        else {
            console.log('shortcutFocusTag');
            shortcutFocusTag();
        }
        
        let editing = false;
        if (itemIsSelected()) { //TODO: won't this always be true?
            editing = true;
        }
        $sidebar.updateSidebar(selectedItem, getSubitemIndex(), editing);
        ////////////////////////////////////////////////

        handleEvent(e, 'onTab'); //TODO: do we need this one?
        return;
    }

    function onClickTagSuggestion() {
        if (canTakeAction('onClickTagSuggestion()') == false) {
            return;
        }
    	$auto_complete_tags.selectSuggestion(selectedItem, selectedSubitemPath);
        let tagsString = selectedItem.subitems[getSubitemIndex()].tags.trim() + ' ';
        $auto_complete_tags.onChange(selectedItem, selectedSubitemPath, tagsString);
    }

    function onSearchClick(e) {
        handleEvent(e, 'onSearchClick');
        if (canTakeAction('onSearchClick()') == false) {
            return;
        }
        $auto_complete_search.showOptions();
        if (itemIsSelected()) {
            closeSelectedItem();
            render();
        }
    }

    function onSearchFocusOut(e) {
        handleEvent(e, 'onSearchFocusOut');
        if (canTakeAction('onSearchFocusOut()') == false) {
            return;
        }
        $auto_complete_search.hideOptions();
        $auto_complete_tags.hideOptions();
    }

    function onEscape() {
        if (canTakeAction('onEscape()') == false) {
            return;
        }
        if ($auto_complete_search.getModeHidden() == false) {
            $auto_complete_search.hideOptions();
        }
        if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.hideOptions();
        }
        if (itemIsSelected()) {
            closeSelectedItem();
            render();
        }
    }

    function actionMoreResults() {
        if (canTakeAction('actionMoreResults()') == false) {
            return;
        }
        modeMoreResults = true;
        closeSelectedItem();
        render();
    }

    function actionExpandRedacted(e) {
        if (canTakeAction('actionExpandRedacted()') == false) {
            return;
        }
        handleEvent(e);
        setModeRedacted(false);
        render();
    }

    function setModeRedacted(value) {
        if (value != modeRedacted) {
            $view.resetCache();
            modeRedacted = value;
        }
    }

    function itemIsSelected() {
        if (selectedItem != null) {
            return true;
        }
        return false;
    }

    function noItemSelected() {
        if (selectedItem == null) {
            return true;
        }
        return false;
    }

    function actionSave(e) {
        handleEvent(e, 'actionSave');
        if (canTakeAction('actionSave()') == false) {
            return;
        }
        if ($unlock.getIsLocked()) {
            alert('Cannot save while locked');
            return;
        }
        genericModal($backup_dlg.open_dialog);
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
        handleEvent(e, 'onShell');
        if (canTakeAction('onShell()') == false) {
            return;
        }
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

    function onOpenFile(e) {
        handleEvent(e, 'onOpenFile');
        if (canTakeAction('onOpenFile()') == false) {
            return;
        }
        let text = e.currentTarget.innerHTML;
        text = $format.toText(text);

        function onFnSuccess(message) {
            console.log('-----------------------------');
            console.log(message)
            console.log('-----------------------------');
        }

        function onFnFailure() {
            alert('FAILED');
        }

        let obj = {
            filePath: text
        }

        $.ajax({
            url: '/open-file',
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
        handleEvent(e, 'onCopy');
        if (canTakeAction('onCopy()') == false) {
            return;
        }
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

        render();
    }

    function actionGotoSearch(e) {
        if (canTakeAction('actionGotoSearch()') == false) {
            return;
        }
        let text = e.target.innerText;
        $view.setSearchText(text);
        actionEditSearch();
        handleEvent(e, 'actionGotoSearch');
    }

    function actionJumpToSearchBar(e) {
        if (canTakeAction('actionJumpToSearchBar()') == false) {
            return;
        }
        //actionEditSearch();
        let el = $('#search-input'); //TODO move to view
        placeCaretAtEndInput(el);
        $auto_complete_search.focus();
        actionEditSearch();

        //handleEvent(e, 'actionJumpToSearchBar');
    }

    function onCheck(e) {
        handleEvent(e, 'onCheck');
        if (canTakeAction('onCheck()') == false) {
            return;
        }
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = parseInt(path.split(':')[0]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace(META_TODO, META_DONE); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        render();
    }

    function onUncheck(e) {
        handleEvent(e, 'onUncheck');
        if (canTakeAction('onUncheck()') == false) {
            return;
        }
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = parseInt(path.split(':')[0]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace(META_DONE, META_TODO); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        render();
    }

    function onClickSelectSearchSuggestion(e) {
        handleEvent(e, 'onClickSelectSearchSuggestion');
        if (canTakeAction('onClickSelectSearchSuggestion()') == false) {
            return;
        }
        $auto_complete_search.selectSuggestion();
        actionEditSearch();
    }

    //TODO: what does this do again?
    function navigate(newSubitemPath) {
        if (itemIsSelected() && newSubitemPath != selectedSubitemPath) {
            selectedSubitemPath = newSubitemPath;
            render();
        }
    }

    function onUpArrow(e) {
        
        if (canTakeAction('onUpArrow()') == false) {
            return;
        }

        if ($auto_complete_search.getModeHidden() == false) {
            $auto_complete_search.arrowUp();
            handleEvent(e, 'onUpArrow');
            return;
        }
        
        if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.arrowUp();
            handleEvent(e, 'onUpArrow');
            return;
        }
        
        if (itemIsSelected()) {
            let pos = $view.getCaretPositionOfSelectedItem();
            if (pos.location == 0) {
                navigate($model.getPrevSubitemPath(selectedItem, selectedSubitemPath));
                let div = $view.getSubitemElementByPath(selectedSubitemPath);
                placeCaretAtStartContentEditable(div);
                handleEvent(e, 'onUpArrow');
            }
            else {
                // let div = $view.getSubitemElementByPath(selectedSubitemPath);
                // placeCaretAtStartContentEditable(div);
            }
            return;
        }
    }

    function onDownArrow(e) {
        
        if (canTakeAction('onDownArrow()') == false) {
            return;
        }
        if ($auto_complete_search.getModeHidden() == false) {
            $auto_complete_search.arrowDown();
            handleEvent(e, 'onDownArrow');
            return;
        }
        
        if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.arrowDown();
            handleEvent(e, 'onDownArrow');
            return;
        }
        
        if (itemIsSelected()) {
            let pos = $view.getCaretPositionOfSelectedItem();
            console.log('pos = ' + pos.location);
            if (pos.location == pos.textLength) {
                navigate($model.getNextSubitemPath(selectedItem, selectedSubitemPath));
                handleEvent(e, 'onDownArrow');
            }
            else {
                // let div = $view.getSubitemElementByPath(selectedSubitemPath);
                // placeCaretAtEndInput(div);
            }
            return;
        }
    }

    function updateSelectedSearchSuggestion(id) {
        if (canTakeAction('updateSelectedSearchSuggestion()') == false) {
            return;
        }
        if (id == undefined) {
            $auto_complete_search.updateSelectedSearchSuggestion();
        }
        else {
            $auto_complete_search.updateSelectedSearchSuggestion(id);
        }
    }

    function updateSelectedTagSuggestion(id) {
        if (canTakeAction('updateSelectedTagSuggestion()') == false) {
            return;
        }
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

    function onClickMenu() {
        if (canTakeAction('onClickMenu()') == false) {
            return;
        }
        //TODO: this pattern exists in a lot of places
        if (itemIsSelected()) {
            closeSelectedItem();
            render();
        }
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

    function actionGenerateRandomPassword() {
        genericModal($random_password_generator_dlg.open_dialog);
    }

    function actionPasswordProtectionSettings() {
        if (canTakeAction('actionPasswordProtectionSettings()') == false) {
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
        $persist.deleteEverything(
            function success() {
                modeForceReload = true;
                modeAlertSafeToExit = true;
                localStorage.removeItem('search');
                location.reload();
            }, 
            function fail() {
                alert('Failed to delete everything.');
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
        handleEvent(e, 'actionMakeLinkGoto');
        if (canTakeAction('actionMakeLinkGoto()') == false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }
        subsectionClipboard = [{data: "@id="+selectedItem.id, tags: "@goto", indent:0}];
    }

    function actionMakeLinkEmbed(e) {
        handleEvent(e, 'actionMakeLinkEmbed');
        if (canTakeAction('actionMakeLinkEmbed()') == false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }
        subsectionClipboard = [{data: "@id="+selectedItem.id, tags: "@embed", indent:0}];
    }

    function getSubitemIndex() {
        if (noSubitemSelected()) {
            console.warn('why is no subitem selected here?');
            return 0;
        }
        return parseInt(selectedSubitemPath.split(':')[1]);
    }

    function getSelectedPath() {
        if (selectedItem == null) {
            throw "No item selected";
        }
        let subitemIndex = getSubitemIndex();
        let path = selectedItem.id+':'+selectedSubitemPath;
        return path;
    }

    function actionCopySubsection(e) {
        handleEvent(e, 'actionCopySubsection');
        if (canTakeAction('actionCopySubsection()') == false) {
            return;
        }
        if (noItemSelected()) {
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
        console.log('DEBUG: get item as text');
        console.log(text);
        let _onCopy = function(e) {
            e.clipboardData.setData('text/plain', text);
            e.preventDefault();
        };
        document.addEventListener('copy', _onCopy);
        document.execCommand('copy');
        document.removeEventListener('copy', _onCopy);
    }

    function actionPasteSubsection(e) {
        handleEvent(e, 'actionPasteSubsection');
        if (canTakeAction('actionPasteSubsection()') == false) {
            return;
        }
        if (subsectionClipboard == null) {
            alert("There is nothing in the clipboard to paste.");
            return;
        }
        if (noItemSelected()) {
            let tags = getTagsFromSearch();
            selectedItem = $model.addItemFromSearchBar(tags);
            selectedSubitemPath = selectedItem.id+':0';
            $model.fullyIncludeItem(selectedItem);
        }

        let indexInto = $model.pasteSubsection(selectedItem, getSubitemIndex(), subsectionClipboard);
        
        for (let i = 0; i < subsectionClipboard.length; i++) {
            let path = selectedItem.id+':'+(indexInto+i);
            $effects.emphasizeSubitem(path);
        }
        //TODO: this is yucky, we should unify notation
        if (indexInto > 0) {
            selectedSubitemPath = selectedItem.id+':'+indexInto;
        }
        render();
    }

    function actionRemoveFormatting(e) {
        handleEvent(e, 'actionRemoveFormatting');
        if (canTakeAction('actionRemoveFormatting()') == false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }
        let subitemIndex = getSubitemIndex();
        $model.removeSubitemFormatting(selectedItem, subitemIndex);
        render();
    }

    function actionSplit(e) {

        handleEvent(e, 'actionSplit');

        

        if (canTakeAction('actionSplit()') == false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }

        let subitemIndex = getSubitemIndex();
        $model.split(selectedItem, subitemIndex);
        render();
    }

    function actionCollapseAllView() {

        if (canTakeAction('actionCollapseAllView()') == false) {
            return;
        }
        const items = $model.getUnsortedItems();
        let toCollapse = [];
        for (let item of items) {
            if (item.subitems[0]._include == 1 &&
                item.subitems.length > 1 &&
                item.collapse == 0) {
                toCollapse.push(item);
            }
        }
        $model.collapseMany(toCollapse);
        render();
    }

    function actionExpandAllView() {

        if (canTakeAction('actionExpandAllView()') == false) {
            return;
        }
        const items = $model.getUnsortedItems();
        let toExpand = [];
        for (let item of items) {
            if (item.subitems[0]._include == 1 &&
                item.subitems.length > 1 &&
                item.collapse == 1) {
                toExpand.push(item);
            }
        }
        $model.expandMany(toExpand);
        render();
    }

    function actionCollapseItem(e) {
        handleEvent(e, 'actionCollapseItem');
        if (canTakeAction('actionCollapseItem()') == false) {
            return;
        }
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = path.split(':')[0];
        let subitemIndex = path.split(':')[1];
        let item = $model.getItemById(id);
        $model.collapse(item, subitemIndex);
        render();
    }
    
    function actionExpandItem(e) {
        handleEvent(e, 'actionExpandItem');
        if (canTakeAction('actionExpandItem()') == false) {
            return;
        }
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = path.split(':')[0];
        let subitemIndex = path.split(':')[1];
        let item = $model.getItemById(id);
        $model.expand(item, subitemIndex);
        render();
    }

    function actionRenameTag() {
        genericModal($dlg.renameTag);
    }

    function actionReplaceText() {
        genericModal($dlg.replaceText);
    }

    function actionDeleteTag(e) {
        genericModal($dlg.deleteTag);
    }

    //TODO: move this into persist function
    function restoreFromFile(obj) {
        if (obj.encryption.encrypted == false) {
            $view.showSpinner();
            try {
                let newItems = $schema.checkSchemaUpdate(obj.data, obj.data_schema_version);
                $model.setItems(newItems);
                $persist.setItemsCache(newItems);
                $protection.setPassword(null);
                successfulInit();
                $persist.saveToHostFull(
                    saveSuccessAfterRestoreFromFile, 
                    saveFail
                );
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
                render();
                $view.scrollToTop();
            }
            modeModal = true;
            $dlg.restoreFromFile(obj, after);
        }
    }

    function genericModal(fn) {

        if (canTakeAction('genericModal()') == false) {
            return;
        }
        $view.closeAnyOpenMenus();
        deselect();
        function after() {
            modeModal = false;
            render();
        }
        modeModal = true;
        fn(after);
    }

    function actionRemoveTagCurrentView() {
        genericModal($dlg.removeTagFromCurrentView);
    }

    function actionDeleteEverything() {
        genericModal($dlg.deleteEverything);
    }

    function actionAddMetaRule() {
        genericModal($dlg.addMetaRule);
    }

    function actionAddTagCurrentView() {
        genericModal($dlg.addTagToCurrentView);
    }

    function actionVisualizeCategorical() {
        genericModal($visualize_categorical.open_dialog);
    }

    function actionVisualizeNumeric() {
        genericModal($visualize_numeric.open_dialog);
    }

    function setSidebar() {
        if (modeAdvancedView == false) {
            $sidebar.clearSidebar();
            return;
        }

        if (itemIsSelected()) {
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

    function onMouseMoveOverSubitem(e) {
        if (canTakeAction('onMouseMoveOverSubitem') == false) {
            return;
        }
        if (modeMousedown) {

            // NOTE: this logic is for drag-and-drop between items, but may not be used in future

            //$view.setCursor('grabbing');

            if (itemOnClick.id == mousedItemId && subitemIdOnClick == mousedSubitemId) {
                //same subitem, do nothing
                return;
            }

            let y = e.pageY - $(e.currentTarget).offset().top;
            let height = e.currentTarget.offsetHeight;
            //console.log('DEBUG2 mouse move+down over subitem y = ' + y + ' / height = ' + height);
            if (y < height/2) {
                if (itemOnClick.id == mousedItemId) {
                    //console.log('DEBUG2 drag drop UPPER HALF, same item');
                    //$view.setCursor('n-resize');
                }
                else {
                    //console.log('DEBUG2 drag drop UPPER HALF, different item');
                    //$view.setCursor('n-resize');
                }
                
            }
            else {
                if (itemOnClick.id == mousedItemId) {
                    //console.log('DEBUG2 drag drop LOWER HALF, same item');
                    //$view.setCursor('s-resize');
                }
                else {
                    //console.log('DEBUG2 drag drop LOWER HALF, different item');
                    //$view.setCursor('s-resize');
                }
            }
        }
    }

    function onMouseOverSubitem(e) {
        setSidebar();
    }

    function onMouseOutItems() {
        clearSidebar();
    }

    function clearSidebar() {
        if (itemIsSelected()) {
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

    function setAdvancedView(value) {
        if (value == true) {
            modeAdvancedView = true;
            $view.showSidePanel();
        }
        else {
            modeAdvancedView = false;
            $view.hideSidePanel();
        }
        localStorage.setItem('modeAdvancedView', modeAdvancedView+'');
    }

    function actionToggleAdvancedView() {
        if (canTakeAction('actionToggleAdvancedView()') == false) {
            return;
        }
        if (modeAdvancedView) {
            setAdvancedView(false);
        }
        else {
            setAdvancedView(true);
        }
    }

    function saveFail() {
        console.warn('Failed saving file during idle');
        //TODO: this is safer for now because it introduces bugs otherwise
        $view.gotoErrorPageDisconnected();
    }

    function saveSuccessAfterLogout() {
        location.reload();
    }

    function saveSuccessAfterIdle() {
        $view.setCursor("auto");
        if (modeAlertSafeToExit) {
            alert('Work has been saved.\nIt is now safe to exit.');
            modeAlertSafeToExit = false;
        }
    }

    function saveSuccessAfterRestoreFromFile() {
        $unlock.exitLock();
        maybeResetSearch();
        render();
        $view.scrollToTop();
    }

    function actionPaste(e, pastedTextData, pastedHTMLData) {

        if (subitemIsSelected()) {
            //only do this when nothing selected!
            return;
        }
        //TODO: yucky that I have to test this first

        handleEvent(e, 'actionPaste');

        if (canTakeAction('actionPaste()') == false) {
            return;
        }

        let toPaste = null;
        if (pastedHTMLData == null || pastedHTMLData == '') {
            if (pastedTextData == null || pastedTextData == '') {
                //nothing to paste
                return;
            }
            //TODO: this should probably be somewhere else
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
        render();
        $view.scrollToTop();
    }

    function onShiftEnter(event) {

        /*
        This function allows adding additional newlines inside a subitem.
        */

        if (canTakeAction('onShiftEnter()') == false) {
            handleEvent(event, 'onShiftEnter');
            return;
        }

        if (itemIsSelected() == false) {
            handleEvent(event, 'onShiftEnter');
            return;
        }
        
    }

    function genericToggleFormatTag(tag, event) {

        handleEvent(event, 'genericToggleFormatTag');
        if (canTakeAction('genericToggleFormatTag()') == false) {
            return;
        }
        let subitem = $model.getSubitem(selectedItem, selectedSubitemPath);
        if (subitem._implied_tags.includes(tag)) {
            return;
        }
        $model.toggleFormatTag(selectedItem, selectedSubitemPath, tag);
        $view.setTagInput(subitem.tags);
        $sidebar.updateSidebar(selectedItem, getSubitemIndex(), true);
        $auto_complete_tags.hideOptions();
        modeFocus = FOCUS_EDIT_BAR;
    }

    function actionToggleBold(e) {
        genericToggleFormatTag(META_BOLD, e);
    }

    function actionToggleItalic(e) {
        genericToggleFormatTag(META_ITALIC, e);
    }

    function actionToggleHeading(e) {
        genericToggleFormatTag(META_HEADING, e);
    }

    function actionToggleTodo(e) {
        genericToggleFormatTag(META_TODO, e);
    }

    function actionToggleDone(e) {
        genericToggleFormatTag(META_DONE, e);
    }

    function actionToggleCode(e) {
        genericToggleFormatTag(META_MONOSPACE_DARK, e);
    }

    function actionToggleListBulleted(e) {
        genericToggleFormatTag(META_LIST_BULLETED, e);
    }

    function actionToggleListNumbered(e) {
        genericToggleFormatTag(META_LIST_NUMBERED, e);
    }

    function actionToggleDateHeadline(e) {
        genericToggleFormatTag(META_DATE_HEADLINE, e);
    }

    function onDblClickSubitem(e) {
        handleEvent(e, 'onDblClickSubitem');
        if (canTakeAction('onDblClickSubitem()') == false) {
            return;
        }
        onEscape();
    }

    function getClipboardText() {
        return modeClipboardText;
    }

    function render() {
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults, modeRedacted);
        if (subitemIsSelected()) {
            focusOnSelectedSubItem();
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

        if (canTakeAction('actionLogOut()') == false) {
            return;
        }

        if (timestampLastIdleSaved != $model.getTimestampLastUpdate()) {
            $view.setSpinnerContentSavingAndLoggingOut();
            $view.showSpinner();
            $persist.saveToHostFull(
                saveSuccessAfterLogout,
                saveFail
            );
        }
        else {
            location.reload();
        }
    }

    function actionExportViewAsText() {
        let tot = 0;
        let result = '';
        for (let item of $model.getFilteredItems()) {
            tot += 1;
            for (let subitem of item.subitems) {
                if (subitem._include === -1) {
                    continue;
                }
                let prefix = '';
                for (let i = 0; i < subitem.indent; i++) {
                    prefix += '\t';
                }
                let text = $format.toText(subitem.data);
                let parts = text.split('\n');
                for (let part of parts) {
                    result += prefix + part + '\n';
                }
            }
            result += '\n';
        }
        var s = $view.getSearchText().replace(/"/g,'').replace(/@/g,'').trim();
        var filename = s.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        if (filename !== '') {
            $persist.fileSaveText(result, `MetaList.${filename}.txt`);
        }
        else {
            $persist.fileSaveText(result, `MetaList.txt`);
        }
    }

    function actionDownloadLatest() {
        const url = 'https://github.com/evolvingstuff/MetaList/archive/master.zip';
        window.open(url,'_blank');
    }

    function successfulInit() {
        $model.testConsistency();
        deselect();
        $menu.init();
        $auto_complete_search.hideOptions();
        $model.resetTagCountsCache();
        $model.resetCachedAttributeTags();
        $view.blurActiveElement();
        render();
        timestampLastIdleSaved = $model.getTimestampLastUpdate();
        resetInactivityTimer();
        $view.showMainApp();
        $view.setSpinnerContentLoading();
        $view.hideSpinner();

        //warn if running out of space in localStorage
        if (getHostingContext() == 'localStorage') {
            let tot = getLocalStorageSpaceInMB();
            if (tot > LOCALSTORAGE_MAX_MB * LOCALSTORAGE_WARN_ON_PERCENT) {
                alert('Warning: currently using '+tot.toFixed(2)+'MB of localStorage memory, out of a max of '+LOCALSTORAGE_MAX_MB+'MB.\nSuggest switching to MetaList server version.');
            }
        }
    }



    function init() {

        //TODO: not if grabbing from server
        if (testLocalStorage() == false) {
            $view.gotoErrorPage();
            return;
        }

        let search = localStorage.getItem('search');
        if (search != null && search != 'null') {
            $view.setSearchText(search);
        }
        else {
            localStorage.removeItem('search');
            $view.setSearchText('');
        }

        if (localStorage.getItem('modeAdvancedView') != null) {
            if (localStorage.getItem('modeAdvancedView') == 'true') {
                setAdvancedView(true);
            }
            else {
                setAdvancedView(false);
            }
        }
        else {
            if (ADVANCED_VIEW_BY_DEFAULT) {
                setAdvancedView(true);
            }
            else {
                setAdvancedView(false);
            }
        }

        //These are first time events...
        $events.registerEvents();

        setInterval(checkForIdle, CHECK_FOR_IDLE_FREQ_MS);
        setInterval(checkForIdleWhileEditing, CHECK_FOR_IDLE_FREQ_MS);

        $persist.loadFromHost(
            successfulInit, 
            function failure(){
                alert('Failed to load');
            });
    }

    return {
        init: init,
        restoreFromFile: restoreFromFile,
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
        actionSplit: actionSplit,
		actionEditTag: actionEditTag,
		actionEditTime: actionEditTime,
		actionEditSearch: actionEditSearch,
        actionExportViewAsText: actionExportViewAsText,
		actionAddSubItem: actionAddSubItem,
		actionMouseover: actionMouseover,
		actionMouseoff: actionMouseoff,
		actionMousedown: actionMousedown,
		actionMouseup: actionMouseup,
		actionFocusEditTag: actionFocusEditTag,
        actionMoreResults: actionMoreResults,
        actionExpandRedacted: actionExpandRedacted,
        actionSave: actionSave,
        actionRenameTag: actionRenameTag,
        actionReplaceText: actionReplaceText,
        actionDeleteTag: actionDeleteTag,
        actionAddTagCurrentView: actionAddTagCurrentView,
        actionRemoveTagCurrentView: actionRemoveTagCurrentView,
        actionDeleteEverything: actionDeleteEverything,
        actionAddMetaRule: actionAddMetaRule,
        actionGotoSearch: actionGotoSearch,
        actionPasswordProtectionSettings: actionPasswordProtectionSettings,
        actionGenerateRandomPassword: actionGenerateRandomPassword,
        actionCollapseAllView: actionCollapseAllView,
        actionExpandAllView: actionExpandAllView,
        actionCollapseItem: actionCollapseItem,
        actionExpandItem: actionExpandItem,
        actionVisualizeNumeric: actionVisualizeNumeric,
        actionVisualizeCategorical: actionVisualizeCategorical,
        actionToggleBold: actionToggleBold,
        actionToggleItalic: actionToggleItalic,
        actionToggleTodo: actionToggleTodo,
        actionToggleDone: actionToggleDone,
        actionToggleHeading: actionToggleHeading,
        actionToggleCode: actionToggleCode,
        actionToggleListBulleted: actionToggleListBulleted,
        actionToggleListNumbered: actionToggleListNumbered,
        actionToggleDateHeadline: actionToggleDateHeadline,
        actionLogOut: actionLogOut,
		actionDelete: actionDelete,
        actionDownloadLatest: actionDownloadLatest,
        onCopy: onCopy,
        onShell: onShell,
        onOpenFile: onOpenFile,
        onEscape: onEscape,
		onBackspaceUp: onBackspaceUp,
		onBackspaceDown: onBackspaceDown,
		onWindowFocus: onWindowFocus,
		onEnter: onEnter,
        onTab: onTab,
		onClickTagSuggestion: onClickTagSuggestion,
        onCheck: onCheck,
        onUncheck: onUncheck,
        onSearchClick: onSearchClick,
        onSearchFocusOut: onSearchFocusOut,
        onClickSelectSearchSuggestion: onClickSelectSearchSuggestion,
        onShiftEnter: onShiftEnter,
        onUpArrow: onUpArrow,
        onDownArrow: onDownArrow,
        onCtrlBackspace: onCtrlBackspace,
        onMouseOverSubitem: onMouseOverSubitem,
        onMouseOutItems: onMouseOutItems,
        onMouseMoveOverSubitem: onMouseMoveOverSubitem,
        itemIsSelected: itemIsSelected,
        updateSelectedSearchSuggestion: updateSelectedSearchSuggestion,
        updateSelectedTagSuggestion: updateSelectedTagSuggestion,
        setMoreResults: setMoreResults,
        onClickMenu: onClickMenu,
        setSidebar: setSidebar,
        clearSidebar: clearSidebar,
        resetInactivityTimer: resetInactivityTimer,
        actionToggleAdvancedView: actionToggleAdvancedView,
        actionPaste: actionPaste,
        getClipboardText: getClipboardText,
        getValidSearchTags: getValidSearchTags,
        resetAllCache: resetAllCache,
        deleteEverything: deleteEverything,
        maybeResetSearch: maybeResetSearch,
        handleEvent: handleEvent,
        successfulInit: successfulInit,

    };
})();
