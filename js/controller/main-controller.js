"use strict";

/* TODO
   - consolidate how saveSuccess and saveFail work across functions
   - all mentions of DOM elements should be handled by $view
   - all mentions of localStorage should be handled by $persist
   - introduce a state machine / pub-sub model?
     - maybe just getters/setters for all mode changes?
   - rename events without intention as on*
*/

let $main_controller = (function () {

    const CHECK_FOR_IDLE_FREQ_MS = 10;
    const SAVE_AFTER_MS_OF_IDLE = 10;
    const SAVE_AFTER_MS_OF_IDLE_EDIT_MODE = 3000;
    const LOCK_AFTER_MS_OF_IDLE = 60 * 60 * 1000; //60 minutes default
    const CLOSE_ITEM_AFTER_MS_OF_IDLE = 2 * 60 * 1000;
    const UPDATE_SIDEBAR_ON_EDIT_ITEM_DATA = false;
    const MAX_SHADOW_ITEMS_ON_MOVE = 25;
    const MIN_FOCUS_TIME_TO_EDIT = 300;
    const INDENT_ACTION_PIXEL_WIDTH = 10;
    const FOCUS_TAG = 'tag';
    const FOCUS_SUBITEM = 'subitem';
    const FOCUS_EDIT_BAR = 'edit-bar';
    const FOCUS_NONE = 'none';
    const SHOW_EVENTS = false;
    const DELETE_IF_BACKSPACE_AND_EMPTY = false;
    const DEV_MODE = true;

    let state = {}

    //TODO: keep track of scrolling state?

    state.modeFocus = FOCUS_NONE; //TODO re-explore logic of this; not used much yet
    state.modeBackspaceKey = false;
    state.modeSkippedRender = false;
    state.modeMoreResults = false;
    state.modeRedacted = true;
    state.modeModal = false;
    state.modeAlreadyIdleSaved = false;
    state.modeMousedown = false;
    state.modeEditingSubitem = false;
    state.modeEditingSubitemInitialState = null;
    state.modeClipboardText = null;
    state.modeAlertSafeToExit = false;

    state.timestampLastIdleSaved = 0;
    state.selectedItem = null;
    state.selectedSubitemPath = null; //convert to index
    state.itemOnClick = null;
    state.subitemIdOnClick = null; //convert to index
    state.itemOnRelease = null;
    state.subitemIdOnRelease = null;
    state.xOnRelease = null;
    state.mousedItemId = null;
    state.mousedSubitemId = null;  //Should be called mousedSubitemIndex
    state.recentClickedSubitem = null;
    state.xOnClick = null;
    state.copyOfSelectedItemBeforeEditing = null;
    state.subsectionClipboard = null;
    state.timestampFocused = Date.now();
    state.timestampLastActive = Date.now();

    let ws = null;

    function canTakeAction(context) {

        if (DEV_MODE) {
            console.log(`action -> ${context}`);
        }

        if (state.context === undefined) {
            state.context = '';
        }
        if (state.modeModal) {
            console.warn(state.context+ ' Blocked by modeModal');
            return false;
        }
        if ($persist.isMutexLocked()) {
            console.warn(state.context+ ' Blocked by $persist.isMutexLocked()');
            return false;
        }
        if ($unlock.getIsLocked()) {
            console.warn(state.context + ' blocked by $unlock.getIsLocked()');
            return false;
        }
        return true;
    }

    //TODO: most of this logic should be moved
    function getTagsFromSearch() {
        let currentSearchString = $auto_complete_search.getSearchString();
        let parseResults = $parseSearch.parse(currentSearchString);
        if (parseResults === null) {
            console.warn('invalid parse, will not add new');
            return null;
        }

        let arr = []
        for (let result of parseResults) {
            if (result.type === 'tag' && 
                result.negated === undefined && 
                result.valid_exact_tag_matches.length > 0) {

                if (arr.includes(result.valid_exact_tag_matches[0]) === false) {
                    arr.push(result.valid_exact_tag_matches[0])
                }
            }
            //Need this to add new, non-existing tags
            if (result.type === 'tag' && 
                result.negated === undefined && 
                result.partial === true) {

                if (arr.includes(result.text) === false) {
                    arr.push(result.text);
                }
            }
        }
        let tags = arr.join(' ');
        return tags;
    }

    function focusOnSelectedSubItem() {
        $view.focusSubitem(state.selectedSubitemPath);
        onEnterEditingSubitem();
    }

    function deselect() {
        if (subitemIsSelected()) { //TODO this is hacky
            onExitEditingSubitem();
        }
        state.selectedItem = null;  //TODO asdf duplicated code fragment?
        state.selectedSubitemPath = null;
        state.itemOnClick = null;
        state.subitemIdOnClick = null;
        state.itemOnRelease = null;
        state.subitemIdOnRelease = null;
        state.xOnClick = null;
        state.xOnRelease = null;
        state.mousedItemId = null;
        state.mousedSubitemId = null;
        state.modeFocus = FOCUS_NONE;
        clearSidebar();
    }

    function handleEvent(event, msg) {
        if (SHOW_EVENTS) {
            console.log('$main_controller.handleEvent() ' + msg);
        }
        if (event !== undefined) {
            event.stopPropagation();
            event.preventDefault();
        }
    }

    function actionAddLink(event, url) {
        actionAddNewItem(event);
        $model.updateSubitemData(state.selectedItem, state.selectedItem.id+":"+0, url);
        deselect();
        render();
    }

    //TODO: why do we need this extra function instead of just actionAdd() ?
    function actionAddNewItem(event) {
        handleEvent(event, 'actionAddNewItem');
        if (canTakeAction('actionAddNewItem()') === false) {
            return;
        }
        $view.closeAnyOpenMenus();
        deselect();
        actionAdd(event);
    }

    function actionAdd(event) {
        handleEvent(event, 'actionAdd');
        if (canTakeAction('actionAdd()') === false) {
            return;
        }

        console.log('DEBUG: actionAdd()');

        $view.closeAnyOpenMenus();

        if (itemIsSelected()) {
            onExitEditingSubitem();
            let subitemIndex = getSubitemIndex();
            let extraIndent = false;
            state.selectedSubitemPath = $model.addSubItem(state.selectedItem, subitemIndex, extraIndent);
            render();
        }
        else {
            state.modeMoreResults = false;
            setModeRedacted(true);
            let tags = getTagsFromSearch();
            if (tags === null) {
                console.warn('Cannot add because no valid tags');
                return;
            }
            state.selectedItem = $model.addItemFromSearchBar(tags);
            $auto_complete_search.refreshParse();
            $effects.temporary_highlight(state.selectedItem.id);
            state.selectedSubitemPath = state.selectedItem.id+':0';
            $model.fullyIncludeItem(state.selectedItem);
            render();
        }

        if (itemIsSelected()) {
            let el = $view.getItemElementById(state.selectedItem.id);
            $view.onMouseoverAndSelected(el);
        }
    }

    function actionAddSubItem(event) {
        handleEvent(event, 'actionAddSubItem');
        if (canTakeAction('actionAddSubItem()') === false) {
            return;
        }
        onExitEditingSubitem();
        let extraIndent = true;
        state.selectedSubitemPath = $model.addSubItem(state.selectedItem, getSubitemIndex(), extraIndent); //TODO: get back new ref to items?
        render();
    }

    function actionDeleteButton(event) {
        handleEvent(event, 'actionDeleteButton');
        if (canTakeAction('actionDeleteButton()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }
        let subitemIndex = getSubitemIndex();
        if (subitemIndex === 0) {
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
    function actionDelete(event) {
        handleEvent(event, 'actionDelete');
        if (canTakeAction('actionDelete()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }

        state.copyOfSelectedItemBeforeEditing = copyJSON(state.selectedItem);

        let subitemIndex = getSubitemIndex();
        if (subitemIndex === 0) {
            $model.deleteItem(state.selectedItem);
            deselect();
        }
        else {
            let indent = state.selectedItem.subitems[subitemIndex].indent;
            let newSubitemIndex = 0;
            if (state.selectedItem.subitems.length > subitemIndex+1 &&
                state.selectedItem.subitems[subitemIndex+1].indent === indent) {
                //Use next
                newSubitemIndex = subitemIndex; //it will inherit current subitem index
            }
            else {
                //Find previous
                for (let i = subitemIndex-1; i >= 0; i--) {
                    if (state.selectedItem.subitems[i].indent <= indent) {
                        newSubitemIndex = i;
                        break;
                    }
                }
            }
            
            $model.removeSubItem(state.selectedItem, state.selectedSubitemPath);
            state.selectedSubitemPath = state.selectedItem.id+':'+newSubitemIndex;
        }

        if ($model.itemHasMetaTags(state.copyOfSelectedItemBeforeEditing)) {
            let recalculated = $ontology.maybeRecalculateOntology();
            if (recalculated) {
                resetAllCache();
            }
        }

        if ($model.itemHasAttributeTags(state.copyOfSelectedItemBeforeEditing)) {
            $model.resetTagCountsCache();
            $model.resetCachedAttributeTags();
        }

        $auto_complete_search.refreshParse();
        render();
    }

    function shortcutFocusTag() {
        let item = state.selectedItem;
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

        state.modeFocus = FOCUS_TAG;
        placeCaretAtEndInput(el);
    }

    function actionFullUp(event) {
        handleEvent(event, 'actionFullUp');
        if (canTakeAction('actionFullUp()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }

        //TODO: refactor some of this logic into model
        let filteredItems = $model.getFilteredItems();
        let firstFilteredItem = filteredItems[0];
        if (firstFilteredItem.id === state.selectedItem.id) {
            //at top, do nothing
            return;
        }
        $effects.temporary_highlight(state.selectedItem.id);
        let migrated = $model.drag(state.selectedItem, firstFilteredItem);
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
        if (canTakeAction('actionFullDown()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }

        //TODO: refactor some of this logic into model
        let filteredItems = $model.getFilteredItems();
        let lastFilteredItem = filteredItems[filteredItems.length-1];
        if (lastFilteredItem.id === state.selectedItem.id) {
            // at bottom, do nothing
            return;
        }
        $effects.temporary_highlight(state.selectedItem.id);
        let migrated = $model.drag(state.selectedItem, lastFilteredItem);
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
        if (canTakeAction('actionUp()') === false) {
            return;
        }

        let subitemIndex = getSubitemIndex();
        if (subitemIndex > 0) {
            state.selectedSubitemPath = $model.moveUpSubitem(state.selectedItem, state.selectedSubitemPath);
        }
        else {
            $effects.temporary_highlight(state.selectedItem.id);
            let migrated = $model.moveUp(state.selectedItem);
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
        if (canTakeAction('actionDown()') === false) {
            return;
        }

        let subitemIndex = getSubitemIndex();
        if (subitemIndex > 0) {
            state.selectedSubitemPath = $model.moveDownSubitem(state.selectedItem, state.selectedSubitemPath);
        }
        else {
            $effects.temporary_highlight(state.selectedItem.id);
            let migrated = $model.moveDown(state.selectedItem);
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
        if (canTakeAction('actionIndent()') === false) {
            return;
        }
        if (getSubitemIndex() > 0) {
            $model.indentSubitem(state.selectedItem, state.selectedSubitemPath);
            render();
        }
    }

    function actionUnindent() {
        handleEvent(event, 'actionUnindent');
        if (canTakeAction('actionUnindent()') === false) {
            return;
        }
        if (getSubitemIndex() > 0) {
            $model.unindentSubitem(state.selectedItem, state.selectedSubitemPath);
            render();
        }
    }

    function onClickEditBar(event) {
        //TODO: why are we doing this?
        handleEvent(event, 'onClickEditBar');
    }

    function onClickSubitem(event) {
        handleEvent(event, 'onClickSubitem');
        if (canTakeAction('onClickSubitem()') === false) {
            return;
        }
        $view.closeAnyOpenMenus();
        //Do not want to immediately go into editing mode if not already interacting with window?
        let now = Date.now();
        if (now - state.timestampFocused < MIN_FOCUS_TIME_TO_EDIT) {
            //skip
            return;
        }
        let path = $view.getSubitemPathFromEventTarget(event.currentTarget); //currentTarget
        state.recentClickedSubitem = path;
        let doSelect = false;
        if (itemIsSelected()) {
            let itemId = getItemIdFromPath(path);
            state.selectedSubitemPath = recentClickedSubitem;
            if (state.selectedItem.id !== itemId) {
                doSelect = true;
            }
        }
        else {
            doSelect = true;
        }
        if (doSelect) {
            closeSelectedItem();
            let itemId = parseInt(this.dataset.subitemPath.split(':')[0]);
            state.selectedItem = $model.getItemById(itemId);
            state.copyOfSelectedItemBeforeEditing = copyJSON(state.selectedItem);
            state.selectedSubitemPath = state.recentClickedSubitem;
            state.mousedItemId = state.selectedItem.id;
            state.mousedSubitemId = getSubitemIndexFromPath(path);
            render();
        }
        if (itemIsSelected()) {
            console.log(state.selectedItem);
        }
        state.recentClickedSubitem = null;
        setSidebar();
    }
    
    function onClickItem(event) {
        handleEvent(event, 'onClickItem');
        if (canTakeAction('onClickItem()') === false) {
            return;
        }
        console.log(state.selectedItem);
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
        if (canTakeAction('closeSelectedItem()') === false) {
            return;
        }

        if (noItemSelected()) {
            return;
        }

        //TODO: this is very slow!!
        if (JSON.stringify(state.copyOfSelectedItemBeforeEditing) !== JSON.stringify(state.selectedItem)) {
            //Only highlight if an update was made
            $effects.temporary_highlight(state.selectedItem.id);
        }

        if (state.copyOfSelectedItemBeforeEditing === null) {
            console.warn('copyOfSelectedItemBeforeEditing === null');
        }

        if ($model.itemHasMetaTags(state.copyOfSelectedItemBeforeEditing) ||
            $model.itemHasMetaTags(state.selectedItem)) {

            let recalculated = $ontology.maybeRecalculateOntology();
            if (recalculated) {
                resetAllCache();
            }
        }
    
        if ($model.itemHasAttributeTags(state.copyOfSelectedItemBeforeEditing) ||
            $model.itemHasAttributeTags(state.selectedItem)) {

            $model.resetTagCountsCache();
            $model.resetCachedAttributeTags();
        }
        deselect();
    }

    function subitemIsSelected() {
        if (state.selectedSubitemPath !== null) {
            return true;
        }
        return false;
    }

    function noSubitemSelected() {
        if (state.selectedSubitemPath === null) {
            return true;
        }
        return false;
    }

    function onEnterEditingSubitem() {
        if (canTakeAction('onEnterEditingSubitem()') === false) {
            return;
        }
        if (noItemSelected() || noSubitemSelected()) {
            console.warn('expected subitem and item to be selected');
            return;
        }

        state.copyOfSelectedItemBeforeEditing = copyJSON(state.selectedItem);
        state.modeEditingSubitem = true;
        let subitem = $model.getSubitem(state.selectedItem, state.selectedSubitemPath);
        state.modeEditingSubitemInitialState = subitem.data;
    }

    function onExitEditingSubitem() {
        if (canTakeAction('onExitEditingSubitem()') === false) {
            return;
        }
        if (state.modeEditingSubitem === false) {
            console.warn('Expected we were editing a subitem');
            return;
        }

        let subitem = $model.getSubitem(state.selectedItem, state.selectedSubitemPath);
        if (subitem !== null) {
            let newData = subitem.data;
            if (newData !== state.modeEditingSubitemInitialState) {
                //TODO: hacky to have this done in controller!
                autoformat(state.selectedItem, state.selectedSubitemPath, state.modeEditingSubitemInitialState, newData);
            }
            state.modeEditingSubitem = false;
            state.modeEditingSubitemInitialState = null;
        }
    }

    function onEditSubitem(event) {
        handleEvent(event, 'onEditSubitem');
        if (canTakeAction('onEditSubitem()') === false) {
            return;
        }
        if (noItemSelected() || noSubitemSelected()) {
            console.warn('expected we were editing a subitem');
            return;
        }
        let text = event.target.innerHTML;
        let path = $view.getSubitemPathFromEventTarget(event.target);
        $model.updateSubitemData(state.selectedItem, path, text);
        if (UPDATE_SIDEBAR_ON_EDIT_ITEM_DATA) {
            setSidebar();
        }
    }

    function onFocusSubitem(event) {
        handleEvent(event, 'onFocusSubitem');
        if (canTakeAction('onFocusSubitem()') === false) {
            return;
        }
        state.modeFocus = FOCUS_SUBITEM;
        $auto_complete_tags.hideOptions();
        if (noItemSelected()) {
            return;
        }

        if (subitemIsSelected() && state.modeEditingSubitem === true) {
            onExitEditingSubitem();
        }
        $view.onFocusSubitem(event);
        setSidebar();
        onEnterEditingSubitem();
    }

    function actionEditTime(event) {
        handleEvent(event, 'actionEditTime');
        if (canTakeAction('actionEditTime()') === false) {
            return;
        }
        if (noItemSelected()) {
            throw "Unexpected, no selected item...";
        }

        let text = $view.getSelectedTimeAsText();
        let utcDate = new Date(text);
        let timestamp = utcDate.getTime() + utcDate.getTimezoneOffset() * 60 * 1000;
        $model.updateTimestamp(state.selectedItem, timestamp);
    }

    function actionFocusEditTag() {
        if (canTakeAction('actionFocusEditTag()') === false) {
            return;
        }
        let subitemIndex = getSubitemIndex();
        let tags = state.selectedItem.subitems[subitemIndex].tags;

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
        state.modeFocus = FOCUS_TAG;
        $auto_complete_tags.onChange(state.selectedItem, state.selectedSubitemPath, tagsString);
        $auto_complete_tags.showOptions();
        $sidebar.updateSidebar(state.selectedItem, subitemIndex, true);
    }
    
    function actionEditTag() {
        if (canTakeAction('actionEditTag()') === false) {
            return;
        }
        if (noItemSelected()) {
            throw "Unexpected, no selected item...";
        }
        //TODO refactor into view?
        let tagsString = $view.getItemTagElementById(state.selectedItem.id).value;
        $model.updateSubTag(state.selectedItem, state.selectedSubitemPath, tagsString);
        $auto_complete_tags.onChange(state.selectedItem, state.selectedSubitemPath, tagsString);
        $auto_complete_tags.showOptions();
        $sidebar.updateSidebar(state.selectedItem, getSubitemIndex(), true);
    }

    function actionEditSearch() {
        if (canTakeAction('actionEditSearch()') === false) {
            return;
        }
        //TODO refactor into view?
        let text = $auto_complete_search.getSearchString();

        //TODO asdf is this search legal?

        localStorage.setItem('search', text); //TODO move to persist
        state.modeMoreResults = false;
        setModeRedacted(true);
        if (state.modeBackspaceKey === false) {
            $auto_complete_search.onChange();
            render();
            $view.scrollToTop();
        }
        else {
            state.modeSkippedRender = true;
        }
    }

    function maybeResetSearch() {
        let currentSearchString = $auto_complete_search.getSearchString();
        if (currentSearchString !== null && currentSearchString !== '') {
            let parse_results = $parseSearch.parse(currentSearchString);
            $model.filterItemsWithParse(parse_results, false); //TODO: why is this called twice?
            let tot = 0;
            const items = $model.getUnsortedItems();
            for (let item of items) {
                if (item.subitems[0]._include === 1) {
                    tot++;
                }
            }
            if (tot === 0) {
                localStorage.setItem('search', null);
                $view.setSearchText('');
                parse_results = [];
                $filter.filterItemsWithParse(parse_results, false); //TODO: why is this called twice?
            }
        }
        $auto_complete_search.onChange();
    }

    //TODO move this function out of here, into $persist
    function actionMouseoverItem(e) {
    	let subitemPath = $view.getSubitemPathFromEventTarget(e.target);
        if (subitemPath !== undefined) {
            state.mousedItemId = getItemIdFromPath(subitemPath);
            state.mousedSubitemId = getSubitemIndexFromPath(subitemPath);
        }
        else {
            state.mousedItemId = $view.getItemIdFromEventTarget(e.currentTarget);
            state.mousedSubitemId = 0;
        }

        if (itemIsSelected() && state.mousedItemId === state.selectedItem.id) {
            $view.onMouseoverAndSelected(e.currentTarget);
        }
        else if (noItemSelected()) {
            $view.onMouseover(e.currentTarget);
            $auto_complete_tags.hideOptions();
        }

        if (state.itemOnClick !== null && state.itemOnClick.id !== state.mousedItemId) {
            $view.removeAllRanges();
        }
        $auto_complete_search.hideOptions();
        setSidebar();
    }

    function actionMouseoffItem(e) {
        $view.onMouseoff();
        state.mousedItemId = null;
        state.mousedSubitemId = null;
    }

    function actionMousedownItem(e) {
        if (canTakeAction('actionMousedown()') === false) {
            return;
        }
        state.itemOnClick = $model.getItemById(state.mousedItemId);
        state.subitemIdOnClick = state.mousedSubitemId;
        state.xOnClick = e.clientX;
        state.modeMousedown = true;
        if (state.itemOnClick !== null) {
            //don't add to search unless an actual item is clicked
            //$searchHistory.addActivatedSearch();
            if (noItemSelected()) {
                $view.setCursor("grab");
            }
            else {
                if (state.selectedItem.id !== state.itemOnClick.id) {
                    $view.setCursor("grab");
                }
                else {
                    console.log('DEBUG: no grab?')
                }
            }
        }
    }

    function actionMouseupItem(e) {
        if (canTakeAction('actionMouseup()') === false) {
            return;
        }

        state.xOnRelease = e.clientX;
        state.modeMousedown = false;

        $view.setCursor("auto");

        state.itemOnRelease = null;
        if (state.mousedItemId !== null) {
            state.itemOnRelease = $model.getItemById(state.mousedItemId);
        }
        state.subitemIdOnRelease = null;
        if (state.mousedSubitemId !== null) {
            state.subitemIdOnRelease = state.mousedSubitemId;
        }

        if (state.itemOnClick === null) {
            return;
        }

        if (state.itemOnRelease !== null &&
            state.itemOnClick.id === state.itemOnRelease.id &&
            noItemSelected()) {

            let newpath = null;

            if (state.subitemIdOnClick !== state.subitemIdOnRelease) {
                newpath = $model.dragSubitem(state.itemOnClick, state.subitemIdOnClick, state.subitemIdOnRelease);
            }
            else if (state.xOnRelease < state.xOnClick - INDENT_ACTION_PIXEL_WIDTH) {
                newpath = $model.unindentSubitem(state.itemOnClick, state.itemOnClick.id+':'+state.subitemIdOnClick)
            }
            else if (state.xOnRelease > state.xOnClick + INDENT_ACTION_PIXEL_WIDTH) {
                newpath = $model.indentSubitem(state.itemOnClick, state.itemOnClick.id+':'+state.subitemIdOnClick)
            }

            if (newpath !== null) {
                $effects.emphasizeSubitemAndChildren(state.itemOnClick, newpath);
                deselect();
                render();   
                return;
            }
        }

        //TODO: This is spaghetti
        if (state.itemOnRelease !== null &&
            itemIsSelected() &&
            state.selectedItem.id === state.itemOnRelease.id) {
            //Released inside the item we are editing
            state.itemOnClick = null;
            state.subitemIdOnClick = null;
            state.itemOnRelease = null;
            return;
        }

        if (state.itemOnClick !== null &&
            state.itemOnRelease !== null &&
            state.itemOnClick.id !== state.itemOnRelease.id) {
            $effects.temporary_highlight(state.itemOnClick.id);
            let migrated = $model.drag(state.itemOnClick, state.itemOnRelease);
            if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
                for (let id of migrated) {
                    $effects.temporary_shadow(id);
                }
            }
            render();
        }

        //TODO: deselect() here?
        state.itemOnClick = null;
        state.subitemIdOnClick = null;
        state.itemOnRelease = null;
        state.subitemIdOnRelease = null;
        state.xOnClick = null;
        state.xOnRelease = null;
    }

    function onBackspaceUp() {
        if (canTakeAction('onBackspaceUp()') === false) {
            return;
        }
        state.modeBackspaceKey = false;
        if (state.modeSkippedRender === true) {
            actionEditSearch();
        }
    }

    function actionDeleteIfEmpty(e) {

        if (canTakeAction('actionDeleteIfEmpty()') === false) {
            return;
        }

        if (noItemSelected()) {
            return;
        }

        let index = getSubitemIndex();

        if (state.selectedItem.subitems[index].data !== '') {
            return;
        }

        if (state.selectedItem.subitems.length > index+1 &&
            state.selectedItem.subitems[index].indent < state.selectedItem.subitems[index+1].indent) {
            alert('Has children, cannot delete.');
            return;
        }

        actionDelete(e);
    }

    function onBackspaceDown(e) {
        if (canTakeAction('onBackspaceDown()') === false) {
            return;
        }
        state.modeBackspaceKey = true;

        if (DELETE_IF_BACKSPACE_AND_EMPTY) {
            actionDeleteIfEmpty(e);
        }
    }

    function checkForIdleWhileEditing() {

        if ($persist.isMutexLocked()) {
            return false;
        }
        if (itemIsSelected() === false) {
            return;
        }

        let now = Date.now();
        let elapsed = now - state.timestampLastActive;

        if (elapsed > SAVE_AFTER_MS_OF_IDLE_EDIT_MODE) {
            if (state.timestampLastIdleSaved === $model.getTimestampLastUpdate()) {
                //console.log('already idle saved at '+timestampLastIdleSaved+', do nothing');
            }
            else {
                $view.setCursor("progress");
                state.timestampLastIdleSaved = $model.getTimestampLastUpdate();
                $persist.saveToHostOnIdle(
                    saveSuccessAfterIdle, 
                    saveFail
                );
            } 
        }

        if ($protection.getModeProtected() &&
            state.modeAlertSafeToExit === false &&
            elapsed > LOCK_AFTER_MS_OF_IDLE) {
            location.reload();
        }
        
    }

    function checkForIdle() {
        if ($persist.isMutexLocked()) {
            return false;
        }

        let now = Date.now();
        let elapsed = now - state.timestampLastActive;

        if (itemIsSelected() === true) {
            if (elapsed > CLOSE_ITEM_AFTER_MS_OF_IDLE) {
                console.log('CLOSE');
                onEscape();
            }
            return;
        }

        if (elapsed > SAVE_AFTER_MS_OF_IDLE) {
            if (state.timestampLastIdleSaved === $model.getTimestampLastUpdate()) {
                //console.log('already idle saved at '+timestampLastIdleSaved+', do nothing');
            }
            else {
                $view.setCursor("progress");
                state.timestampLastIdleSaved = $model.getTimestampLastUpdate();
                $persist.saveToHostOnIdle(
                    saveSuccessAfterIdle, 
                    saveFail
                );
            } 
        }

        if ($protection.getModeProtected() &&
            state.modeAlertSafeToExit === false &&
            elapsed > LOCK_AFTER_MS_OF_IDLE) {
            location.reload();
        }
    }

    function onWindowFocus() {
        state.timestampFocused = Date.now();
    }

    //TODO refactor this into modes
    function onEnter(e) {

        if ($unlock.getIsLocked()) {
            $('#ok-unlock').click();
            handleEvent(e, 'onEnter');
            return;
        }

        if (canTakeAction('onEnter()') === false) {
            return;
        }

        //TODO: this sometimes does not add a new item
    	if ($auto_complete_search.getModeHidden() === false) {
            $auto_complete_search.selectSuggestion();
            actionEditSearch();
            handleEvent(e, 'onEnter');
            return;
        }
        
        if ($auto_complete_tags.getModeHidden() === false) {
            $auto_complete_tags.selectSuggestion(state.selectedItem, state.selectedSubitemPath);

            let editing = false;
            if (itemIsSelected()) {
                editing = true;
            }
            $sidebar.updateSidebar(state.selectedItem, getSubitemIndex(), editing);
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

        state.modeBackspaceKey = false;

        if ($unlock.getIsLocked()) {
            return;
        }

        if (canTakeAction('onCtrlBackspace()') === false) {
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

        if (canTakeAction('onTab()') === false) {
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
        if (state.modeFocus === FOCUS_TAG && subitemIsSelected()) {
            focusOnSelectedSubItem();
        }
        else {
            shortcutFocusTag();
        }
        
        let editing = false;
        if (itemIsSelected()) { //TODO: won't this always be true?
            editing = true;
        }
        $sidebar.updateSidebar(state.selectedItem, getSubitemIndex(), editing);
        ////////////////////////////////////////////////

        handleEvent(e, 'onTab'); //TODO: do we need this one?
        return;
    }

    function onClickTagSuggestion() {
        if (canTakeAction('onClickTagSuggestion()') === false) {
            return;
        }
    	$auto_complete_tags.selectSuggestion(state.selectedItem, state.selectedSubitemPath);
        let tagsString = state.selectedItem.subitems[getSubitemIndex()].tags.trim() + ' ';
        $auto_complete_tags.onChange(state.selectedItem, state.selectedSubitemPath, tagsString);
    }

    function onSearchClick(e) {
        handleEvent(e, 'onSearchClick');
        if (canTakeAction('onSearchClick()') === false) {
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
        if (canTakeAction('onSearchFocusOut()') === false) {
            return;
        }
        $auto_complete_search.hideOptions();
        $auto_complete_tags.hideOptions();
    }

    function onEscape() {
        if (canTakeAction('onEscape()') === false) {
            return;
        }

        if ($auto_complete_search.getModeHidden() === false) {
            $auto_complete_search.hideOptions();
        }
        if ($auto_complete_tags.getModeHidden() === false) {
            $auto_complete_tags.hideOptions();
        }
        if (itemIsSelected()) {
            closeSelectedItem();
            render();
        }
    }

    function actionMoreResults() {
        if (canTakeAction('actionMoreResults()') === false) {
            return;
        }
        state.modeMoreResults = true;
        closeSelectedItem();
        render();
    }

    function actionExpandRedacted(e) {
        if (canTakeAction('actionExpandRedacted()') === false) {
            return;
        }
        handleEvent(e);
        setModeRedacted(false);
        render();
    }

    function setModeRedacted(value) {
        if (value !== state.modeRedacted) {
            $view.resetCache();
            state.modeRedacted = value;
        }
    }

    function itemIsSelected() {
        if (state.selectedItem !== null) {
            return true;
        }
        return false;
    }

    function noItemSelected() {
        if (state.selectedItem === null) {
            return true;
        }
        return false;
    }

    function actionSave(e) {
        handleEvent(e, 'actionSave');
        if (canTakeAction('actionSave()') === false) {
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
        if (canTakeAction('onShell()') === false) {
            return;
        }
        let text = e.currentTarget.innerHTML;
        text = $format.toText(text);

        //TODO: basic checks here

        if (text.includes(CLIPBOARD_ESCAPE_SEQUENCE)) {
            if (state.modeClipboardText === null || state.modeClipboardText.trim() === '') {
                alert("Nothing in clipboard. Ignoring command.");
                return;
            }
            text = text.replace(CLIPBOARD_ESCAPE_SEQUENCE, state.modeClipboardText);
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
            fail: function(){
                onFnFailure();
            },
            error: function() {
                onFnFailure();
            },
            data: JSON.stringify(obj)
        });
    }

    function onOpenFile(e) {
        handleEvent(e, 'onOpenFile');
        if (canTakeAction('onOpenFile()') === false) {
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
            fail: function(){
                onFnFailure();
            },
            error: function() {
                onFnFailure();
            },
            data: JSON.stringify(obj)
        });
    }

    function onCopy(e) {
        handleEvent(e, 'onCopy');
        if (canTakeAction('onCopy()') === false) {
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
        state.modeClipboardText = text;
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
        if (canTakeAction('actionGotoSearch()') === false) {
            return;
        }
        let text = e.target.innerText;
        $view.setSearchText(text);
        actionEditSearch();
        handleEvent(e, 'actionGotoSearch');
    }

    function actionJumpToSearchBar(e) {
        if (canTakeAction('actionJumpToSearchBar()') === false) {
            return;
        }
        let el = $('#search-input'); //TODO move to view
        placeCaretAtEndInput(el);
        $auto_complete_search.focus();
        actionEditSearch();
    }

    function onCheck(e) {
        handleEvent(e, 'onCheck');
        if (canTakeAction('onCheck()') === false) {
            return;
        }
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = getItemIdFromPath(path);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace(META_TODO, META_DONE); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        render();
    }

    function onUncheck(e) {
        handleEvent(e, 'onUncheck');
        if (canTakeAction('onUncheck()') === false) {
            return;
        }
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = getItemIdFromPath(path);
        let item = $model.getItemById(id);
        let subitem = $model.getSubitem(item, path);
        let text = subitem.tags.replace(META_DONE, META_TODO); //TODO: proper regex
        $model.updateSubTag(item, path, text);
        render();
    }

    function onClickSelectSearchSuggestion(e) {
        handleEvent(e, 'onClickSelectSearchSuggestion');
        if (canTakeAction('onClickSelectSearchSuggestion()') === false) {
            return;
        }
        $auto_complete_search.selectSuggestion();
        actionEditSearch();
    }

    //TODO: what does this do again?
    function navigate(newSubitemPath) {
        if (itemIsSelected() && newSubitemPath !== state.selectedSubitemPath) {
            state.selectedSubitemPath = newSubitemPath;
            render();
        }
    }

    function onUpArrow(e) {
        
        if (canTakeAction('onUpArrow()') === false) {
            return;
        }

        if ($auto_complete_search.getModeHidden() === false) {
            $auto_complete_search.arrowUp();
            handleEvent(e, 'onUpArrow');
            return;
        }
        
        if ($auto_complete_tags.getModeHidden() === false) {
            $auto_complete_tags.arrowUp();
            handleEvent(e, 'onUpArrow');
            return;
        }
        
        if (itemIsSelected()) {
            let pos = $view.getCaretPositionOfSelectedItem();
            if (pos.location === 0) {
                navigate($model.getPrevSubitemPath(state.selectedItem, state.selectedSubitemPath));
                let div = $view.getSubitemElementByPath(state.selectedSubitemPath);
                placeCaretAtStartContentEditable(div);
                handleEvent(e, 'onUpArrow');
            }
            else {
                // let div = $view.getSubitemElementByPath(state.selectedSubitemPath);
                // placeCaretAtStartContentEditable(div);
            }
            return;
        }
    }

    function onDownArrow(e) {
        
        if (canTakeAction('onDownArrow()') === false) {
            return;
        }
        if ($auto_complete_search.getModeHidden() === false) {
            $auto_complete_search.arrowDown();
            handleEvent(e, 'onDownArrow');
            return;
        }
        
        if ($auto_complete_tags.getModeHidden() === false) {
            $auto_complete_tags.arrowDown();
            handleEvent(e, 'onDownArrow');
            return;
        }
        
        if (itemIsSelected()) {
            let pos = $view.getCaretPositionOfSelectedItem();
            console.log('pos = ' + pos.location);
            if (pos.location === pos.textLength) {
                navigate($model.getNextSubitemPath(state.selectedItem, state.selectedSubitemPath));
                handleEvent(e, 'onDownArrow');
            }
            else {
                // let div = $view.getSubitemElementByPath(state.selectedSubitemPath);
                // placeCaretAtEndInput(div);
            }
            return;
        }
    }

    function updateSelectedSearchSuggestion(id) {
        if (canTakeAction('updateSelectedSearchSuggestion()') === false) {
            return;
        }
        if (id === undefined) {
            $auto_complete_search.updateSelectedSearchSuggestion();
        }
        else {
            $auto_complete_search.updateSelectedSearchSuggestion(id);
        }
    }

    function updateSelectedTagSuggestion(id) {
        if (canTakeAction('updateSelectedTagSuggestion()') === false) {
            return;
        }
        if (id === undefined) {
            $auto_complete_tags.updateSelectedTagSuggestion();
        }
        else {
            $auto_complete_tags.updateSelectedTagSuggestion(id);
        }
    }

    //TODO: this is an ugly way to set state.
    function setMoreResults(value) {
        state.modeMoreResults = value;
    }

    function onClickMenu() {
        if (canTakeAction('onClickMenu()') === false) {
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
            if (part === '') {
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
        if (canTakeAction('actionPasswordProtectionSettings()') === false) {
            return;
        }
        deselect();
        function after(newPassword) {
            state.modeModal = false;
            $protection.setPassword(newPassword);
            $model.setTimestampLastUpdate(Date.now());
            actionLogOut();
        }
        state.modeModal = true;
        $password_protection_dlg.open_dialog(after);
    }

    function resetAllCache() {
        $view.resetCache();
        $auto_complete_tags.resetCache();
        $model.resetTagCountsCache();
        $sidebar.resetCache();
        $parseSearch.resetCache();
    }

    function actionMakeLinkEmbed(e) {
        handleEvent(e, 'actionMakeLinkEmbed');
        if (canTakeAction('actionMakeLinkEmbed()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }
        state.subsectionClipboard = [{data: "@id="+state.selectedItem.id, tags: "@embed", indent:0}];
    }

    function getItemIdFromPath(path) {
        return parseInt(path.split(':')[0]);
    }

    function getSubitemIndexFromPath(path) {
        return parseInt(path.split(':')[1]);
    }

    function getSubitemIndex() {
        if (noSubitemSelected()) {
            console.warn('why is no subitem selected here?');
            return 0;
        }
        return parseInt(state.selectedSubitemPath.split(':')[1]);
    }

    function getSelectedPath() {
        if (state.selectedItem === null) {
            throw "No item selected";
        }
        let path = state.selectedItem.id+':'+state.selectedSubitemPath;
        return path;
    }

    function actionCopySubsection(e) {
        handleEvent(e, 'actionCopySubsection');
        if (canTakeAction('actionCopySubsection()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }

        let subitemIndex = getSubitemIndex();
        let _subsectionClipboard = $model.copySubsection(state.selectedItem, subitemIndex);

        if (_subsectionClipboard.length === 1 && _subsectionClipboard[0].data === '') {
            alert('Cannot copy an empty subsection.');
            return;
        }

        for (let i = 0; i < _subsectionClipboard.length; i++) {
            let path = state.selectedItem.id+':'+(subitemIndex+i);
            $effects.emphasizeSubitem(path);
        }
        $effects.apply_post_render_effects(state.selectedItem);

        state.subsectionClipboard = _subsectionClipboard;

        console.log(state.subsectionClipboard);

        //copy text version to clipboard
        let pseudoItem = new Object();
        pseudoItem.subitems = copyJSON(state.subsectionClipboard);
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
        if (canTakeAction('actionPasteSubsection()') === false) {
            return;
        }
        if (state.subsectionClipboard === null) {
            alert("There is nothing in the clipboard to paste.");
            return;
        }
        if (noItemSelected()) {
            let tags = getTagsFromSearch();
            if (tags === null) {
                console.warn('Cannot add because no valid tags');
                return;
            }
            state.selectedItem = $model.addItemFromSearchBar(tags);
            state.selectedSubitemPath = state.selectedItem.id+':0';
            $model.fullyIncludeItem(state.selectedItem);
        }

        let indexInto = $model.pasteSubsection(state.selectedItem, getSubitemIndex(), state.subsectionClipboard);
        
        for (let i = 0; i < state.subsectionClipboard.length; i++) {
            let path = selectedItem.id+':'+(indexInto+i);
            $effects.emphasizeSubitem(path);
        }
        //TODO: this is yucky, we should unify notation
        if (indexInto > 0) {
            state.selectedSubitemPath = state.selectedItem.id+':'+indexInto;
        }
        render();
    }

    function actionRemoveFormatting(e) {
        handleEvent(e, 'actionRemoveFormatting');
        if (canTakeAction('actionRemoveFormatting()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }
        let subitemIndex = getSubitemIndex();
        $model.removeSubitemFormatting(state.selectedItem, subitemIndex);
        render();
    }

    function actionExtract(e) {
        handleEvent(e, 'actionExtract');

        if (canTakeAction('actionExtract()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }

        let subitemIndex = getSubitemIndex();
        let tags = getTagsFromSearch();
        if (tags === null) {
            console.warn('Cannot add because no valid tags');
            return;
        }
        let updated = $model.extract(state.selectedItem, subitemIndex, tags);
        if (updated) {
            state.selectedSubitemPath = state.selectedItem.id+':'+(subitemIndex-1);
            focusOnSelectedSubItem();
        }
        render();
    }

    function actionSplit(e) {

        handleEvent(e, 'actionSplit');

        if (canTakeAction('actionSplit()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }

        let subitemIndex = getSubitemIndex();
        $model.split(state.selectedItem, subitemIndex);
        render();
    }

    function actionCollapseAllView() {

        if (canTakeAction('actionCollapseAllView()') === false) {
            return;
        }
        const items = $model.getUnsortedItems();
        let toCollapse = [];
        for (let item of items) {
            if (item.subitems[0]._include === 1 &&
                item.subitems.length > 1 &&
                item.collapse === 0) {
                toCollapse.push(item);
            }
        }
        $model.collapseMany(toCollapse);
        render();
    }

    function actionExpandAllView() {

        if (canTakeAction('actionExpandAllView()') === false) {
            return;
        }
        const items = $model.getUnsortedItems();
        let toExpand = [];
        for (let item of items) {
            if (item.subitems[0]._include === 1 &&
                item.subitems.length > 1 &&
                item.collapse === 1) {
                toExpand.push(item);
            }
        }
        $model.expandMany(toExpand);
        render();
    }

    function actionCollapseItem(e) {
        handleEvent(e, 'actionCollapseItem');
        if (canTakeAction('actionCollapseItem()') === false) {
            return;
        }
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = getItemIdFromPath(path);
        let subitemIndex = getSubitemIndexFromPath(path);
        let item = $model.getItemById(id);
        $model.collapse(item, subitemIndex);
        render();
    }
    
    function actionExpandItem(e) {
        handleEvent(e, 'actionExpandItem');
        if (canTakeAction('actionExpandItem()') === false) {
            return;
        }
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = getItemIdFromPath(path);
        let subitemIndex = getSubitemIndexFromPath(path);
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
        if (obj.encryption.encrypted === false) {
            $view.showSpinner();
            try {
                let newItems = null;
                if ($schema.isUpdateRequired(obj.data_schema_version)) {
                    newItems = $schema.updateSchema(obj.data, obj.data_schema_version);
                }
                else {
                    newItems = obj.data;
                }
                
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
            if (state.modeModal) {
                return;
            }
            deselect();
            function after() {
                state.modeModal = false;
                render();
                $view.scrollToTop();
            }
            state.modeModal = true;
            $dlg.restoreFromFile(obj, after);
        }
    }

    function genericModal(fn) {

        if (canTakeAction('genericModal()') === false) {
            return;
        }
        $view.closeAnyOpenMenus();
        deselect();
        function after() {
            state.modeModal = false;
            render();
        }
        state.modeModal = true;
        fn(after);
    }

    function actionRemoveTagCurrentView() {
        genericModal($dlg.removeTagFromCurrentView);
    }

    function actionAddMetaRule() {
        genericModal($dlg.addMetaRule);
    }

    function actionAddTagCurrentView() {
        genericModal($dlg.addTagToCurrentView);
    }

    function setSidebar() {

        if (itemIsSelected()) {
            $sidebar.updateSidebar(state.selectedItem, getSubitemIndex(), true);
            return;
        }
        
        if (state.mousedItemId !== null) {
            let mousedItem = $model.getItemById(state.mousedItemId);
            let index = 0;
            if (state.mousedSubitemId !== null) {
                index = state.mousedSubitemId;
            }
            $sidebar.updateSidebar(mousedItem, index, false);
            return;
        }
    }

    function onMouseMoveOverSubitem(e) {
        if (canTakeAction('onMouseMoveOverSubitem') === false) {
            return;
        }
        if (state.modeMousedown) {

            // NOTE: this logic is for drag-and-drop between items, but may not be used in future

            $view.setCursor('grabbing');

            if (state.itemOnClick.id === state.mousedItemId && state.subitemIdOnClick === state.mousedSubitemId) {
                //same subitem, do nothing
                return;
            }

            let y = e.pageY - $(e.currentTarget).offset().top;
            let height = e.currentTarget.offsetHeight;
            if (y < height/2) {
                if (state.itemOnClick.id === state.mousedItemId) {
                    //console.log('DEBUG2 drag drop UPPER HALF, same item');
                    //$view.setCursor('n-resize');
                }
                else {
                    //console.log('DEBUG2 drag drop UPPER HALF, different item');
                    //$view.setCursor('n-resize');
                }
                
            }
            else {
                if (state.itemOnClick.id === state.mousedItemId) {
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
        $sidebar.clearSidebar();
    }

    function resetInactivityTimer() {
        state.timestampLastActive = Date.now();
        state.modeAlreadyIdleSaved = false;
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
        if (state.modeAlertSafeToExit) {
            alert('Work has been saved.\nIt is now safe to exit.');
            state.modeAlertSafeToExit = false;
        }
    }

    function saveSuccessAfterRestoreFromFile() {
        $unlock.exitLock();
        resetAllCache();
        let recalculated = $ontology.maybeRecalculateOntology();
        if (recalculated) {
            resetAllCache();
        }
        successfulInit();
    }

    function actionPaste(e, pastedTextData, pastedHTMLData) {

        if (subitemIsSelected()) {
            //only do this when nothing selected!
            return;
        }
        //TODO: yucky that I have to test this first

        handleEvent(e, 'actionPaste');

        if (canTakeAction('actionPaste()') === false) {
            return;
        }

        let toPaste = null;
        if (pastedHTMLData === null || pastedHTMLData === '') {
            if (pastedTextData === null || pastedTextData === '') {
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
        if (tags === null) {
            console.warn('Cannot add because no valid tags');
            return;
        }
        let newItem = $model.addItemFromSearchBar(tags);
        state.selectedItem = newItem;
        $effects.temporary_highlight(state.selectedItem.id);
        state.selectedSubitemPath = newItem.id+':0';
        onEnterEditingSubitem();
        $model.updateSubitemData(newItem, state.selectedSubitemPath, toPaste);
        deselect();
        render();
        $view.scrollToTop();
    }

    function onShiftEnter(event) {

        /*
        This function allows adding additional newlines inside a subitem.
        */

        if (canTakeAction('onShiftEnter()') === false) {
            handleEvent(event, 'onShiftEnter');
            return;
        }

        if (itemIsSelected() === false) {
            handleEvent(event, 'onShiftEnter');
            return;
        }
        
    }

    function genericToggleFormatTag(tag, event) {

        handleEvent(event, 'genericToggleFormatTag');
        if (canTakeAction('genericToggleFormatTag()') === false) {
            return;
        }
        let subitem = $model.getSubitem(state.selectedItem, state.selectedSubitemPath);
        if (subitem._implied_tags.includes(tag)) {
            return;
        }
        $model.toggleFormatTag(state.selectedItem, state.selectedSubitemPath, tag);
        $view.setTagInput(subitem.tags);
        $sidebar.updateSidebar(state.selectedItem, getSubitemIndex(), true);
        $auto_complete_tags.hideOptions();
        state.modeFocus = FOCUS_EDIT_BAR;
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
        if (canTakeAction('onDblClickSubitem()') === false) {
            return;
        }
        onEscape();
    }

    function getClipboardText() {
        return state.modeClipboardText;
    }

    function render() {
        $view.render(state.selectedItem, state.selectedSubitemPath, state.modeMoreResults, state.modeRedacted);
        if (subitemIsSelected()) {
            focusOnSelectedSubItem();
            let el = $view.getItemElementById(state.selectedItem.id);
            $view.onMouseoverAndSelected(el);
        }
        clearSidebar();
        state.modeSkippedRender = false;
        $view.hideSpinner();
    }

    function actionLogOut() {

        if (canTakeAction('actionLogOut()') === false) {
            return;
        }

        if (state.timestampLastIdleSaved !== $model.getTimestampLastUpdate()) {
            //TODO: this should never happen
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

    function onMouseoverDelete() {
        let el = document.querySelector('.selected-item');
        el.classList.remove('selected-item');
        el.classList.add('selected-item-warn-of-delete');
    }

    function onMouseoutDelete() {
        let el = document.querySelector('.selected-item-warn-of-delete');
        el.classList.remove('selected-item-warn-of-delete');
        el.classList.add('selected-item');
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
        state.timestampLastIdleSaved = $model.getTimestampLastUpdate();
        resetInactivityTimer();
        $view.showMainApp();
        $view.setSpinnerContentLoading();
        $view.hideSpinner();

        console.log('successfulInit()');
    }


    function init() {

        console.log('connecting to websocket...');
        state.ws = new WebSocket('ws://localhost:3001');
        state.ws.onopen = function() {
            console.log('WebSocket opened');
            state.ws.send('Hello!');
        }

        state.ws.onmessage = function(event) {
            console.log("WS message: " + event.data);
        }

        //TODO: not if grabbing from server
        if (testLocalStorage() === false) {
            $view.gotoErrorPage();
            return;
        }

        let search = localStorage.getItem('search');
        if (search !== null && search !== 'null') {
            $view.setSearchText(search);
        }
        else {
            localStorage.removeItem('search');
            $view.setSearchText('');
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
        actionAddLink: actionAddLink,
        actionMakeLinkEmbed: actionMakeLinkEmbed,
        actionCopySubsection: actionCopySubsection,
        actionPasteSubsection: actionPasteSubsection,
        actionRemoveFormatting: actionRemoveFormatting,
        actionSplit: actionSplit,
        actionExtract: actionExtract,
		actionEditTag: actionEditTag,
		actionEditTime: actionEditTime,
		actionEditSearch: actionEditSearch,
        actionExportViewAsText: actionExportViewAsText,
		actionAddSubItem: actionAddSubItem,
		actionMouseoverItem: actionMouseoverItem,
		actionMouseoffItem: actionMouseoffItem,
		actionMousedownItem: actionMousedownItem,
		actionMouseupItem: actionMouseupItem,
		actionFocusEditTag: actionFocusEditTag,
        actionMoreResults: actionMoreResults,
        actionExpandRedacted: actionExpandRedacted,
        actionSave: actionSave,
        actionRenameTag: actionRenameTag,
        actionReplaceText: actionReplaceText,
        actionDeleteTag: actionDeleteTag,
        actionAddTagCurrentView: actionAddTagCurrentView,
        actionRemoveTagCurrentView: actionRemoveTagCurrentView,
        actionAddMetaRule: actionAddMetaRule,
        actionGotoSearch: actionGotoSearch,
        actionPasswordProtectionSettings: actionPasswordProtectionSettings,
        actionGenerateRandomPassword: actionGenerateRandomPassword,
        actionCollapseAllView: actionCollapseAllView,
        actionExpandAllView: actionExpandAllView,
        actionCollapseItem: actionCollapseItem,
        actionExpandItem: actionExpandItem,
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
        onMouseoverDelete: onMouseoverDelete,
        onMouseoutDelete: onMouseoutDelete,
        itemIsSelected: itemIsSelected,
        updateSelectedSearchSuggestion: updateSelectedSearchSuggestion,
        updateSelectedTagSuggestion: updateSelectedTagSuggestion,
        setMoreResults: setMoreResults,
        onClickMenu: onClickMenu,
        setSidebar: setSidebar,
        clearSidebar: clearSidebar,
        resetInactivityTimer: resetInactivityTimer,
        actionPaste: actionPaste,
        getClipboardText: getClipboardText,
        getValidSearchTags: getValidSearchTags,
        resetAllCache: resetAllCache,
        maybeResetSearch: maybeResetSearch,
        successfulInit: successfulInit
    };
})();
