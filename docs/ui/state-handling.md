# State Handling in MetaList3

## ModeManager Architecture

The ModeManager is a modular state management system designed to replace the complex state machine previously used in MetaList3. Instead of exclusive states, it uses boolean flags (modes) that can be active simultaneously.

### Key Components

1. **ModeContext**: Central state store with boolean flags and context data
2. **Actions**: Centralized operations that affect state, make server calls, and trigger UI updates
3. **Event Handlers**: Map DOM events to appropriate actions
4. **Logger**: Categorized logging for debugging and monitoring

## Core Principles

### Separation of Concerns

- **Event Handlers** detect user interaction and delegate to actions
- **Actions** encapsulate complex operations including state changes, server calls, and UI updates
- **ModeContext** manages the actual state and validates invariants
- **CommandGate** is the single “busy” boundary for all user-initiated server calls

This separation creates a flow that is more complex than a simple linear progression:

```
User Interaction → Event Handler → Action 
                                    ↓
                           ┌────────┼────────┐
                           ↓        ↓        ↓
                     State Change  API Call  UI Update
                           ↓        ↓
                           └───→ Response Handler
                                    ↓
                           ┌────────┼────────┐
                           ↓        ↓        ↓
                     State Change  API Call  UI Update
```

### Event-Action-State Pattern

1. **Events**: 
   - Handle raw DOM events (clicks, keypress, input)
   - Determine what action to take based on context
   - Perform basic filtering to avoid unnecessary actions
   - Can chain multiple actions together for complex interactions
   - For server-bound actions: call `CommandGate.run(...)` and do not touch loading state

2. **Actions**:
   - Encapsulate complex operations that may include:
     - State changes (via ModeContext)
     - API calls to the server
     - Handling API responses
     - Triggering UI updates
   - Validate inputs before proceeding
   - Maintain state consistency
   - Throw errors for invalid operations
   - Can be composed together for more complex operations

3. **State (ModeContext)**:
   - Store the application state
   - Provide getters and setters for state fields
   - Validate state invariants
   - Notify listeners of changes
   - Reject same-value writes in setters so redundant state transitions fail loudly

### Validation Strategy

The system follows a "fail-fast" approach to error handling at multiple levels:

1. **Input Validation**: Actions validate their inputs before proceeding
2. **State Invariants**: The ModeContext enforces state consistency rules
3. **Redundancy Checks**: State setters fail on redundant state changes
4. **Error Propagation**: Errors are thrown and logged immediately when detected

Key invariants and validation rules include:
- If editing mode is active, a currentNoteId must be set
- If editing mode is not active, no currentNoteId should be set
- Setting any ModeContext state property to its current value is considered a programming error
- Expected duplicate inputs must be checked before calling the setter, with an inline comment explaining why the duplicate can happen

#### Redundancy Checks vs. NOOP Pattern

The ModeManager implements two distinct approaches to handle potentially redundant operations:

1. **Redundancy Checks (in ModeContext)**: 
   ```javascript
   // Inside setEditing() method
   if (this._editing === value) {
     throw new Error(`Redundant state change: editing is already ${value}`);
   }
   ```
   These catch programming errors where code accidentally tries to set state to its current value. This applies to scalar fields, tab scroll state, root anchors, clipboard state, connection state, and modal stack mutations.

2. **NOOP Pattern (in event handlers)**:
   ```javascript
   // In handleClick()
   if (ModeContext.isEditing && ModeContext.currentNoteId === noteId) {
     Logger.logNoop('Click in already selected note - no action needed');
     return; // Prevent redundant action call
   }
   ```
   This handles expected user behaviors like clicking the same note twice.

   When a caller checks before setting, the comment next to that check should explain the specific legitimate duplicate path, such as repeated browser input events, polling that observes an unchanged scroll position, or a server response that echoes the current version.

This dual approach ensures:
- Programming errors fail fast and visibly (with errors)
- Expected user behaviors are handled gracefully (with NOOP logs)

### API Failure Boundaries

- An HTTP response proves that the server connection is working. `4xx` and `5xx` responses show an application/request error but do not set `ModeContext.isConnected` to false or tear down edit mode.
- `401` responses retain the dedicated authentication/logout path.
- Only transport failures such as a rejected `fetch` or request timeout enter disconnected mode, show the persistent soft-amber reconnecting banner, and disable editing. Their expected promise rejections are kept out of the fatal red stack overlay; unexpected client exceptions still surface there and fail loudly.
- Unexpected client exceptions are rethrown instead of being relabeled as network failures.
- Note selection sets `isEditing` and `currentNoteId` before awaiting the initial content refresh, so `currentContent` can legitimately still be `null` during that transition. Disconnect cleanup checks each nullable field before clearing it so strict state setters do not receive redundant writes.
- A refresh can remove the edited note from the DOM and clear `currentContent` before deselection completes. Deselect cleanup therefore checks `currentContent` before clearing it while still requiring the editing and note-selection transitions.

## Boolean Flags vs. Traditional State Machines

The ModeManager's boolean flags approach differs fundamentally from traditional state machines in several important ways:

### Context Retention

A key advantage of the boolean flags approach is **contextual memory**:

```javascript
// In an action method:
void CommandGate.run('note.save', async () => {
  await NotesAPI.saveNote(noteId, contentHTML, tags)
  await actionRefreshAndMaybeSelect({ context: 'note.save' })
})
```

With a traditional state machine:
- Entering a "loading" state would typically EXIT the "editing" state
- You'd need to store what state to return to after loading
- Complex state machines need "history" mechanisms to track this
- Each combination of states becomes its own state (EditingAndLoading, IdleAndLoading, etc.)

### Parallel Concerns

The boolean flags approach naturally models parallel concerns:

```javascript
// These can all be true simultaneously
ModeContext.isEditing     // User is editing a note
ModeContext.isCallingApi  // An API request is in progress
ModeContext.isLoading     // UI is showing a loading indicator
ModeContext.isDirty       // Content has unsaved changes
```

With traditional state machines:
- Each combination becomes a distinct state
- The number of states explodes exponentially
- Transition rules become extremely complex
- Debugging becomes difficult ("why am I in EditingDirtyLoadingState instead of EditingDirtyState?")

### Simpler Validation

With boolean flags, validation rules are simple expressions:

```javascript
// Clear invariants
if (this._editing && !this._currentNoteId) {
  throw new Error('Invariant violation: editing mode is active but no currentNoteId is set');
}
```

With state machines:
- Validation is embedded in transition rules
- It's harder to express invariants that span multiple aspects of state
- Validating becomes more complex as the number of states grows

## Logging System

The ModeManager uses a categorized logging system to make debugging easier:

### Log Categories

- **[ACTION]**: High-level user actions (selectNote, deselectNote)
- **[STATE]**: Individual state changes (editing, currentNoteId)
- **[EVENT]**: Raw DOM events (click, keypress)
- **[NOOP]**: No-operation events (when an action is intentionally skipped)
- **[INIT]**: Component initialization
- **[ERROR]**: Errors and exceptions

All logs are prefixed with `+++ ModeManager` for easy filtering in the console.

### Logging Best Practices

1. Use `logAction()` for high-level operations that affect multiple states
2. Use `logState()` for individual state property changes
3. Use `logDebug()` with the EVENT category for raw DOM events
4. Use `logNoop()` when an event is processed but intentionally ignored
5. Use `logError()` for validation failures and exceptions

## Asynchronous Code Pattern

The ModeManager uses `async/await` for readability, but cleanup must be written in the project’s allowed style.

### Cleanup (No Leaked Busy State)

The startup JS sanity rules disallow `try { ... } finally { ... }` without a `catch` in JS, so cleanup should use `.finally(...)`:

```javascript
await somePromise.finally(() => {
  // cleanup
})
```

When you need a multi-step block with cleanup:

```javascript
await (async () => {
  // ...multiple awaits...
})().finally(() => {
  // cleanup
})
```

### Key Benefits

1. **Linear Code Flow**: Code executes top-to-bottom in a more readable and maintainable way
2. **Better Error Propagation**: Errors naturally propagate up the call stack when not caught
3. **Simplified Variable Scoping**: Variables are accessible throughout the entire function
4. **Reduced Nesting**: Eliminates the "pyramid of doom" from nested Promise chains
5. **Improved Debugging**: Error stack traces are more accurate and meaningful

### Implementation Guidelines

```javascript
// DO: Use async/await
export async function saveNote(noteId) {
  // Validation
  if (!noteId) {
    throw new Error('Cannot save note: noteId is required');
  }
  
  // Set loading state
  ModeContext.setLoading(true);
  
  // Call API and await result
  const response = await NotesAPI.saveNote(noteId, contentHTML);
  
  // Update state after API call
  ModeContext.setLastSavedContent(contentHTML);
  ModeContext.setDirty(false);
  
  // Clear loading state
  ModeContext.setLoading(false);
  
  return response;
}

// DON'T: Use Promise chains
export function saveNote(noteId) {
  // Validation
  if (!noteId) {
    throw new Error('Cannot save note: noteId is required');
  }
  
  // Set loading state
  ModeContext.setLoading(true);
  
  // Call API with Promise chain
  return NotesAPI.saveNote(noteId, contentHTML)
    .then(response => {
      // Update state in nested callback
      ModeContext.setLastSavedContent(contentHTML);
      ModeContext.setDirty(false);
      
      // Clear loading state
      ModeContext.setLoading(false);
      
      return response;
    });
}
```

### Rule of Thumb

* All asynchronous functions should be marked with `async` keyword
* Use `await` for all Promise-returning function calls
* Avoid `try/catch` blocks to maintain fail-fast behavior when errors occur
* Never use `.then()`, `.catch()`, or `.finally()` methods in new code

This pattern works particularly well with our "Always Be Changin'" (ABC) validation approach, as the linear flow makes state transitions more explicit and easier to follow.

## Code Examples

### Event Handler (Processing but not "doing")

```javascript
function handleClick(event) {
   // Determine what was clicked
   const noteContent = event.target.closest('.note-content');

   if (noteContent) {
      const noteId = noteContent.closest('.note').dataset.noteId;

      // Only call the action if needed (avoid redundant operations)
      if (!ModeContext.isEditing || ModeContext.currentNoteId !== noteId) {
         // Map the event to an action (but don't modify state directly)
         actionSelectNote(noteId);
      } else {
         // Log intentionally ignored operations
         Logger.logNoop('Click in already selected note - no action needed', {noteId});
      }
   }
}
```

### Action Chaining

Some user interactions require multiple actions to execute in sequence. Event handlers can orchestrate this without directly handling state changes:

```javascript
function handleSearchClick(event) {
   // 1. Check if we need to deselect the current note first
   if (ModeContext.isEditing) {
      // Call the deselectNote action to properly exit editing mode
      actionDeselectNote();
   }

   // 2. Now focus the search field and enter search mode
   actionEnterSearchMode();

   // 3. Log the user's intention at a high level
   Logger.logDebug('User clicked search - chained deselectNote and enterSearchMode', {
      wasEditing: ModeContext.isEditing,
      searchQuery: ModeContext.searchQuery
   }, Logger.LogCategory.EVENT);
}
```

This approach:
- Keeps each action focused on a single responsibility
- Allows event handlers to orchestrate complex sequences
- Maintains proper logging of the intent and sequence
- Preserves the principle that only actions modify state

### Action (The "doing" part)

```javascript
export async function selectNote(noteId) {
  // Validation
  if (!noteId) {
    throw new Error('Cannot select note: noteId is required');
  }
  
  // Check if we're already calling the API
  if (ModeContext.isCallingApi) {
    Logger.logError('Cannot select note while API call is in progress');
    return;
  }
  
  // 1. Update state - mark that we're calling API
  ModeContext.setLoading(true);
  
  // 2. Make API call to load note content
  const response = await api.fetchNoteContent(noteId);
  
  // 3. Process API response
  
  // 4. Update state with note content and set editing mode
  ModeContext.setCurrentContent(response.content);
  ModeContext.setCurrentNoteId(noteId);
  ModeContext.setEditing(true);
  
  // 5. UI update - focus the editor
  document.querySelector(`[data-note-id="${noteId}"] .note-content`).focus();
  
  // 6. Final state change - mark API call as complete
  ModeContext.setLoading(false);
  
  // 7. Validate the resulting state
  ModeContext.validate();
  
  // 8. Log the action completion
  Logger.logAction('selectNote', { noteId, success: true });
}
```

The example above illustrates how an action can:
1. Validate inputs
2. Change state (multiple times)
3. Make API calls
4. Process responses
5. Update the UI
6. Handle errors
7. Validate state consistency

## Multi-Tab Extension

The ModeManager architecture naturally supports extending to multi-tab search contexts without breaking the core design principles.

### Tab State Integration

Tabs add a **minimal layer** above the existing global ModeContext and the
server keeps that structure hot in memory, so browser restarts no longer lose
search contexts:

```javascript
// Existing global state (shared across tabs)
ModeContext = {
  // These remain global - never edit in background tabs
  editing: false,
  loading: false, 
  isDirty: false,
  currentNoteId: null,
  clipboardNoteId: '456',
  
  // New tab management
  activeTabId: 'tab-uuid-work',
  tabOrder: ['tab-uuid-work', 'tab-uuid-personal'],
  tabs: {
    'tab-uuid-work': { searchQuery: 'project alpha', scrollY: 150 },
    'tab-uuid-personal': { searchQuery: 'recipes', scrollY: 0 }
  }
}
```

- `tab-state-service.js` fetches `/api2/notes/tab-state` on startup and hydrates
  `ModeContext` so the UI mirrors whatever the previous window last displayed.
- Tab IDs are server-assigned UUIDs and a `tabOrder` array defines display order.
- The UI reorders tabs by dragging one tab row over another. A drop moves the dragged
  tab into the hovered tab's former slot, updates `tabOrder`, and persists the updated
  snapshot back to `/api2/notes/tab-state`. Hovering retains the normal pointer; the
  grabbing cursor starts only after the browser begins a drag.
- New tabs are created by duplicating a source tab so the new tab inherits its search/scroll state, then the search field is focused and its duplicated query text is fully selected so it can be replaced immediately.
- If the source tab survives a server restart but its detached DOM cache does not, tab duplication still succeeds: the new tab keeps the duplicated tab-state metadata and the next `/notes/view` response bootstraps its DOM from the server.
- Creating/deleting tabs uses dedicated endpoints so the server remains the source of truth.
- Scroll/search changes are throttled (≈1 Hz) and POSTed back so the cache stays
  aligned with the DOM without spamming requests.
- The server persists the tab-state snapshot per namespace in the main SQLite DB, so
  active tab/search/scroll context survives server restarts instead of only browser reloads.
- Command-palette preferences and usage history now follow the same namespace-scoped model:
  the browser loads them from `/api2/auth/client-state`, persists updates back to the
  main SQLite DB, and only keeps `sessionStorage` for per-tab ephemeral ids.
- Session idle timeout is also namespace-scoped, but it is server-owned auth state in
  `app_settings`, not client-state mirrored into the browser. It is disabled by default;
  when explicitly enabled, expiry invalidates authentication without purging the hydrated
  server cache. Explicit logout still purges decrypted runtime state.
- If password protection is enabled, that persisted tab-state payload is encrypted at rest;
  passwordless namespaces keep the same payload in plaintext.
- **Diff cache isolation**: each tab now owns its own `clientNoteUuidHashes` map inside
  `ModeContext`. Swapping tabs swaps the active hash map so `/notes/view` payloads only
  contain nodes that tab has rendered—prevents the first tab from inheriting the
  thousands of roots you just scrolled past in another tab.
- With a single interactive client, this namespace-scoped persisted snapshot keeps
  persistence simple: new browser windows and restarted servers immediately reuse
  the stored tabs.

### Event-Driven Tab Switching

The event → action → state pattern handles tabs naturally:

```javascript
function handleTabSwitch(newTabId) {
  // Event handler determines intent
  if (ModeContext.activeTabId === newTabId) {
    Logger.logNoop('Tab already active', {tabId: newTabId});
    return;
  }
  
  // Action orchestrates the complex operation
  actionSwitchToTab(newTabId);
}

async function actionSwitchToTab(newTabId) {
  // 1. Save current context
  saveCurrentTabContext();
  
  // 2. Clean up current state (no background editing)
  if (ModeContext.isEditing) {
    await actionSaveAndDeselect(); // tab switches should be single-click: save+exit, then switch
  }
  
  // 3. Switch tab context
  ModeContext.setActiveTab(newTabId);
  
  // 4. Restore new context  
  await actionRefreshView();
  restoreTabScrollPosition();
}
```

### Undo/Redo with Context Boundaries

Application undo/redo is **server-side** and scoped by a client-computed `undoContext` (`tabId + searchQuery + epoch`). The epoch creates an explicit boundary even when tab and search text stay the same.

- The client sends `undoContext` on every relevant request (including `POST /api2/notes/view`).
- When `undoContext` changes, the server **clears** the undo+redo stacks for that `clientId`.
- This guarantees `Cmd+Z`/`Cmd+Y` never crosses tab or search boundaries.

History contains supported saved mutations, not every operation that writes state:
- Selecting, switching between, and deselecting notes do not add history entries.
- Saving changed note content/tags adds an `update_content` entry.
- Structural and persisted presentation mutations (create, delete, move, collapse/expand, paste, split) add their corresponding entries.
- While a note editor has unsaved or previously saved local edits in its current session, `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` remain browser-native text-editing operations. MetaList maps `Cmd/Ctrl+Y` to the active editor's local redo command so macOS browsers do not open History; no server request is made. When the active editor has no local edit history, application Undo/Redo remains available for saved mutations such as creating that note.
- Application Undo/Redo started in view mode remains in view mode; `focusNoteId` scrolls the affected note into view without selecting it for editing.
- A collapsed note temporarily expanded for editing does not add a selection-related history entry.

### Bulk Operations Are Outside Ordinary Undo/Redo

Context-wide/global bulk operations are history boundaries, not ordinary undoable actions. Existing examples include root prioritization, root alphabetization, and timestamp repair. An atomic transaction guarantees all-or-nothing application; it does not imply an undo entry.

This distinction concerns operation scope, not simply the number of records touched: an existing local action such as split, paste, or subtree deletion can retain its supported undo behavior. A bulk pass across potentially thousands of offscreen notes does not have a meaningful ordinary current-view Undo presentation.

For bulk AI proposal generation, acceptance, and rejection/removal, the contract is:

- After successful application, clear the pre-existing undo **and** redo stacks through the search-context boundary mechanism. Create no per-note or combined bulk undo entry and no bulk Undo affordance.
- On failure, cancellation, or decline, preserve existing history. No-change results preserve history as well.
- Keep individual proposal accept/reject controls undoable.
- Explicit bulk accept/remove commands name an action and scope; they are not a per-pass reversal system.

Opening the command palette no longer advances the undo epoch. Only successful bulk changes invalidate history; merely opening or dismissing their controls does not. See [command palette boundaries](command-palette.md#undoredo-boundary).

### Context Boundary Rules

- **Tab switches**: clear undo/redo stacks (new `undoContext`).
- **Search changes**: clear undo/redo stacks (new `undoContext`).
  - Search execution refreshes `/api2/notes/view` using the new query and resets scroll/root-window state.
- **App reload**: clears undo/redo stacks (fresh server state).

**Performance Note (Tab Switches):**
- The UI may cache/detach the rendered notes DOM per tab so switching back to a deeply-scrolled tab is instant; the next `/api2/notes/view` call reconciles any diffs.

**Edit Mode Integration:**
```javascript
// Enter edit mode
async function actionSelectNote(noteId) {
  ModeContext.setCurrentNoteId(noteId);
  ModeContext.setEditing(true);
  await actionRefreshView();
}


// Exit edit mode (Esc / click-outside)
async function actionDeselectNote() {
  const noteId = ModeContext.currentNoteId;
  await actionSaveNote(noteId);
  ModeContext.setEditing(false);
  ModeContext.setCurrentNoteId(null);
  await actionRefreshView();
}
```

### Design Benefits Preserved

The tab extension **maintains all core ModeManager principles**:

1. **Single Global State**: ModeContext remains the single source of truth
2. **Fail-Fast Validation**: Tab switching triggers full state validation  
3. **Event-Driven Flow**: Tab operations follow event → action → state pattern
4. **Transparent Debugging**: All tab state visible in single object inspection
5. **Action Composition**: Complex tab operations compose existing actions

### Implementation Strategy

- **Phase 1**: Add tab properties to ModeContext, persist via `/api2/notes/tab-state`
- **Phase 2**: Implement tab switching actions using existing patterns
- **Phase 3**: Extend undo commands to capture tab snapshots  
- **Phase 4**: Add tab UI components and keyboard shortcuts

The event-driven architecture makes this extension **additive rather than disruptive** - existing code continues to work while new tab functionality layers on top.

## Future Considerations

1. **Action Composition**: Complex operations can be built by composing multiple actions
2. **Undo/Redo**: The action pattern makes it easier to implement history tracking
3. **Middleware**: Additional processing can be added between actions and state changes
4. **State Persistence**: The clean separation makes it easier to save/restore state

## Migration Path

The ModeManager is designed to run in parallel with the existing state machine during migration. By using the capture phase for event listeners, it can observe user interactions before the state machine processes them.
