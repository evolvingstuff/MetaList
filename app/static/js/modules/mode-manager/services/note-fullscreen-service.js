import { ApplicationState } from '../../application-state.js';
import { NotesAPI } from '../../api-client.js';
import { hydrateImageFilePreviews } from './file-image-preview-service.js';
import { ensureAnchorsOpenInNewTabs } from './markdown-render-service.js';
import { queueMermaidDiagramRendering } from './mermaid-render-service.js';
import { hydrateRemoteImageProxies } from './remote-image-proxy-service.js';
import { recordNoteInteractionIfNew } from './search-interaction-service.js';

const moduleState = ApplicationState.createFields('note-fullscreen-service', {
    activeOverlay: null,
    previousFocusElement: null,
});


function handleFullscreenKeydown(event) {
    if (!event || event.key !== 'Escape' || moduleState.activeOverlay === null) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeNoteFullscreen();
}

export function closeNoteFullscreen() {
    if (moduleState.activeOverlay === null) {
        return;
    }
    const overlay = moduleState.activeOverlay;
    const focusTarget = moduleState.previousFocusElement;
    moduleState.activeOverlay = null;
    moduleState.previousFocusElement = null;

    document.removeEventListener('keydown', handleFullscreenKeydown, { capture: true });
    document.documentElement.classList.remove('note-fullscreen-open');
    document.body.classList.remove('note-fullscreen-open');
    overlay.remove();

    if (focusTarget instanceof HTMLElement && focusTarget.isConnected) {
        focusTarget.focus();
    }
}

function createNoteFullscreenOverlay(markup) {
    if (typeof markup !== 'string' || markup.length === 0) {
        throw new Error('createNoteFullscreenOverlay requires non-empty markup');
    }
    const mainApp = document.getElementById('main-app');
    if (!(mainApp instanceof HTMLElement)) {
        throw new Error('Cannot open note full screen: main app element is missing');
    }

    const overlay = document.createElement('section');
    overlay.classList.add('note-fullscreen-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Full screen note');

    const closeButton = document.createElement('button');
    closeButton.classList.add('note-fullscreen-close');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Exit full screen note');
    closeButton.title = 'Exit full screen (Esc)';
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => closeNoteFullscreen());
    overlay.appendChild(closeButton);

    const scrollContainer = document.createElement('div');
    scrollContainer.classList.add('note-fullscreen-scroll');
    const tree = document.createElement('main');
    tree.classList.add('note-fullscreen-tree');
    tree.innerHTML = markup;
    scrollContainer.appendChild(tree);
    overlay.appendChild(scrollContainer);
    mainApp.appendChild(overlay);
    return { overlay, tree, closeButton };
}

export async function openNoteFullscreen(noteId) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('openNoteFullscreen requires noteId string');
    }

    const response = await NotesAPI.getNoteFullscreen(noteId);
    closeNoteFullscreen();
    moduleState.previousFocusElement = document.activeElement;

    const elements = createNoteFullscreenOverlay(response.html);
    moduleState.activeOverlay = elements.overlay;
    document.documentElement.classList.add('note-fullscreen-open');
    document.body.classList.add('note-fullscreen-open');
    document.addEventListener('keydown', handleFullscreenKeydown, { capture: true });

    ensureAnchorsOpenInNewTabs(elements.tree);
    hydrateImageFilePreviews(elements.tree);
    hydrateRemoteImageProxies(elements.tree);
    void queueMermaidDiagramRendering(elements.tree);
    elements.closeButton.focus();
    await recordNoteInteractionIfNew(noteId, 'fullscreen');
}
