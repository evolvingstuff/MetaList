"use strict";

/* TODO
   - all mentions of DOM elements should be handled by $view
   - all mentions of localStorage should be handled by $persist
   - events should be handled in a more consistent manner
     - review stopPropagation vs preventDefault
   - early exit conditions, like if (modeModal) should be more systematic
   - introduce a state machine / pub-sub model?
     - maybe just getters/setters for all mode changes?
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

    let modeFocus = FOCUS_NONE; //TODO re-explore logic of this; not used much yet
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

    //TODO: most of this logic should be moved
    function getTagsFromSearch() {
        let currentSearchString = $auto_complete.getSearchString();
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

    //TODO: why do we need this extra function instead of just actionAdd() ?
    function actionAddNewItem(event) {
        $view.closeAnyOpenMenus();
        deselect();
        actionAdd(event);
    }

    function actionAdd(event) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionAdd()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionAdd()');
            return;
        }

        $view.closeAnyOpenMenus();

        if (event != undefined) {
            event.stopPropagation();
            event.preventDefault();
        }

        if (itemIsSelected()) {
            onExitEditingSubitem();
            let subitemIndex = getSubitemIndex();
            let extraIndent = false;
            selectedSubitemPath = $model.addSubItem(selectedItem, subitemIndex, extraIndent);
            render();
        }
        else {
            modeMoreResults = false;
            let tags = getTagsFromSearch();
            selectedItem = $model.addItemFromSearchBar(tags);
            $auto_complete.refreshParse();
            $effects.temporary_highlight(selectedItem.id);
            selectedSubitemPath = selectedItem.id+':0';
            $model.fullyIncludeItem(selectedItem);
            render();
        }

        if (itemIsSelected()) {
            let el = $view.getItemElementById(selectedItem.id);
            $view.onMouseoverAndSelected(el);
        }
        $searchHistory.addActivatedSearch();
    }

    function actionAddSubItem(event) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionAddSubItem()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionAddSubItem()');
            return;
        }
        event.stopPropagation();
        onExitEditingSubitem();
        let extraIndent = true;
        selectedSubitemPath = $model.addSubItem(selectedItem, getSubitemIndex(), extraIndent); //TODO: get back new ref to items?
        render();
    }

    function actionDeleteButton(event) {
        event.stopPropagation();
        event.preventDefault();
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

    function actionDelete(e) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionDelete()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionDelete()');
            return;
        }
        if (noItemSelected()) {
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

        $auto_complete.refreshParse();
        $searchHistory.addActivatedSearch();
        render();
    }

    function shortcutFocusTag() {
        let item = selectedItem;
        let el = $view.getItemTagElementById(item.id);
        el.focus(); //TODO: should be part of view
        actionFocusEditTag();
        let subitemIndex = getSubitemIndex();
        let tags = item.subitems[subitemIndex].tags;

        //add space at end if not there to trigger suggestions
        if (tags.trim().length > 0) {
            el.value = tags.trim() + ' ';
            actionEditTag();
        }

        placeCaretAtEndInput(el);
        modeFocus = FOCUS_TAG;
    }

    function actionFullUp(event) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionFullUp()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionFullUp()');
            return;
        }
        event.stopPropagation();
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
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionFullDown()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionFullDown()');
            return;
        }
        event.stopPropagation();
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
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionUp()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionUp()');
            return;
        }
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
        render();
    }

    function actionDown(event) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionDown()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionDown()');
            return;
        }
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
        render();
    }

    function actionIndent() {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionIndent()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionIndent()');
            return;
        }
        if (getSubitemIndex() > 0) {
            $model.indentSubitem(selectedItem, selectedSubitemPath);
            render();
        }
    }

    function actionUnindent() {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionUnindent()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionUnindent()');
            return;
        }
        if (getSubitemIndex() > 0) {
            $model.unindentSubitem(selectedItem, selectedSubitemPath);
            render();
        }
    }

    function onClickEditBar(event) {
        //TODO: why are we doing this?
        event.stopPropagation();
    }

    function onClickSubitem(event) {
        event.stopPropagation();
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
        $searchHistory.addActivatedSearch();
        setSidebar();
    }
    
    function onClickItem(event) {
        console.log(selectedItem);
        $view.closeAnyOpenMenus();
        event.stopPropagation();
    }

    function onClickDocument(event) {
        $view.closeAnyOpenMenus();
        if (itemIsSelected()) {
            closeSelectedItem();
            render();
        }
    }

    function closeSelectedItem() {

        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.closeSelectedItem()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.closeSelectedItem()');
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
        if (noItemSelected()) {
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
        modeFocus = FOCUS_TAG;
        $auto_complete_tags.onChange(selectedItem, selectedSubitemPath, tagsString);
        $auto_complete_tags.showOptions();
        $sidebar.updateSidebar(selectedItem, subitemIndex, true);
    }
    
    function actionEditTag() {
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
        //TODO refactor into view?
        let text = $auto_complete.getSearchString();
        localStorage.setItem('search', text); //TODO move to persist
        modeMoreResults = false;
        if (modeBackspaceKey == false) {
            $auto_complete.onChange();
            render();
            $view.scrollToTop();
        }
        else {
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
        modeMousedown = true;
        if (itemOnClick != null) {
            //don't add to search unless an actual item is clicked
            $searchHistory.addActivatedSearch();
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

        if (itemOnClick.id == itemOnRelease.id && noItemSelected()) {

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
            $searchHistory.addActivatedSearch();
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
    	modeBackspaceKey = false;
        if (modeSkippedRender == true) {
            actionEditSearch();
        }
    }

    function onBackspaceDown() {
    	modeBackspaceKey = true;
    }

    function checkForUpdates() {
        if ($unlock.getIsLocked()) {
            return;
        }
        function after(shouldReload) {
            if (shouldReload == false) {
                return;
            }
            console.log('update detected / triggering logout');
            modeForceReload = true;
            location.reload(); //Just make it simple for now
        }
        $persist.maybeShouldReload(after);
    }

    function checkForIdleWhileEditing() {
        if (itemIsSelected() == false) {
            return;
        }
        if (modeModal) {
            return;
        }
        if ($unlock.getIsLocked()) {
            return;
        }
        let now = Date.now();
        let elapsed = now - timestampLastActive;
        if (elapsed > SAVE_AFTER_MS_OF_IDLE_EDIT_MODE) {
            //console.log('DEBUG: checkForIdleWhileEditing()');
            if (timestampLastIdleSaved == $model.getTimestampLastUpdate()) {
                //console.log('already idle saved at '+timestampLastIdleSaved+', do nothing');
            }
            else {
                $view.setCursor("progress");
                timestampLastIdleSaved = $model.getTimestampLastUpdate();
                $persist.saveToHostOnIdle(
                    function saveSuccess() {
                        $view.removeBackgroundWarn();
                        console.log('Save successful.');
                        $view.setCursor("auto");
                        if (modeAlertSafeToExit) {
                            alert('Work has been saved.\nIt is now safe to exit.');
                            modeAlertSafeToExit = false;
                        }
                    }, 
                    function saveFail() {
                        console.warn('Failed saving file during idle');
                        // $view.setBackgroundWarn();
                        // alert(WARNING_MESSAGE_IF_DISCONNECTED_FROM_SERVER);
                        // $view.setCursor("default");

                        //TODO: this is safer for now because it introduces bugs otherwise
                        $view.gotoErrorPageDisconnected();
                    });
            } 
        }
    }

    function checkForIdle() {
        if (itemIsSelected()) {
            return;
        }
        if (modeModal) {
            return;
        }
        if ($unlock.getIsLocked()) {
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
                    function saveSuccess() {
                        $view.removeBackgroundWarn();
                        console.log('Save successful.');
                        $view.setCursor("default");
                        if (modeAlertSafeToExit) {
                            alert('Work has been saved.\nIt is now safe to exit.');
                            modeAlertSafeToExit = false;
                        }
                    }, 
                    function saveFail() {
                        console.warn('Failed saving file during idle');
                        // $view.setBackgroundWarn();
                        // alert(WARNING_MESSAGE_IF_DISCONNECTED_FROM_SERVER);
                        // $view.setCursor("default");
                        //TODO: this is safer for now because it introduces bugs otherwise
                        $view.gotoErrorPageDisconnected();
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
    }

    //TODO refactor this into modes
    function onEnterOrTab(e) {

        if ($unlock.getIsLocked()) {
            //console.warn('Pressed enter in locked state - currently not working');
            //TODO: clean this up!
            e.stopPropagation();
            e.preventDefault();
            $('#ok-unlock').click();
            return;
        }

        //TODO: this sometimes does not add a new item
    	if ($auto_complete.getModeHidden() == false) {
            console.log('DEBUG: enter in autocomplete mode');
            let selected = $auto_complete.selectSuggestion();
            console.log('DEBUG: selected = ' + selected);
            if (selected == false && e.keyCode == 13) { //TODO: this is hacky
                actionAdd(e);
            }
            else {
                actionEditSearch();
            }
            return;
        }
        
        if ($auto_complete_tags.getModeHidden() == false) {
            $auto_complete_tags.selectSuggestion(selectedItem, selectedSubitemPath);

            let editing = false;
            if (itemIsSelected()) {
                editing = true;
            }
            $sidebar.updateSidebar(selectedItem, getSubitemIndex(), editing);
            return;
        }
        
        if (noItemSelected()) {
            if (e.keyCode == 9) { //TODO: refactor this, hacky
                //ignore tabs
                //e.preventDefault();
                return;
            }
            actionAdd(e);
        }
    }

    function onClickTagSuggestion() {
    	$auto_complete_tags.selectSuggestion(selectedItem, selectedSubitemPath);
        let tagsString = selectedItem.subitems[getSubitemIndex()].tags.trim() + ' ';
        $auto_complete_tags.onChange(selectedItem, selectedSubitemPath, tagsString);
    }

    function onSearchClick(e) {
        $auto_complete.showOptions();
        if (itemIsSelected()) {
            closeSelectedItem();
            render();
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
        if (itemIsSelected()) {
            closeSelectedItem();
            render();
        }
    }

    function actionMoreResults() {
        modeMoreResults = true;
        closeSelectedItem();
        render();
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

        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionSave()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionSave()');
            return;
        }

        if (e != undefined) {
            e.preventDefault();
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

    function onOpenFile(e) {
        e.stopPropagation();
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

        render();
    }

    function actionGotoSearch(e) {
        e.stopPropagation();
        let text = e.target.innerText;
        $view.setSearchText(text);
        actionEditSearch();
    }

    function onCheck(e) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.onCheck()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.onCheck()');
            return;
        }
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = parseInt(path.split(':')[0]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace(META_TODO, META_DONE); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        render();
    }

    function onUncheck(e) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.onUncheck()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.onUncheck()');
            return;
        }
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = parseInt(path.split(':')[0]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace(META_DONE, META_TODO); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        render();
    }

    function onFold(e) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.onFold()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.onFold()');
            return;
        }
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = parseInt(path.split(':')[0]);
        let index = parseInt(path.split(':')[1]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        $model.toggleFormatTag(item, path, META_FOLDED);
        render();
    }

    function onUnfold(e) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.onUnfold()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.onUnfold()');
            return;
        }
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = parseInt(path.split(':')[0]);
        let index = parseInt(path.split(':')[1]);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        $model.toggleFormatTag(item, path, META_UNFOLDED);
        render();
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

    function navigate(newSubitemPath) {
        if (itemIsSelected() && newSubitemPath != selectedSubitemPath) {
            selectedSubitemPath = newSubitemPath;
            render();
        }
    }

    function onUpArrow(e) {
        if ($auto_complete.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete.arrowUp();
            return;
        }
        
        if ($auto_complete_tags.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete_tags.arrowUp();
            return;
        }
        
        if (itemIsSelected()) {
            e.stopPropagation();
            let pos = $view.getCaretPositionOfSelectedItem();
            if (pos.location == 0) {
                navigate($model.getPrevSubitemPath(selectedItem, selectedSubitemPath));
                placeCaretAtStartContentEditable(div);
            }
            return;
        }
    }

    function onDownArrow(e) {
        if ($auto_complete.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete.arrowDown();
            return;
        }
        
        if ($auto_complete_tags.getModeHidden() == false) {
            e.stopPropagation();
            $auto_complete_tags.arrowDown();
            return;
        }
        
        if (itemIsSelected()) {
            e.stopPropagation();
            let pos = $view.getCaretPositionOfSelectedItem();
            if (pos.location == pos.textLength) {
                navigate($model.getNextSubitemPath(selectedItem, selectedSubitemPath));
            }
            return;
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
        if (noItemSelected()) {
            return;
        }

        //TODO: keep track of caret position and move back to that

        e.preventDefault();
        
        if (modeFocus == FOCUS_TAG && subitemIsSelected()) {
            focusOnSelectedSubItem();
        }
        else {
            shortcutFocusTag();
        }
        
        let editing = false;
        if (itemIsSelected()) { //TODO: won't this always be true?
            editing = true;
        }
        $sidebar.updateSidebar(selectedItem, getSubitemIndex(), editing);
    }

    function onClickMenu() {
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
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.deleteEverything()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.deleteEverything()');
            return;
        }
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
        e.stopPropagation();
        if (noItemSelected()) {
            return;
        }
        subsectionClipboard = [{data: "@id="+selectedItem.id, tags: "@goto", indent:0}];
    }

    function actionMakeLinkEmbed(e) {
        e.stopPropagation();
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

    function actionCopySubsection(e) {
        e.stopPropagation();
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
        let _onCopy = function(e) {
            e.clipboardData.setData('text/plain', text);
            e.preventDefault();
        };
        document.addEventListener('copy', _onCopy);
        document.execCommand('copy');
        document.removeEventListener('copy', _onCopy);
    }

    function actionPasteSubsection(e) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionPasteSubsection()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionPasteSubsection()');
            return;
        }
        if (e != undefined) {
            e.stopPropagation();
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
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionRemoveFormatting()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionRemoveFormatting()');
            return;
        }
        if (e != undefined) {
            e.stopPropagation();
        }
        if (noItemSelected()) {
            return;
        }
        let subitemIndex = getSubitemIndex();
        $model.removeSubitemFormatting(selectedItem, subitemIndex);
        let path = selectedItem.id+':'+subitemIndex;
        render();
    }

    function actionCollapseAllView() {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionCollapseAllView()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionCollapseAllView()');
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
        //console.log('DEBUG: collapse items ' + toCollapse);
        render();
    }

    function actionExpandAllView() {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionExpandAllView()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionExpandAllView()');
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
        //console.log('DEBUG: expand items ' + toExpand);
        render();
    }

    function actionCollapseItem(e) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionCollapseItem()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionCollapseItem()');
            return;
        }
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = path.split(':')[0];
        let item = $model.getItemById(id);
        $model.collapse(item);
        render();
    }
    
    function actionExpandItem(e) {
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionExpandItem()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionExpandItem()');
            return;
        }
        e.stopPropagation();
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = path.split(':')[0];
        let item = $model.getItemById(id);
        $model.expand(item);
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
                $todo.successfulInit();
                $persist.saveToHostFull(
                    function saveSuccess() {
                        $view.removeBackgroundWarn();
                        $unlock.exitLock();
                        maybeResetSearch();
                        render();
                        $view.scrollToTop();
                    }, 
                    function saveFail() {
                        alert('Failed saving file');
                    });
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
        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.genericModal()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.genericModal()');
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

    //TODO: use this everywhere
    function saveSuccess() {
        $view.removeBackgroundWarn();
        $view.hideSpinner();
        modeDisconnected = false;
        if (saveAttempt != null) {
            clearInterval(saveAttempt);
            saveAttempt = null;
        }
    }

    function saveFail() {
        console.warn('saveFail()');
        if (modeDisconnected) {
            return;
        }
        $view.setSpinnerContentDisconnected();
        $view.showSpinner();
        //TODO: actual message here.
        //alert('ERROR: Failed to save to server. May be disconnected.\nTry refreshing the browser.');
        modeDisconnected = true;
        saveAttempt = setInterval(function() {
            $persist.saveToHostFull(
                function saveSuccess() {
                    $view.removeBackgroundWarn();
                }, 
                function saveFail() {
                    //$view.setBackgroundWarn();
                    //TODO: this is safer for now because it introduces bugs otherwise
                    $view.gotoErrorPageDisconnected();
                });
        }, 5000);
    }

    function actionPaste(e, pastedTextData, pastedHTMLData) {

        //TODO: test this function again

        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionPaste()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionPaste()');
            return;
        }

        if (subitemIsSelected()) {
            return;
        }

        e.stopPropagation();
        e.preventDefault();
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

    function genericToggleFormatTag(tag, event) {

        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.genericToggleFormatTag()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.genericToggleFormatTag()');
            return;
        }

        event.stopPropagation();
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

    function actionToggleExpanded(e) {
        genericToggleFormatTag(META_UNFOLDED, e);
    }

    function actionToggleCollapsed(e) {
        genericToggleFormatTag(META_FOLDED, e);
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
        e.stopPropagation();
        onEscape();
    }

    function getClipboardText() {
        return modeClipboardText;
    }

    function render() {
        $view.render(selectedItem, selectedSubitemPath, modeMoreResults);
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

        if (modeModal) {
            console.warn('Blocked by modeModal @ $todo.actionLogOut()');
            return;
        }
        if ($persist.isLocked()) {
            console.warn('Blocked by $persist.isLocked() @ $todo.actionLogOut()');
            return;
        }

        if (timestampLastIdleSaved != $model.getTimestampLastUpdate()) {
            $view.setSpinnerContentSavingAndLoggingOut();
            $view.showSpinner();
            $persist.saveToHostFull(
                //TODO: should all be one function
                function saveSuccess() {
                    $view.removeBackgroundWarn();
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

    function successfulInit() {

        let _just_a_test_of_sorting_validity = $model.getSortedItems();

        deselect();
        $menu.init();
        $auto_complete.hideOptions();
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
		actionDelete: actionDelete,
        onCopy: onCopy,
        onShell: onShell,
        onOpenFile: onOpenFile,
        onEscape: onEscape,
		onBackspaceUp: onBackspaceUp,
		onBackspaceDown: onBackspaceDown,
		onWindowFocus: onWindowFocus,
		onEnterOrTab: onEnterOrTab,
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
        actionToggleAdvancedView: actionToggleAdvancedView,
        actionPaste: actionPaste,
        getClipboardText: getClipboardText,
        getValidSearchTags: getValidSearchTags,
        resetAllCache: resetAllCache,
        deleteEverything: deleteEverything,
        maybeResetSearch: maybeResetSearch,
        successfulInit: successfulInit
    };
})();
