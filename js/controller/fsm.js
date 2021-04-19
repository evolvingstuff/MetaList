"use strict";

const STATE_LOGIN = 'STATE_LOGIN';
const STATE_DEFAULT = 'STATE_DEFAULT';
const STATE_SEARCH = 'STATE_SEARCH';
const STATE_MENU = 'STATE_MENU';
const STATE_EDIT_CONTENT = 'STATE_EDIT_CONTENT';
const STATE_EDIT_TAGS = 'STATE_EDIT_TAGS';
const STATE_DIALOG = 'STATE_DIALOG';
const STATE_ERROR = 'STATE_ERROR';
const STATE_SAVING_DIFF = 'STATE_SAVING_DIFF';

const EVENT_ON_CLICK_ENTER = 'EVENT_ON_CLICK_ENTER';
const EVENT_ON_CLICK_TAB = 'EVENT_ON_CLICK_TAB';

/*
STATE_DRAGGING
STATE_LOADING
*/

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const entryRoutes = {
    "STATE_EDIT_CONTENT": () => {
        $main_controller.enableEditingMode();  //TODO: hierarchical
    },
    "STATE_SAVING_DIFF": () => {
        $view.setCursor('progress');
    },
    "STATE_ERROR": () => {
        $view.gotoErrorPageDisconnected();
    }
};

const transitionRoutes = {
    "STATE_LOGIN->STATE_DEFAULT": () => {
        //$main_controller.renderNonEditing();
        $main_controller.onClickSelectSearchSuggestion();
    },
    "STATE_EDIT_CONTENT->STATE_EDIT_TAGS": () => {
        $main_controller.enableEditTags();
    },
    "STATE_EDIT_CONTENT->STATE_DEFAULT": () => {
        $main_controller.disableEditingMode();
        $main_controller.renderNonEditing();
        //$main_controller.render();
    },
    "STATE_EDIT_CONTENT->STATE_SEARCH": () => {
        $main_controller.disableEditingMode();
        $main_controller.renderNonEditing();
    },
    "STATE_EDIT_CONTENT->STATE_MENU": () => {
        $main_controller.disableEditingMode();
        $main_controller.renderNonEditing();
    },
    "STATE_EDIT_CONTENT->STATE_DIALOG": () => {
        $main_controller.disableEditingMode();
        $main_controller.renderNonEditing();
    },
    "STATE_EDIT_TAGS->STATE_EDIT_CONTENT": () => {
        $auto_complete_tags.hideOptions();
        $auto_complete_search.blur();
        $view.focusSubitem(state.selectedSubitemPath);
    },
    "STATE_EDIT_TAGS->STATE_DEFAULT": () => {
        $main_controller.disableEditingMode();
        $main_controller.renderNonEditing();
    },
    "STATE_EDIT_TAGS->STATE_SEARCH": () => {
        $main_controller.disableEditingMode();
        $main_controller.renderNonEditing();
    },
    "STATE_EDIT_TAGS->STATE_MENU": () => {
        $main_controller.disableEditingMode();
        $main_controller.renderNonEditing();
    },
    "STATE_EDIT_TAGS->STATE_DIALOG": () => {
        $main_controller.disableEditingMode();
        $main_controller.renderNonEditing();
    }
};

const exitRoutes = {
    "STATE_SAVING_DIFF": () => {
        $view.setCursor('default');
    },
    "STATE_SEARCH": () => {
        $auto_complete_search.hideOptions();
        $auto_complete_search.blur();
    },
    "STATE_MENU": () => {
        $view.closeAnyOpenMenus();
    }
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

function transitionRouter(nextState) {
    if (nextState == STATE_ERROR) {
        alert('ERROR!');
    }

    if (state.state_machine == nextState) {
        return;
    }

    //TODO: maybe move that function into here?
    //TODO: what if we are transitioning out of a paused state? I think this needs to live in actions, not here
    if ($main_controller.canTakeAction('transitionRouter()') === false) {
        return;
    }

    let key = `${state.state_machine}->${nextState}`

    console.log(`>>> ${key}`);

    state.state_history.push(nextState);

    //exit events
    if (exitRoutes[state.state_machine] !== undefined) {
        exitRoutes[state.state_machine]();
    }

    //transition events
    if (transitionRoutes[key] !== undefined) {
        transitionRoutes[key]();
    }

    //update state
    state.state_machine = nextState;  //TODO: before or after? Should not matter much

    //entry events
    if (entryRoutes[nextState] !== undefined) {
        entryRoutes[nextState]();
    }

    // //update state
    // state.state_machine = nextState;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

function pushState(nextState) {
    state.state_stack = state.state_machine;
    transitionRouter(nextState);
}

function popState() {
    transitionRouter(state.state_stack);
    state.state_stack = null;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////