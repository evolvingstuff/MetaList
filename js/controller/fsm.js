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

const STATE_IMPLICATIONS = {
    "STATE_DEFAULT":        ["**STATES_NON_EDIT", "**STATES"],
    "STATE_SEARCH":         ["**STATES_NON_EDIT", "**STATES"],
    "STATE_MENU":           ["**STATES_NON_EDIT", "**STATES"],
    "STATE_DIALOG":         ["**STATES_NON_EDIT", "**STATES"],
    "STATE_EDIT_CONTENT":   ["**STATES_EDIT",     "**STATES"],
    "STATE_EDIT_TAGS":      ["**STATES_EDIT",     "**STATES"]
};

///////////////////////////////////////////////////////////////////////////////

const entryRoutes = {
    "STATE_SAVING_DIFF": () => {
        $view.setCursor('progress');
    },
    "STATE_ERROR": () => {
        alert('ERROR');
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
