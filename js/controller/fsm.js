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

const STATE_IMPLICATIONS = {
    "STATE_DEFAULT":        ["**STATES_NON_EDIT"],
    "STATE_SEARCH":         ["**STATES_NON_EDIT"],
    "STATE_MENU":           ["**STATES_NON_EDIT"],
    "STATE_DIALOG":         ["**STATES_NON_EDIT"],
    "STATE_EDIT_CONTENT":   ["**STATES_EDIT"],
    "STATE_EDIT_TAGS":      ["**STATES_EDIT"]
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const entryRoutes = {
    "STATE_SAVING_DIFF": () => {
        $view.setCursor('progress');
    },
    "STATE_ERROR": () => {
        $view.gotoErrorPageDisconnected();
    }
};

const transitionRoutes = {
    "STATE_LOGIN->STATE_DEFAULT": () => {
        $main_controller.onClickSelectSearchSuggestion();
    },
    "**STATES_NON_EDIT->STATE_EDIT_CONTENT": () => {
        $main_controller.enableEditingMode();
    },
    "STATE_EDIT_CONTENT->STATE_EDIT_TAGS": () => {
        $main_controller.enableEditTags();
    },
    "STATE_EDIT_TAGS->STATE_EDIT_CONTENT": () => {
        $auto_complete_tags.hideOptions();
        $auto_complete_search.blur();
        $view.focusSubitem(state.selectedSubitemPath);
    },
    "**STATES_EDIT->**STATES_NON_EDIT": () => {
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

    state.state_history.push(nextState);

    //specific exit events
    if (exitRoutes[state.state_machine] !== undefined) {
        exitRoutes[state.state_machine]();
    }

    //implied exit events
    //TODO: need to make sure next state does not imply same
    if (STATE_IMPLICATIONS[state.state_machine] !== undefined) {
        for (let implied_key of STATE_IMPLICATIONS[state.state_machine]) {
            if (exitRoutes[implied_key] !== undefined) {
                exitRoutes[implied_key]();
            }
        }
    }

    let possible_keys = [key];
    //TODO: double check this code
    if (STATE_IMPLICATIONS[state.state_machine] !== undefined) {
        for (let lhs of STATE_IMPLICATIONS[state.state_machine]) {
            possible_keys.push(`${lhs}->${nextState}`);
            if (STATE_IMPLICATIONS[nextState] !== undefined) {
                for (let rhs of STATE_IMPLICATIONS[nextState]) {
                    possible_keys.push(`${lhs}->${rhs}`);
                }
            }
        }
        if (STATE_IMPLICATIONS[nextState] !== undefined) {
            for (let rhs of STATE_IMPLICATIONS[nextState]) {
                possible_keys.push(`${state.state_machine}->${rhs}`);
            }
        }
    }
    else {
        if (STATE_IMPLICATIONS[nextState] !== undefined) {
            for (let rhs of STATE_IMPLICATIONS[nextState]) {
                possible_keys.push(`${state.state_machine}->${rhs}`);
            }
        }
    }
    //console.log(possible_keys);

    for (let possible_key of possible_keys) {
        if (transitionRoutes[possible_key] !== undefined) {
            console.log(possible_key);
            transitionRoutes[possible_key]();
        }
    }

    //update state
    state.state_machine = nextState;  //TODO: before or after? Should not matter much

    //implied entry events
    //TODO: need to make sure prior state does not imply same
    if (STATE_IMPLICATIONS[nextState] !== undefined) {
        for (let implied_key of STATE_IMPLICATIONS[nextState]) {
            if (entryRoutes[implied_key] !== undefined) {
                entryRoutes[implied_key]();
            }
        }
    }

    //specific entry events
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