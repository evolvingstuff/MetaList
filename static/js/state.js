//TODO add getters and setters

export const state = {
    modeShowMoreResults: false,
    pendingQuery: null,
    mostRecentQuery: null,
    serverIsBusy: false,
    modeLocked: false,
    selectedItemSubitemId: null,  //TODO: should just be one subitem
    modeEdit: false,
    modeCursorSelected: false,
    _selectedItemSubitemId: null  //prior state of selectedItemSubitemId
}

export function stateNoMode() {
    return state.modeEdit === false;
}