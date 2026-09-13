import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';

const MODAL_NAME = 'imageFileInsertChoiceModal';
const MODAL_ID = 'image-file-insert-choice-modal';

const moduleState = ApplicationState.createFields('image-file-insert-choice-modal-service', {
    activeDialog: null,
});

function addModalToStack() {
    if (ModeContext.modalStack.includes(MODAL_NAME)) {
        throw new Error('Image file insert choice modal already present in modal stack');
    }
    ModeContext.pushModal(MODAL_NAME);
}

function removeModalFromStack() {
    ModeContext.removeModal(MODAL_NAME);
}

function ensureModalElement() {
    let modalElement = document.getElementById(MODAL_ID);
    if (modalElement instanceof HTMLElement) {
        return modalElement;
    }

    modalElement = document.createElement('div');
    modalElement.id = MODAL_ID;
    modalElement.className = 'modal image-file-insert-choice-modal';
    modalElement.style.display = 'none';
    modalElement.innerHTML = `
        <div class="modal-content image-file-insert-choice-modal-content">
            <button type="button" class="modal-close-button" aria-label="Close" title="Close (Esc)">×</button>
            <h2 id="image-file-insert-choice-title">Handle image file</h2>
            <p id="image-file-insert-choice-description"></p>
            <div class="image-file-insert-choice-actions">
                <button type="button" class="primary-btn" id="image-file-insert-choice-embed">Paste Inline</button>
                <button type="button" class="secondary-btn" id="image-file-insert-choice-attach">Save as File</button>
                <button type="button" class="secondary-btn" id="image-file-insert-choice-cancel">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(modalElement);
    return modalElement;
}

function buildChoiceDescription(imageCount, source) {
    if (!Number.isInteger(imageCount) || imageCount <= 0) {
        throw new Error(`buildChoiceDescription invalid imageCount: ${imageCount}`);
    }
    if (source !== 'paste' && source !== 'drop') {
        throw new Error(`buildChoiceDescription invalid source: ${source}`);
    }

    const noun = imageCount === 1 ? 'image' : `${imageCount} images`;
    const sourceVerb = source === 'paste' ? 'pasted' : 'dropped';
    return (
        `You ${sourceVerb} ${noun}. `
        + 'Paste Inline keeps the current compressed embed behavior. '
        + 'Save as File uploads the original file and inserts its file UUID token into the note.'
    );
}

export function promptForImageFileInsertMode(options) {
    if (options === null || typeof options !== 'object') {
        throw new Error('promptForImageFileInsertMode expects options object');
    }

    const imageCount = options.imageCount;
    const source = options.source;
    if (!Number.isInteger(imageCount) || imageCount <= 0) {
        throw new Error(`promptForImageFileInsertMode invalid imageCount: ${imageCount}`);
    }
    if (source !== 'paste' && source !== 'drop') {
        throw new Error(`promptForImageFileInsertMode invalid source: ${source}`);
    }
    if (moduleState.activeDialog !== null) {
        throw new Error('Image file insert choice modal is already open');
    }
    if (ModeContext.modalStack.length > 0) {
        throw new Error('Cannot open image file insert choice modal while another modal is open');
    }

    const modalElement = ensureModalElement();
    const descriptionElement = modalElement.querySelector('#image-file-insert-choice-description');
    const embedButton = modalElement.querySelector('#image-file-insert-choice-embed');
    const attachButton = modalElement.querySelector('#image-file-insert-choice-attach');
    const cancelButton = modalElement.querySelector('#image-file-insert-choice-cancel');
    const closeButton = modalElement.querySelector('.modal-close-button');

    if (!(descriptionElement instanceof HTMLElement)) {
        throw new Error('Image file insert choice description element missing');
    }
    if (!(embedButton instanceof HTMLButtonElement)) {
        throw new Error('Image file insert choice embed button missing');
    }
    if (!(attachButton instanceof HTMLButtonElement)) {
        throw new Error('Image file insert choice attach button missing');
    }
    if (!(cancelButton instanceof HTMLButtonElement)) {
        throw new Error('Image file insert choice cancel button missing');
    }
    if (!(closeButton instanceof HTMLButtonElement)) {
        throw new Error('Image file insert choice close button missing');
    }

    descriptionElement.textContent = buildChoiceDescription(imageCount, source);
    modalElement.style.display = 'block';
    addModalToStack();

    return new Promise((resolve) => {
        const finish = (value) => {
            if (moduleState.activeDialog === null) {
                return;
            }
            cleanup();
            modalElement.style.display = 'none';
            removeModalFromStack();
            moduleState.activeDialog = null;
            resolve(value);
        };

        const handleClick = (event) => {
            if (!event.target) {
                throw new Error('Image file insert choice click missing target');
            }
            if (event.target === modalElement) {
                finish(null);
                return;
            }
            const embedTarget = event.target.closest('#image-file-insert-choice-embed');
            if (embedTarget) {
                finish('embed');
                return;
            }
            const attachTarget = event.target.closest('#image-file-insert-choice-attach');
            if (attachTarget) {
                finish('attach');
                return;
            }
            const cancelTarget = event.target.closest('#image-file-insert-choice-cancel');
            if (cancelTarget) {
                finish(null);
                return;
            }
            const closeTarget = event.target.closest('.modal-close-button');
            if (closeTarget) {
                finish(null);
            }
        };

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finish(null);
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                finish('embed');
            }
        };

        const cleanup = () => {
            modalElement.removeEventListener('click', handleClick);
            document.removeEventListener('keydown', handleKeyDown, true);
        };

        moduleState.activeDialog = { resolve };
        modalElement.addEventListener('click', handleClick);
        document.addEventListener('keydown', handleKeyDown, true);
        window.setTimeout(() => {
            embedButton.focus();
        }, 0);
    });
}
