//TODO add getters and setters

export const state = {
    modeShowMoreResults: false,
    pendingQuery: null,
    mostRecentQuery: null,
    serverIsBusy: false,
    modeLocked: false,
    selectedItemSubitemIds: new Set(),
    modeEdit: false,
    _selectedItemSubitemIds: new Set()  //prior state of selectedItemSubitemIds
}

export function stateNoMode() {
    return state.modeEdit === false;
}