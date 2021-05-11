"use strict";

/* TODO
   - consolidate how saveSuccess and saveFail work across functions
   - all mentions of DOM elements should be handled by $view
   - all mentions of localStorage should be handled by $persist
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

    ///////////////////////////////////////////////////////////////////

    function eventRouter(eventName, e) {
        if (canTakeAction(eventName) === false) {
            return;
        }
        let key = `${state.state_machine}::${eventName}`;
        let possible_keys = [key];
        if (STATE_IMPLICATIONS[state.state_machine] !== undefined) {
            for (let lhs of STATE_IMPLICATIONS[state.state_machine]) {
                possible_keys.push(`${lhs}::${eventName}`);
            }
        }
        let match = false;
        for (let possible_key of possible_keys) {
            if (eventRoutes[possible_key] !== undefined) {
                console.log(`${possible_key}`);
                eventRoutes[possible_key](e);
                match = true;
            }
        }
        if (match == false) {
            console.warn(`IGNORED EVENT: event ${eventName} in state ${state.state_machine} is undefined`);
            return;
        }
        else {
            handleEventCancel(e, eventName);
        }
    }

    ///////////////////////////////////////////////////////////////////

    const eventRoutes = {
        '**STATES::EVENT_ON_SAVE': (e) => {
            if (state.state_machine !== STATE_DIALOG) {
                genericModal($backup_dlg.open_dialog); //TODO: kind of ugly
            }
        },
        '**STATES::EVENT_ON_LOGOUT': (e) => {
            actionLogOut(e);
        },
        '**STATES_NON_EDIT::EVENT_ON_CLICK_ADD_NEW_ITEM': (e) => {
            actionAddItemFromNonEditing();
            transitionRouter(STATE_EDIT_CONTENT);
        },
        '**STATES_EDIT::EVENT_ON_CLICK_ADD_NEW_SUBITEM': (e) => {
            actionAddSubItemNoIndent(e);
            transitionRouter(STATE_EDIT_CONTENT);
        },
        '**STATES_EDIT::EVENT_ON_CLICK_ADD_NEW_ITEM': (e) => {
            transitionRouter(STATE_DEFAULT);
            actionAddItemFromNonEditing();
            transitionRouter(STATE_EDIT_CONTENT);
        },
        '**STATES_EDIT::EVENT_ON_CLICK_CTRL_SHIFT_ENTER': (e) => {
            actionAddSubItemIndent(e);
            transitionRouter(STATE_EDIT_CONTENT);
        },
        '**STATES_EDIT::EVENT_ON_CLICK_CTRL_ENTER': (e) => {
            actionAddSubItemNoIndent(e);
            transitionRouter(STATE_EDIT_CONTENT);
        },
        '**STATES_EDIT::EVENT_ON_CLICK_DELETE': (e) => {
            actionDeleteButton(e);
        },
        'STATE_DEFAULT::EVENT_ON_CLICK_ENTER': (e) => {
            actionAddItemFromNonEditing(e);
            transitionRouter(STATE_EDIT_CONTENT);
        },
        'STATE_DEFAULT::EVENT_ON_CLICK_TAB': (e) =>  {
            actionJumpToSearchBar(e);
        },
        'STATE_SEARCH::EVENT_ON_CLICK_ENTER': (e) => {
            if ($auto_complete_search.getModeHidden() === false &&
                state.selectedSuggestionId > 0) { //TODO: make a substate?
                $auto_complete_search.selectSuggestion();
                actionEditSearch();
            }
            else {
                actionAddItemFromNonEditing();
                transitionRouter(STATE_EDIT_CONTENT);
            }
        },
        'STATE_EDIT_CONTENT::EVENT_ON_CLICK_TAB': (e) => {
            $sidebar.updateSidebar(state.selectedItem, getSubitemIndex(), true);  //TODO move to fsm
            transitionRouter(STATE_EDIT_TAGS);
        },
        'STATE_EDIT_TAGS::EVENT_ON_CLICK_ENTER': (e) => {
            if ($auto_complete_tags.getModeHidden() === false &&
                state.selectedTagSuggestionId > 0) { //TODO: make a substate?
                $auto_complete_tags.selectSuggestion(state.selectedItem, state.selectedSubitemPath);
                $sidebar.updateSidebar(state.selectedItem, getSubitemIndex(), true);
            }
        },
        'STATE_EDIT_TAGS::EVENT_ON_CLICK_TAB': (e) => {
            $sidebar.updateSidebar(state.selectedItem, getSubitemIndex(), true);  //TODO move to fsm
            transitionRouter(STATE_EDIT_CONTENT);
        }
    };

    ///////////////////////////////////////////////////////////////////

    function enableEditTags() {
        let item = state.selectedItem;
        let subitemIndex = getSubitemIndex();
        let tags = item.subitems[subitemIndex].tags;
        //TODO: refactor into $view
        function focusOnTag() {
            let el = $view.getItemTagElementById(item.id);
            actionFocusEditTag();  //TODO: factor this out
            if (tags.trim().length > 0) {
                el.value = tags.trim() + ' '; //add space at end if not there to trigger suggestions
                actionEditTag();
            }
            placeCaretAtEndInput(el);
        }
        focusOnTag();
    }

    function enableEditingMode() {
        state.copyOfSelectedItemBeforeEditing = copyJSON(state.selectedItem);
        state.copyOfSelectedSubitemBeforeEditing = copyJSON($model.getSubitem(state.selectedItem, state.selectedSubitemPath));
        renderEditing();
        $view.focusSubitem(state.selectedSubitemPath);
    }

    function disableEditingMode() {
        let subitem = $model.getSubitem(state.selectedItem, state.selectedSubitemPath);
        if (subitem !== null) {
            let newData = subitem.data;
            if (newData !== state.copyOfSelectedSubitemBeforeEditing.data) {
                //TODO: hacky to have this done in controller!
                autoformat(state.selectedItem, state.selectedSubitemPath, state.copyOfSelectedSubitemBeforeEditing.data, newData);
            }
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

    //TODO this should eventually be state driven
    function canTakeAction(context) {
        if (context === undefined) {
            context = '';
        }
        if ($persist.isMutexLocked()) {
            console.warn(context+ ' Blocked by $persist.isMutexLocked()');
            return false;
        }
        if ($unlock.isLocked()) {
            console.warn(context + ' blocked by $unlock.getIsLocked()');
            return false;
        }
        return true;
    }

    //TODO can we move all refs to this into the state machine?
    function deselect() {
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
        clearSidebar();
    }

    function handleEventCancel(event, msg) {
        if (event !== undefined) {
            event.stopPropagation();
            event.preventDefault();
        }
    }

    function actionAddLink(event, url) {
        //TODO when exactly is this triggered?
        alert('actionAddLink TODO');
        return;
        // actionAddNewItem(event);
        // $model.updateSubitemData(state.selectedItem, state.selectedItem.id+":"+0, url);
        // transitionRouter(STATE_DEFAULT);
    }

    function actionAddItemFromNonEditing() {
        state.modeMoreResults = false; //TODO: move to transition
        setModeRedacted(true);
        let tags = $auto_complete_search.getTagsFromSearch();
        state.selectedItem = $model.addItemFromSearchBar(tags);
        $effects.temporary_highlight(state.selectedItem.id);
        state.selectedSubitemPath = state.selectedItem.id+':0';
        $model.fullyIncludeItem(state.selectedItem);
        let el = $view.getItemElementById(state.selectedItem.id);
        $view.onMouseoverAndSelected(el);
    }

    function actionAddSubItemIndent(e) {
        state.selectedSubitemPath = $model.addSubItem(state.selectedItem, getSubitemIndex(), true);
        renderEditing();
    }

    function actionAddSubItemNoIndent(e) {
        state.selectedSubitemPath = $model.addSubItem(state.selectedItem, getSubitemIndex(), false);
        renderEditing();
    }

    function actionDeleteButton(e) {
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

    //TODO: this should be broken into separate functions for subitem vs item delete
    function actionDelete(event) {
        handleEventCancel(event, 'actionDelete');
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
            transitionRouter(STATE_DEFAULT);
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
            transitionRouter(STATE_EDIT_CONTENT);
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

    //TODO rename to onEvent format
    //TODO add states
    function actionFullUp(event) {
        handleEventCancel(event, 'actionFullUp');
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
            // at bottom, do nothing
            return;
        }
        transportItem(firstFilteredItem);
    }

    function actionFullDown(event) {
        handleEventCancel(event, 'actionFullDown');
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
        transportItem(lastFilteredItem);
    }

    function transportItem(item) {
        $effects.temporary_highlight(state.selectedItem.id);
        let migrated = $model.drag(state.selectedItem, item);
        if (migrated.length <= MAX_SHADOW_ITEMS_ON_MOVE) {
            for (let id of migrated) {
                $effects.temporary_shadow(id);
            }
        }
        transitionRouter(STATE_DEFAULT);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionUp(event) {
        handleEventCancel(event, 'actionUp');
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
        if (itemIsSelected()) {
            transitionRouter(STATE_EDIT_CONTENT);
        }
        else {
            transitionRouter(STATE_DEFAULT);
        }
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionDown(event) {
        handleEventCancel(event, 'actionDown');
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
        if (itemIsSelected()) {
            transitionRouter(STATE_EDIT_CONTENT);
        }
        else {
            transitionRouter(STATE_DEFAULT);
        }
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionIndent() {
        handleEventCancel(event, 'actionIndent');
        if (canTakeAction('actionIndent()') === false) {
            return;
        }
        if (getSubitemIndex() > 0) {
            $model.indentSubitem(state.selectedItem, state.selectedSubitemPath);
            render();
        }
        if (itemIsSelected()) {
            transitionRouter(STATE_EDIT_CONTENT);
        }
        else {
            transitionRouter(STATE_DEFAULT);
        }
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionUnindent() {
        handleEventCancel(event, 'actionUnindent');
        if (canTakeAction('actionUnindent()') === false) {
            return;
        }
        if (getSubitemIndex() > 0) {
            $model.unindentSubitem(state.selectedItem, state.selectedSubitemPath);
            render();
        }
        if (itemIsSelected()) {
            transitionRouter(STATE_EDIT_CONTENT);
        }
        else {
            transitionRouter(STATE_DEFAULT);
        }
    }

    //TODO: why are we doing this?
    function onClickEditBar(event) {
        handleEventCancel(event, 'onClickEditBar');
    }

    //TODO: add states
    //TODO: make a selected and non-selected version of this
    function onClickSubitem(event) {
        handleEventCancel(event, 'onClickSubitem');
        if (canTakeAction('onClickSubitem()') === false) {
            return;
        }

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
            state.selectedSubitemPath = state.recentClickedSubitem;
            if (state.selectedItem.id !== itemId) {
                doSelect = true;
            }
        }
        else {
            doSelect = true;
        }
        if (doSelect) {
            let itemId = parseInt(this.dataset.subitemPath.split(':')[0]);
            state.selectedItem = $model.getItemById(itemId);
            state.copyOfSelectedItemBeforeEditing = copyJSON(state.selectedItem);
            state.selectedSubitemPath = state.recentClickedSubitem;
            state.mousedItemId = state.selectedItem.id;
            state.mousedSubitemId = getSubitemIndexFromPath(path);
            render();
        }
        transitionRouter(STATE_EDIT_CONTENT);
        $view.onFocusSubitem(event);
        if (itemIsSelected()) {
            console.log(state.selectedItem);
        }
        state.recentClickedSubitem = null;
        setSidebar();
    }

    function onClickDocument(event) {
        if (state.state_machine == STATE_EDIT_CONTENT || state.state_machine == STATE_EDIT_TAGS ||
            state.state_machine == STATE_SEARCH || state.state_machine == STATE_MENU ||
            state.state_machine == STATE_DIALOG) {
            handleEventCancel(event, 'onClickDocument');
            transitionRouter(STATE_DEFAULT);
        }
    }

    //TODO: use states, this should never be called
    function subitemIsSelected() {
        if (state.selectedSubitemPath !== null) {
            return true;
        }
        return false;
    }

    //TODO: use states, this should never be called
    function noSubitemSelected() {
        if (state.selectedSubitemPath === null) {
            return true;
        }
        return false;
    }

    //TODO: add states
    function onEditSubitem(event) {
        handleEventCancel(event, 'onEditSubitem');
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
        transitionRouter(STATE_EDIT_CONTENT);
    }

    //TODO: add states
    function onFocusSubitem(event) {
        $view.onFocusSubitem(event);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionEditTime(event) {
        handleEventCancel(event, 'actionEditTime');
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
        transitionRouter(STATE_EDIT_CONTENT);
    }

    function onClickTagBar(e) {
        handleEventCancel(e, 'onClickTagBar');
        transitionRouter(STATE_EDIT_TAGS);
    }

    //TODO: onEvent syntax
    //TODO: add states
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
        $auto_complete_tags.onChange(state.selectedItem, state.selectedSubitemPath, tagsString);
        $auto_complete_tags.showOptions();
        $sidebar.updateSidebar(state.selectedItem, subitemIndex, true);
        //transitionRouter(STATE_EDIT_TAGS);
    }

    //TODO: onEvent syntax
    //TODO: add states
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

    //TODO: onEvent syntax
    //TODO: add states
    function actionEditSearch() {
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
        transitionRouter(STATE_SEARCH);
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

    //TODO: onEvent syntax
    //TODO: add states
    function actionMouseoverItem(e) {

        if (state.state_machine === STATE_SEARCH ||
            state.state_machine === STATE_MENU) {  //TODO: this is kind of ugly

            transitionRouter(STATE_DEFAULT);
        }

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
        }

        if (state.itemOnClick !== null && state.itemOnClick.id !== state.mousedItemId) {
            $view.removeAllRanges();
        }

        setSidebar();
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionMouseoffItem(e) {
        $view.onMouseoff();
        state.mousedItemId = null;
        state.mousedSubitemId = null;
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionMousedownItem(e) {
        if (canTakeAction('actionMousedown()') === false) {
            return;
        }
        state.itemOnClick = $model.getItemById(state.mousedItemId);
        state.subitemIdOnClick = state.mousedSubitemId;
        state.xOnClick = e.clientX;
        state.modeMousedown = true;
        if (state.itemOnClick !== null) {
            if (noItemSelected()) {
                $view.setCursor("grab");
            }
            else {
                if (state.selectedItem.id !== state.itemOnClick.id) {
                    $view.setCursor("grab");
                }
            }
        }
    }

    //TODO add STATE_DRAGGING
    //TODO: onEvent syntax
    //TODO: add states
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

        //TODO: state
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
                deselect();  //TODO state transition instead?
                render();   
                return;
            }
        }

        //TODO: This is spaghetti
        if (itemIsSelected() &&
            state.itemOnRelease !== null &&
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

        deselect();
    }

    //TODO: add states
    function onBackspaceUp() {
        state.modeBackspaceKey = false;
        //TODO: what if cannot take action? Get stuck not knowing state?
        if (state.state_machine == STATE_SEARCH && state.modeSkippedRender === true) {
            actionEditSearch();
        }
    }

    //TODO: add states
    function onBackspaceDown(e) {
        //TODO: should we capture key event even if cannot take action?
        if (canTakeAction('onBackspaceDown()') === false) {
            return;
        }
        state.modeBackspaceKey = true;
    }

    //TODO: combine with other onCheckForIdle function?
    //TODO: add states
    function onCheckForIdleWhileEditing() {

        //TODO: just do canTakeAction()? No, locked breaks it
        if ($persist.isMutexLocked()) {
            return;
        }

        //TODO: add states
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
                pushState(STATE_SAVING_DIFF);
                $persist.saveToHostOnIdle(
                    saveSuccessAfterIdle, 
                    saveFail
                );
            } 
        }

        if ($protection.getModeProtected() &&
            elapsed > LOCK_AFTER_MS_OF_IDLE) {
                location.reload();
        }
        
    }

    //TODO: combine with other onCheckForIdle function?
    //TODO: add states
    function onCheckForIdle() {

        //TODO: just do canTakeAction()? No, locked breaks it
        if ($persist.isMutexLocked()) {
            return;
        }

        let now = Date.now();
        let elapsed = now - state.timestampLastActive;

        //TODO: add states
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
                pushState(STATE_SAVING_DIFF);
                $persist.saveToHostOnIdle(
                    saveSuccessAfterIdle, 
                    saveFail
                );
            } 
        }

        if ($protection.getModeProtected() &&
            elapsed > LOCK_AFTER_MS_OF_IDLE) {
                location.reload();
        }
    }

    function onWindowFocus() {
        state.timestampFocused = Date.now();
    }

    function onEnter(e) {

        //This is for login screen
        //Must happen before canTakeAction
        //TODO: fix this to work with router
        if ($unlock.isLocked()) {
            $('#ok-unlock').click();
            handleEventCancel(e, 'onEnter');
            return;
        }

        eventRouter(EVENT_ON_CLICK_ENTER, e);
    }

    function onTab(e) {
        eventRouter(EVENT_ON_CLICK_TAB, e);
    }

    //TODO: add states
    function onClickTagSuggestion() {
        if (canTakeAction('onClickTagSuggestion()') === false) {
            return;
        }
    	$auto_complete_tags.selectSuggestion(state.selectedItem, state.selectedSubitemPath);
        let tagsString = state.selectedItem.subitems[getSubitemIndex()].tags.trim() + ' ';
        $auto_complete_tags.onChange(state.selectedItem, state.selectedSubitemPath, tagsString);
        transitionRouter(STATE_EDIT_TAGS);
    }

    //TODO: add states
    function onEscape() {
        if (canTakeAction('onEscape()') === false) {
            return;
        }

        if ($auto_complete_search.hasFocus()) {
            $view.setSearchText('');
            $auto_complete_search.onChange();
            render();
            transitionRouter(STATE_SEARCH);
        }
        else {
            transitionRouter(STATE_DEFAULT);
        }
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionMoreResults() {
        if (canTakeAction('actionMoreResults()') === false) {
            return;
        }
        state.modeMoreResults = true;
        render(); //TODO: capture as a state?
        transitionRouter(STATE_DEFAULT);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionExpandRedacted(e) {
        if (canTakeAction('actionExpandRedacted()') === false) {
            return;
        }
        handleEventCancel(e);
        setModeRedacted(false);
        render();
        transitionRouter(STATE_DEFAULT);
    }

    function setModeRedacted(value) {
        if (value !== state.modeRedacted) {
            $view.resetCache();
            state.modeRedacted = value;
        }
    }

    //TODO use states, never this
    function itemIsSelected() {
        if (state.selectedItem !== null) {
            return true;
        }
        return false;
    }

    //TODO use states, never this
    function noItemSelected() {
        if (state.selectedItem === null) {
            return true;
        }
        return false;
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

    //TODO: add states
    function onShell(e) {
        handleEventCancel(e, 'onShell');
        if (canTakeAction('onShell()') === false) {
            return;
        }
        let text = e.currentTarget.innerHTML;
        text = $format.toText(text);
        //TODO: basic checks here
        if (text.includes(CLIPBOARD_ESCAPE_SEQUENCE)) {
            if (state.clipboardText === null || state.clipboardText.trim() === '') {
                alert("Nothing in clipboard. Ignoring command.");
                return;
            }
            text = text.replace(CLIPBOARD_ESCAPE_SEQUENCE, state.clipboardText);
        }

        function onFnSuccess(message) {
            console.log('-----------------------------');
            console.log(message)
            console.log('-----------------------------');
        }

        function onFnFailure() { alert('FAILED'); }

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
            data: JSON.stringify({ command: text})
        });
        transitionRouter(STATE_DEFAULT);
    }

    //TODO: add states
    function onOpenFile(e) {
        handleEventCancel(e, 'onOpenFile');
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
        transitionRouter(STATE_DEFAULT);
    }

    //TODO: add states
    function onCopy(e) {
        handleEventCancel(e, 'onCopy');
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
        state.clipboardText = text;
        let _onCopy = function(e) {
          e.clipboardData.setData('text/plain', text);
          e.preventDefault();
        };
        document.addEventListener('copy', _onCopy);
        document.execCommand('copy');
        document.removeEventListener('copy', _onCopy);

        render();
    }

    function actionJumpToSearchBar(e) {
        if (canTakeAction('actionJumpToSearchBar()') === false) {
            return;
        }
        let el = $('#search-input'); //TODO move to view
        placeCaretAtEndInput(el);
        $auto_complete_search.focus();
        actionEditSearch();
        transitionRouter(STATE_SEARCH);
    }

    //TODO: add states
    function onCheck(e) {
        handleEventCancel(e, 'onCheck');
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
        transitionRouter(STATE_DEFAULT);
    }

    //TODO: add states
    function onUncheck(e) {
        handleEventCancel(e, 'onUncheck');
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
        transitionRouter(STATE_DEFAULT);
    }

    //TODO: add states
    function onClickSelectSearchSuggestion(e) {
        handleEventCancel(e, 'onClickSelectSearchSuggestion');
        if (canTakeAction('onClickSelectSearchSuggestion()') === false) {
            return;
        }
        $auto_complete_search.selectSuggestion();
        actionEditSearch();
        transitionRouter(STATE_DEFAULT);
    }

    //TODO: what does this do again?
    function navigate(newSubitemPath) {
        if (itemIsSelected() && newSubitemPath !== state.selectedSubitemPath) {
            state.selectedSubitemPath = newSubitemPath;
            render();
        }
    }

    //TODO: add states
    function onUpArrow(e) {
        
        if (canTakeAction('onUpArrow()') === false) {
            return;
        }

        if ($auto_complete_search.getModeHidden() === false) {
            $auto_complete_search.arrowUp();
            handleEventCancel(e, 'onUpArrow');
            transitionRouter(STATE_DEFAULT);
            return;
        }
        
        if ($auto_complete_tags.getModeHidden() === false) {
            $auto_complete_tags.arrowUp();
            handleEventCancel(e, 'onUpArrow');
            transitionRouter(STATE_EDIT_TAGS);
            return;
        }
        
        if (itemIsSelected()) {
            let pos = $view.getCaretPositionOfSelectedItem();
            if (pos.location === 0) {
                navigate($model.getPrevSubitemPath(state.selectedItem, state.selectedSubitemPath));
                let div = $view.getSubitemElementByPath(state.selectedSubitemPath);
                placeCaretAtStartContentEditable(div);
                handleEventCancel(e, 'onUpArrow');
            }
            else {
                // let div = $view.getSubitemElementByPath(state.selectedSubitemPath);
                // placeCaretAtStartContentEditable(div);
            }
            transitionRouter(STATE_EDIT_CONTENT);
            return;
        }
    }

    //TODO: add states
    function onDownArrow(e) {
        
        if (canTakeAction('onDownArrow()') === false) {
            return;
        }

        //TODO: use statae variables here

        if ($auto_complete_search.getModeHidden() === false) {
            $auto_complete_search.arrowDown();
            handleEventCancel(e, 'onDownArrow');
            return;
        }
        
        if ($auto_complete_tags.getModeHidden() === false) {
            $auto_complete_tags.arrowDown();
            handleEventCancel(e, 'onDownArrow');
            return;
        }
        
        if (itemIsSelected()) {
            let pos = $view.getCaretPositionOfSelectedItem();
            //console.log('pos = ' + pos.location);
            if (pos.location === pos.textLength) {
                navigate($model.getNextSubitemPath(state.selectedItem, state.selectedSubitemPath));
                handleEventCancel(e, 'onDownArrow');
            }
            else {
                // let div = $view.getSubitemElementByPath(state.selectedSubitemPath);
                // placeCaretAtEndInput(div);
            }
            //stateMachine(STATE_EDIT_CONTENT);
            return;
        }
    }

    //TODO: action syntax
    //TODO: add states
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

    //TODO: action syntax
    //TODO: add states
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
        transitionRouter(STATE_EDIT_TAGS);
    }

    //TODO: this is an ugly way to set state.
    function setMoreResults(value) {
        state.modeMoreResults = value;
        transitionRouter(STATE_DEFAULT);  //TODO: always true?
    }

    //TODO: add states
    function onClickMenu() {
        if (canTakeAction('onClickMenu()') === false) {
            return;
        }
        transitionRouter(STATE_MENU);
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

    function actionGenerateRandomPassword(e) {
        handleEventCancel(e, 'actionGenerateRandomPassword');
        if (canTakeAction('actionGenerateRandomPassword()') === false) {
            return;
        }
        genericModal($random_password_generator_dlg.open_dialog);
    }

    function actionPasswordProtectionSettings(e) {
        handleEventCancel(e, 'actionPasswordProtectionSettings');
        if (canTakeAction('actionPasswordProtectionSettings()') === false) {
            return;
        }
        function after(newPassword) {
            $protection.setPassword(newPassword);
            $model.setTimestampLastUpdate(Date.now());
            actionLogOut(e);  //TODO: refactor to regular event
        }
        $password_protection_dlg.open_dialog(after);
        transitionRouter(STATE_DIALOG);
    }

    function resetAllCache() {
        $view.resetCache();
        $auto_complete_tags.resetCache();
        $model.resetTagCountsCache();
        $sidebar.resetCache();
        $parseSearch.resetCache();
    }

    //TODO asdf get rid of this
    function actionMakeLinkEmbed(e) {
        handleEventCancel(e, 'actionMakeLinkEmbed');
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

    //TODO: onEvent syntax
    //TODO: add states
    function actionCopySubsection(e) {
        handleEventCancel(e, 'actionCopySubsection');
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
        console.log(text);
        let _onCopy = function(e) {
            e.clipboardData.setData('text/plain', text);
            e.preventDefault();
        };
        document.addEventListener('copy', _onCopy);
        document.execCommand('copy');
        document.removeEventListener('copy', _onCopy);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionPasteSubsection(e) {
        handleEventCancel(e, 'actionPasteSubsection');
        if (canTakeAction('actionPasteSubsection()') === false) {
            return;
        }
        if (state.subsectionClipboard === null) {
            alert("There is nothing in the clipboard to paste.");
            return;
        }
        if (noItemSelected()) {
            let tags = $auto_complete_search.getTagsFromSearch();
            state.selectedItem = $model.addItemFromSearchBar(tags);
            state.selectedSubitemPath = state.selectedItem.id+':0';
            $model.fullyIncludeItem(state.selectedItem);
        }

        let indexInto = $model.pasteSubsection(state.selectedItem, getSubitemIndex(), state.subsectionClipboard);
        
        for (let i = 0; i < state.subsectionClipboard.length; i++) {
            let path = state.selectedItem.id+':'+(indexInto+i);
            $effects.emphasizeSubitem(path);
        }
        //TODO: this is yucky, we should unify notation
        if (indexInto > 0) {
            state.selectedSubitemPath = state.selectedItem.id+':'+indexInto;
        }
        render();
        transitionRouter(STATE_EDIT_CONTENT);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionRemoveFormatting(e) {
        handleEventCancel(e, 'actionRemoveFormatting');
        if (canTakeAction('actionRemoveFormatting()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }
        let subitemIndex = getSubitemIndex();
        $model.removeSubitemFormatting(state.selectedItem, subitemIndex);
        render();
        transitionRouter(STATE_EDIT_CONTENT);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionExtract(e) {
        handleEventCancel(e, 'actionExtract');

        if (canTakeAction('actionExtract()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }

        let subitemIndex = getSubitemIndex();
        let tags = $auto_complete_search.getTagsFromSearch();
        if (tags === null) {
            console.warn('Cannot add because no valid tags');
            return;
        }
        let updated = $model.extract(state.selectedItem, subitemIndex, tags);
        if (updated) {
            state.selectedSubitemPath = state.selectedItem.id+':'+(subitemIndex-1);
            $view.focusSubitem(state.selectedSubitemPath);
        }
        render();
        transitionRouter(STATE_EDIT_CONTENT);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionSplit(e) {

        handleEventCancel(e, 'actionSplit');

        if (canTakeAction('actionSplit()') === false) {
            return;
        }
        if (noItemSelected()) {
            return;
        }

        let subitemIndex = getSubitemIndex();
        $model.split(state.selectedItem, subitemIndex);
        render();
        transitionRouter(STATE_EDIT_CONTENT);
    }

    //TODO: onEvent syntax
    //TODO: add states
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
        transitionRouter(STATE_DEFAULT);
    }

    //TODO: onEvent syntax
    //TODO: add states
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
        transitionRouter(STATE_DEFAULT);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionCollapseItem(e) {
        handleEventCancel(e, 'actionCollapseItem');
        if (canTakeAction('actionCollapseItem()') === false) {
            return;
        }
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = getItemIdFromPath(path);
        let subitemIndex = getSubitemIndexFromPath(path);
        let item = $model.getItemById(id);
        $model.collapse(item, subitemIndex);
        render();
        transitionRouter(STATE_DEFAULT);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionExpandItem(e) {
        handleEventCancel(e, 'actionExpandItem');
        if (canTakeAction('actionExpandItem()') === false) {
            return;
        }
        let path = $view.getPathFromCheckboxlike(e.target);
        let id = getItemIdFromPath(path);
        let subitemIndex = getSubitemIndexFromPath(path);
        let item = $model.getItemById(id);
        $model.expand(item, subitemIndex);
        render();
        transitionRouter(STATE_DEFAULT);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionRenameTag(e) {
        handleEventCancel(e, 'actionRenameTag');
        if (canTakeAction('actionRenameTag()') === false) {
            return;
        }
        genericModal($dlg.renameTag);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionReplaceText(e) {
        handleEventCancel(e, 'actionReplaceTexte');
        if (canTakeAction('actionReplaceTexte()') === false) {
            return;
        }
        genericModal($dlg.replaceText);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionDeleteTag(e) {
        handleEventCancel(e, 'actionDeleteTag');
        if (canTakeAction('actionDeleteTag()') === false) {
            return;
        }
        genericModal($dlg.deleteTag);
    }

    //TODO: move this into persist function
    //TODO: onEvent syntax
    //TODO: add states
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
            transitionRouter(STATE_SAVING_DIFF);
        }
        else {
            if (state.state_machine == STATE_DIALOG) {
                return;
            }
            function after() {
                $view.scrollToTop();
                transitionRouter(STATE_DEFAULT);
            }
            transitionRouter(STATE_DIALOG);
            $dlg.restoreFromFile(obj, after);
        }
        transitionRouter(STATE_DEFAULT);
    }

    function genericModal(fn) {
        function after() {
            transitionRouter(STATE_DEFAULT);
        }
        transitionRouter(STATE_DIALOG);
        fn(after);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionRemoveTagCurrentView(e) {
        handleEventCancel(e, 'actionRemoveTagCurrentView');
        if (canTakeAction('actionRemoveTagCurrentView()') === false) {
            return;
        }
        genericModal($dlg.removeTagFromCurrentView);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionAddMetaRule(e) {
        handleEventCancel(e, 'actionAddMetaRule');
        if (canTakeAction('actionAddMetaRule()') === false) {
            return;
        }
        genericModal($dlg.addMetaRule);
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionAddTagCurrentView(e) {
        handleEventCancel(e, 'actionAddTagCurrentView');
        if (canTakeAction('actionAddTagCurrentView()') === false) {
            return;
        }
        genericModal($dlg.addTagToCurrentView);
    }

    //TODO: move to $sidebar
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
        if (state.state_machine == STATE_DEFAULT && state.modeMousedown) {
            $view.setCursor('grabbing');
        }
    }

    //TODO: add states
    function onMouseOverSubitem(e) {
        setSidebar();
    }

    //TODO: add states
    function onMouseOutItems() {
        clearSidebar();
    }

    function clearSidebar() {
        if (itemIsSelected()) {  //TODO use states
            return;
        }
        $sidebar.clearSidebar();
    }

    function resetInactivityTimer() {
        state.timestampLastActive = Date.now();
    }

    function saveFail() {
        console.warn('Failed saving file');
        transitionRouter(STATE_ERROR);
    }

    function saveSuccessAfterIdle() {
        $view.setCursor("auto");  //TODO: move to fsm
        popState();
    }

    function saveSuccessAfterRestoreFromFile() {
        $unlock.exitLock();
        resetAllCache();
        let recalculated = $ontology.maybeRecalculateOntology();
        if (recalculated) {
            resetAllCache();
        }
        successfulInit();  //don't pop here, just go to default regardless
    }

    function genericToggleFormatTag(tag, event) {
        handleEventCancel(event, 'genericToggleFormatTag');
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
    }



    //TODO: onEvent syntax
    //TODO: add states
    function getClipboardText() {
        return state.clipboardText;
    }

    //TODO: move to view?
    function renderNonEditing() {

        $view.render(state.selectedItem, state.selectedSubitemPath, state.modeMoreResults, state.modeRedacted);

        // all states
        clearSidebar();
        state.modeSkippedRender = false;
        $view.hideSpinner();
    }

    //TODO: move to view?
    function renderEditing() {

        $view.render(state.selectedItem, state.selectedSubitemPath, state.modeMoreResults, state.modeRedacted);

        $view.focusSubitem(state.selectedSubitemPath);
        let el = $view.getItemElementById(state.selectedItem.id);
        $view.onMouseoverAndSelected(el);

        // all states
        clearSidebar();
        state.modeSkippedRender = false;
        $view.hideSpinner();
    }

    //TODO remove all refs to this
    function render() {

        $view.render(state.selectedItem, state.selectedSubitemPath, state.modeMoreResults, state.modeRedacted);

        // TODO this should be a different function
        if (state.state_machine == STATE_EDIT_CONTENT) {
            $view.focusSubitem(state.selectedSubitemPath);
            let el = $view.getItemElementById(state.selectedItem.id);
            $view.onMouseoverAndSelected(el);
        }

        // all states
        clearSidebar();
        state.modeSkippedRender = false;
        $view.hideSpinner();
    }

    //TODO: onEvent syntax
    //TODO: add states
    function actionLogOut(e) {
        //TODO we probably do not need this.
        if (state.timestampLastIdleSaved !== $model.getTimestampLastUpdate()) {
            //TODO: this should never happen
            $view.setSpinnerContentSavingAndLoggingOut();
            $view.showSpinner();
            function saveSuccessAfterLogout() {
                location.reload();
            }
            $persist.saveToHostFull(
                saveSuccessAfterLogout,
                saveFail
            );
        }
        else {
            location.reload();
        }
    }

    //TODO: move this to $persist ?
    //TODO: onEvent syntax
    //TODO: add states
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

    //TODO: move to view
    function onMouseoverDelete() {
        let el = document.querySelector('.selected-item');
        el.classList.remove('selected-item');
        el.classList.add('selected-item-warn-of-delete');
    }

    //TODO: move to view
    function onMouseoutDelete() {
        let el = document.querySelector('.selected-item-warn-of-delete');
        el.classList.remove('selected-item-warn-of-delete');
        el.classList.add('selected-item');
    }

    //TODO: move to view?
    function onMousedownLink(e) {
        console.log('clicked link');
        handleEventCancel(e);
    }

    function actionToggleShowMetaRule(e) {
        if (canTakeAction('actionToggleShowMetaRule()') === false) {
            return;
        }
        if (state.state_show_implications === false) {
            state.state_show_implications = true;
            localStorage.setItem('show_implications', 'true');
        }
        else {
            state.state_show_implications = false;
            localStorage.setItem('show_implications', 'false');
        }
        render();// TODO: do we need this?
        transitionRouter(STATE_DEFAULT);
    }

    function successfulInit() {
        //TODO: this should be handled by a transitionLoadingToDefault()
        $model.testConsistency();
        $auto_complete_search.hideOptions();
        $model.resetTagCountsCache();
        $model.resetCachedAttributeTags();
        $view.blurActiveElement();
        state.timestampLastIdleSaved = $model.getTimestampLastUpdate();
        resetInactivityTimer();
        $view.showMainApp();
        $view.setSpinnerContentLoading();
        $view.hideSpinner();
        transitionRouter(STATE_DEFAULT);
    }

    function init() {

        transitionRouter(STATE_LOGIN);

        //console.log('connecting to websocket...');
        state.ws = new WebSocket('ws://localhost:3001');
        state.ws.onopen = function() {
            //console.log('WebSocket opened');
            state.ws.send('Hello!');
        }

        state.ws.onmessage = function(event) {
            //console.log("WS message: " + event.data);
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

        let show_implications = localStorage.getItem('show_implications');
        if (show_implications == null) {
            state.state_show_implications = true; //TODO should this be default?
            localStorage.setItem('show_implications', 'true');
        }
        else if (show_implications == 'false') {
            state.state_show_implications = false;
        }
        else if (show_implications == 'true') {
            state.state_show_implications = true;
        }
        else {
            console.warn('Unknown show_implications value in localStorage');
        }
        
        //These are first time events...
        $events.registerEvents();

        setInterval(onCheckForIdle, CHECK_FOR_IDLE_FREQ_MS);
        setInterval(onCheckForIdleWhileEditing, CHECK_FOR_IDLE_FREQ_MS);

        $persist.loadFromHost(
            successfulInit, 
            function failure(){
                alert('Failed to load');
            });
    }

    return {
        init: init,
        restoreFromFile: restoreFromFile,
        onClickDocument: onClickDocument,
        onClickSubitem: onClickSubitem,
        onClickEditBar: onClickEditBar,
		onEditSubitem: onEditSubitem,
		onFocusSubitem: onFocusSubitem,
		actionUp: actionUp,
		actionDown: actionDown,
        actionIndent: actionIndent,
        actionUnindent: actionUnindent,
        actionFullUp: actionFullUp,
        actionFullDown: actionFullDown,
        actionAddLink: actionAddLink,
        actionAddTagCurrentView: actionAddTagCurrentView,
        actionAddMetaRule: actionAddMetaRule,
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
		actionMouseoverItem: actionMouseoverItem,
		actionMouseoffItem: actionMouseoffItem,
		actionMousedownItem: actionMousedownItem,
		actionMouseupItem: actionMouseupItem,
        onClickTagBar: onClickTagBar,
        actionMoreResults: actionMoreResults,
        actionExpandRedacted: actionExpandRedacted,
        actionRenameTag: actionRenameTag,
        actionReplaceText: actionReplaceText,
        actionDeleteTag: actionDeleteTag,
        actionRemoveTagCurrentView: actionRemoveTagCurrentView,
        actionPasswordProtectionSettings: actionPasswordProtectionSettings,
        actionGenerateRandomPassword: actionGenerateRandomPassword,
        actionCollapseAllView: actionCollapseAllView,
        actionExpandAllView: actionExpandAllView,
        actionCollapseItem: actionCollapseItem,
        actionExpandItem: actionExpandItem,
		actionDelete: actionDelete,
        actionToggleShowMetaRule: actionToggleShowMetaRule,
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
        onClickSelectSearchSuggestion: onClickSelectSearchSuggestion,
        onUpArrow: onUpArrow,
        onDownArrow: onDownArrow,
        onMouseOverSubitem: onMouseOverSubitem,
        onMouseOutItems: onMouseOutItems,
        onMouseMoveOverSubitem: onMouseMoveOverSubitem,
        onMouseoverDelete: onMouseoverDelete,
        onMouseoutDelete: onMouseoutDelete,
        onMousedownLink: onMousedownLink,
        itemIsSelected: itemIsSelected,
        updateSelectedSearchSuggestion: updateSelectedSearchSuggestion,
        updateSelectedTagSuggestion: updateSelectedTagSuggestion,
        setMoreResults: setMoreResults,
        onClickMenu: onClickMenu,
        setSidebar: setSidebar,
        clearSidebar: clearSidebar,
        resetInactivityTimer: resetInactivityTimer,
        getClipboardText: getClipboardText,
        getValidSearchTags: getValidSearchTags,
        resetAllCache: resetAllCache,
        maybeResetSearch: maybeResetSearch,
        successfulInit: successfulInit,
        enableEditTags: enableEditTags,
        enableEditingMode: enableEditingMode,
        disableEditingMode: disableEditingMode,
        canTakeAction: canTakeAction,
        renderNonEditing: renderNonEditing,
        renderEditing: renderEditing,
        eventRouter: eventRouter,
        genericToggleFormatTag:genericToggleFormatTag
    };
})();
