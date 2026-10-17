// Shows Excalidraw diagrams in view mode: fetches the stored light and dark SVG previews and
// displays them as images (never as inline SVG), keyed by the file's content revision.
import { ApplicationState } from '../application-state.js';
import { FilesAPI } from '../api-client.js';
import { rethrowUnexpectedError } from '../expected-errors.js';
import { EXCALIDRAW_PREVIEW_VARIANTS } from './excalidraw-scene.js';

const EMBED_SELECTOR = '.note-file-excalidraw-embed[data-file-ref-id]';
// Excalidraw exports an empty drawing as a tiny padded square.
const EMPTY_PREVIEW_MAX_PX = 40;
// Frame widths within this step share a remembered height.
const FRAME_WIDTH_BUCKET_PX = 10;

const previewState = ApplicationState.createFields('excalidraw-preview-service', {
    // `${fileId}:${revision}:${variant}` -> Promise<{ status: 'ready', objectUrl } | { status: 'missing' }>
    previews: new Map(),
    // Object URLs of resolved previews, revoked when their revision is superseded.
    objectUrls: new Map(),
    // Rendered frame height by file, revision and frame width, for this page
    // session: a diagram rendered again holds that height while it loads.
    frameHeights: new Map(),
});

function frameOf(target) {
    const frame = target.querySelector('.note-file-excalidraw-frame');
    if (!(frame instanceof HTMLElement)) {
        throw new Error('Excalidraw embed is missing its frame');
    }
    return frame;
}

function frameHeightKey(target, fileId, revision) {
    return `${fileId}:${revision}:${Math.round(frameOf(target).clientWidth / FRAME_WIDTH_BUCKET_PX) * FRAME_WIDTH_BUCKET_PX}`;
}

function previewKey(fileId, revision, variant) {
    return `${fileId}:${revision}:${variant}`;
}

function readEmbed(target) {
    if (!(target instanceof HTMLElement)) {
        throw new Error('Excalidraw embed must be an HTMLElement');
    }
    const fileId = target.dataset.fileRefId;
    const revision = Number(target.dataset.fileRevision);
    if (typeof fileId !== 'string' || fileId.length === 0) {
        throw new Error('Excalidraw embed is missing data-file-ref-id');
    }
    if (!Number.isInteger(revision) || revision < 1) {
        throw new Error('Excalidraw embed is missing a valid data-file-revision');
    }
    return { fileId, revision };
}

function fetchPreview(fileId, revision, variant) {
    const key = previewKey(fileId, revision, variant);
    if (previewState.previews.has(key)) {
        return previewState.previews.get(key);
    }
    const request = FilesAPI.downloadFilePreview(fileId, variant).then((result) => { // shockharness: ignore[EXC001] reason="the handler only resets state, then rethrows the error unchanged"
        if (result.status === 'missing') {
            return { status: 'missing' };
        }
        if (!(result.blob instanceof Blob)) {
            throw new Error('Excalidraw preview response is missing its blob');
        }
        const objectUrl = URL.createObjectURL(result.blob);
        if (previewState.previews.get(key) !== request) {
            URL.revokeObjectURL(objectUrl);
            throw new DOMException('Excalidraw preview superseded by a newer revision', 'AbortError');
        }
        previewState.objectUrls.set(key, objectUrl);
        return { status: 'ready', objectUrl };
    }, (error) => {
        previewState.previews.delete(key);
        throw error;
    });
    previewState.previews.set(key, request);
    return request;
}

function placeholderOf(target) {
    const placeholder = target.querySelector('.note-file-excalidraw-placeholder');
    if (!(placeholder instanceof HTMLElement)) {
        throw new Error('Excalidraw embed is missing its placeholder');
    }
    return placeholder;
}

function imageOf(target, variant) {
    const image = target.querySelector(`.note-file-excalidraw-preview[data-preview-variant="${variant}"]`);
    if (!(image instanceof HTMLImageElement)) {
        throw new Error(`Excalidraw embed is missing its ${variant} preview image`);
    }
    return image;
}

async function showPreviews(target, results) {
    const placeholder = placeholderOf(target);
    if (results.some((result) => result.status === 'missing')) {
        placeholder.textContent = 'This diagram has not been rendered yet. Double-click it to open the editor.';
        target.dataset.previewState = 'missing';
        return;
    }
    const images = EXCALIDRAW_PREVIEW_VARIANTS.map((variant, index) => {
        const image = imageOf(target, variant);
        image.src = results[index].objectUrl;
        return image;
    });
    await Promise.all(images.map((image) => image.decode()));
    const isEmpty = images[0].naturalWidth <= EMPTY_PREVIEW_MAX_PX && images[0].naturalHeight <= EMPTY_PREVIEW_MAX_PX;
    if (isEmpty) {
        placeholder.textContent = 'Empty diagram. Double-click it to start drawing.';
        target.dataset.previewState = 'empty';
        return;
    }
    for (const image of images) {
        image.hidden = false;
    }
    placeholder.textContent = '';
    target.dataset.previewState = 'loaded';
    const frame = frameOf(target);
    if (frame.style.minHeight !== '') {
        frame.style.minHeight = '';
    }
    const { fileId, revision } = readEmbed(target);
    const key = frameHeightKey(target, fileId, revision);
    const height = Math.round(frame.getBoundingClientRect().height);
    if (height > 0 && previewState.frameHeights.get(key) !== height) {
        previewState.frameHeights.set(key, height);
    }
}

function showFailure(target) {
    placeholderOf(target).textContent = 'Diagram preview unavailable';
    target.dataset.previewState = 'failed';
}

export function hydrateExcalidrawPreviews(rootNode) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') {
        throw new Error('hydrateExcalidrawPreviews expects a root node with querySelectorAll');
    }
    const requests = [];
    for (const target of rootNode.querySelectorAll(EMBED_SELECTOR)) {
        const { fileId, revision } = readEmbed(target);
        if (target.dataset.previewState !== 'idle') {
            continue;
        }
        target.dataset.previewState = 'loading';
        const reservedKey = frameHeightKey(target, fileId, revision);
        if (previewState.frameHeights.has(reservedKey)) {
            frameOf(target).style.minHeight = `${previewState.frameHeights.get(reservedKey)}px`;
        }
        const variants = EXCALIDRAW_PREVIEW_VARIANTS.map((variant) => fetchPreview(fileId, revision, variant));
        // A refresh to a newer revision may replace this request before it finishes.
        const isCurrent = () => target.dataset.fileRevision === String(revision) && target.dataset.previewState === 'loading';
        requests.push(Promise.all(variants)
            .then((results) => (isCurrent() ? showPreviews(target, results) : undefined))
            .catch((error) => {
                rethrowUnexpectedError(error);
                if (isCurrent()) {
                    showFailure(target);
                }
            }));
    }
    return Promise.all(requests);
}

// After a save, point every rendered copy of the diagram at its new revision and reload the previews.
export function refreshExcalidrawEmbeds(fileId, revision) {
    if (typeof fileId !== 'string' || fileId.length === 0) {
        throw new Error('refreshExcalidrawEmbeds requires fileId');
    }
    if (!Number.isInteger(revision) || revision < 1) {
        throw new Error('refreshExcalidrawEmbeds requires a positive integer revision');
    }
    const isSuperseded = (key) => key.startsWith(`${fileId}:`) && !key.startsWith(`${fileId}:${revision}:`);
    for (const key of Array.from(previewState.previews.keys()).filter(isSuperseded)) {
        previewState.previews.delete(key);
    }
    for (const key of Array.from(previewState.objectUrls.keys()).filter(isSuperseded)) {
        URL.revokeObjectURL(previewState.objectUrls.get(key));
        previewState.objectUrls.delete(key);
    }
    for (const target of document.querySelectorAll(`${EMBED_SELECTOR}[data-file-ref-id="${fileId}"]`)) {
        target.dataset.fileRevision = String(revision);
        target.dataset.previewState = 'idle';
        for (const variant of EXCALIDRAW_PREVIEW_VARIANTS) {
            imageOf(target, variant).hidden = true;
        }
        placeholderOf(target).textContent = 'Loading diagram...';
    }
    return hydrateExcalidrawPreviews(document);
}
