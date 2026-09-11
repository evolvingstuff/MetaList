# Modal Architecture Pattern

## Overview

This document defines the standard pattern for implementing modal dialogs in the application. All modals must follow this architecture for consistency and maintainability.

## Design Principles

### 0. **One Dark Visual System**
- Every application modal uses the shared dark shell in `app/static/css/main.css`, independent of the page's light/dark preference.
- Shared tokens on `.modal` define the surface, inset surface, borders, text hierarchy, accent, success, and danger colors.
- `.modal-content` owns the standard panel, shadow, radius, padding, scrolling, headings, controls, buttons, and close control. Feature-specific modal CSS should define layout and width only where possible.
- Dense information uses cards, tables, and split panes only when they improve scanning. Do not repeat a value in a large summary card beside the control that already displays it.
- Default action rows are right-aligned on desktop and stack to full width on narrow screens.
- The command palette retains its specialized layout while using the shared surface language. The ontology editor and its sub-dialogs keep their established standalone styling and are excluded from shared modal overrides.
- Within the ontology exception, tag suggestions stay attached to the search input. The focused-tag edit dialog exposes confirmed whole-tag deletion, while **Add new tag…** avoids redundant description and label text.

### 1. **Centralized State Management**
- **ALL modal state lives in ModeContext** - no exceptions
- Modal-specific state stored in `ModeContext.modalState = {modalName: {...}}`
- Modal lifecycle managed via `ModeContext.modalStack = []` (empty = no modals open)

### 2. **Clean State Enforcement**
- **Notes must be closed** (exit editing mode) before opening any modal
- **BaseModal throws error** if opening when application is in active state:
  - `ModeContext.currentNoteId` exists (editing state)
  - In searching state  
  - Any other "active" state that should be closed first
- Caller responsible for cleaning state before attempting to open modal
- When a caller exits note editing, it must complete the normal save/deselect/view-refresh flow before opening the modal. This restores view-only rendering such as cached URL titles instead of leaving the editor HTML visible behind the modal.

### 3. **Event Handling Integration**
- Follow existing pattern in `keyboard-events.js` (like Esc key handler)
- Keyboard events still fire but check modal state and defer appropriately
- Operations like Cmd+Enter (new note) require modal to be closed first
- Modal has precedence - if modal open, modal-specific logic handles events

## File Organization

```
app/static/js/modules/modals/
├── base-modal.js       # BaseModal class with state enforcement
└── password-modal.js   # Password management modal
└── note-layout-appearance-modal.js # Namespace-scoped note layout presets + preview
└── [future-modal].js   # Other modals follow same pattern
```

## Implementation Pattern

### BaseModal Class

All modals extend BaseModal which provides:

1. **State Validation**
   - Throws error if opening with dirty application state
   - Enforces clean state requirement

2. **ModeContext Integration**  
   - Updates `ModeContext.modalStack` on open/close
   - Sets modal-specific state in `ModeContext.modalState`

3. **Common Event Handling**
   - Every modal shows the same upper-right circular `×` close control as full-screen note view
   - `Escape` closes every modal
   - Clicking outside the modal content closes every modal
   - `Enter` activates the modal's single declared primary action; modals with multi-step or input-specific behavior implement the equivalent explicitly
   - Focus management

4. **Shared Visual Contract**
   - Render the top-level panel with `.modal-content`; add a feature class only for specialized width/layout.
   - Use `.form-group`, `.form-actions`, `.primary-btn`, `.secondary-btn`, and `.danger-btn` instead of redefining controls.
   - Use the shared muted text, inset panel, warning, table, and status patterns before adding feature-specific colors.
   - Keep the main content within the shared viewport-aware max height; only large workspaces such as reminders or ontology should declare a fixed working height.

### Modal Opening Flow

1. User triggers a modal from the command palette or another UI control.
2. Handler checks current application state
3. If editing/searching → save + deselect + refresh the note view and/or exit search first
4. Attempt `new ModalClass().open()`
5. BaseModal enforces clean state (throws error if dirty)
6. Modal opens and updates `ModeContext.modalStack`
7. Modal-specific initialization runs

### Modal State Management

```javascript
// Example modal state structure
ModeContext.modalState = {
  passwordModal: {
    mode: 'create', // 'create' | 'change' | 'remove'
    currentStep: 1,
    formData: {...},
    isProcessing: false
  }
};

// Modal stack for stacking support
ModeContext.modalStack = ['passwordModal']; // Active modals in order
```

### Keyboard Event Integration

```javascript
// In keyboard-events.js
function handleKeyDown(event) {
  // Check if modal is open
  if (ModeContext.modalStack.length > 0) {
    const activeModal = ModeContext.modalStack[ModeContext.modalStack.length - 1];
    // Defer to modal-specific event handling
    return deferToModal(activeModal, event);
  }
  
  // Normal application event handling
  // ...
}
```

## Modal Lifecycle

### Opening a Modal
1. Validate clean application state
2. Add to modal stack
3. Set modal-specific state
4. Show modal UI
5. Set up modal-specific event listeners

### Closing a Modal  
1. The user clicks the upper-right `×`, presses `Escape`, or clicks outside the modal content
2. Clean up modal-specific event listeners
3. Remove modal-specific state
4. Remove from modal stack
5. Hide modal UI
6. Return focus to application

Dismiss-only footer buttons labeled `Close` or `OK` are not used. Workflow actions such as `Save`, `Cancel`, `Back`, and destructive confirmations remain visible when they carry meaning beyond dismissing the modal.

### Modal Stacking
- Modals can stack via `ModeContext.modalStack`
- Top modal receives events
- Closing top modal reveals previous modal
- Rarely used but architecture supports it

## Example Implementation

### BaseModal Class Structure
```javascript
class BaseModal {
  constructor(modalName) {
    this.modalName = modalName;
  }
  
  open() {
    this.validateCleanState();
    this.addToModalStack();
    this.setupModalState();
    this.showModal();
    this.setupEventListeners();
  }
  
  close() {
    this.cleanupEventListeners();
    this.hideModal();
    this.removeModalState();
    this.removeFromModalStack();
  }
  
  validateCleanState() {
    if (ModeContext.currentNoteId) {
      throw new Error('Cannot open modal while editing note');
    }
    if (ModeContext.isSearching) {
      throw new Error('Cannot open modal while in search mode');
    }
    // Add other state validations
  }
}
```

### Keyboard Shortcut Handler
```javascript
// In keyboard-events.js
if (event.metaKey && event.key === 'p') {
  event.preventDefault();
  
  // Clean state first
  if (ModeContext.currentNoteId) {
    await exitEditingMode();
  }
  
  // Open one explicit password operation; the command palette exposes all three.
  const addPasswordModal = new AddPasswordModal();
  addPasswordModal.open();
}
```

Password management uses three distinct modal flows from
`app/static/js/modules/modals/password-modal.js`:

- **Add Password**: passwordless namespace → encrypted namespace. Shows local zxcvbn strength feedback.
- **Change Password**: current password → new password. Shows local zxcvbn strength feedback.
- **Remove Password**: encrypted namespace → passwordless namespace. Requires an explicit plaintext-storage acknowledgement.

Each modal checks `/api2/auth/status` before rendering and rejects an operation
that does not match the namespace's current password state.

## Benefits of This Architecture

1. **Consistency** - All modals follow same pattern
2. **State Safety** - Clean state enforcement prevents conflicts
3. **Integration** - Works seamlessly with existing ModeContext system
4. **Scalability** - Easy to add new modals following same pattern
5. **Maintainability** - Clear separation of concerns
6. **Debuggability** - All state centralized and inspectable

## Future Considerations

- Modal animations/transitions
- Modal size variants (small, medium, large)
- Modal positioning (center, top, custom)
- Nested modal content (tabs within modals)
- Modal templates for common patterns

All future enhancements must maintain compatibility with this base architecture.
