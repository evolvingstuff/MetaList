//TODO add getters and setters

const state = {
    modeShowMoreResults: false,
    pendingQuery: null,
    mostRecentQuery: null,
    serverIsBusy: false,
    modeLocked: false,
    selectedItemSubitemIds: new Set(),
    modeEdit: false,
    modeMove: false,
    modeTags: false,
    modeFormat: false,

    pendingContentUpdate: null,
}