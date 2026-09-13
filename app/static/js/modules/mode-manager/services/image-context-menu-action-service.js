import { ApplicationState } from '../../application-state.js';
import { HttpRequestError } from '../../expected-errors.js';
const moduleState = ApplicationState.createFields('image-context-menu-action-service', {
    activeZoomOverlay: null,
});

function handleZoomKeyDown(event) {
    if (!event) {
        throw new Error('handleZoomKeyDown requires event');
    }
    if (event.key === 'Escape') {
        closeActiveZoomOverlay();
    }
}

function requireImageContext(imageContext) {
    if (imageContext === null) {
        throw new Error('Image action requires imageContext object');
    }
    if (typeof imageContext !== 'object') {
        throw new Error('Image action requires imageContext object');
    }
    const sourceKind = imageContext.sourceKind;
    if (sourceKind !== 'inline' && sourceKind !== 'file') {
        throw new Error(`Invalid imageContext sourceKind: ${sourceKind}`);
    }
    const src = imageContext.src;
    if (typeof src !== 'string') {
        throw new Error('Image action requires imageContext.src');
    }
    if (src.length === 0) {
        throw new Error('Image action requires imageContext.src');
    }
    if (sourceKind === 'file') {
        const fileId = imageContext.fileId;
        if (typeof fileId !== 'string') {
            throw new Error('File image action requires imageContext.fileId');
        }
        if (fileId.length === 0) {
            throw new Error('File image action requires imageContext.fileId');
        }
    }
}

function imageExtensionFromMimeType(mimeType) {
    if (typeof mimeType !== 'string') {
        throw new Error('imageExtensionFromMimeType requires mimeType string');
    }
    const lower = mimeType.trim().toLowerCase();
    if (lower === 'image/jpeg') {
        return 'jpg';
    }
    if (lower === 'image/jpg') {
        return 'jpg';
    }
    if (lower === 'image/png') {
        return 'png';
    }
    if (lower === 'image/gif') {
        return 'gif';
    }
    if (lower === 'image/webp') {
        return 'webp';
    }
    if (lower === 'image/svg+xml') {
        return 'svg';
    }
    if (lower === 'image/bmp') {
        return 'bmp';
    }
    if (lower === 'image/avif') {
        return 'avif';
    }
    return 'img';
}

export function buildSuggestedImageFilename(imageContext, mimeType) {
    requireImageContext(imageContext);
    if (typeof mimeType !== 'string') {
        throw new Error('buildSuggestedImageFilename requires mimeType string');
    }

    const filename = imageContext.filename;
    if (typeof filename === 'string' && filename.trim().length > 0) {
        return filename.trim();
    }

    const alt = imageContext.alt;
    if (typeof alt === 'string' && alt.trim().length > 0) {
        const sanitized = alt.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
        if (sanitized.length > 0) {
            return `${sanitized}.${imageExtensionFromMimeType(mimeType)}`;
        }
    }

    return `image.${imageExtensionFromMimeType(mimeType)}`;
}

function resolveImageMimeType(blob, sourceUrl) {
    if (!(blob instanceof Blob)) {
        throw new Error('resolveImageMimeType requires Blob');
    }
    if (typeof sourceUrl !== 'string') {
        throw new Error('resolveImageMimeType requires sourceUrl string');
    }

    const blobType = typeof blob.type === 'string' ? blob.type.trim().toLowerCase() : '';
    if (blobType.startsWith('image/')) {
        return blobType;
    }

    const dataMatch = /^data:(image\/[^;,]+)[;,]/i.exec(sourceUrl);
    if (dataMatch && typeof dataMatch[1] === 'string') {
        return dataMatch[1].toLowerCase();
    }

    return 'image/png';
}

async function fetchInlineImageBlob(sourceUrl) {
    if (typeof sourceUrl !== 'string') {
        throw new Error('fetchInlineImageBlob requires sourceUrl');
    }
    if (sourceUrl.length === 0) {
        throw new Error('fetchInlineImageBlob requires sourceUrl');
    }
    const response = await fetch(sourceUrl);
    if (!response.ok) {
        throw new HttpRequestError(`Image fetch failed: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    const mimeType = resolveImageMimeType(blob, sourceUrl);
    if (!mimeType.startsWith('image/')) {
        throw new Error(`Image fetch returned non-image MIME type: ${mimeType}`);
    }
    return {
        blob,
        mimeType,
        filename: null,
    };
}

async function loadImageBlob(imageContext) {
    requireImageContext(imageContext);

    if (imageContext.sourceKind === 'file') {
        const { FilesAPI } = await import('../../api-client.js');
        const payload = await FilesAPI.downloadFile(imageContext.fileId);
        if (payload === null) {
            throw new Error('File image download returned invalid payload');
        }
        if (typeof payload !== 'object') {
            throw new Error('File image download returned invalid payload');
        }
        const blob = payload.blob;
        if (!(blob instanceof Blob)) {
            throw new Error('File image download missing blob');
        }
        const mimeType = resolveImageMimeType(blob, imageContext.src);
        if (!mimeType.startsWith('image/')) {
            throw new Error(`File image download returned non-image MIME type: ${mimeType}`);
        }
        const filename = payload.filename;
        return {
            blob,
            mimeType,
            filename: typeof filename === 'string' && filename.trim().length > 0 ? filename.trim() : null,
        };
    }

    return await fetchInlineImageBlob(imageContext.src);
}

function triggerImageDownload(blob, filename) {
    if (!(blob instanceof Blob)) {
        throw new Error('triggerImageDownload requires Blob');
    }
    if (typeof filename !== 'string') {
        throw new Error('triggerImageDownload requires filename');
    }
    if (filename.trim().length === 0) {
        throw new Error('triggerImageDownload requires filename');
    }

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename.trim();
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 0);
}

function resolveClipboardItemClass() {
    if (typeof ClipboardItem !== 'function') {
        throw new Error('ClipboardItem is required to copy images');
    }
    return ClipboardItem;
}

async function decodeImageBlob(blob) {
    if (!(blob instanceof Blob)) {
        throw new Error('decodeImageBlob requires Blob');
    }

    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    const loadedImage = await new Promise((resolve, reject) => {
        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Failed decoding image for clipboard copy'));
        };
        image.src = objectUrl;
    });
    return loadedImage;
}

async function convertImageBlobToClipboardPng(blob) {
    if (!(blob instanceof Blob)) {
        throw new Error('convertImageBlobToClipboardPng requires Blob');
    }
    const mimeType = typeof blob.type === 'string' ? blob.type.trim().toLowerCase() : '';
    if (mimeType === 'image/png') {
        return blob;
    }

    const image = await decodeImageBlob(blob);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!Number.isFinite(width)) {
        throw new Error('Image has invalid dimensions for clipboard copy');
    }
    if (!Number.isFinite(height)) {
        throw new Error('Image has invalid dimensions for clipboard copy');
    }
    if (width <= 0) {
        throw new Error('Image has invalid dimensions for clipboard copy');
    }
    if (height <= 0) {
        throw new Error('Image has invalid dimensions for clipboard copy');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Canvas 2D context unavailable for image clipboard copy');
    }
    context.drawImage(image, 0, 0);

    const pngBlob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => {
            if (!(result instanceof Blob)) {
                reject(new Error('Canvas failed to encode image clipboard PNG'));
                return;
            }
            resolve(result);
        }, 'image/png');
    });
    return pngBlob;
}

export function resolveImageContextFromElement(element) {
    if (!(element instanceof HTMLElement)) {
        return null;
    }
    const image = element.closest('img');
    if (!(image instanceof HTMLImageElement)) {
        return null;
    }
    const src = typeof image.currentSrc === 'string' && image.currentSrc.length > 0
        ? image.currentSrc
        : image.src;
    if (typeof src !== 'string') {
        return null;
    }
    if (src.length === 0) {
        return null;
    }

    const fileId = image.dataset.fileRefId;
    const alt = image.alt;
    if (typeof fileId === 'string' && fileId.length > 0) {
        const referenceBlock = image.closest('.note-reference-block[data-ref-occurrence]');
        if (!(referenceBlock instanceof HTMLElement)) {
            throw new Error('Rendered file image is missing its reference occurrence');
        }
        const hostNoteId = referenceBlock.dataset.refHostNoteId;
        const occurrenceIndex = Number.parseInt(referenceBlock.dataset.refOccurrence, 10);
        if (typeof hostNoteId !== 'string' || hostNoteId.length === 0) {
            throw new Error('Rendered file image is missing its host note id');
        }
        if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
            throw new Error('Rendered file image has an invalid reference occurrence');
        }
        return {
            sourceKind: 'file',
            fileId,
            hostNoteId,
            occurrenceIndex,
            src,
            alt: typeof alt === 'string' ? alt : '',
            filename: null,
        };
    }

    let occurrenceIndex = Number.parseInt(image.dataset.inlineImageOccurrence, 10);
    if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
        const noteContent = image.closest('.note-content');
        if (!(noteContent instanceof HTMLElement)) {
            throw new Error('Inline image is missing its note content container');
        }
        const images = Array.from(noteContent.querySelectorAll('img'));
        occurrenceIndex = images.indexOf(image);
        if (occurrenceIndex < 0) {
            throw new Error('Inline image occurrence could not be resolved');
        }
    }
    const embeddedNote = image.closest('.note-embed-node[data-embed-note-id]');
    const hostNote = image.closest('.note[data-note-id]');
    const hostNoteId = embeddedNote instanceof HTMLElement
        ? embeddedNote.dataset.embedNoteId
        : hostNote?.dataset.noteId;
    if (typeof hostNoteId !== 'string' || hostNoteId.length === 0) {
        throw new Error('Inline image is missing its host note id');
    }

    return {
        sourceKind: 'inline',
        fileId: null,
        hostNoteId,
        occurrenceIndex,
        src,
        alt: typeof alt === 'string' ? alt : '',
        filename: null,
    };
}

export async function copyImageFromContext(imageContext) {
    requireImageContext(imageContext);
    const clipboard = navigator.clipboard;
    if (!clipboard) {
        throw new Error('navigator.clipboard.write is required to copy images');
    }
    if (typeof clipboard.write !== 'function') {
        throw new Error('navigator.clipboard.write is required to copy images');
    }
    const ResolvedClipboardItem = resolveClipboardItemClass();
    const loaded = await fetchInlineImageBlob(imageContext.src);
    const clipboardBlob = await convertImageBlobToClipboardPng(loaded.blob);
    await clipboard.write([
        new ResolvedClipboardItem({
            [clipboardBlob.type]: clipboardBlob,
        }),
    ]);
}

export async function saveImageFromContext(imageContext) {
    requireImageContext(imageContext);
    const loaded = await loadImageBlob(imageContext);
    const filename = loaded.filename !== null
        ? loaded.filename
        : buildSuggestedImageFilename(imageContext, loaded.mimeType);
    triggerImageDownload(loaded.blob, filename);
}

export async function openImageInNewTabFromContext(imageContext) {
    requireImageContext(imageContext);
    window.open(imageContext.src, '_blank', 'noopener');
}

function closeActiveZoomOverlay() {
    if (moduleState.activeZoomOverlay === null) {
        return;
    }
    moduleState.activeZoomOverlay.remove();
    moduleState.activeZoomOverlay = null;
    document.removeEventListener('keydown', handleZoomKeyDown, { capture: true });
}

function buildZoomOverlay(src, alt) {
    if (typeof src !== 'string') {
        throw new Error('buildZoomOverlay requires src');
    }
    if (src.length === 0) {
        throw new Error('buildZoomOverlay requires src');
    }
    if (typeof alt !== 'string') {
        throw new Error('buildZoomOverlay requires alt string');
    }

    const overlay = document.createElement('div');
    overlay.className = 'image-zoom-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'image-zoom-close';
    closeButton.setAttribute('aria-label', 'Close image zoom');
    closeButton.textContent = '×';

    const image = document.createElement('img');
    image.className = 'image-zoom-image';
    image.src = src;
    image.alt = alt;

    overlay.appendChild(closeButton);
    overlay.appendChild(image);

    closeButton.addEventListener('click', () => {
        closeActiveZoomOverlay();
    });
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeActiveZoomOverlay();
        }
    });

    return overlay;
}

export async function zoomImageFromContext(imageContext) {
    requireImageContext(imageContext);
    closeActiveZoomOverlay();

    const alt = typeof imageContext.alt === 'string' ? imageContext.alt : '';
    moduleState.activeZoomOverlay = buildZoomOverlay(imageContext.src, alt);
    document.body.appendChild(moduleState.activeZoomOverlay);
    document.addEventListener('keydown', handleZoomKeyDown, { capture: true });
}
