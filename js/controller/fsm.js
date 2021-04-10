"use strict";

const STATE_LOGIN = 'STATE_LOGIN';
const STATE_DEFAULT = 'STATE_DEFAULT';
const STATE_SEARCH = 'STATE_SEARCH';
const STATE_MENU = 'STATE_MENU';
const STATE_EDIT_CONTENT = 'STATE_EDIT_CONTENT';
const STATE_EDIT_TAGS = 'STATE_EDIT_TAGS';
const STATE_DIALOG = 'STATE_DIALOG';
const STATE_ERROR = 'STATE_ERROR';

function transitionToLogin() {
    state.state_machine = STATE_LOGIN;
}

function transitionLoginToDefault() {
    $main_controller.renderNonEditing();
    state.state_machine = STATE_DEFAULT;
}

function transitionLoginToError() {
    $view.gotoErrorPageDisconnected();
}

// DEFAULT TRANSITIONS

function transitionDefaultToSearch() {
    state.state_machine = STATE_SEARCH;
}

function transitionDefaultToEditContent() {
    $main_controller.enableEditingMode();
    state.state_machine = STATE_EDIT_CONTENT;
}

function transitionDefaultToMenu() {
    state.state_machine = STATE_MENU;
}

function transitionDefaultToDialog() {
    state.state_machine = STATE_DIALOG;
}

function transitionDefaultToError() {
    $view.gotoErrorPageDisconnected();
}

// SEARCH TRANSITIONS

function transitionSearchToDefault() {
    $auto_complete_search.hideOptions();
    state.state_machine = STATE_DEFAULT;
}

function transitionSearchToEditContent() {
    $auto_complete_search.hideOptions();
    $main_controller.enableEditingMode();
    state.state_machine = STATE_EDIT_CONTENT;
}

function transitionSearchToMenu() {
    $auto_complete_search.hideOptions();
    state.state_machine = STATE_MENU;
}

function transitionSearchToDialog() {
    $auto_complete_search.hideOptions();
    state.state_machine = STATE_DIALOG;
}

function transitionSearchToError() {
    $view.gotoErrorPageDisconnected();
}

// EDIT CONTENT TRANSITIONS

function transitionEditContentToEditTags() {
    state.state_machine = STATE_EDIT_TAGS;
    $main_controller.enableEditTags();
}

function transitionEditContentToDefault() {
    $main_controller.disableEditingMode();
    state.state_machine = STATE_DEFAULT;
    $main_controller.renderNonEditing();
}

function transitionEditContentToSearch() {
    $main_controller.disableEditingMode();
    state.state_machine = STATE_SEARCH;
    $main_controller.renderNonEditing();
}

function transitionEditContentToMenu() {
    $main_controller.disableEditingMode();
    state.state_machine = STATE_MENU;
    $main_controller.renderNonEditing();
}

function transitionEditContentToDialog() {
    $main_controller.disableEditingMode();
    state.state_machine = STATE_DIALOG;
    $main_controller.renderNonEditing();
}

function transitionEditContentToError() {
    $view.gotoErrorPageDisconnected();
}

// EDIT TAGS TRANSITIONS

function transitionEditTagsToEditContent() {
    $auto_complete_tags.hideOptions();
    $view.focusSubitem(state.selectedSubitemPath);
    state.state_machine = STATE_EDIT_CONTENT;
}

function transitionEditTagsToDefault() {
    $main_controller.disableEditingMode();
    state.state_machine = STATE_DEFAULT;
    $main_controller.renderNonEditing();
}

function transitionEditTagsToSearch() {
    $main_controller.disableEditingMode();
    state.state_machine = STATE_SEARCH;
    $main_controller.renderNonEditing();
}

function transitionEditTagsToMenu() {
    $main_controller.disableEditingMode();
    state.state_machine = STATE_MENU;
    $main_controller.renderNonEditing();
}

function transitionEditTagsToDialog() {
    $main_controller.disableEditingMode();
    state.state_machine = STATE_DIALOG;
    $main_controller.renderNonEditing();
}

function transitionEditTagsToError() {
    $view.gotoErrorPageDisconnected();
}

// MENU TRANSITIONS

function transitionMenuToDialog() {
    $view.closeAnyOpenMenus();
    state.state_machine = STATE_DIALOG;
}

function transitionMenuToDefault() {
    $view.closeAnyOpenMenus();
    state.state_machine = STATE_DEFAULT;
}

function transitionMenuToEditContent() {
    $view.closeAnyOpenMenus();
    $main_controller.enableEditingMode();
    state.state_machine = STATE_EDIT_CONTENT;
}

function transitionMenuToSearch() {
    $view.closeAnyOpenMenus();
    state.state_machine = STATE_SEARCH;
}

function transitionMenuToError() {
    $view.gotoErrorPageDisconnected();
}

// DIALOG TRANSITIONS

function transitionDialogToDefault() {
    state.state_machine = STATE_DEFAULT;
}

function transitionDialogToError() {
    $view.gotoErrorPageDisconnected();
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

function stateMachineTransitionTo(nextState) {

    if (state.state_machine == nextState) {
        return;
    }

    //TODO: maybe move that function into here?
    if ($main_controller.canTakeAction('stateMachineTransitionTo()') === false) {
        return;
    }

    console.log(`>>> ${state.state_machine} -> ${nextState}`);

    if (state.state_machine == null) {
        transitionToLogin(state);
        return;
    }

    if (state.state_machine == STATE_LOGIN) {
        switch (nextState) {
            case STATE_DEFAULT:
                transitionLoginToDefault();
                return;
            case STATE_ERROR:
                transitionLoginToError();
                return;
        }
    }

    if (state.state_machine == STATE_DEFAULT) {
        switch (nextState) {
            case STATE_SEARCH:
                transitionDefaultToSearch();
                return;
            case STATE_EDIT_CONTENT:
                transitionDefaultToEditContent();
                return;
            case STATE_MENU:
                transitionDefaultToMenu();
                return;
            case STATE_DIALOG:
                transitionDefaultToDialog();
                return;
            case STATE_ERROR:
                transitionDefaultToError();
                return;
        }
    }

    if (state.state_machine == STATE_SEARCH) {
        switch (nextState) {
            case STATE_DEFAULT:
                transitionSearchToDefault();
                return;
            case STATE_EDIT_CONTENT:
                transitionSearchToEditContent();
                return;
            case STATE_MENU:
                transitionSearchToMenu();
                return;
            case STATE_DIALOG:
                transitionSearchToDialog();
                return;
            case STATE_ERROR:
                transitionSearchToError();
                return;
        }
    }

    if (state.state_machine == STATE_EDIT_CONTENT) {
        switch(nextState) {
            case STATE_EDIT_TAGS:
                transitionEditContentToEditTags();
                return;
            case STATE_DEFAULT:
                transitionEditContentToDefault();
                return;
            case STATE_SEARCH:
                transitionEditContentToSearch();
                return;
            case STATE_MENU:
                transitionEditContentToMenu();
                return;
            case STATE_DIALOG:
                transitionEditContentToDialog();
                return;
            case STATE_ERROR:
                transitionEditContentToError();
                return;
        }
    }

    if (state.state_machine == STATE_EDIT_TAGS) {
        switch(nextState) {
            case STATE_EDIT_CONTENT:
                transitionEditTagsToEditContent();
                return;
            case STATE_DEFAULT:
                transitionEditTagsToDefault();
                return;
            case STATE_SEARCH:
                transitionEditTagsToSearch();
                return;
            case STATE_MENU:
                transitionEditTagsToMenu();
                return;
            case STATE_DIALOG:
                transitionEditTagsToDialog();
                return;
            case STATE_ERROR:
                transitionEditTagsToError();
                return;
        }
    }

    if (state.state_machine == STATE_MENU) {
        switch(nextState) {
            case STATE_DIALOG:
                transitionMenuToDialog();
                return;
            case STATE_DEFAULT:
                transitionMenuToDefault();
                return;
            case STATE_EDIT_CONTENT:
                transitionMenuToEditContent();
                return;
            case STATE_SEARCH:
                transitionMenuToSearch();
                return;
            case STATE_ERROR:
                transitionMenuToError();
                return;
        }
    }

    if (state.state_machine == STATE_DIALOG) {
        switch(nextState) {
            case STATE_DEFAULT:
                transitionDialogToDefault();
                return;
            case STATE_ERROR:
                transitionDialogToError();
                return;
        }
    }

    throw `Unexpected state transition ${state.state_machine} to ${nextState}`;
}