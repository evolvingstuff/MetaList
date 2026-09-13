import { ApplicationState } from '../../application-state.js';
import { rethrowUnexpectedError } from '../../expected-errors.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import {
    createNote,
    createNoteAtTop,
    deleteNote,
    createChildNote,
    moveNoteUp,
    moveNoteDown,
    moveNoteToTop,
    indentNote,
    outdentNote,
    actionCopyNote,
    actionPasteNoteSibling,
    actionPasteNoteChild,
    splitCurrentNoteFromSelection,
    unformatCurrentNoteContent,
} from '../actions/note-actions.js';
import { actionSaveNote } from '../actions/content-actions.js';
import { actionDeselectNote, actionExitEditingWithoutSavingOrRefreshing, actionSaveAndExitEditingWithoutRefreshing } from '../actions/selection-actions.js';
import { actionUndo, actionRedo } from '../actions/history-actions.js';
import {
    executeEditorRedo,
    shouldExecuteEditorRedo,
    shouldUseApplicationHistory,
} from '../services/history-shortcut-policy-service.js';
import { actionEnterSearchMode, actionExitSearchMode } from '../actions/search-actions.js';
import { HelpModal } from '../../modals/help-modal.js';
import { DOMUtils } from '../../dom-utils.js';
import { CONFIG } from '../../config.js';
import { NotesAPI } from '../../api-client.js';
import { ErrorHandler } from '../../error-handler.js';
import { persistTabStateSnapshot, createTabOnServer, deleteTabOnServer } from '../services/tab-state-service.js';
import { cacheNotesDomForTab, restoreNotesDomForTab, cloneNotesDomForTab, clearCachedNotesDomForTab, clearActiveNotesDom } from '../services/tab-dom-cache-service.js';
import { finalizeDuplicatedTabClone, getDuplicateTabCloneOptions } from '../services/tab-duplication-service.js';
import { areScrollAnchorsEqual, computeScrollAnchor } from '../services/scroll-anchor-service.js';
import {
    blurFocusedSearchInput,
    focusSearchInputAndSelectAllText,
    resolveSearchInputDisplayQuery,
    syncSearchInputValue,
} from '../services/search-input-service.js';
import { analyzeSearchQueryInput } from '../services/search-syntax-service.js';
import { buildBacklinksQuery } from '../services/backlinks-navigation-service.js';
import {
    captureReferenceOriginScopeForActiveTab,
    isViewingReferenceSource,
    popReferenceNavigationEntryForActiveTab,
    pushReferenceNavigationEntry,
    replaceActiveReferenceNavigationQuery,
    updateReferenceSourceIndicator,
} from '../services/reference-source-navigation-service.js';
import { shouldFocusSearchInputForViewModeTab } from '../services/view-mode-search-shortcut-service.js';
import {
    getTagBarValue,
    normalizeTagBarForNewTag,
    sanitizeTags,
    setTagBarValue,
    syncTagBar,
} from '../services/tag-bar-service.js';
import { sanitizeAndInsertExternalPaste } from '../services/html-paste-sanitizer-service.js';
import {
    resolveClipboardTrackingAfterPasteEvent,
    shouldAllowBrowserPasteForShortcut,
    shouldCreateTopNoteForPaste,
} from '../services/clipboard-shortcut-policy-service.js';
import {
    writeRenderedNotePromiseToSystemClipboard,
    writeRenderedNoteToSystemClipboard,
} from '../services/note-clipboard-write-service.js';
import {
    addPasswordTag,
    shouldAutoTagGeneratedPasswordPaste,
} from '../services/password-clipboard-service.js';
import {
    estimateDataUrlPayloadBytes,
    getEmbedTargetImageBytes,
    getMaxClipboardImageBytes,
    getMaxPasteDataImageBytes,
    imageBlobToEmbeddedDataUrl,
} from '../services/embedded-image-service.js';
import { promptForImageFileInsertMode } from '../services/image-file-insert-choice-modal-service.js';
import { attachPickedFileToCurrentNote, insertReferenceTokenIntoActiveEditor } from '../services/file-reference-service.js';
import { shouldCreateTopNoteForFileDrop } from '../services/file-drop-policy-service.js';
import { shouldDeleteSelectedNoteFromKeyboard } from '../services/note-delete-shortcut-policy-service.js';
import { syncBacklinksPanelPlacement } from '../services/backlinks-panel-service.js';
import {
    hideSearchContextsOverlay,
    initializeSearchContextsHover,
    isSearchContextsKeyboardCreateActive,
    updateSearchContextsOverlayPlacement,
} from '../services/search-contexts-overlay-service.js';
import { CommandPalette } from '../../command-palette/command-palette-controller.js';
import { CommandGate } from '../services/command-gate-service.js';
import { captureSelectionSnapshot, getActiveEditable } from '../../editor-selection.js';

const helpModal = new HelpModal();

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);
const NAVIGATION_KEYS = new Set([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
]);
const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const DELETE_KEYS = new Set(['Backspace', 'Delete']);
const TAG_BAR_META_SHORTCUT_KEYS = new Set(['c', 'x', 'v', 'z', 'y', 'r', 's', 'j', 'u', 'p']);

const moduleState = ApplicationState.createFields('keyboard-events', {
    savedEditingRange: null,
    savedEditingRangeNoteId: null,
    savedEditingCursorOffset: null,
    noteClipboardRequiresBrowserValidation: false,
    tabDragCandidateId: null,
    draggedTabId: null,
    ignoreClickAfterTabDragUntil: null,
});


function isTagBarNoteShortcut(event) {
    if (!event) {
        throw new Error('isTagBarNoteShortcut called without event');
    }
    if (typeof event.key !== 'string') {
        throw new Error('isTagBarNoteShortcut requires event.key');
    }

    if (event.key === 'Tab') {
        return true;
    }

    if (!(event.metaKey || event.ctrlKey)) {
        return false;
    }

    if (event.key === 'Enter') {
        return true;
    }
    if (DELETE_KEYS.has(event.key)) {
        return true;
    }
    if (MOVE_KEYS.has(event.key)) {
        return true;
    }
    return TAG_BAR_META_SHORTCUT_KEYS.has(event.key);
}

export function initKeyboardEvents() {
        
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    document.addEventListener('paste', handlePasteEvent, { capture: false });
    document.addEventListener('visibilitychange', handleVisibilityChange, { capture: false });
    document.addEventListener('dragover', handleDragOverEvent, { capture: false });
    document.addEventListener('drop', handleDropEvent, { capture: false });
    document.addEventListener('mousedown', handleTabDragCandidateMouseDown, { capture: true });
    document.addEventListener('mouseup', clearTabDragCandidate, { capture: true });
    document.addEventListener('dragstart', handleTabDragStart, { capture: true });
    document.addEventListener('dragover', handleTabDragOver, { capture: true });
    document.addEventListener('drop', handleTabDrop, { capture: true });
    document.addEventListener('dragend', handleTabDragEnd, { capture: true });
    document.addEventListener('click', handleTabDragClick, { capture: true });
    window.addEventListener('blur', handleWindowBlur, { capture: false });
    window.addEventListener('resize', handleSearchContextsViewportChange, { passive: true });
    initializeSearchContextsHover();
        
    Logger.logInit('Keyboard events handler');
    
    // Initialize search contexts list on startup
    updateSearchContextsList();
    updateReferenceSourceIndicator();
}

function handleSearchContextsViewportChange() {
    updateSearchContextsOverlayPlacement();
    syncBacklinksPanelPlacement();
}

function markSystemClipboardAsTrusted() {
    moduleState.noteClipboardRequiresBrowserValidation = false;
    // System clipboard writes can happen repeatedly while the clipboard mode is already system.
    if (ModeContext.clipboardMode !== 'system') {
        ModeContext.setClipboardMode('system');
    }
}

function markNoteClipboardAsTrusted() {
    moduleState.noteClipboardRequiresBrowserValidation = false;
    // Note clipboard writes can refresh clipboard contents without changing clipboard mode.
    if (ModeContext.clipboardMode !== 'note') {
        ModeContext.setClipboardMode('note');
    }
}

function invalidateTrustedNoteClipboard() {
    if (ModeContext.clipboardMode !== 'note') {
        return;
    }
    moduleState.noteClipboardRequiresBrowserValidation = true;
}

function handleWindowBlur() {
    invalidateTrustedNoteClipboard();
    finishTabDrag();
}

function handleVisibilityChange() {
    if (document.visibilityState !== 'hidden') {
        return;
    }
    invalidateTrustedNoteClipboard();
}

function syncClipboardTrackingFromPasteEventHtml(clipboardHtml) {
    const resolved = resolveClipboardTrackingAfterPasteEvent({
        clipboardMode: ModeContext.clipboardMode,
        noteClipboardRequiresBrowserValidation: moduleState.noteClipboardRequiresBrowserValidation,
        clipboardHtml,
    });
    moduleState.noteClipboardRequiresBrowserValidation = resolved.noteClipboardRequiresBrowserValidation;
    // Browser paste validation can confirm the existing clipboard mode.
    if (ModeContext.clipboardMode !== resolved.clipboardMode) {
        ModeContext.setClipboardMode(resolved.clipboardMode);
    }
    return resolved.hasNoteClipboardHtml;
}

function handleKeyDown(event) {
    if (!event) {
        throw new Error('handleKeyDown called without an event object');
    }

    // Native batch dialogs remain keyboard-operable while CommandGate locks the
    // rest of the app. Never treat their Enter/Escape/arrow keys as note commands.
    if (event.target instanceof HTMLElement
        && event.target.closest('dialog.bulk-proposal-dialog[open], .ai-chat-tag-operation')) {
        return;
    }

    if (typeof event.key !== 'string') {
        Logger.logNoop('Ignoring keyboard event missing key', {
            eventType: event.type,
            keyValue: event.key,
        });
        return;
    }

    if ((event.key === 'Enter' || event.key === ' ')
        && event.target instanceof HTMLElement
        && event.target.closest('.note-source-arrow, #reference-source-indicator-clear')) {
        return;
    }

    if (event.key === 'Enter') {
        const searchInput = document.getElementById('search-input');
        const suggestions = document.getElementById('search-suggestions');
        if (searchInput && suggestions && !suggestions.hidden && document.activeElement === searchInput) {
            Logger.logNoop('Ignoring Enter for global shortcuts while search suggestions are open');
            return;
        }
    }

    // Never interpret typing/navigation within inputs as global shortcuts.
    // In particular, Backspace/Delete must not delete notes while editing the search box.
    // Exception: Enter in the search input is treated like a global "create note" action.
	    if (event.key !== 'Escape') {
	        const target = event.target;
	        if (target instanceof HTMLElement) {
	            const tagName = target.tagName;
	            let isTextInput = false;
	            if (tagName === 'INPUT') {
	                isTextInput = true;
	            } else if (tagName === 'TEXTAREA') {
	                isTextInput = true;
	            }
	            const isSearchInput = tagName === 'INPUT' && target.id === 'search-input';
	            const isTagBarInput = tagName === 'INPUT' && target.classList.contains('note-tag-bar-input');
	            const isCommandPaletteShortcut = event.key === '/' && (event.metaKey || event.ctrlKey);
                const isTagBarShortcut = isTagBarInput && ModeContext.isEditing && isTagBarNoteShortcut(event);

	            if (isTextInput && !(isSearchInput && event.key === 'Enter') && !isCommandPaletteShortcut) {
	                if (!isTagBarShortcut) {
	                    return;
	                }
	            }
	        }
	    }

    if (ModeContext.isLoading) {
        Logger.logNoop('Keyboard event ignored while system is loading', {
            key: event.key,
            meta: event.metaKey || event.ctrlKey,
            shift: event.shiftKey,
            isLoading: true
        });
        event.preventDefault();
        event.stopPropagation();
        return;
    }

    let metaOrCtrl = false;
    if (event.metaKey) {
        metaOrCtrl = true;
    } else if (event.ctrlKey) {
        metaOrCtrl = true;
    }

    const previousKeyInfo = ModeContext.keyInfo;
    // Key-repeat and modifier-only sequences can produce identical key snapshots.
    if (
        previousKeyInfo.key !== event.key
        || previousKeyInfo.meta !== metaOrCtrl
        || previousKeyInfo.shift !== Boolean(event.shiftKey)
    ) {
        ModeContext.setKeyPressed(event.key, metaOrCtrl, event.shiftKey);
    }

    Logger.logDebug('Key pressed', {
        key: event.key,
        meta: event.metaKey || event.ctrlKey,
        shift: event.shiftKey
    }, Logger.LogCategory.EVENT);

    revealCaretForCurrentNote();

    if (ModeContext.modalStack && ModeContext.modalStack.length > 0) {
        const targetElement = event.target instanceof Element ? event.target.closest('.modal') : null;
        if (targetElement) {
            return;
        }

        if (event.key !== 'Escape') {
            Logger.logNoop('Keyboard event ignored while a modal is open', {
                key: event.key,
                modalStack: ModeContext.modalStack.slice()
            });
            event.preventDefault();
            event.stopPropagation();
            return;
        }
    }

    if (ModeContext.isEditing) {
                
        const isModifierKey = MODIFIER_KEYS.has(event.key);
        const isNavigationKey = NAVIGATION_KEYS.has(event.key);
        const isFunctionKey = event.key.startsWith('F') && event.key.length > 1; 

        if (!isModifierKey && !isNavigationKey && !isFunctionKey && 
                !event.ctrlKey && !event.metaKey && event.key !== 'Escape') {

            Logger.logDebug('Detected content-changing keypress', {
                key: event.key,
                noteId: ModeContext.currentNoteId
            }, Logger.LogCategory.EVENT);

            if (!ModeContext.isDirty) {
                ModeContext.setDirty(true);
                Logger.logDebug('Content marked as dirty due to typing', {
                    key: event.key,
                    noteId: ModeContext.currentNoteId
                }, Logger.LogCategory.STATE);
            }
        }
    }
    
	    const isMoveKey = MOVE_KEYS.has(event.key);
    const isSelectedDeleteShortcut = shouldDeleteSelectedNoteFromKeyboard({
        key: event.key,
        metaKey: Boolean(event.metaKey),
        ctrlKey: Boolean(event.ctrlKey),
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
    });

    // Check if we're disconnected from server for operations that need it
	    if (!ModeContext.isConnected) {
        let needsServer = false;
        if (event.key === 'Enter' && (metaOrCtrl || !ModeContext.isEditing)) {
            needsServer = true;
        } else if (isSelectedDeleteShortcut) {
            needsServer = true;
	        } else if (isMoveKey && metaOrCtrl) {
	            needsServer = true;
        } else if (event.key === 'v' && metaOrCtrl) {
            needsServer = true;
        } else if (event.key === 'u' && metaOrCtrl) {
            needsServer = true;
        } else if (event.key === 's' && metaOrCtrl) {
            needsServer = true;
        } else if (event.key === 'c' && metaOrCtrl) {
            needsServer = true;
        } else if ((event.key === 'z' || event.key === 'y') && metaOrCtrl) {
            needsServer = true;
        }
        
        if (needsServer) {
            Logger.logNoop('Keyboard shortcut ignored while disconnected from server', {
                key: event.key,
                meta: event.metaKey || event.ctrlKey,
                isConnected: false
            });
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        // Allow ESC and search while disconnected.
    }

    switch (event.key) {
        case 'Tab':
            if (ModeContext.isEditing) {
                handleToggleTagBarFocusShortcut(event);
            } else {
                handleViewModeSearchFocusShortcut(event);
            }
            break;
        case 'Escape':
            handleEscapeKey();
            break;
        case 'Enter':
            if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
                handleCreateChildNoteShortcut(event);
            } else if (event.metaKey || event.ctrlKey) {
                handleCreateNoteShortcut(event);
            } else {
                handleEnterKey(event);
            }
            break;
        case 'Backspace':
        case 'Delete':
            if (isSelectedDeleteShortcut) {
                handleDeleteNoteShortcut(event);
            }
            break;
        case '/':
            if (event.metaKey || event.ctrlKey) {
                event.preventDefault();
                event.stopPropagation();
                void CommandPalette.toggle();
            }
            break;
	        case 'ArrowUp':
	            if (event.metaKey || event.ctrlKey) {
                    if (event.shiftKey) {
                        handleMoveNoteToTopShortcut(event);
                    } else {
	                    handleMoveNoteUpShortcut(event);
                    }
	            }
	            break;
	        case 'ArrowDown':
	            if (event.metaKey || event.ctrlKey) {
	                handleMoveNoteDownShortcut(event);
	            }
	            break;
	        case 'ArrowLeft':
	            if (event.metaKey || event.ctrlKey) {
	                handleOutdentNoteShortcut(event);
	            }
	            break;
	        case 'ArrowRight':
	            if (event.metaKey || event.ctrlKey) {
	                handleIndentNoteShortcut(event);
	            }
	            break;
        case 'v':
            if (event.metaKey || event.ctrlKey) {
                if (event.shiftKey) {
                    handlePasteNoteChildShortcut(event);
                } else {
                    handlePasteNoteSiblingShortcut(event);
                }
            }
            break;
        case 'z':
            if (event.metaKey || event.ctrlKey) {
                if (event.shiftKey) {
                    handleRedoShortcut(event);
                } else {
                    handleUndoShortcut(event);
                }
            }
            break;
        case 'c':
            if (event.metaKey || event.ctrlKey) {
                handleCopyNoteShortcut(event);
            }
            break;
        case 'r':
            if (event.metaKey || event.ctrlKey) {
                handleInsertEmbedReferenceShortcut(event);
            }
            break;
        case 's':
            if (event.metaKey || event.ctrlKey) {
                void handleSplitNoteShortcut(event);
            }
            break;
        case 'u':
            if (event.metaKey || event.ctrlKey) {
                void handleUnformatNoteShortcut(event);
            }
            break;
        case 'x':
            if (event.metaKey || event.ctrlKey) {
                void handleCutNoteShortcut(event);
            }
            break;
        case 'y':
            if (event.metaKey || event.ctrlKey) {
                handleRedoShortcut(event);
            }
            break;
        case '?':
            if (!event.metaKey && !event.ctrlKey) {
                handleHelpModalShortcut(event);
            }
            break;
        default:
            break;
                
    }
}

function handleViewModeSearchFocusShortcut(event) {
    if (!event) {
        throw new Error('handleViewModeSearchFocusShortcut called without an event object');
    }

    const modalStack = Array.isArray(ModeContext.modalStack) ? ModeContext.modalStack : [];
    const shouldFocusSearch = shouldFocusSearchInputForViewModeTab({
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isEditing: ModeContext.isEditing,
        isSearching: ModeContext.isSearching,
        isLoading: ModeContext.isLoading,
        modalStack,
    });

    if (!shouldFocusSearch) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    void actionEnterSearchMode();
    const didFocus = focusSearchInputAndSelectAllText();
    Logger.logDebug('Search input focused via view-mode Tab shortcut', {
        didFocus,
    }, Logger.LogCategory.EVENT);
}

function handleToggleTagBarFocusShortcut(event) {
    if (!event) {
        throw new Error('handleToggleTagBarFocusShortcut called without an event object');
    }

    if (!ModeContext.isEditing || !ModeContext.currentNoteId) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const currentNoteId = ModeContext.currentNoteId;
    const noteElement = DOMUtils.getNoteById(currentNoteId);

    const activeElement = document.activeElement;
    const activeIsTagInput = activeElement && activeElement.classList
        ? activeElement.classList.contains('note-tag-bar-input')
        : false;

	    if (activeIsTagInput) {
	        const tagInput = noteElement.querySelector('.note-tag-bar-input');
	        if (!tagInput) {
	            throw new Error('Expected tag input to exist when toggling focus back to content');
	        }
	
	        const rawTags = tagInput.value;
	        if (typeof rawTags !== 'string') {
	            throw new Error('Tag input value must be string');
	        }
	        const sanitized = sanitizeTags(rawTags);
	        setTagBarValue(noteElement, sanitized);

        const contentElement = DOMUtils.getNoteContent(noteElement);
        if (!contentElement) {
            throw new Error('Note missing content element when restoring focus');
        }

        contentElement.focus();

        if (moduleState.savedEditingRange && moduleState.savedEditingRangeNoteId === currentNoteId) {
            const range = moduleState.savedEditingRange;
            const startOk = range.startContainer && contentElement.contains(range.startContainer);
            const endOk = range.endContainer && contentElement.contains(range.endContainer);
            if (startOk && endOk) {
                const selection = window.getSelection();
                if (!selection) {
                    throw new Error('No selection available when restoring editor range');
                }
                selection.removeAllRanges();
                selection.addRange(range);
                return;
            }
        }

        if (Number.isInteger(moduleState.savedEditingCursorOffset) && moduleState.savedEditingRangeNoteId === currentNoteId) {
            DOMUtils.focusNote(noteElement, moduleState.savedEditingCursorOffset);
            return;
        }

        DOMUtils.focusNoteEdge(noteElement, 'end');
        return;
    }

    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const contentElement = DOMUtils.getNoteContent(noteElement);
        if (contentElement && range && range.commonAncestorContainer && contentElement.contains(range.commonAncestorContainer)) {
            moduleState.savedEditingRange = range.cloneRange();
            moduleState.savedEditingRangeNoteId = currentNoteId;
            moduleState.savedEditingCursorOffset = null;

            const anchorNode = selection.anchorNode;
            if (anchorNode && contentElement.contains(anchorNode)) {
                moduleState.savedEditingCursorOffset = DOMUtils.getCursorOffset(noteElement);
            }
        }
    }

    syncTagBar(noteElement);
    const tagInput = noteElement.querySelector('.note-tag-bar-input');
    if (!tagInput) {
        throw new Error('Tag input missing after syncTagBar');
    }

    normalizeTagBarForNewTag(noteElement, tagInput);

    tagInput.focus();
    const end = tagInput.value.length;
    tagInput.setSelectionRange(end, end);
}

function revealCaretForCurrentNote() {
    // Most keystrokes happen after the caret is already visible; collapsed-note edit mode is the exception.
    if (!ModeContext.isEditing || !ModeContext.isCaretHidden) {
        return;
    }

    const currentNoteId = ModeContext.currentNoteId;
    if (!currentNoteId) {
        return;
    }

    const noteElement = DOMUtils.getNoteById(currentNoteId);
    DOMUtils.revealCaret(noteElement);
    ModeContext.markCaretVisible();
}

function handleEscapeKey() {
    if (ModeContext.isSearching === undefined) {
        throw new Error('ModeContext missing isSearching property in handleEscapeKey');
    }

    const didHideSearchContexts = hideSearchContextsOverlay();

    if (!didHideSearchContexts && !ModeContext.isEditing && isViewingReferenceSource()) {
        void CommandGate.run('keyboard.escape.reference', async () => {
            await navigateBackFromReferenceContext();
        });
        return;
    }

    if (blurFocusedSearchInput()) {
        if (ModeContext.isSearching) {
            actionExitSearchMode();
        }
        Logger.logDebug('Search input blurred via Escape key', {}, Logger.LogCategory.EVENT);
        return;
    }

    if (didHideSearchContexts) {
        Logger.logDebug('Search contexts hidden via Escape key', {}, Logger.LogCategory.EVENT);
        return;
    }
        
    if (ModeContext.isSearching) {
        ModeContext.setSearching(false);
        ModeContext.validate();
        Logger.logDebug('Search cancelled via Escape key', {}, Logger.LogCategory.EVENT);
    }
	else if (ModeContext.isEditing) {
	    void CommandGate.run('keyboard.escape.deselect', async () => {
	        await actionDeselectNote();
	    });
	            
		Logger.logDebug('Editing cancelled via Escape key', {
			previousNoteId: ModeContext.currentNoteId 
		}, Logger.LogCategory.EVENT);
	}
    else {
                
        Logger.logNoop('Escape key pressed but had no effect', {
            isSearching: ModeContext.isSearching,
            isEditing: ModeContext.isEditing
        });
    }
}

function handleEnterKey(event) {
    if (!event) {
        throw new Error('handleEnterKey called without an event object');
    }
        
    if (ModeContext.isEditing === undefined) {
        throw new Error('ModeContext missing isEditing property in handleEnterKey');
    }

    Logger.logDebug('Enter key pressed', {
        inEditor: ModeContext.isEditing,
        noteId: ModeContext.currentNoteId
    });

    if (ModeContext.isEditing) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (isSearchContextsKeyboardCreateActive()) {
        void CommandGate.run('keyboard.enter.blank_search_context', async () => {
            await createBlankSearchContextFromHover();
        });
        return;
    }

	if (ModeContext.isSearching) {
		actionExitSearchMode();
	}

	void CommandGate.run('keyboard.enter.create', async () => {
		await createNote();
	});
}

function handleCreateNoteShortcut(event) {
    if (!event) {
        throw new Error('handleCreateNoteShortcut called without an event object');
    }

    Logger.logDebug('Create note shortcut triggered', {
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId
    }, Logger.LogCategory.EVENT);

    event.preventDefault();

	if (ModeContext.isSearching) {
		actionExitSearchMode();
	}

	void CommandGate.run('keyboard.create_note', async () => {
		await createNote();
	});
}

function handleCreateChildNoteShortcut(event) {
    if (!event) {
        throw new Error('handleCreateChildNoteShortcut called without an event object');
    }

    Logger.logDebug('Create child note shortcut triggered', {
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId
    }, Logger.LogCategory.EVENT);

    event.preventDefault();

	if (ModeContext.isSearching) {
		actionExitSearchMode();
	}

	void CommandGate.run('keyboard.create_child', async () => {
		await createChildNote();
	});
}

function handleDeleteNoteShortcut(event) {
    if (!event) {
        throw new Error('handleDeleteNoteShortcut called without an event object');
    }
        
    const noteId = ModeContext.currentNoteId;

    Logger.logDebug('Delete note shortcut triggered', {
        isEditing: ModeContext.isEditing,
        currentNoteId: noteId
    }, Logger.LogCategory.EVENT);

    event.preventDefault();

	if (noteId) {
	    void CommandGate.run('keyboard.delete', async () => {
	        await deleteNote(noteId);
	    });
	} else {
                
        Logger.logNoop('Delete shortcut pressed but no note is selected', {
            isEditing: ModeContext.isEditing,
            currentNoteId: null
        });
    }
}

function handleSearchShortcut() {
    if (typeof ModeContext.setSearching !== 'function') {
        throw new Error('ModeContext missing setSearching method in handleSearchShortcut');
    }
        
    ModeContext.setSearching(true);
    ModeContext.validate();
    Logger.logDebug('Search activated via keyboard shortcut');

}

function handleMoveNoteUpShortcut(event) {
    if (!event) {
        throw new Error('handleMoveNoteUpShortcut called without an event object');
    }

    event.preventDefault();
    event.stopPropagation();

    const noteId = ModeContext.currentNoteId;
    if (!noteId) {
        Logger.logNoop('Move up shortcut pressed but no note is selected', {
            isEditing: ModeContext.isEditing,
            currentNoteId: null
        });
        return;
    }

    Logger.logDebug('Move note up shortcut triggered', {
        noteId: ModeContext.currentNoteId
    }, Logger.LogCategory.EVENT);

	void CommandGate.run('keyboard.move_up', async () => {
		await moveNoteUp(noteId);
	});
}

function handleMoveNoteToTopShortcut(event) {
    if (!event) {
        throw new Error('handleMoveNoteToTopShortcut called without an event object');
    }

    event.preventDefault();
    event.stopPropagation();

    const noteId = ModeContext.currentNoteId;
    if (!noteId) {
        Logger.logNoop('Move to top shortcut pressed but no note is selected', {
            isEditing: ModeContext.isEditing,
            currentNoteId: null,
        });
        return;
    }

    Logger.logDebug('Move note to top shortcut triggered', {
        noteId: ModeContext.currentNoteId,
        searchQuery: ModeContext.searchQuery,
    }, Logger.LogCategory.EVENT);

    void CommandGate.run('keyboard.move_to_top', async () => {
        await moveNoteToTop(noteId);
    });
}

function handleMoveNoteDownShortcut(event) {
    if (!event) {
        throw new Error('handleMoveNoteDownShortcut called without an event object');
    }

    event.preventDefault();
    event.stopPropagation();

    const noteId = ModeContext.currentNoteId;
    if (!noteId) {
        Logger.logNoop('Move down shortcut pressed but no note is selected', {
            isEditing: ModeContext.isEditing,
            currentNoteId: null
        });
        return;
    }

	Logger.logDebug('Move note down shortcut triggered', {
		noteId: ModeContext.currentNoteId
	}, Logger.LogCategory.EVENT);

	void CommandGate.run('keyboard.move_down', async () => {
		await moveNoteDown(noteId);
	});
}

function handleIndentNoteShortcut(event) {
    if (!event) {
        throw new Error('handleIndentNoteShortcut called without an event object');
    }

    event.preventDefault();
    event.stopPropagation();

    const noteId = ModeContext.currentNoteId;
    if (!noteId) {
        Logger.logNoop('Indent shortcut pressed but no note is selected', {
            isEditing: ModeContext.isEditing,
            currentNoteId: null
        });
        return;
    }

    Logger.logDebug('Indent note shortcut triggered', {
        noteId: ModeContext.currentNoteId
    }, Logger.LogCategory.EVENT);

	void CommandGate.run('keyboard.indent', async () => {
		await indentNote(noteId);
	});
}

function handleOutdentNoteShortcut(event) {
    if (!event) {
        throw new Error('handleOutdentNoteShortcut called without an event object');
    }

    event.preventDefault();
    event.stopPropagation();

    const noteId = ModeContext.currentNoteId;
    if (!noteId) {
        Logger.logNoop('Outdent shortcut pressed but no note is selected', {
            isEditing: ModeContext.isEditing,
            currentNoteId: null
        });
        return;
    }

    Logger.logDebug('Outdent note shortcut triggered', {
        noteId: ModeContext.currentNoteId
    }, Logger.LogCategory.EVENT);

	void CommandGate.run('keyboard.outdent', async () => {
		await outdentNote(noteId);
	});
}

function handleUndoShortcut(event) {
    if (!event) {
        throw new Error('handleUndoShortcut called without an event object');
    }

    if (!shouldUseApplicationHistory({
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty,
        editSessionHasEdits: ModeContext.editSessionHasEdits,
    })) {
        Logger.logDebug('Undo shortcut left to the active note editor', {
            isEditing: ModeContext.isEditing,
            currentNoteId: ModeContext.currentNoteId,
            isDirty: ModeContext.isDirty,
            editSessionHasEdits: ModeContext.editSessionHasEdits
        }, Logger.LogCategory.EVENT);
        return;
    }

    Logger.logDebug('Undo shortcut triggered', {
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId
    }, Logger.LogCategory.EVENT);

    event.preventDefault();

    event.stopPropagation();

	void CommandGate.run('keyboard.undo', async () => {
		await actionUndo();
	});
}

function handleRedoShortcut(event) {
    if (!event) {
        throw new Error('handleRedoShortcut called without an event object');
    }

    if (!shouldUseApplicationHistory({
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty,
        editSessionHasEdits: ModeContext.editSessionHasEdits,
    })) {
        if (shouldExecuteEditorRedo({ isEditing: ModeContext.isEditing, key: event.key })) {
            event.preventDefault();
            event.stopPropagation();
            const didRedo = executeEditorRedo(document);
            Logger.logDebug('Redo shortcut executed in the active note editor', {
                currentNoteId: ModeContext.currentNoteId,
                didRedo,
            }, Logger.LogCategory.EVENT);
            return;
        }
        Logger.logDebug('Redo shortcut left to the active note editor', {
            isEditing: ModeContext.isEditing,
            currentNoteId: ModeContext.currentNoteId,
            isDirty: ModeContext.isDirty,
            editSessionHasEdits: ModeContext.editSessionHasEdits,
        }, Logger.LogCategory.EVENT);
        return;
    }

    Logger.logDebug('Redo shortcut triggered', {
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId
    }, Logger.LogCategory.EVENT);

    event.preventDefault();

    event.stopPropagation();

	void CommandGate.run('keyboard.redo', async () => {
		await actionRedo();
	});
}

async function handleCopyNoteShortcut(event) {
    if (!event) {
        throw new Error('handleCopyNoteShortcut called without an event object');
    }

    Logger.logDebug('Copy note shortcut triggered', {
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId
    }, Logger.LogCategory.EVENT);

    if (!ModeContext.isEditing) {
        Logger.logNoop('Copy shortcut pressed but not in editing mode', {
            isEditing: false
        });
        return;
    }

    const currentNoteId = ModeContext.currentNoteId;
    if (!currentNoteId) {
        Logger.logNoop('Copy shortcut pressed but no note is selected', {
            isEditing: true,
            currentNoteId: null
        });
        return;
    }

    const activeElement = document.activeElement;
    const activeElementIsTextInput = activeElement
        && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');
    if (activeElementIsTextInput) {
        const selectionStart = activeElement.selectionStart;
        const selectionEnd = activeElement.selectionEnd;
        if (typeof selectionStart === 'number' && typeof selectionEnd === 'number' && selectionEnd > selectionStart) {
            markSystemClipboardAsTrusted();
            return;
        }
    }

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && document.activeElement.isContentEditable) {

        Logger.logDebug('Text selection detected, using system clipboard for text copy', {}, Logger.LogCategory.EVENT);

        // Set clipboard mode to system and allow default browser behavior
        markSystemClipboardAsTrusted();
        
        return; // Let browser handle text copy
    }

    // No text selected - do note copy
    event.preventDefault();

    const copyResultPromise = CommandGate.run('keyboard.copy_note', async () => {
        return await actionCopyNote();
    });
    const clipboardResult = await writeRenderedNotePromiseToSystemClipboard({
        renderedNotePromise: copyResultPromise,
        logger: Logger,
    });
    const copyResult = clipboardResult.renderedNote;
    if (copyResult === null) {
        return;
    }
    markNoteClipboardAsTrusted();

    const copiedNoteId = copyResult?.note_id;
    if (typeof copiedNoteId === 'string' && copiedNoteId.length > 0) {
        // Copying the same note again should refresh system clipboard data without changing note clipboard state.
        if (ModeContext.clipboardNoteId !== copiedNoteId) {
            ModeContext.setClipboardNoteId(copiedNoteId);
        }
    }

    Logger.logDebug('Note copied to server clipboard', {
        noteId: ModeContext.currentNoteId
    }, Logger.LogCategory.EVENT);

    if (!copyResult?.html && !copyResult?.plain_text) {
        Logger.logDebug('Copy endpoint returned no rendered content', {}, Logger.LogCategory.EVENT);
        return;
    }

    if (!clipboardResult.didWrite) {
        Logger.logDebug('Unable to write rendered note content to system clipboard', {}, Logger.LogCategory.EVENT);
    }
}

function ensureSelectionInsideEditableContent(contentElement) {
    if (!contentElement) {
        throw new Error('ensureSelectionInsideEditableContent requires content element');
    }

    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable');
    }

    const hasRangeInContent = (
        selection.rangeCount > 0
        && contentElement.contains(selection.anchorNode)
        && contentElement.contains(selection.focusNode)
    );
    if (hasRangeInContent) {
        return;
    }

    const range = document.createRange();
    range.selectNodeContents(contentElement);
    range.collapse(false);
    contentElement.focus();
    selection.removeAllRanges();
    selection.addRange(range);
}

function _linePrefixText(fullText) {
    if (typeof fullText !== 'string') {
        throw new Error('_linePrefixText requires string');
    }
    const lastLf = fullText.lastIndexOf('\n');
    const lastCr = fullText.lastIndexOf('\r');
    const boundary = Math.max(lastLf, lastCr);
    if (boundary === -1) {
        return fullText;
    }
    return fullText.slice(boundary + 1);
}

function _lineSuffixText(fullText) {
    if (typeof fullText !== 'string') {
        throw new Error('_lineSuffixText requires string');
    }
    const lf = fullText.indexOf('\n');
    const cr = fullText.indexOf('\r');
    let boundary = -1;
    if (lf === -1) {
        boundary = cr;
    } else if (cr === -1) {
        boundary = lf;
    } else {
        boundary = Math.min(lf, cr);
    }
    if (boundary === -1) {
        return fullText;
    }
    return fullText.slice(0, boundary);
}

function _lineHasVisibleText(text) {
    if (typeof text !== 'string') {
        throw new Error('_lineHasVisibleText requires string');
    }
    const normalized = text.replace(/\u00a0/g, ' ');
    return normalized.trim().length > 0;
}

function _findDirectLineContainer(contentElement, node) {
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('_findDirectLineContainer requires content element');
    }
    if (!node) {
        return null;
    }

    let current = node;
    while (current && current !== contentElement) {
        if (current.parentNode === contentElement) {
            if (current instanceof HTMLElement) {
                return current;
            }
            return null;
        }
        current = current.parentNode;
    }
    return null;
}

function _lineElementIsVisuallyEmpty(lineElement) {
    if (!(lineElement instanceof HTMLElement)) {
        throw new Error('_lineElementIsVisuallyEmpty requires HTMLElement');
    }
    if (
        lineElement.querySelector(
            'img,video,audio,iframe,svg,math,canvas,input,textarea,button,table,hr',
        )
    ) {
        return false;
    }
    const text = typeof lineElement.textContent === 'string' ? lineElement.textContent : '';
    const normalized = text.replace(/\u00a0/g, ' ');
    return normalized.trim().length === 0;
}

function _isSelectionCollapsedOnEmptyVisualLine(contentElement, range) {
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('_isSelectionCollapsedOnEmptyVisualLine requires content element');
    }
    if (!(range instanceof Range)) {
        throw new Error('_isSelectionCollapsedOnEmptyVisualLine requires range');
    }
    if (!range.collapsed) {
        return false;
    }

    const lineElement = _findDirectLineContainer(contentElement, range.startContainer);
    if (lineElement) {
        return _lineElementIsVisuallyEmpty(lineElement);
    }

    if (range.startContainer === contentElement) {
        if (contentElement.childNodes.length === 0) {
            return true;
        }
        if (contentElement.childNodes.length === 1) {
            const onlyChild = contentElement.childNodes[0];
            if (onlyChild instanceof HTMLBRElement) {
                return true;
            }
            if (onlyChild instanceof Text) {
                return !(_lineHasVisibleText(onlyChild.data));
            }
        }
    }

    return false;
}

function getSelectionLineContext(contentElement) {
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('getSelectionLineContext requires content element');
    }

    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable');
    }
    if (selection.rangeCount === 0) {
        throw new Error('Selection range missing');
    }

    const range = selection.getRangeAt(0);
    if (!contentElement.contains(range.startContainer) || !contentElement.contains(range.endContainer)) {
        throw new Error('Selection is outside editable content');
    }

    if (_isSelectionCollapsedOnEmptyVisualLine(contentElement, range)) {
        return {
            hasTextBeforeOnLine: false,
            hasTextAfterOnLine: false,
        };
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(contentElement);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const beforeText = beforeRange.toString();

    const afterRange = document.createRange();
    afterRange.selectNodeContents(contentElement);
    afterRange.setStart(range.endContainer, range.endOffset);
    const afterText = afterRange.toString();

    const beforeLineText = _linePrefixText(beforeText);
    const afterLineText = _lineSuffixText(afterText);

    return {
        hasTextBeforeOnLine: _lineHasVisibleText(beforeLineText),
        hasTextAfterOnLine: _lineHasVisibleText(afterLineText),
    };
}

function insertPlainTextAtCurrentSelection(text) {
    if (typeof text !== 'string') {
        throw new Error('insertPlainTextAtCurrentSelection requires text string');
    }

    const inserted = document.execCommand('insertText', false, text);
    if (inserted) {
        return;
    }

    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable while inserting text');
    }
    if (selection.rangeCount === 0) {
        throw new Error('Selection range missing while inserting text');
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function handleInsertEmbedReferenceShortcut(event) {
    if (!event) {
        throw new Error('handleInsertEmbedReferenceShortcut called without an event object');
    }

    const currentNoteId = ModeContext.currentNoteId;

    event.preventDefault();
    event.stopPropagation();

    const referenceNoteId = ModeContext.clipboardNoteId;
    if (typeof referenceNoteId !== 'string' || referenceNoteId.length === 0) {
        Logger.logNoop('Reference shortcut ignored: no copied note UUID available', {
            isEditing: ModeContext.isEditing,
            currentNoteId,
        });
        return;
    }

    if (!ModeContext.isEditing) {
        if (event.shiftKey) {
            return;
        }
        void CommandGate.run('keyboard.paste_reference_new_top_note', async () => {
            const newNoteId = await createNoteAtTop();
            insertReferenceTokenIntoActiveEditor(`![[${referenceNoteId}]]`);
            await actionSaveNote(newNoteId);
            ModeContext.resetEditSessionState({ startedCollapsed: false });
        });
        return;
    }

    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        throw new Error('Reference insertion requires current note id while editing');
    }

    if (event.shiftKey) {
        void CommandGate.run('keyboard.paste_reference_child', async () => {
            await createChildNote();
            insertReferenceTokenIntoActiveEditor(`![[${referenceNoteId}]]`);
        });
        return;
    }

    const noteElement = DOMUtils.getNoteById(currentNoteId);
    const contentElement = DOMUtils.getNoteContent(noteElement);
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('Current note missing editable content element');
    }

    ensureSelectionInsideEditableContent(contentElement);
    const lineContext = getSelectionLineContext(contentElement);
    const referenceToken = `![[${referenceNoteId}]]`;
    let insertionText = referenceToken;
    if (lineContext.hasTextBeforeOnLine) {
        insertionText = `\n${insertionText}`;
    }
    if (lineContext.hasTextAfterOnLine) {
        insertionText = `${insertionText}\n`;
    }
    insertPlainTextAtCurrentSelection(insertionText);

    if (!ModeContext.isDirty) {
        ModeContext.setDirty(true);
    }
}

async function handleSplitNoteShortcut(event) {
    if (!event) {
        throw new Error('handleSplitNoteShortcut called without an event object');
    }

    if (!ModeContext.isEditing) {
        return;
    }

    const currentNoteId = ModeContext.currentNoteId;
    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    await CommandGate.run('keyboard.split_note', async () => {
        await splitCurrentNoteFromSelection();
    });
}

async function handleUnformatNoteShortcut(event) {
    if (!event) {
        throw new Error('handleUnformatNoteShortcut called without an event object');
    }

    if (!ModeContext.isEditing) {
        return;
    }

    const currentNoteId = ModeContext.currentNoteId;
    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    await CommandGate.run('keyboard.unformat_note', async () => {
        await unformatCurrentNoteContent(null);
    });
}

async function handleCutNoteShortcut(event) {
    if (!event) {
        throw new Error('handleCutNoteShortcut called without an event object');
    }

    Logger.logDebug('Cut note shortcut triggered', {
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
    }, Logger.LogCategory.EVENT);

    if (!ModeContext.isEditing) {
        return;
    }

    const currentNoteId = ModeContext.currentNoteId;
    if (!currentNoteId) {
        return;
    }

    const activeElement = document.activeElement;
    const isTextInput = activeElement
        && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');
    if (isTextInput) {
        const selectionStart = activeElement.selectionStart;
        const selectionEnd = activeElement.selectionEnd;
        if (typeof selectionStart === 'number' && typeof selectionEnd === 'number' && selectionEnd > selectionStart) {
            markSystemClipboardAsTrusted();
            return;
        }
    }

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && document.activeElement && document.activeElement.isContentEditable) {
        markSystemClipboardAsTrusted();
        return;
    }

    if (!ModeContext.isConnected) {
        Logger.logNoop('Cut note shortcut ignored while disconnected from server', {
            isConnected: false,
        });
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const cutResult = await CommandGate.run('keyboard.cut_note', async () => {
        const copyResult = await actionCopyNote();
        const renderedHtml = copyResult?.html;
        const renderedPlainText = copyResult?.plain_text;

        if (renderedHtml || renderedPlainText) {
            await writeRenderedNoteToSystemClipboard({
                renderedHtml,
                renderedPlainText,
                logger: Logger,
            });
        }

        await deleteNote(currentNoteId);
    });
    if (cutResult === null) {
        return;
    }
    markNoteClipboardAsTrusted();
}

function handlePasteNoteSiblingShortcut(event) {
    if (!event) {
        throw new Error('handlePasteNoteSiblingShortcut called without an event object');
    }

    Logger.logDebug('Paste sibling shortcut triggered', {
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        clipboardMode: ModeContext.clipboardMode,
        noteClipboardRequiresBrowserValidation: moduleState.noteClipboardRequiresBrowserValidation,
    }, Logger.LogCategory.EVENT);

    const shouldAllowBrowserPaste = shouldAllowBrowserPasteForShortcut({
        clipboardMode: ModeContext.clipboardMode,
        noteClipboardRequiresBrowserValidation: moduleState.noteClipboardRequiresBrowserValidation,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
    });
    if (shouldAllowBrowserPaste) {
        if (ModeContext.clipboardMode === 'system') {
            Logger.logDebug('System clipboard mode - allowing default paste behavior', {}, Logger.LogCategory.EVENT);
            return; // NO preventDefault - let browser handle text paste
        }
        if (moduleState.noteClipboardRequiresBrowserValidation) {
            Logger.logDebug('Note clipboard requires browser validation - allowing paste event inspection', {}, Logger.LogCategory.EVENT);
            return;
        }
        Logger.logNoop('Note paste shortcut conditions not met', {
            isEditing: ModeContext.isEditing,
            currentNoteId: ModeContext.currentNoteId,
            clipboardMode: ModeContext.clipboardMode,
            noteClipboardRequiresBrowserValidation: moduleState.noteClipboardRequiresBrowserValidation,
        });
        return;
    }

    // YES preventDefault - prevent browser, do note paste
    event.preventDefault();
    void CommandGate.run('keyboard.paste_sibling', async () => {
        await actionPasteNoteSibling();
    });
}

function handlePasteNoteChildShortcut(event) {
    if (!event) {
        throw new Error('handlePasteNoteChildShortcut called without an event object');
    }

    Logger.logDebug('Paste child shortcut triggered', {
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        clipboardMode: ModeContext.clipboardMode,
        noteClipboardRequiresBrowserValidation: moduleState.noteClipboardRequiresBrowserValidation,
    }, Logger.LogCategory.EVENT);

    const shouldAllowBrowserPaste = shouldAllowBrowserPasteForShortcut({
        clipboardMode: ModeContext.clipboardMode,
        noteClipboardRequiresBrowserValidation: moduleState.noteClipboardRequiresBrowserValidation,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
    });
    if (shouldAllowBrowserPaste) {
        if (ModeContext.clipboardMode === 'system') {
            Logger.logDebug('System clipboard mode - allowing default paste behavior', {}, Logger.LogCategory.EVENT);
            return; // NO preventDefault - let browser handle text paste
        }
        if (moduleState.noteClipboardRequiresBrowserValidation) {
            Logger.logDebug('Note clipboard requires browser validation - allowing paste event inspection', {}, Logger.LogCategory.EVENT);
            return;
        }
        Logger.logNoop('Note paste child shortcut conditions not met', {
            isEditing: ModeContext.isEditing,
            currentNoteId: ModeContext.currentNoteId,
            clipboardMode: ModeContext.clipboardMode,
            noteClipboardRequiresBrowserValidation: moduleState.noteClipboardRequiresBrowserValidation,
        });
        return;
    }
    
    // YES preventDefault - prevent browser, do note paste
    event.preventDefault();
    void CommandGate.run('keyboard.paste_child', async () => {
        await actionPasteNoteChild();
    });
}

function handleHelpModalShortcut(event) {
    if (!event) {
        throw new Error('handleHelpModalShortcut called without an event object');
    }

    if (ModeContext.isEditing || ModeContext.isSearching || ModeContext.isLoading) {
        Logger.logNoop('Help modal shortcut ignored: not in idle state', {
            isEditing: ModeContext.isEditing,
            isSearching: ModeContext.isSearching,
            isLoading: ModeContext.isLoading
        });
        return;
    }

    if (ModeContext.modalStack && ModeContext.modalStack.length > 0) {
        Logger.logNoop('Help modal shortcut ignored: another modal already open', {
            stackDepth: ModeContext.modalStack.length
        });
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    helpModal.open();
    Logger.logDebug('Help modal opened via keyboard shortcut', {}, Logger.LogCategory.EVENT);
}

function isImageFile(candidate) {
    if (!(candidate instanceof File)) {
        return false;
    }
    return typeof candidate.type === 'string' && candidate.type.toLowerCase().startsWith('image/');
}

function getFilesFromTransfer(transferData) {
    if (!transferData) {
        throw new Error('getFilesFromTransfer expects transferData');
    }

    const foundFiles = [];
    const seenKeys = new Set();

    const addFileCandidate = (candidate) => {
        if (!(candidate instanceof File)) {
            return;
        }
        const dedupeKey = `${candidate.name}|${candidate.size}|${candidate.type}|${candidate.lastModified}`;
        if (seenKeys.has(dedupeKey)) {
            return;
        }
        seenKeys.add(dedupeKey);
        foundFiles.push(candidate);
    };

    if (transferData.items && transferData.items.length > 0) {
        let i = 0;
        while (i < transferData.items.length) {
            const item = transferData.items[i];
            if (item && item.kind === 'file') {
                const file = item.getAsFile();
                addFileCandidate(file);
            }
            i += 1;
        }
    }

    if (transferData.files && transferData.files.length > 0) {
        let i = 0;
        while (i < transferData.files.length) {
            const file = transferData.files[i];
            addFileCandidate(file);
            i += 1;
        }
    }

    return foundFiles;
}

function getImageFilesFromTransfer(transferData) {
    const foundFiles = getFilesFromTransfer(transferData).filter((file) => isImageFile(file));
    if (foundFiles.length === 0) {
        return foundFiles;
    }

    foundFiles.sort((left, right) => right.size - left.size);
    return [foundFiles[0]];
}

function transferHasFiles(transferData) {
    if (!transferData) {
        return false;
    }

    if (transferData.items && transferData.items.length > 0) {
        let i = 0;
        while (i < transferData.items.length) {
            const item = transferData.items[i];
            if (item && item.kind === 'file') {
                return true;
            }
            i += 1;
        }
    }

    if (transferData.files && transferData.files.length > 0) {
        return true;
    }

    return false;
}

function formatKiB(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
        throw new Error(`formatKiB invalid bytes: ${bytes}`);
    }
    return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatMiB(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
        throw new Error(`formatMiB invalid bytes: ${bytes}`);
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function showImageTooLargeForEmbedError(fileName) {
    const targetBytes = getEmbedTargetImageBytes();
    const maxBytes = getMaxPasteDataImageBytes();
    const label = typeof fileName === 'string' && fileName.length > 0
        ? fileName
        : 'clipboard image';
    ErrorHandler.showErrorBanner(
        `Could not shrink ${label} enough. Target ${formatKiB(targetBytes)}, hard max ${formatMiB(maxBytes)}.`,
        'error',
        6500,
        true,
    );
}

function buildEmbeddedImageHtmlFromDataUrls(dataUrls) {
    if (!Array.isArray(dataUrls)) {
        throw new Error('buildEmbeddedImageHtmlFromDataUrls expects array');
    }
    if (dataUrls.length === 0) {
        return '';
    }

    let html = '';
    let i = 0;
    while (i < dataUrls.length) {
        const dataUrl = dataUrls[i];
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
            throw new Error(`Invalid data URL at index ${i}`);
        }

        const imageIndex = i + 1;
        html += `<img src="${dataUrl}" alt="pasted-image-${imageIndex}" style="max-width: 100%; width: auto; height: auto;" />`;
        if (imageIndex < dataUrls.length) {
            html += '<br />';
        }
        i += 1;
    }
    return html;
}

function clipboardHasFileUriReference(clipboardData) {
    if (!clipboardData || typeof clipboardData.getData !== 'function') {
        return false;
    }

    const uriList = clipboardData.getData('text/uri-list');
    if (typeof uriList !== 'string' || uriList.length === 0) {
        return false;
    }

    const lines = uriList.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const line = lines[i].trim();
        if (line.length > 0 && !line.startsWith('#') && line.toLowerCase().startsWith('file://')) {
            return true;
        }
        i += 1;
    }
    return false;
}

function contentElementHasRenderableMedia(contentElement) {
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('contentElementHasRenderableMedia requires contentElement');
    }

    return Boolean(
        contentElement.querySelector('img,video,audio,iframe,svg,math,canvas,input,textarea,button,table,hr'),
    );
}

function isCurrentEditingNoteEmptyForPasswordAutoTag() {
    if (!ModeContext.isEditing || typeof ModeContext.currentNoteId !== 'string' || ModeContext.currentNoteId.length === 0) {
        return false;
    }

    const noteElement = DOMUtils.getNoteById(ModeContext.currentNoteId);
    const contentElement = DOMUtils.getNoteContent(noteElement);
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('Current editing note content missing');
    }

    if (contentElementHasRenderableMedia(contentElement)) {
        return false;
    }

    const renderedText = typeof contentElement.textContent === 'string'
        ? contentElement.textContent.replace(/\u00A0/g, ' ').trim()
        : '';
    return renderedText.length === 0;
}

function maybeApplyPasswordTagForClipboardPaste(clipboardPlainText) {
    if (typeof clipboardPlainText !== 'string') {
        throw new Error('maybeApplyPasswordTagForClipboardPaste requires clipboardPlainText string');
    }
    if (!ModeContext.isEditing || typeof ModeContext.currentNoteId !== 'string' || ModeContext.currentNoteId.length === 0) {
        return false;
    }

    const noteElement = DOMUtils.getNoteById(ModeContext.currentNoteId);
    const existingTags = getTagBarValue(noteElement);
    const shouldAutoTag = shouldAutoTagGeneratedPasswordPaste({
        clipboardPlainText,
        existingTags,
        noteIsEmpty: isCurrentEditingNoteEmptyForPasswordAutoTag(),
    });
    if (!shouldAutoTag) {
        return false;
    }

    const nextTags = addPasswordTag(existingTags);
    if (nextTags === existingTags) {
        return false;
    }

    setTagBarValue(noteElement, nextTags);
    return true;
}

function buildClipboardPasteEventSnapshot(html, plainText) {
    if (typeof html !== 'string') {
        throw new Error('buildClipboardPasteEventSnapshot expects html string');
    }
    if (typeof plainText !== 'string') {
        throw new Error('buildClipboardPasteEventSnapshot expects plainText string');
    }

    return {
        clipboardData: {
            getData(format) {
                if (format === 'text/html') {
                    return html;
                }
                if (format === 'text/plain') {
                    return plainText;
                }
                return '';
            },
        },
    };
}

function getSelectionRangeSnapshot() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const activeEditable = getActiveEditable();
    if (activeEditable instanceof HTMLElement && !activeEditable.contains(range.startContainer)) {
        return null;
    }
    return range.cloneRange();
}

function restoreSelectionRangeSnapshot(selectionRange) {
    if (selectionRange === null) {
        return;
    }
    if (!(selectionRange instanceof Range)) {
        throw new Error('restoreSelectionRangeSnapshot expects Range or null');
    }

    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable while restoring selection range');
    }

    selection.removeAllRanges();
    selection.addRange(selectionRange.cloneRange());
    captureSelectionSnapshot();
}

async function resolveImageFileHandlingMode(imageFiles, source, options) {
    if (!Array.isArray(imageFiles) || imageFiles.length === 0) {
        throw new Error('resolveImageFileHandlingMode expects non-empty imageFiles');
    }
    if (source !== 'paste' && source !== 'drop') {
        throw new Error(`resolveImageFileHandlingMode invalid source: ${source}`);
    }
    if (typeof options === 'undefined') {
        options = {};
    }
    if (options === null || typeof options !== 'object') {
        throw new Error('resolveImageFileHandlingMode options must be object');
    }

    if (source === 'paste') {
        let shouldPrompt = options.forcePrompt === true;
        if (!shouldPrompt) {
            shouldPrompt = imageFiles.length > 1;
        }
        if (!shouldPrompt) {
            shouldPrompt = imageFiles.some((file) => typeof file.name === 'string' && file.name.trim().length > 0);
        }
        if (!shouldPrompt) {
            return 'embed';
        }
    }

    return await promptForImageFileInsertMode({
        imageCount: imageFiles.length,
        source,
    });
}

async function attachFilesAsReferenceTokens(files, options) {
    if (!Array.isArray(files) || files.length === 0) {
        return false;
    }
    if (options === null || typeof options !== 'object') {
        throw new Error('attachFilesAsReferenceTokens requires options object');
    }

    const createTopNote = options.createTopNote === true;
    const selectionRange = 'selectionRange' in options ? options.selectionRange : null;
    if (selectionRange !== null && !(selectionRange instanceof Range)) {
        throw new Error('attachFilesAsReferenceTokens selectionRange must be Range or null');
    }

    let currentTargetNoteId = createTopNote ? null : ModeContext.currentNoteId;
    let createdTopNote = false;
    let insertedAnything = false;
    let shouldRestoreSelection = selectionRange instanceof Range && !createTopNote;

    let i = 0;
    while (i < files.length) {
        const file = files[i];
        if (!(file instanceof File)) {
            throw new Error(`attachFilesAsReferenceTokens file at index ${i} is not a File`);
        }

        if (shouldRestoreSelection) {
            restoreSelectionRangeSnapshot(selectionRange);
            shouldRestoreSelection = false;
        }

        await attachPickedFileToCurrentNote(file, currentTargetNoteId, {
            createAtTop: createTopNote && !createdTopNote && currentTargetNoteId === null,
        });
        insertedAnything = true;
        currentTargetNoteId = ModeContext.currentNoteId;
        if (createTopNote) {
            createdTopNote = true;
        }
        i += 1;
    }

    return insertedAnything;
}

function resolveEditingDropTarget(event) {
    if (!event) {
        throw new Error('resolveEditingDropTarget expects event');
    }
    if (!ModeContext.isEditing || !ModeContext.currentNoteId) {
        return null;
    }

    const rawTarget = event.target;
    if (!(rawTarget instanceof Element)) {
        return null;
    }

    const noteContent = rawTarget.closest('.note-content');
    if (!(noteContent instanceof HTMLElement)) {
        return null;
    }
    if (noteContent.getAttribute('contenteditable') !== 'true') {
        return null;
    }

    const noteElement = noteContent.closest('.note');
    if (!(noteElement instanceof HTMLElement)) {
        return null;
    }
    const noteId = noteElement.dataset.noteId;
    if (!noteId || noteId !== ModeContext.currentNoteId) {
        return null;
    }

    return noteContent;
}

function getCurrentEditableDropTarget() {
    const activeEditable = getActiveEditable();
    if (activeEditable instanceof HTMLElement) {
        return activeEditable;
    }

    const currentNoteId = ModeContext.currentNoteId;
    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        throw new Error('Current editable drop target requires current note id');
    }

    const noteElement = document.querySelector(`.note[data-note-id="${currentNoteId}"]`);
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error(`Could not find current note element for drop target: ${currentNoteId}`);
    }

    const noteContent = noteElement.querySelector('.note-content');
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error(`Current note is missing editable content: ${currentNoteId}`);
    }
    if (noteContent.getAttribute('contenteditable') !== 'true') {
        throw new Error(`Current note is not editable for drop target: ${currentNoteId}`);
    }

    return noteContent;
}

function focusDropTargetForInsertion(target, event) {
    if (!(target instanceof HTMLElement)) {
        throw new Error('focusDropTargetForInsertion requires HTMLElement target');
    }

    target.focus();
    const positioned = placeCaretAtDropPoint(target, event);
    if (!positioned) {
        placeCaretAtEnd(target);
    }
    captureSelectionSnapshot();
}

function focusCurrentEditableAtEnd() {
    const target = getCurrentEditableDropTarget();
    target.focus();
    placeCaretAtEnd(target);
    captureSelectionSnapshot();
    return target;
}

function placeCaretAtEnd(element) {
    if (!(element instanceof HTMLElement)) {
        throw new Error('placeCaretAtEnd expects HTMLElement');
    }

    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable while placing caret');
    }

    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
}

function placeCaretAtDropPoint(noteContent, event) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('placeCaretAtDropPoint expects HTMLElement noteContent');
    }
    if (!event) {
        throw new Error('placeCaretAtDropPoint expects event');
    }
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
        return false;
    }

    let range = null;
    if (typeof document.caretRangeFromPoint === 'function') {
        range = document.caretRangeFromPoint(event.clientX, event.clientY);
    } else if (typeof document.caretPositionFromPoint === 'function') {
        const position = document.caretPositionFromPoint(event.clientX, event.clientY);
        if (position && position.offsetNode) {
            const candidateRange = document.createRange();
            candidateRange.setStart(position.offsetNode, position.offset);
            candidateRange.collapse(true);
            range = candidateRange;
        }
    }

    if (!(range instanceof Range)) {
        return false;
    }
    if (!noteContent.contains(range.startContainer)) {
        return false;
    }

    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable while placing drop caret');
    }

    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

async function pasteClipboardImagesAsEmbeddedContent(files, selectionRange) {
    if (!Array.isArray(files) || files.length === 0) {
        return false;
    }

    let insertionSelectionRange = selectionRange;
    if (typeof insertionSelectionRange === 'undefined') {
        insertionSelectionRange = getSelectionRangeSnapshot();
    } else if (insertionSelectionRange !== null && !(insertionSelectionRange instanceof Range)) {
        throw new Error('pasteClipboardImagesAsEmbeddedContent selectionRange must be Range or null');
    }
    const dataUrls = [];

    let i = 0;
    while (i < files.length) {
        const file = files[i];
        if (!(file instanceof File)) {
            throw new Error(`Clipboard image at index ${i} is not a File`);
        }
        const maxClipboardBytes = getMaxClipboardImageBytes();
        if (file.size > maxClipboardBytes) {
            const maxMiB = (maxClipboardBytes / (1024 * 1024)).toFixed(1);
            ErrorHandler.showErrorBanner(
                `Image too large to process (${file.name || 'clipboard image'}). Max allowed is ${maxMiB} MiB.`,
                'error',
                6000,
                true,
            );
            return false;
        }

        const dataUrl = await imageBlobToEmbeddedDataUrl(file);
        if (dataUrl === null) {
            showImageTooLargeForEmbedError(file.name);
            return false;
        }
        const embeddedPayloadBytes = estimateDataUrlPayloadBytes(dataUrl);
        if (embeddedPayloadBytes === null) {
            throw new Error('Embedded image data URL missing payload bytes');
        }
        Logger.logDebug('Clipboard image compressed for embed', {
            fileName: file.name || null,
            originalBytes: file.size,
            embeddedPayloadBytes,
            embedTargetBytes: getEmbedTargetImageBytes(),
            embedMaxBytes: getMaxPasteDataImageBytes(),
        }, Logger.LogCategory.EVENT);
        dataUrls.push(dataUrl);
        i += 1;
    }

    const html = buildEmbeddedImageHtmlFromDataUrls(dataUrls);
    if (html.length === 0) {
        return false;
    }

    const syntheticPasteEvent = buildClipboardPasteEventSnapshot(html, '');
    return await sanitizeAndInsertExternalPaste(syntheticPasteEvent, insertionSelectionRange);
}

async function embedDroppedImageFiles(imageFiles, selectionRange) {
    if (!Array.isArray(imageFiles) || imageFiles.length === 0) {
        return false;
    }

    const inserted = await pasteClipboardImagesAsEmbeddedContent(imageFiles, selectionRange);
    Logger.logDebug('Dropped image file handled', {
        imageCount: imageFiles.length,
        inserted,
        selectedImageBytes: imageFiles[0] ? imageFiles[0].size : null,
    }, Logger.LogCategory.EVENT);

    if (inserted) {
        captureSelectionSnapshot();
        if (!ModeContext.isDirty) {
            ModeContext.setDirty(true);
            Logger.logDebug('Content marked as dirty due to dropped embedded image', {
                noteId: ModeContext.currentNoteId,
            }, Logger.LogCategory.STATE);
        }
    }

    return inserted;
}

async function handleClipboardImageFiles(imageFiles, options) {
    if (!Array.isArray(imageFiles) || imageFiles.length === 0) {
        return {
            inserted: false,
            imageHandlingMode: null,
            wasBlocked: false,
        };
    }
    if (typeof options === 'undefined') {
        options = {};
    }
    if (options === null || typeof options !== 'object') {
        throw new Error('handleClipboardImageFiles options must be object');
    }

    const createTopNote = options.createTopNote === true;
    const selectionRange = 'selectionRange' in options ? options.selectionRange : getSelectionRangeSnapshot();
    if (selectionRange !== null && !(selectionRange instanceof Range)) {
        throw new Error('handleClipboardImageFiles selectionRange must be Range or null');
    }
    if (createTopNote && selectionRange !== null) {
        throw new Error('handleClipboardImageFiles cannot use selectionRange when creating a top note');
    }
    const imageHandlingMode = await resolveImageFileHandlingMode(imageFiles, 'paste', {
        forcePrompt: options.forcePrompt === true,
    });
    if (imageHandlingMode === null) {
        return {
            inserted: false,
            imageHandlingMode: null,
            wasBlocked: false,
        };
    }
    if (imageHandlingMode === 'attach') {
        const result = await CommandGate.run('keyboard.pasteImageFiles.attach', async () => {
            const inserted = await attachFilesAsReferenceTokens(imageFiles, {
                createTopNote,
                selectionRange,
            });
            if (
                createTopNote
                && inserted
                && ModeContext.isDirty
                && typeof ModeContext.currentNoteId === 'string'
                && ModeContext.currentNoteId.length > 0
            ) {
                await actionSaveNote(ModeContext.currentNoteId);
            }
            return inserted;
        }, {
            timeoutMs: 120000,
        });
        return {
            inserted: result === true,
            imageHandlingMode,
            wasBlocked: result === null,
        };
    }

    if (createTopNote) {
        const result = await CommandGate.run('keyboard.pasteImageFiles.embedNewTopNote', async () => {
            const newNoteId = await createNoteAtTop();
            focusCurrentEditableAtEnd();
            const inserted = await pasteClipboardImagesAsEmbeddedContent(imageFiles, null);
            if (inserted && !ModeContext.isDirty) {
                ModeContext.setDirty(true);
            }
            if (inserted) {
                await actionSaveNote(newNoteId);
            }
            return inserted;
        }, {
            timeoutMs: 120000,
        });
        return {
            inserted: result === true,
            imageHandlingMode,
            wasBlocked: result === null,
        };
    }

    return {
        inserted: await pasteClipboardImagesAsEmbeddedContent(imageFiles, selectionRange),
        imageHandlingMode,
        wasBlocked: false,
    };
}

async function processDroppedFiles(droppedFiles, options) {
    if (!Array.isArray(droppedFiles) || droppedFiles.length === 0) {
        return false;
    }
    if (options === null || typeof options !== 'object') {
        throw new Error('processDroppedFiles requires options object');
    }

    const createTopNote = options.createTopNote === true;
    const imageHandlingMode = options.imageHandlingMode;
    if (imageHandlingMode !== 'embed' && imageHandlingMode !== 'attach') {
        throw new Error(`processDroppedFiles invalid imageHandlingMode: ${imageHandlingMode}`);
    }
    const selectionRange = 'selectionRange' in options ? options.selectionRange : null;
    if (selectionRange !== null && !(selectionRange instanceof Range)) {
        throw new Error('processDroppedFiles selectionRange must be Range or null');
    }
    let currentTargetNoteId = createTopNote ? null : ModeContext.currentNoteId;
    let createdTopNote = false;
    let insertedAnything = false;
    let sawAttachedFile = false;
    let pendingSelectionRange = selectionRange;

    let i = 0;
    while (i < droppedFiles.length) {
        const file = droppedFiles[i];
        if (!(file instanceof File)) {
            throw new Error(`Dropped file at index ${i} is not a File`);
        }

        if (isImageFile(file)) {
            if (imageHandlingMode === 'attach') {
                if (pendingSelectionRange instanceof Range) {
                    restoreSelectionRangeSnapshot(pendingSelectionRange);
                    pendingSelectionRange = null;
                }
                sawAttachedFile = true;
                await attachPickedFileToCurrentNote(file, currentTargetNoteId, {
                    createAtTop: createTopNote && !createdTopNote && currentTargetNoteId === null,
                });
                insertedAnything = true;
                currentTargetNoteId = ModeContext.currentNoteId;
                if (createTopNote) {
                    createdTopNote = true;
                }
            } else {
                if (createTopNote && !createdTopNote && currentTargetNoteId === null) {
                    await createNoteAtTop();
                    focusCurrentEditableAtEnd();
                    currentTargetNoteId = ModeContext.currentNoteId;
                    createdTopNote = true;
                }

                const inserted = await embedDroppedImageFiles([file], pendingSelectionRange);
                if (inserted) {
                    insertedAnything = true;
                }
                pendingSelectionRange = null;
                currentTargetNoteId = ModeContext.currentNoteId;
            }
        } else {
            if (pendingSelectionRange instanceof Range) {
                restoreSelectionRangeSnapshot(pendingSelectionRange);
                pendingSelectionRange = null;
            }
            sawAttachedFile = true;
            await attachPickedFileToCurrentNote(file, currentTargetNoteId, {
                createAtTop: createTopNote && !createdTopNote && currentTargetNoteId === null,
            });
            insertedAnything = true;
            currentTargetNoteId = ModeContext.currentNoteId;
            if (createTopNote) {
                createdTopNote = true;
            }
        }

        i += 1;
    }

    let shouldSaveAfterDrop = false;
    if (createTopNote) {
        shouldSaveAfterDrop = true;
    }
    if (sawAttachedFile) {
        shouldSaveAfterDrop = true;
    }
    if (
        shouldSaveAfterDrop
        && ModeContext.isDirty
        && typeof ModeContext.currentNoteId === 'string'
        && ModeContext.currentNoteId.length > 0
    ) {
        await actionSaveNote(ModeContext.currentNoteId);
    }

    return insertedAnything;
}

function handleDragOverEvent(event) {
    if (!event || !event.dataTransfer) {
        return;
    }

    if (!transferHasFiles(event.dataTransfer)) {
        return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
}

function handleDropEvent(event) {
    if (!event || !event.dataTransfer) {
        return;
    }

    if (!transferHasFiles(event.dataTransfer)) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const droppedFiles = getFilesFromTransfer(event.dataTransfer);
    if (droppedFiles.length === 0) {
        return;
    }

    const target = resolveEditingDropTarget(event);
    const imageFiles = droppedFiles.filter((file) => isImageFile(file));
    const onlyImages = imageFiles.length === droppedFiles.length;
    const shouldCreateTopNote = shouldCreateTopNoteForFileDrop({
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        hasNonImageFile: !onlyImages,
        hasEditingDropTarget: target instanceof HTMLElement,
    });
    let targetSelectionRange = null;
    if (target instanceof HTMLElement) {
        focusDropTargetForInsertion(target, event);
        targetSelectionRange = getSelectionRangeSnapshot();
        if (onlyImages) {
            const selectionRange = targetSelectionRange;
            void (async () => {
                const imageHandlingMode = await resolveImageFileHandlingMode(droppedFiles, 'drop');
                if (imageHandlingMode === null) {
                    return false;
                }
                if (imageHandlingMode === 'attach') {
                    return await CommandGate.run('keyboard.dropImageFiles.attach', async () => {
                        return await attachFilesAsReferenceTokens(droppedFiles, {
                            createTopNote: false,
                            selectionRange,
                        });
                    }, {
                        timeoutMs: 120000,
                    });
                }
                return await embedDroppedImageFiles(droppedFiles, selectionRange);
            })()
                .then((result) => {
                    if (result !== null) {
                        return;
                    }
                    ErrorHandler.showErrorBanner(
                        'Dropped image files did not start because another command is still running.',
                        'error',
                        10000,
                        true,
                    );
                })
                .catch((error) => {
            rethrowUnexpectedError(error);
                    const message = error instanceof Error ? error.message : String(error);
                    Logger.logDebug('Dropped image file handling failed', {
                        error: message,
                        fileCount: droppedFiles.length,
                    }, Logger.LogCategory.EVENT);
                    ErrorHandler.showErrorBanner(
                        'Failed to handle dropped image files.',
                        'error',
                        6000,
                        true,
                    );
                });
            return;
        }
    }

    void (async () => {
        let imageHandlingMode = 'embed';
        if (imageFiles.length > 0) {
            const choice = await resolveImageFileHandlingMode(imageFiles, 'drop');
            if (choice === null) {
                return false;
            }
            imageHandlingMode = choice;
        }

        return await CommandGate.run('keyboard.dropFiles', async () => {
            return await processDroppedFiles(droppedFiles, {
                createTopNote: shouldCreateTopNote,
                imageHandlingMode,
                selectionRange: targetSelectionRange,
            });
        }, {
            timeoutMs: 120000,
        });
    })()
        .then((result) => {
            if (result === false) {
                return;
            }
            if (result === null) {
                ErrorHandler.showErrorBanner(
                    'File drop did not start because another command is still running.',
                    'error',
                    10000,
                    true,
                );
                return;
            }
            Logger.logDebug('Dropped files processed', {
                fileCount: droppedFiles.length,
                createTopNote: shouldCreateTopNote,
                inserted: result,
            }, Logger.LogCategory.EVENT);
        })
        .catch((error) => {
            rethrowUnexpectedError(error);
            const message = error instanceof Error ? error.message : String(error);
            Logger.logDebug('Dropped file handling failed', {
                error: message,
                fileCount: droppedFiles.length,
                onlyImages,
            }, Logger.LogCategory.EVENT);
            if (onlyImages) {
                ErrorHandler.showErrorBanner(
                    'Failed to handle dropped image files.',
                    'error',
                    6000,
                    true,
                );
                return;
            }
            ErrorHandler.showErrorBanner(
                `File drop failed: ${message}`,
                'error',
                10000,
                true,
            );
        });
}

function pasteEventHasNativeTextTarget(event) {
    if (!event) {
        throw new Error('pasteEventHasNativeTextTarget expects event');
    }

    const nativeTargetSelector = 'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]';
    const eventTarget = event.target;
    if (eventTarget instanceof Element && eventTarget.closest(nativeTargetSelector)) {
        return true;
    }

    const activeElement = document.activeElement;
    return Boolean(activeElement instanceof Element && activeElement.closest(nativeTargetSelector));
}

function markCurrentNoteDirtyFromPaste(logMessage) {
    if (typeof logMessage !== 'string' || logMessage.length === 0) {
        throw new Error('markCurrentNoteDirtyFromPaste requires logMessage');
    }
    if (ModeContext.isDirty) {
        return;
    }

    ModeContext.setDirty(true);
    Logger.logDebug(logMessage, {
        noteId: ModeContext.currentNoteId,
    }, Logger.LogCategory.STATE);
}

async function pasteExternalContentIntoNewTopNote(pasteEventSnapshot, plainText) {
    if (!pasteEventSnapshot || !pasteEventSnapshot.clipboardData) {
        throw new Error('pasteExternalContentIntoNewTopNote requires clipboard data');
    }
    if (typeof plainText !== 'string') {
        throw new Error('pasteExternalContentIntoNewTopNote requires plainText string');
    }

    return await CommandGate.run('paste_event.external_new_top_note', async () => {
        const newNoteId = await createNoteAtTop();
        focusCurrentEditableAtEnd();
        const autoTaggedPasswordPaste = maybeApplyPasswordTagForClipboardPaste(plainText);
        const inserted = await sanitizeAndInsertExternalPaste(pasteEventSnapshot, null);
        if (inserted) {
            markCurrentNoteDirtyFromPaste('Content marked as dirty due to paste into new top note');
        }
        if (inserted || autoTaggedPasswordPaste) {
            await actionSaveNote(newNoteId);
        }
        return {
            inserted,
            autoTaggedPasswordPaste,
        };
    }, {
        timeoutMs: 120000,
    });
}

async function pasteCopiedNoteIntoNewTopNote() {
    return await CommandGate.run('paste_event.note_new_top_note', async () => {
        await createNoteAtTop();
        await actionPasteNoteSibling();
        return true;
    }, {
        timeoutMs: 120000,
    });
}


function handlePasteEvent(event) {
    if (!event || !event.clipboardData) {
        Logger.logDebug('Paste event without clipboard data - allowing default behavior', {}, Logger.LogCategory.EVENT);
        return;
    }

    const activeElement = document.activeElement;
    const hasEditableTarget = Boolean(activeElement && activeElement.isContentEditable);
    const hasActiveNote = (
        ModeContext.isEditing
        && typeof ModeContext.currentNoteId === 'string'
        && ModeContext.currentNoteId.length > 0
    );
    const shouldHandleInlinePaste = hasActiveNote && hasEditableTarget;
    const imageFiles = getImageFilesFromTransfer(event.clipboardData);
    const clipboardContainsFileReference = clipboardHasFileUriReference(event.clipboardData);

    // Get HTML from clipboard if available
    const html = event.clipboardData.getData('text/html');
    const plainText = event.clipboardData.getData('text/plain');
    const hasTrackedNoteClipboardHtml = syncClipboardTrackingFromPasteEventHtml(html);
    const hasClipboardPayload = (
        imageFiles.length > 0
        || hasTrackedNoteClipboardHtml
        || html.length > 0
        || plainText.length > 0
    );
    const hasNativePasteTarget = pasteEventHasNativeTextTarget(event);
    const isModalOpen = Boolean(ModeContext.modalStack && ModeContext.modalStack.length > 0);
    const shouldCreateTopNote = shouldCreateTopNoteForPaste({
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        hasNativePasteTarget,
        hasClipboardPayload,
        isModalOpen,
    });
    const autoTaggedPasswordPaste = shouldHandleInlinePaste
        ? maybeApplyPasswordTagForClipboardPaste(plainText)
        : false;
    
    Logger.logDebug('Paste event detected', {
        hasHtml: !!html,
        htmlLength: html ? html.length : 0,
        plainTextLength: plainText ? plainText.length : 0,
        imageFileCount: imageFiles.length,
        hasFileUriReference: clipboardContainsFileReference,
        isEditing: ModeContext.isEditing,
        shouldCreateTopNote,
        autoTaggedPasswordPaste,
    }, Logger.LogCategory.EVENT);

    if ((shouldHandleInlinePaste || shouldCreateTopNote) && imageFiles.length > 0) {
        event.preventDefault();
        const selectionRange = shouldCreateTopNote ? null : getSelectionRangeSnapshot();
        void handleClipboardImageFiles(imageFiles, {
            createTopNote: shouldCreateTopNote,
            selectionRange,
            forcePrompt: clipboardContainsFileReference,
        })
            .then((result) => {
                const inserted = result.inserted;
                Logger.logDebug('Clipboard image paste handled', {
                    imageCount: imageFiles.length,
                    inserted,
                    imageHandlingMode: result.imageHandlingMode,
                    createdTopNote: shouldCreateTopNote,
                    wasBlocked: result.wasBlocked,
                    selectedImageBytes: imageFiles[0] ? imageFiles[0].size : null,
                }, Logger.LogCategory.EVENT);

                if (result.wasBlocked) {
                    ErrorHandler.showErrorBanner(
                        'Pasted image file did not start because another command is still running.',
                        'error',
                        10000,
                        true,
                    );
                    return;
                }

                if (inserted && result.imageHandlingMode === 'embed' && !shouldCreateTopNote) {
                    markCurrentNoteDirtyFromPaste('Content marked as dirty due to pasted embedded image');
                }
            })
            .catch((error) => {
            rethrowUnexpectedError(error);
                const message = error instanceof Error ? error.message : String(error);
                Logger.logDebug('Clipboard image paste failed', {
                    error: message,
                }, Logger.LogCategory.EVENT);
                ErrorHandler.showErrorBanner(
                    'Failed to handle pasted image file.',
                    'error',
                    6000,
                    true,
                );
            });
        return;
    }

    if (
        (shouldHandleInlinePaste || shouldCreateTopNote)
        && imageFiles.length === 0
        && typeof html === 'string'
        && html.includes('<img')
        && clipboardContainsFileReference
    ) {
        event.preventDefault();
        ErrorHandler.showErrorBanner(
            'Clipboard contains a file reference/icon preview, not image bytes. Open the image and copy the pixels, then paste again.',
            'error',
            7000,
            true,
        );
        return;
    }

    // Check if this is our note HTML (contains note-content class)
    if (hasTrackedNoteClipboardHtml) {
        Logger.logDebug('Detected note HTML in clipboard - using server clipboard', {}, Logger.LogCategory.EVENT);
        
        // This is our note HTML - prevent default and use server clipboard
        if (hasActiveNote) {
            event.preventDefault();
            
			// Determine if shift is held for child paste
			if (event.shiftKey) {
				void CommandGate.run('paste_event.child', async () => {
					await actionPasteNoteChild();
				});
			} else {
				void CommandGate.run('paste_event.sibling', async () => {
					await actionPasteNoteSibling();
				});
			}
		} else if (shouldCreateTopNote) {
            event.preventDefault();
            void pasteCopiedNoteIntoNewTopNote()
                .then((result) => {
                    if (result !== null) {
                        return;
                    }
                    ErrorHandler.showErrorBanner(
                        'Copied note paste did not start because another command is still running.',
                        'error',
                        10000,
                        true,
                    );
                })
                .catch((error) => {
            rethrowUnexpectedError(error);
                    const message = error instanceof Error ? error.message : String(error);
                    Logger.logDebug('Copied note paste into new top note failed', {
                        error: message,
                    }, Logger.LogCategory.EVENT);
                    ErrorHandler.showErrorBanner(
                        'Failed to paste copied note into a new top note.',
                        'error',
                        6000,
                        true,
                    );
                });
		}
    } else {
        const shouldSanitizeExternalHtml = ModeContext.isEditing && hasEditableTarget && typeof html === 'string' && html.length > 0;

        if (shouldSanitizeExternalHtml) {
            const pasteEventSnapshot = buildClipboardPasteEventSnapshot(html, plainText);
            const selectionRange = getSelectionRangeSnapshot();
            event.preventDefault();
            void sanitizeAndInsertExternalPaste(pasteEventSnapshot, selectionRange)
                .then((inserted) => {
                    Logger.logDebug('External HTML paste sanitized and inserted', {
                        inserted,
                        htmlLength: html.length,
                    }, Logger.LogCategory.EVENT);

                    if (inserted && !ModeContext.isDirty) {
                        markCurrentNoteDirtyFromPaste('Content marked as dirty due to sanitized external paste');
                    }
                })
                .catch((error) => {
            rethrowUnexpectedError(error);
                    const message = error instanceof Error ? error.message : String(error);
                    Logger.logDebug('External HTML paste sanitization failed', {
                        error: message,
                        htmlLength: html.length,
                    }, Logger.LogCategory.EVENT);
                    ErrorHandler.showErrorBanner(
                        'Failed to sanitize pasted HTML.',
                        'error',
                        6000,
                        true,
                    );
                });
        } else if (shouldCreateTopNote) {
            const pasteEventSnapshot = buildClipboardPasteEventSnapshot(html, plainText);
            event.preventDefault();
            void pasteExternalContentIntoNewTopNote(pasteEventSnapshot, plainText)
                .then((result) => {
                    if (result === null) {
                        ErrorHandler.showErrorBanner(
                            'Paste did not start because another command is still running.',
                            'error',
                            10000,
                            true,
                        );
                        return;
                    }
                    Logger.logDebug('External content pasted into new top note', {
                        inserted: result.inserted,
                        autoTaggedPasswordPaste: result.autoTaggedPasswordPaste,
                    }, Logger.LogCategory.EVENT);
                })
                .catch((error) => {
            rethrowUnexpectedError(error);
                    const message = error instanceof Error ? error.message : String(error);
                    Logger.logDebug('External paste into new top note failed', {
                        error: message,
                    }, Logger.LogCategory.EVENT);
                    ErrorHandler.showErrorBanner(
                        'Failed to paste into a new top note.',
                        'error',
                        6000,
                        true,
                    );
                });
        } else {
            Logger.logDebug('External content detected - using browser default paste', {
                hasHtml: !!html,
                autoTaggedPasswordPaste,
            }, Logger.LogCategory.EVENT);

            if (ModeContext.isEditing && !ModeContext.isDirty) {
                markCurrentNoteDirtyFromPaste('Content marked as dirty due to paste');
            }
        }
    }
}

function getTabContextItem(target) {
    if (!(target instanceof Element)) {
        return null;
    }
    const item = target.closest('.tab-context-item');
    if (!item) {
        return null;
    }
    const searchContextsList = document.getElementById('search-contexts-list');
    if (!searchContextsList || !searchContextsList.contains(item)) {
        return null;
    }
    return item;
}

function getTabIdFromContextItem(item) {
    if (!(item instanceof Element) || !item.classList.contains('tab-context-item')) {
        throw new Error('getTabIdFromContextItem requires a tab context item');
    }
    const tabId = item.getAttribute('data-tab-id');
    if (!tabId) {
        throw new Error('Tab context item missing data-tab-id');
    }
    return tabId;
}

function clearTabDragCandidate() {
    // Most mouse events do not belong to a tab drag episode.
    if (moduleState.tabDragCandidateId === null) return;
    moduleState.tabDragCandidateId = null;
}

function clearTabDragStyling() {
    document.querySelectorAll('.tab-context-item.is-dragging, .tab-context-item.is-drop-target')
        .forEach((item) => {
            item.classList.remove('is-dragging', 'is-drop-target');
        });
    if (document.body) {
        document.body.classList.remove('tab-drag-active');
    }
}

function finishTabDrag() {
    clearTabDragCandidate();
    if (moduleState.draggedTabId !== null) moduleState.draggedTabId = null;
    clearTabDragStyling();
}

function handleTabDragCandidateMouseDown(event) {
    clearTabDragCandidate();
    if (!event || event.button !== 0 || !(event.target instanceof Element)) {
        return;
    }
    if (event.target.closest('.tab-context-action')) {
        return;
    }
    const item = getTabContextItem(event.target);
    if (!item || ModeContext.tabOrder.length < 2) {
        return;
    }
    moduleState.tabDragCandidateId = getTabIdFromContextItem(item);
}

function handleTabDragStart(event) {
    const item = getTabContextItem(event.target);
    if (!item) {
        return;
    }
    const tabId = getTabIdFromContextItem(item);
    if (moduleState.tabDragCandidateId !== tabId || ModeContext.isLoading) {
        event.preventDefault();
        finishTabDrag();
        return;
    }
    if (!event.dataTransfer) {
        throw new Error('Tab dragstart requires dataTransfer');
    }

    moduleState.draggedTabId = tabId;
    item.classList.add('is-dragging');
    document.body.classList.add('tab-drag-active');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tabId);
}

function handleTabDragOver(event) {
    if (moduleState.draggedTabId === null) {
        return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
    }

    document.querySelectorAll('.tab-context-item.is-drop-target').forEach((item) => {
        item.classList.remove('is-drop-target');
    });
    const hoveredItem = getTabContextItem(event.target);
    if (hoveredItem && getTabIdFromContextItem(hoveredItem) !== moduleState.draggedTabId) {
        hoveredItem.classList.add('is-drop-target');
    }
}

function handleTabDrop(event) {
    if (moduleState.draggedTabId === null) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();

    const sourceTabId = moduleState.draggedTabId;
    const hoveredItem = getTabContextItem(event.target);
    const hoveredTabId = hoveredItem ? getTabIdFromContextItem(hoveredItem) : null;
    moduleState.ignoreClickAfterTabDragUntil = performance.now() + 500;
    finishTabDrag();

    if (hoveredTabId === null || hoveredTabId === sourceTabId) {
        return;
    }
    void CommandGate.run('tab.drag_reorder', async () => {
        await moveTabContext(sourceTabId, hoveredTabId);
    });
}

function handleTabDragEnd() {
    if (moduleState.draggedTabId !== null) {
        moduleState.ignoreClickAfterTabDragUntil = performance.now() + 500;
    }
    finishTabDrag();
}

function handleTabDragClick(event) {
    if (moduleState.ignoreClickAfterTabDragUntil === null) {
        return;
    }
    if (performance.now() > moduleState.ignoreClickAfterTabDragUntil) {
        moduleState.ignoreClickAfterTabDragUntil = null;
        return;
    }
    if (!getTabContextItem(event.target)) {
        return;
    }

    moduleState.ignoreClickAfterTabDragUntil = null;
    event.preventDefault();
    event.stopImmediatePropagation();
}

export function updateSearchContextsList() {
    const searchContextsList = document.getElementById('search-contexts-list');
    updateReferenceSourceIndicator();
    if (!searchContextsList) return;
    const showTabUi = document.body.classList.contains('pref-show-tab-ui');
    
    const tabs = ModeContext.tabs;
    const activeTabId = ModeContext.activeTabId;
    const tabOrder = ModeContext.tabOrder;

    if (!CONFIG.TABS || typeof CONFIG.TABS.MAX_TABS !== 'number' || CONFIG.TABS.MAX_TABS <= 0) {
        throw new Error('CONFIG.TABS.MAX_TABS must be a positive number');
    }
    
    // Build the list of search contexts
    let contextsList = [];
    if (!Array.isArray(tabOrder) || tabOrder.length === 0) {
        throw new Error('ModeContext.tabOrder must be a non-empty array');
    }
	for (let i = 0; i < tabOrder.length; i++) {
	    const tabId = tabOrder[i];
	    const tabEntry = tabs[tabId];
	    if (!tabEntry || typeof tabEntry !== 'object') {
	        throw new Error(`ModeContext.tabs missing entry for tab ${tabId}`);
	    }

	    let originalQuery = tabEntry.searchQuery;
	    if (typeof originalQuery !== 'string') {
	        originalQuery = '';
	    }
	    let displayQuery = originalQuery;
	    if (!displayQuery) {
	        displayQuery = '(empty)';
	    }
        
        // Truncate long search queries for display
        if (displayQuery.length > 12 && displayQuery !== '(empty)') {
            displayQuery = displayQuery.substring(0, 12) + '...';
        }
        
        const isActive = tabId === activeTabId;

        const atLimit = tabOrder.length >= CONFIG.TABS.MAX_TABS;
        const addClass = atLimit ? 'is-disabled' : '';
        const canDelete = tabOrder.length > 1;
        const deleteClass = canDelete ? '' : 'is-disabled';

        const actions = `
            <span class="tab-context-action duplicate-context ${addClass}" data-source-tab-id="${tabId}" aria-disabled="${atLimit}">+</span>
            <span class="tab-context-action tab-context-action--danger delete-context ${deleteClass}" data-delete-tab-id="${tabId}" aria-disabled="${!canDelete}">-</span>
        `;

        const activeClass = isActive ? 'is-active' : '';
        contextsList.push(
            `<div data-tab-id="${tabId}" class="tab-context-item ${activeClass}" draggable="true">`
            + `<span class="tab-context-index">${i + 1}:</span>`
            + `<span class="tab-context-query">${displayQuery}</span>`
            + `<span class="tab-context-actions">${actions}</span>`
            + `</div>`
        );
    }
    
    if (contextsList.length > 0) {
        searchContextsList.innerHTML = contextsList.join('');
        if (!showTabUi) {
            searchContextsList.style.display = 'none';
        }
        updateSearchContextsOverlayPlacement();
        
        // Add click handlers to each tab context item
        searchContextsList.querySelectorAll('.tab-context-item').forEach(item => {
            item.addEventListener('click', async (e) => {
                const tabId = e.currentTarget.getAttribute('data-tab-id');
                if (!tabId) {
                    return;
                }
                const searchQuery = ModeContext.getExecutedSearchQuery(tabId);
                if (typeof searchQuery !== 'string') {
                    throw new Error('Clicked tab executed search query must be a string');
                }
                const activityPromise = NotesAPI.recordTabSearchSelection(searchQuery);
                hideSearchContextsOverlay();
                void CommandGate.run('tab.select', async () => {
                    if (tabId === ModeContext.activeTabId) {
                        if (ModeContext.isUntaggedView) {
                            ModeContext.setUntaggedView(false);
                            syncSearchInputField();
                            ModeContext.resetTabDiffCache(tabId, { preserveRootAnchor: false });
                            clearCachedNotesDomForTab(tabId);
                            clearActiveNotesDom();
                            const { actionRefreshAndMaybeSelect } = await import('../actions/ui-actions.js');
                            await actionRefreshAndMaybeSelect({ context: 'untaggedView.dismissTab', animateNoteChanges: false });
                        }
                    } else {
                        await switchToTabContext(tabId, {});
                    }
                });
                await activityPromise;
	            });
	        });
        
        // Add click handlers for per-tab + (duplicate)
        searchContextsList.querySelectorAll('.duplicate-context').forEach(addBtn => {
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.currentTarget.getAttribute('aria-disabled') === 'true') {
                    return;
                }
                const sourceTabId = e.currentTarget.getAttribute('data-source-tab-id');
	                void CommandGate.run('tab.duplicate', async () => {
	                    await duplicateTabContext(sourceTabId, true, CONFIG.TABS.CREATE_AND_SWITCH);
	                });
	            });
	        });
        
        // Add click handler for delete buttons
        searchContextsList.querySelectorAll('.delete-context').forEach(deleteBtn => {
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.currentTarget.getAttribute('aria-disabled') === 'true') {
                    return;
                }
                const deleteTabId = e.currentTarget.getAttribute('data-delete-tab-id');
	                void CommandGate.run('tab.delete', async () => {
	                    await deleteTabContext(deleteTabId);
	                });
	            });
	        });

    } else {
        searchContextsList.style.display = 'none';
        updateSearchContextsOverlayPlacement();
    }

    syncBacklinksPanelPlacement();
    updateReferenceSourceIndicator();
}

export async function switchToTabContext(tabId, options) {
	if (options === null || typeof options !== 'object') {
		throw new Error('switchToTabContext requires options object');
	}
    const canAnimatePreviousView = !ModeContext.isUntaggedView
        && ModeContext.activeTabSortMode === 'normal'
        && !isViewingReferenceSource();

    if (ModeContext.isEditing) {
        await actionSaveAndExitEditingWithoutRefreshing();
    }

    const previousTabId = ModeContext.activeTabId;
    const tabOrder = ModeContext.tabOrder;
    if (!Array.isArray(tabOrder) || tabOrder.length === 0) {
        throw new Error('ModeContext.tabOrder must be a non-empty array');
    }
    const previousTabIndex = tabOrder.indexOf(previousTabId);
    if (previousTabIndex === -1) {
        throw new Error(`previousTabId not present in ModeContext.tabOrder: ${previousTabId}`);
    }
    const nextTabIndex = tabOrder.indexOf(tabId);
    if (nextTabIndex === -1) {
        throw new Error(`tabId not present in ModeContext.tabOrder: ${tabId}`);
    }
    const perfContext = `switchTab tab#${previousTabIndex + 1}→tab#${nextTabIndex + 1}`;

    const dismissedUntaggedView = ModeContext.isUntaggedView;
    if (dismissedUntaggedView) {
        ModeContext.setUntaggedView(false);
        ModeContext.resetTabDiffCache(previousTabId, { preserveRootAnchor: false });
        clearCachedNotesDomForTab(previousTabId);
        clearActiveNotesDom();
    }

	ModeContext.beginIgnoreScrollEvents();
	await (async () => {
		await persistCurrentTabState();

		ModeContext.switchToTab(tabId, { force: true });
		if (!dismissedUntaggedView) {
			cacheNotesDomForTab(previousTabId);
		}
		restoreNotesDomForTab(tabId);

		syncSearchInputField();
		updateSearchContextsList();

		// Persist new tab selection and any newly created tab immediately
		await persistTabStateSnapshot();

		const startedAt = performance.now();
		const { actionRefreshAndMaybeSelect } = await import('../actions/ui-actions.js');
		await actionRefreshAndMaybeSelect({
			startedAt,
			context: perfContext,
			animateNoteChanges: options.animateNoteChanges !== false
                && canAnimatePreviousView
                && ModeContext.activeTabSortMode === 'normal'
                && !isViewingReferenceSource(),
			expectedUpdatedNotesMax: options.expectedUpdatedNotesMax,
			expectedVdomOpsMax: options.expectedVdomOpsMax,
		});

		ModeContext.restoreScrollForActiveTab();
	})().finally(() => {
		ModeContext.endIgnoreScrollEvents();
	});
}

function snapshotActiveTabScrollState() {
    const currentScroll = Math.max(0, Math.round(window.scrollY));
    // Multiple tab commands can snapshot without an intervening scroll event.
    if (ModeContext.getTabScrollPosition(ModeContext.activeTabId) !== currentScroll) {
        ModeContext.updateActiveTabScroll(currentScroll);
    }
    const nextScrollAnchor = computeScrollAnchor({ anchorBias: 'auto' });
    // Tab commands can snapshot a view with no root anchor, leaving both anchors null.
    if (!areScrollAnchorsEqual(ModeContext.getTabScrollAnchor(ModeContext.activeTabId), nextScrollAnchor)) {
        ModeContext.updateActiveTabScrollAnchor(nextScrollAnchor, true);
    }
}

async function duplicateTabContext(sourceTabId, animateNoteChanges, shouldSwitchImmediately) {
    if (typeof animateNoteChanges !== 'boolean') {
        throw new Error('duplicateTabContext requires animateNoteChanges boolean');
    }
    if (typeof shouldSwitchImmediately !== 'boolean') {
        throw new Error('duplicateTabContext requires shouldSwitchImmediately boolean');
    }
	const startedEditing = ModeContext.isEditing;

    if (startedEditing) {
        await actionSaveAndExitEditingWithoutRefreshing();
    }
    if (typeof sourceTabId !== 'string' || sourceTabId.length === 0) {
        throw new Error('sourceTabId is required for tab duplication');
    }
    if (!CONFIG.TABS || typeof CONFIG.TABS.MAX_TABS !== 'number' || CONFIG.TABS.MAX_TABS <= 0) {
        throw new Error('CONFIG.TABS.MAX_TABS must be a positive number');
    }
    if (typeof CONFIG.TABS.CREATE_AND_SWITCH !== 'boolean') {
        throw new Error('CONFIG.TABS.CREATE_AND_SWITCH must be a boolean');
    }

    if (!ModeContext.tabs[sourceTabId]) {
        throw new Error(`Cannot duplicate missing tab: ${sourceTabId}`);
    }

    const payload = ModeContext.getTabStatePayload();
	if (payload.tabOrder.length >= CONFIG.TABS.MAX_TABS) {
		ErrorHandler.showInfoBanner(
			`Tab limit reached (${CONFIG.TABS.MAX_TABS}). Close a tab before adding another.`,
			6000,
		);
		return;
	}

    snapshotActiveTabScrollState();
    await persistTabStateSnapshot();

    const sourceEntry = ModeContext.tabs[sourceTabId];
    if (!sourceEntry || typeof sourceEntry !== 'object') {
        throw new Error(`Cannot duplicate tab with missing state: ${sourceTabId}`);
    }

    const response = await createTabOnServer(sourceTabId);
    const newTabId = response?.newTabId;
    if (typeof newTabId !== 'string' || newTabId.length === 0) {
        throw new Error('Server did not return newTabId');
    }

    if (!response || typeof response !== 'object' || !response.tabs || typeof response.tabs !== 'object') {
        throw new Error('Server did not return tab-state payload');
    }
    if (!response.tabs[newTabId] || typeof response.tabs[newTabId] !== 'object') {
        throw new Error('Server tab-state response missing new tab payload');
    }

    const sourceScrollY = typeof sourceEntry.scrollY === 'number' && sourceEntry.scrollY >= 0
        ? Math.round(sourceEntry.scrollY)
        : 0;
    const sourceSearchQuery = typeof sourceEntry.searchQuery === 'string' ? sourceEntry.searchQuery : '';
    const sourceScrollAnchor = sourceEntry.scrollAnchor && typeof sourceEntry.scrollAnchor === 'object'
        ? sourceEntry.scrollAnchor
        : null;

	let sourceAnchorRootId = null;
	if (sourceTabId === ModeContext.activeTabId) {
		let anchorRootId = ModeContext.getRootAnchorId();
		if (!anchorRootId) {
			anchorRootId = ModeContext.getLastKnownRootId();
		}
		sourceAnchorRootId = anchorRootId;
	} else if (typeof sourceEntry.anchorRootId === 'string' && sourceEntry.anchorRootId.length > 0) {
		sourceAnchorRootId = sourceEntry.anchorRootId;
	}

    response.tabs[newTabId].scrollY = sourceScrollY;
    response.tabs[newTabId].searchQuery = sourceSearchQuery;
    response.tabs[newTabId].scrollAnchor = sourceScrollAnchor;
    response.tabs[newTabId].anchorRootId = sourceAnchorRootId;

    const sourceHashCount = ModeContext.getTabNoteHashCount(sourceTabId);
    const cloneResult = cloneNotesDomForTab(sourceTabId, newTabId, {
        activeTabId: ModeContext.activeTabId,
        ...getDuplicateTabCloneOptions(sourceHashCount),
    });

    ModeContext.hydrateTabState(response);
    ModeContext.cloneTabRedactedReveals(sourceTabId, newTabId);

    // When the source tab DOM is unavailable after a restart, leave the new
    // tab's diff state empty so the next notes.view round-trip can rebuild it
    // from the server instead of assuming a cloned DOM exists.
    finalizeDuplicatedTabClone({
        sourceHashCount,
        sourceTabId,
        newTabId,
        cloneResult,
        cloneTabNoteHashes: (fromTabId, toTabId) => ModeContext.cloneTabNoteHashes(fromTabId, toTabId),
        seedTabNoteHashes: (tabId, noteHashes) => ModeContext.seedTabNoteHashes(tabId, noteHashes),
        resetTabDiffCache: (tabId, options) => ModeContext.resetTabDiffCache(tabId, options),
    });
    updateSearchContextsList();

    if (shouldSwitchImmediately) {
        const switchOptions = { animateNoteChanges };

        await switchToTabContext(newTabId, switchOptions);
        focusSearchInputAndSelectAllText();
        return newTabId;
    }

    return newTabId;
}

async function createBlankSearchContextFromHover() {
    const sourceTabId = ModeContext.activeTabId;
    if (typeof sourceTabId !== 'string' || sourceTabId.length === 0) {
        throw new Error('ModeContext.activeTabId must be a non-empty string');
    }
    if (!CONFIG.TABS || typeof CONFIG.TABS.MAX_TABS !== 'number' || CONFIG.TABS.MAX_TABS <= 0) {
        throw new Error('CONFIG.TABS.MAX_TABS must be a positive number');
    }

    const payload = ModeContext.getTabStatePayload();
    if (payload.tabOrder.length >= CONFIG.TABS.MAX_TABS) {
        ErrorHandler.showInfoBanner(
            `Tab limit reached (${CONFIG.TABS.MAX_TABS}). Close a tab before adding another.`,
            6000,
        );
        return null;
    }

    snapshotActiveTabScrollState();
    await persistTabStateSnapshot();

    const response = await createTabOnServer(sourceTabId);
    const newTabId = response?.newTabId;
    if (typeof newTabId !== 'string' || newTabId.length === 0) {
        throw new Error('Server did not return newTabId');
    }
    if (!response || typeof response !== 'object' || !response.tabs || typeof response.tabs !== 'object') {
        throw new Error('Server did not return tab-state payload');
    }
    const newTab = response.tabs[newTabId];
    if (!newTab || typeof newTab !== 'object') {
        throw new Error('Server tab-state response missing new tab payload');
    }

    newTab.searchQuery = '';
    newTab.scrollY = 0;
    newTab.scrollAnchor = null;
    newTab.anchorRootId = null;

    ModeContext.hydrateTabState(response);
    ModeContext.resetTabDiffCache(newTabId, { preserveRootAnchor: false });

    await switchToTabContext(newTabId, {});
    await actionEnterSearchMode();
    focusSearchInputAndSelectAllText();
    await persistTabStateSnapshot();
    return newTabId;
}

export async function openReferenceInNewTab(referenceNoteId) {
    if (typeof referenceNoteId !== 'string' || referenceNoteId.length === 0) {
        throw new Error('openReferenceInNewTab requires referenceNoteId');
    }
    return openReferenceQueryInNewTabWithContext(
        referenceNoteId,
        'reference.link_open_tab',
        false,
        'source',
    );
}

export async function openReferenceQueryInNewTab(referenceQuery) {
    if (typeof referenceQuery !== 'string' || referenceQuery.length === 0) {
        throw new Error('openReferenceQueryInNewTab requires referenceQuery');
    }
    return openReferenceQueryInNewTabWithContext(
        referenceQuery,
        'reference.collection_open_tab',
        true,
        'source',
    );
}

export async function openBacklinksInNewTab(sourceNoteId) {
    const payload = await NotesAPI.fetchBacklinks(sourceNoteId, null);
    const query = buildBacklinksQuery(payload, sourceNoteId);
    if (query === '') {
        ErrorHandler.showInfoBanner('No notes reference this source anymore.', 3000);
        return;
    }
    await openReferenceQueryInNewTabWithContext(query, 'reference.backlinks_open_tab', false, 'backlinks');
}

async function openReferenceQueryInNewTabWithContext(
    referenceQuery,
    context,
    replaceActiveReference,
    viewKind,
) {
    if (typeof replaceActiveReference !== 'boolean') {
        throw new Error('Reference navigation requires replacement policy');
    }
    if (replaceActiveReference && isViewingReferenceSource()) {
        replaceActiveReferenceNavigationQuery(referenceQuery, viewKind);
        await runReferenceSearchInActiveTab(referenceQuery, context);
        return ModeContext.activeTabId;
    }

    const sourceTabId = ModeContext.activeTabId;
    const originScope = captureReferenceOriginScopeForActiveTab();
    const newTabId = await duplicateTabContext(sourceTabId, false, false);
    if (typeof newTabId !== 'string' || newTabId.length === 0) {
        throw new Error('Reference navigation expected duplicateTabContext to return a tab id');
    }

    // Register the hidden-query view before any tab activation renders its search field.
    pushReferenceNavigationEntry(sourceTabId, newTabId, referenceQuery, originScope, viewKind);
    if (ModeContext.activeTabId !== newTabId) {
        await switchToTabContext(newTabId, { animateNoteChanges: false });
    }

    await runReferenceSearchInActiveTab(referenceQuery, context);
    return newTabId;
}

async function runReferenceSearchInActiveTab(referenceQuery, context) {
    if (typeof referenceQuery !== 'string' || referenceQuery.length === 0) {
        throw new Error('runReferenceSearchInActiveTab requires referenceQuery');
    }
    if (typeof context !== 'string' || context.length === 0) {
        throw new Error('runReferenceSearchInActiveTab requires context');
    }

    const searchInput = document.getElementById('search-input');
    if (!(searchInput instanceof HTMLInputElement)) {
        throw new Error('Search input element not found for reference tab navigation');
    }

    const queryAnalysis = analyzeSearchQueryInput(referenceQuery);
    if (!queryAnalysis.isComplete) {
        throw new Error('Reference navigation query must be a complete search query');
    }
    const normalizedReferenceQuery = queryAnalysis.normalizedText;
    // Opening the same reference from the same tab can leave the search query unchanged.
    if (ModeContext.searchQuery !== normalizedReferenceQuery) {
        ModeContext.setSearchQuery(normalizedReferenceQuery);
    }
    syncSearchInputField();
    updateSearchContextsList();

    await actionEnterSearchMode();
    ModeContext.clearActiveTabDiffCacheForSearchExecution(normalizedReferenceQuery);
    ModeContext.resetRootTracking({ clear: true });
    window.scrollTo(0, 0);
    // Reference navigation can run while the active tab is already scrolled to top.
    if (ModeContext.getTabScrollPosition(ModeContext.activeTabId) !== 0) {
        ModeContext.updateActiveTabScroll(0);
    }
    // updateActiveTabScroll and resetRootTracking leave anchors null.
    if (ModeContext.getTabScrollAnchor(ModeContext.activeTabId) !== null) {
        ModeContext.updateActiveTabScrollAnchor(null, true);
    }
    // resetRootTracking clears the root anchor for the reference search.
    if (ModeContext.getRootAnchorId() !== null) {
        ModeContext.setRootAnchorId(null);
    }
    const startedAt = performance.now();
    const { actionRefreshAndMaybeSelect } = await import('../actions/ui-actions.js');
    await actionRefreshAndMaybeSelect({
        startedAt,
        context,
        requireExecution: true,
        animateNoteChanges: false,
    });
    await persistTabStateSnapshot();

    syncSearchInputField();
    if (!isViewingReferenceSource()) {
        searchInput.focus();
        searchInput.setSelectionRange(
            normalizedReferenceQuery.length,
            normalizedReferenceQuery.length,
        );
    }
}

export async function openReferenceInCurrentTab(referenceNoteId) {
    if (typeof referenceNoteId !== 'string' || referenceNoteId.length === 0) {
        throw new Error('openReferenceInCurrentTab requires referenceNoteId');
    }
    await runReferenceSearchInActiveTab(referenceNoteId, 'reference.link_open_current_tab');
}

async function moveTabContext(tabId, hoveredTabId) {
	if (ModeContext.isEditing) {
		await actionSaveAndExitEditingWithoutRefreshing();
	}
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('tabId is required for tab reorder');
    }
    if (typeof hoveredTabId !== 'string' || hoveredTabId.length === 0) {
        throw new Error('hoveredTabId is required for tab reorder');
    }

    const tabOrder = ModeContext.tabOrder;
    if (!Array.isArray(tabOrder) || tabOrder.length === 0) {
        throw new Error('ModeContext.tabOrder must be a non-empty array');
    }
    if (tabOrder.length === 1) {
        return;
    }

    if (!tabOrder.includes(tabId)) {
        throw new Error(`tabOrder missing dragged tab: ${tabId}`);
    }
    if (!tabOrder.includes(hoveredTabId)) {
        throw new Error(`tabOrder missing hovered tab: ${hoveredTabId}`);
    }
    if (tabId === hoveredTabId) {
        return;
    }

    const currentScroll = Math.max(0, Math.round(window.scrollY));
    // Reordering tabs can be requested without the page moving first.
    if (ModeContext.getTabScrollPosition(ModeContext.activeTabId) !== currentScroll) {
        ModeContext.updateActiveTabScroll(currentScroll);
    }
    const nextScrollAnchor = computeScrollAnchor({ anchorBias: 'auto' });
    // Reordering tabs can snapshot a view with no root anchor, leaving both anchors null.
    if (!areScrollAnchorsEqual(ModeContext.getTabScrollAnchor(ModeContext.activeTabId), nextScrollAnchor)) {
        ModeContext.updateActiveTabScrollAnchor(nextScrollAnchor, true);
    }

    ModeContext.moveTabToHoveredSlot(tabId, hoveredTabId);
    updateSearchContextsList();
    await persistTabStateSnapshot();
}

async function deleteTabContext(deleteTabId) {
	if (ModeContext.isEditing) {
		await actionSaveAndExitEditingWithoutRefreshing();
	}
    if (typeof deleteTabId !== 'string' || deleteTabId.length === 0) {
        throw new Error('deleteTabId is required for tab deletion');
    }

    const payload = ModeContext.getTabStatePayload();
    if (payload.tabOrder.length <= 1) {
        return;
    }
    if (!payload.tabs[deleteTabId]) {
        throw new Error(`Cannot delete missing tab: ${deleteTabId}`);
    }

    const activeBeforeDelete = ModeContext.activeTabId;
    const beforeTabOrder = payload.tabOrder;
    if (!Array.isArray(beforeTabOrder) || beforeTabOrder.length === 0) {
        throw new Error('ModeContext.tabOrder must be a non-empty array');
    }
    const activeBeforeIndex = beforeTabOrder.indexOf(activeBeforeDelete);
    if (activeBeforeIndex === -1) {
        throw new Error(`activeTabId not present in ModeContext.tabOrder: ${activeBeforeDelete}`);
    }
    const deleteTabIndex = beforeTabOrder.indexOf(deleteTabId);
    if (deleteTabIndex === -1) {
        throw new Error(`deleteTabId not present in ModeContext.tabOrder: ${deleteTabId}`);
    }

    if (deleteTabId === activeBeforeDelete) {
        clearActiveNotesDom();
    } else {
        clearCachedNotesDomForTab(deleteTabId);
    }

    snapshotActiveTabScrollState();
    await persistTabStateSnapshot();

    const response = await deleteTabOnServer(deleteTabId);
    ModeContext.hydrateTabState(response, {
        preserveActiveRootTracking: deleteTabId !== activeBeforeDelete,
    });

    syncSearchInputField();
    updateSearchContextsList();

	    if (ModeContext.activeTabId !== activeBeforeDelete) {
        restoreNotesDomForTab(ModeContext.activeTabId);
        const afterTabOrder = ModeContext.tabOrder;
        if (!Array.isArray(afterTabOrder) || afterTabOrder.length === 0) {
            throw new Error('ModeContext.tabOrder must be a non-empty array');
        }
        const activeAfterIndex = afterTabOrder.indexOf(ModeContext.activeTabId);
        if (activeAfterIndex === -1) {
            throw new Error(`activeTabId not present in ModeContext.tabOrder: ${ModeContext.activeTabId}`);
        }
        const perfContext = `deleteTab tab#${deleteTabIndex + 1}→switch tab#${activeBeforeIndex + 1}→tab#${activeAfterIndex + 1}`;
        const startedAt = performance.now();
        const { actionRefreshAndMaybeSelect } = await import('../actions/ui-actions.js');
        await actionRefreshAndMaybeSelect({ startedAt, context: perfContext });
	        ModeContext.restoreScrollForActiveTab();
	    }
}

export async function navigateBackFromReferenceContext() {
    const entry = popReferenceNavigationEntryForActiveTab();
    if (entry === null) {
        return false;
    }

    const fromTabId = entry.fromTabId;
    const toTabId = entry.toTabId;
    if (typeof fromTabId !== 'string' || fromTabId.length === 0) {
        throw new Error('Reference back entry missing fromTabId');
    }
    if (typeof toTabId !== 'string' || toTabId.length === 0) {
        throw new Error('Reference back entry missing toTabId');
    }
    if (!ModeContext.tabs[fromTabId]) {
        return false;
    }

    await switchToTabContext(fromTabId, { animateNoteChanges: false });

    if (
        !CONFIG.REFERENCE_NAVIGATION
        || typeof CONFIG.REFERENCE_NAVIGATION.CLOSE_REF_TAB_ON_BACK !== 'boolean'
    ) {
        throw new Error('CONFIG.REFERENCE_NAVIGATION.CLOSE_REF_TAB_ON_BACK must be a boolean');
    }

    if (CONFIG.REFERENCE_NAVIGATION.CLOSE_REF_TAB_ON_BACK) {
        if (ModeContext.tabs[toTabId]) {
            await deleteTabContext(toTabId);
        }
    }

    updateReferenceSourceIndicator();
    return true;
}

function syncSearchInputField() {
    const searchInput = document.getElementById('search-input');
    if (!searchInput) {
        return;
    }

    const activeQuery = ModeContext.searchQuery;
    if (typeof activeQuery !== 'string') {
        throw new Error('ModeContext.searchQuery must be a string');
    }

    syncSearchInputValue(
        searchInput,
        resolveSearchInputDisplayQuery(
            activeQuery,
            ModeContext.isUntaggedView,
            isViewingReferenceSource(),
        ),
    );
}

async function persistCurrentTabState() {
    const currentScroll = Math.max(0, Math.round(window.scrollY));
    // Explicit tab-state persists may follow a scroll watcher that already stored this Y.
    if (ModeContext.getTabScrollPosition(ModeContext.activeTabId) !== currentScroll) {
        ModeContext.updateActiveTabScroll(currentScroll);
    }
    const nextScrollAnchor = computeScrollAnchor({ anchorBias: 'auto' });
    // Explicit tab-state persists can run when the stored anchor already matches the DOM anchor.
    if (!areScrollAnchorsEqual(ModeContext.getTabScrollAnchor(ModeContext.activeTabId), nextScrollAnchor)) {
        ModeContext.updateActiveTabScrollAnchor(nextScrollAnchor, true);
    }
    await persistTabStateSnapshot();
}
