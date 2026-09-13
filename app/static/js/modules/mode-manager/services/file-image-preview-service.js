import { ApplicationState } from '../../application-state.js';
import { rethrowUnexpectedError } from '../../expected-errors.js';
import { FilesAPI } from '../../api-client.js';


const moduleState = ApplicationState.createFields('file-image-preview-service', {
    previewCache: new Map(),
    pendingPreviewRequests: new Map(),

    cleanupRegistered: false,
});

function ensureCleanupHandlerRegistered() {
    if (moduleState.cleanupRegistered) {
        return;
    }
    if (typeof window === 'undefined') {
        return;
    }
    window.addEventListener('beforeunload', () => {
        for (const cachedPreview of moduleState.previewCache.values()) {
            URL.revokeObjectURL(cachedPreview.objectUrl);
        }
        if (moduleState.previewCache.size > 0) moduleState.previewCache.clear();
        if (moduleState.pendingPreviewRequests.size > 0) moduleState.pendingPreviewRequests.clear();
    });
    moduleState.cleanupRegistered = true;
}

function getImagePreviewTargets(rootNode) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') {
        throw new Error('getImagePreviewTargets expects root node with querySelectorAll');
    }
    return Array.from(rootNode.querySelectorAll('.note-file-image-embed[data-file-ref-id]'));
}

function setPreviewState(target, state) {
    if (!(target instanceof HTMLElement)) {
        throw new Error('setPreviewState expects HTMLElement target');
    }
    if (typeof state !== 'string' || state.length === 0) {
        throw new Error('setPreviewState expects state string');
    }
    target.dataset.previewState = state;
}

function applyPreviewObjectUrl(target, objectUrl) {
    if (!(target instanceof HTMLElement)) {
        throw new Error('applyPreviewObjectUrl expects HTMLElement target');
    }
    if (typeof objectUrl !== 'string' || objectUrl.length === 0) {
        throw new Error('applyPreviewObjectUrl expects objectUrl string');
    }

    const imageElement = target.querySelector('.note-file-image-preview');
    const placeholderElement = target.querySelector('.note-file-image-preview-placeholder');
    if (!(imageElement instanceof HTMLImageElement)) {
        throw new Error('Image file preview element missing');
    }
    if (!(placeholderElement instanceof HTMLElement)) {
        throw new Error('Image file preview placeholder missing');
    }

    imageElement.src = objectUrl;
    imageElement.hidden = false;
    placeholderElement.textContent = '';
    setPreviewState(target, 'loaded');
}

function applyPreviewFailure(target) {
    if (!(target instanceof HTMLElement)) {
        throw new Error('applyPreviewFailure expects HTMLElement target');
    }

    const placeholderElement = target.querySelector('.note-file-image-preview-placeholder');
    if (!(placeholderElement instanceof HTMLElement)) {
        throw new Error('Image file preview placeholder missing');
    }

    placeholderElement.textContent = 'Preview unavailable';
    setPreviewState(target, 'failed');
}

async function fetchPreviewObjectUrl(fileId) {
    if (typeof fileId !== 'string' || fileId.length === 0) {
        throw new Error('fetchPreviewObjectUrl expects fileId');
    }

    if (moduleState.previewCache.has(fileId)) {
        return moduleState.previewCache.get(fileId).objectUrl;
    }
    if (moduleState.pendingPreviewRequests.has(fileId)) {
        return await moduleState.pendingPreviewRequests.get(fileId);
    }

    ensureCleanupHandlerRegistered();

    const request = FilesAPI.downloadFile(fileId)
        .then((payload) => {
            if (!payload || typeof payload !== 'object') {
                throw new Error('Image file preview response missing payload');
            }
            if (!(payload.blob instanceof Blob)) {
                throw new Error('Image file preview response missing blob');
            }
            const mimeType = typeof payload.blob.type === 'string' ? payload.blob.type.toLowerCase() : '';
            if (!mimeType.startsWith('image/')) {
                throw new Error(`Image file preview requires image blob, received: ${mimeType}`);
            }
            const objectUrl = URL.createObjectURL(payload.blob);
            moduleState.previewCache.set(fileId, { objectUrl });
            moduleState.pendingPreviewRequests.delete(fileId);
            return objectUrl;
        })
        .catch((error) => {
            moduleState.pendingPreviewRequests.delete(fileId);
            throw error;
        });

    moduleState.pendingPreviewRequests.set(fileId, request);
    return await request;
}

export function hydrateImageFilePreviews(rootNode) {
    const targets = getImagePreviewTargets(rootNode);
    if (targets.length === 0) {
        return;
    }

    const fileIds = new Set();
    for (const target of targets) {
        if (!(target instanceof HTMLElement)) {
            throw new Error('hydrateImageFilePreviews target must be HTMLElement');
        }
        const fileId = target.dataset.fileRefId;
        if (typeof fileId !== 'string' || fileId.length === 0) {
            throw new Error('Image file preview target missing fileRefId');
        }
        if (target.dataset.previewState === 'loaded') {
            continue;
        }
        setPreviewState(target, 'loading');
        fileIds.add(fileId);
    }

    const requests = [];
    for (const fileId of fileIds) {
        requests.push(fetchPreviewObjectUrl(fileId)
            .then((objectUrl) => {
                document.querySelectorAll(`.note-file-image-embed[data-file-ref-id="${fileId}"]`).forEach((target) => {
                    if (!(target instanceof HTMLElement)) {
                        throw new Error('Image file preview target must remain HTMLElement');
                    }
                    applyPreviewObjectUrl(target, objectUrl);
                });
            })
            .catch((error) => {
            rethrowUnexpectedError(error);
                document.querySelectorAll(`.note-file-image-embed[data-file-ref-id="${fileId}"]`).forEach((target) => {
                    if (!(target instanceof HTMLElement)) {
                        throw new Error('Image file preview target must remain HTMLElement');
                    }
                    applyPreviewFailure(target);
                });
            }));
    }
    return Promise.all(requests);
}
