let state = {};

//TODO: keep track of scrolling state?

state.modeBackspaceKey = false;
state.modeSkippedRender = false;
state.modeMoreResults = false;
state.modeRedacted = true;
state.modeMousedown = false;
state.clipboardText = null;
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
state.copyOfSelectedSubitemBeforeEditing = null;
state.subsectionClipboard = null;
state.timestampFocused = Date.now();
state.timestampLastActive = Date.now();
state.ws = null;
state.state_machine = null;
state.state_history = [];
state.state_stack = null;