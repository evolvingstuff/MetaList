import { ApplicationState } from '../application-state.js';
/**
 * BaseModal - Foundation class for all modal dialogs
 * 
 * Provides common functionality:
 * - Clean state enforcement 
 * - ModeContext integration
 * - Event handling (Esc, click-outside)
 * - Modal lifecycle management
 */

import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';

export class BaseModal {
    constructor(modalName, modalElementId) {
        if (!modalName) {
            throw new Error('Modal name is required');
        }
        
        this.modalName = modalName;
        if (typeof modalElementId === 'string' && modalElementId.length > 0) {
            this.modalElementId = modalElementId;
        } else {
            this.modalElementId = `${modalName}-modal`;
        }
        this.isOpen = false;
        
        // Bind event handlers
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.handleClickOutside = this.handleClickOutside.bind(this);
        this._wrapModalContentRenderer();

        ApplicationState.own(this, 'BaseModal', new.target === BaseModal);
    }
    
    /**
     * Open the modal - validates clean state and initializes modal
     */
    open() {
        if (this.isOpen) {
            throw new Error(`[BaseModal] ${this.modalName} is already open`);
        }
        
        // Enforce clean state requirement
        this.validateCleanState();
        
        // Update ModeContext
        this.addToModalStack();
        this.initializeModalState();
        
        // Show modal UI
        this.showModalElement();
        this._installModalCloseButton();
        
        // Set up event listeners
        this.setupEventListeners();
        
        // Call subclass hook
        this.onOpen();
        
        this.isOpen = true;
        console.log(`[BaseModal] ${this.modalName} opened`);
    }
    
    /**
     * Close the modal - cleanup and restore state
     */
    close() {
        if (!this.isOpen) {
            throw new Error(`[BaseModal] ${this.modalName} is not open`);
        }
        
        // Call subclass hook
        this.onClose();
        
        // Clean up event listeners
        this.cleanupEventListeners();
        
        // Hide modal UI
        this.hideModalElement();
        
        // Update ModeContext
        this.removeModalState();
        this.removeFromModalStack();
        
        this.isOpen = false;
        console.log(`[BaseModal] ${this.modalName} closed`);

        document.dispatchEvent(new CustomEvent('metalist:modal-closed', {
            detail: { modalName: this.modalName }
        }));
    }
    
    /**
     * Validate that application is in clean state before opening modal
     * Throws error if dirty state detected
     */
    validateCleanState() {
        const errors = [];
        
        // Check for editing state
        if (ModeContext.currentNoteId) {
            errors.push(`Cannot open modal while editing note (currentNoteId: ${ModeContext.currentNoteId})`);
        }
        
        // Check for search state  
        if (ModeContext.isSearching) {
            errors.push('Cannot open modal while in search mode');
        }
        
        // Check for loading state
        if (ModeContext.isLoading) {
            errors.push('Cannot open modal while application is loading');
        }
        
        // Check if another modal is already open (unless we support stacking)
        if (ModeContext.modalStack.length > 0) {
            errors.push(`Cannot open modal while ${ModeContext.topModal} is open`);
        }
        
        if (errors.length > 0) {
            throw new Error(`Modal opening blocked: ${errors.join(', ')}`);
        }
    }
    
    /**
     * Add this modal to the modal stack
     */
    addToModalStack() {
        ModeContext.pushModal(this.modalName);
    }
    
    /**
     * Remove this modal from the modal stack
     */
    removeFromModalStack() {
        ModeContext.removeModal(this.modalName);
    }
    
    /**
     * Initialize modal-specific state in ModeContext
     */
    initializeModalState() {
        ModeContext.initializeModalState(this.modalName, this.getInitialModalState());
    }
    
    /**
     * Remove modal-specific state from ModeContext
     */
    removeModalState() {
        ModeContext.removeModalState(this.modalName);
    }
    
    /**
     * Show the modal DOM element
     */
    showModalElement() {
        let modalElement = document.getElementById(this.modalElementId);
        
        // Create modal element if it doesn't exist
        if (!modalElement) {
            modalElement = document.createElement('div');
            modalElement.id = this.modalElementId;
            modalElement.className = 'modal';
            modalElement.style.display = 'none';
            modalElement.innerHTML = `
                <div class="modal-content">
                    <h2 id="${this.modalElementId}-title">Password Management</h2>
                    <div id="${this.modalElementId}-body">
                        <!-- Content will be dynamically inserted -->
                    </div>
                </div>
            `;
            document.body.appendChild(modalElement);
        }
        
        modalElement.style.display = 'block';
        
        // Focus first focusable element
        const firstFocusable = modalElement.querySelector('input, button, textarea, select');
        if (firstFocusable) {
            setTimeout(() => firstFocusable.focus(), 100);
        }
    }
    
    /**
     * Hide the modal DOM element
     */
    hideModalElement() {
        const modalElement = document.getElementById(this.modalElementId);
        if (modalElement) {
            modalElement.style.display = 'none';
        }
    }
    
    /**
     * Set up modal event listeners
     */
    setupEventListeners() {
        document.addEventListener('keydown', this.handleKeyDown);
        
        // Click outside to close (optional, can be overridden)
        if (this.shouldCloseOnClickOutside()) {
            const modalElement = document.getElementById(this.modalElementId);
            if (modalElement) {
                modalElement.addEventListener('click', this.handleClickOutside);
            }
        }
    }
    
    /**
     * Clean up modal event listeners
     */
    cleanupEventListeners() {
        document.removeEventListener('keydown', this.handleKeyDown);
        
        const modalElement = document.getElementById(this.modalElementId);
        if (modalElement) {
            modalElement.removeEventListener('click', this.handleClickOutside);
        }
    }
    
    /**
     * Handle keydown events (Esc to close)
     */
    handleKeyDown(event) {
        // Only handle events if this is the top modal
        const topModal = ModeContext.topModal;
        if (topModal !== this.modalName) {
            return;
        }
        
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.requestClose();
            return;
        }
        
        // Pass to subclass for modal-specific handling
        this.onKeyDown(event);
        if (event.defaultPrevented || event.key !== 'Enter' || event.isComposing) {
            return;
        }
        const target = event.target;
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) {
            return;
        }
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }
        const enterActions = modalElement.querySelectorAll('[data-modal-enter-action]');
        if (enterActions.length === 0) {
            return;
        }
        if (enterActions.length !== 1) {
            throw new Error(`${this.modalName} must have exactly one Enter action`);
        }
        const enterAction = enterActions[0];
        if (!(enterAction instanceof HTMLButtonElement)) {
            throw new Error(`${this.modalName} Enter action must be a button`);
        }
        if (enterAction.disabled) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        enterAction.click();
    }
    
    /**
     * Handle click outside modal content
     */
    handleClickOutside(event) {
        if (event.target === event.currentTarget) {
            this.requestClose();
        }
    }

    _wrapModalContentRenderer() {
        const renderModalContent = this.renderModalContent;
        if (typeof renderModalContent !== 'function') {
            return;
        }
        this.renderModalContent = (...args) => {
            const result = renderModalContent.apply(this, args);
            this._installModalCloseButton();
            return result;
        };
    }

    _installModalCloseButton() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }
        const modalContent = modalElement.querySelector('.modal-content');
        if (!(modalContent instanceof HTMLElement)) {
            throw new Error(`Modal content missing: ${this.modalElementId}`);
        }
        const directCloseButtons = Array.from(modalContent.children).filter((element) => (
            element instanceof HTMLButtonElement
            && element.classList.contains('modal-close-button')
        ));
        if (directCloseButtons.length > 1) {
            throw new Error(`${this.modalName} has multiple modal close buttons`);
        }
        let closeButton = directCloseButtons[0];
        if (!(closeButton instanceof HTMLButtonElement)) {
            closeButton = document.createElement('button');
            closeButton.type = 'button';
            closeButton.className = 'modal-close-button';
            closeButton.setAttribute('aria-label', 'Close');
            closeButton.title = 'Close (Esc)';
            closeButton.textContent = '×';
            modalContent.prepend(closeButton);
        }
        closeButton.disabled = !this.canRequestClose();
        closeButton.onclick = () => this.requestClose();
        return closeButton;
    }

    requestClose() {
        if (!this.canRequestClose()) {
            return;
        }
        this.close();
    }

    canRequestClose() {
        return true;
    }
    
    // Subclass hooks - override these in specific modals
    
    /**
     * Get initial state for this modal
     * Override in subclasses to provide modal-specific state
     */
    getInitialModalState() {
        return {};
    }
    
    /**
     * Called after modal opens
     * Override in subclasses for modal-specific initialization
     */
    onOpen() {
        // Override in subclasses
    }
    
    /**
     * Called before modal closes
     * Override in subclasses for modal-specific cleanup
     */
    onClose() {
        // Override in subclasses
    }
    
    /**
     * Called for modal-specific keydown handling
     * Override in subclasses for custom keyboard shortcuts
     */
    onKeyDown(event) {
        // Override in subclasses
    }
    
    /**
     * Whether this modal should close when clicking outside
     * Override in subclasses to disable click-outside closing
     */
    shouldCloseOnClickOutside() {
        return true;
    }
    
    /**
     * Get current modal state from ModeContext
     */
    getModalState() {
        return ModeContext.getModalState(this.modalName);
    }
    
    /**
     * Update modal state in ModeContext
     */
    updateModalState(updates) {
        ModeContext.updateModalState(this.modalName, updates);
    }
}
