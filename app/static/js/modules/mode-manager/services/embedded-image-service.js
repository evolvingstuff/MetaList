import { HttpRequestError } from '../../expected-errors.js';
import { CONFIG } from '../../config.js';

function getPastePositiveIntegerConfig(key) {
    if (typeof key !== 'string' || key.length === 0) {
        throw new Error('getPastePositiveIntegerConfig expects non-empty key');
    }
    if (!CONFIG || !CONFIG.PASTE) {
        throw new Error('CONFIG.PASTE is required for image embedding');
    }
    const value = CONFIG.PASTE[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new Error(`CONFIG.PASTE.${key} must be a positive integer`);
    }
    return value;
}

export function getMaxPasteDataImageBytes() {
    return getPastePositiveIntegerConfig('MAX_DATA_IMAGE_BYTES');
}

export function getEmbedTargetImageBytes() {
    const targetBytes = getPastePositiveIntegerConfig('EMBED_TARGET_IMAGE_BYTES');
    const maxBytes = getMaxPasteDataImageBytes();
    if (targetBytes > maxBytes) {
        throw new Error(
            `CONFIG.PASTE.EMBED_TARGET_IMAGE_BYTES (${targetBytes}) cannot exceed CONFIG.PASTE.MAX_DATA_IMAGE_BYTES (${maxBytes})`,
        );
    }
    return targetBytes;
}

export function getEmbedMaxDimensionPx() {
    return getPastePositiveIntegerConfig('EMBED_MAX_DIMENSION_PX');
}

export function getMaxClipboardImageBytes() {
    return getPastePositiveIntegerConfig('MAX_CLIPBOARD_IMAGE_BYTES');
}

export function normalizeDataImageUrl(dataUrl) {
    if (typeof dataUrl !== 'string') {
        throw new Error('normalizeDataImageUrl expects string input');
    }
    const trimmed = dataUrl.trim();
    const commaIndex = trimmed.indexOf(',');
    if (commaIndex < 0) {
        return trimmed;
    }
    const header = trimmed.slice(0, commaIndex + 1);
    const payload = trimmed.slice(commaIndex + 1).replace(/\s+/g, '');
    return `${header}${payload}`;
}

export function estimateDataUrlPayloadBytes(dataUrl) {
    if (typeof dataUrl !== 'string') {
        throw new Error('estimateDataUrlPayloadBytes expects string input');
    }
    const normalized = normalizeDataImageUrl(dataUrl);
    const commaIndex = normalized.indexOf(',');
    if (commaIndex < 0) {
        return null;
    }
    const payload = normalized.slice(commaIndex + 1);
    if (payload.length === 0) {
        return 0;
    }
    let paddingBytes = 0;
    if (payload.endsWith('==')) {
        paddingBytes = 2;
    } else if (payload.endsWith('=')) {
        paddingBytes = 1;
    }
    const estimated = Math.floor((payload.length * 3) / 4) - paddingBytes;
    if (estimated < 0) {
        return null;
    }
    return estimated;
}

export function readBlobAsDataUrl(blob) {
    if (!(blob instanceof Blob)) {
        throw new Error('readBlobAsDataUrl expects Blob');
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => {
            reject(new Error('Failed reading image blob as data URL'));
        };
        reader.onload = () => {
            if (typeof reader.result !== 'string') {
                reject(new Error('Unexpected FileReader result type'));
                return;
            }
            resolve(reader.result);
        };
        reader.readAsDataURL(blob);
    });
}

function loadImageElementFromBlob(blob) {
    if (!(blob instanceof Blob)) {
        throw new Error('loadImageElementFromBlob expects Blob');
    }
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(blob);
        const image = new Image();

        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            if (!Number.isFinite(image.naturalWidth) || !Number.isFinite(image.naturalHeight)) {
                reject(new Error('Loaded image has invalid dimensions'));
                return;
            }
            if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
                reject(new Error('Loaded image has zero dimensions'));
                return;
            }
            resolve(image);
        };

        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Failed decoding embedded image'));
        };

        image.src = objectUrl;
    });
}

function computeScaledDimensions(sourceWidth, sourceHeight, maxDimensionPx) {
    if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) {
        throw new Error(`computeScaledDimensions invalid sourceWidth: ${sourceWidth}`);
    }
    if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) {
        throw new Error(`computeScaledDimensions invalid sourceHeight: ${sourceHeight}`);
    }
    if (!Number.isFinite(maxDimensionPx) || maxDimensionPx <= 0) {
        throw new Error(`computeScaledDimensions invalid maxDimensionPx: ${maxDimensionPx}`);
    }

    const largest = Math.max(sourceWidth, sourceHeight);
    if (largest <= maxDimensionPx) {
        return {
            width: Math.floor(sourceWidth),
            height: Math.floor(sourceHeight),
        };
    }

    const scale = maxDimensionPx / largest;
    return {
        width: Math.max(1, Math.floor(sourceWidth * scale)),
        height: Math.max(1, Math.floor(sourceHeight * scale)),
    };
}

function renderImageToBlob(sourceImage, width, height, mimeType, quality) {
    if (!(sourceImage instanceof HTMLImageElement)) {
        throw new Error('renderImageToBlob expects HTMLImageElement');
    }
    if (!Number.isFinite(width) || width <= 0) {
        throw new Error(`renderImageToBlob invalid width: ${width}`);
    }
    if (!Number.isFinite(height) || height <= 0) {
        throw new Error(`renderImageToBlob invalid height: ${height}`);
    }
    if (typeof mimeType !== 'string' || mimeType.length === 0) {
        throw new Error('renderImageToBlob expects mimeType');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Canvas 2D context unavailable for image compression');
    }

    context.clearRect(0, 0, width, height);
    context.drawImage(sourceImage, 0, 0, width, height);

    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (!(blob instanceof Blob)) {
                    reject(new Error(`Canvas export failed for ${mimeType}`));
                    return;
                }
                resolve(blob);
            },
            mimeType,
            quality,
        );
    });
}

export async function compressImageBlobForEmbedding(blob) {
    if (!(blob instanceof Blob)) {
        throw new Error('compressImageBlobForEmbedding expects Blob');
    }
    if (typeof blob.size !== 'number' || blob.size <= 0) {
        throw new Error(`Embedded image has invalid size: ${blob.size}`);
    }

    const maxClipboardBytes = getMaxClipboardImageBytes();
    if (blob.size > maxClipboardBytes) {
        return null;
    }

    const sourceImage = await loadImageElementFromBlob(blob);
    const maxDimensionPx = getEmbedMaxDimensionPx();
    const targetBytes = getEmbedTargetImageBytes();
    const hardMaxBytes = getMaxPasteDataImageBytes();
    const initialSize = computeScaledDimensions(sourceImage.naturalWidth, sourceImage.naturalHeight, maxDimensionPx);

    const encodePlans = [
        { mimeType: 'image/webp', qualities: [0.82, 0.72, 0.62, 0.52, 0.42] },
        { mimeType: 'image/jpeg', qualities: [0.82, 0.72, 0.62, 0.52] },
    ];

    let bestBlob = null;
    let planIndex = 0;
    while (planIndex < encodePlans.length) {
        const plan = encodePlans[planIndex];
        let width = initialSize.width;
        let height = initialSize.height;

        while (true) {
            let qualityIndex = 0;
            while (qualityIndex < plan.qualities.length) {
                const quality = plan.qualities[qualityIndex];
                const candidate = await renderImageToBlob(sourceImage, width, height, plan.mimeType, quality);

                if (bestBlob === null || candidate.size < bestBlob.size) {
                    bestBlob = candidate;
                }
                if (candidate.size <= targetBytes) {
                    return candidate;
                }

                qualityIndex += 1;
            }

            if (Math.max(width, height) <= 512) {
                break;
            }
            width = Math.max(1, Math.floor(width * 0.85));
            height = Math.max(1, Math.floor(height * 0.85));
        }

        planIndex += 1;
    }

    if (bestBlob !== null && bestBlob.size <= hardMaxBytes) {
        return bestBlob;
    }

    return null;
}

export async function imageBlobToEmbeddedDataUrl(blob) {
    const compressedBlob = await compressImageBlobForEmbedding(blob);
    if (!(compressedBlob instanceof Blob)) {
        return null;
    }
    const dataUrl = await readBlobAsDataUrl(compressedBlob);
    const payloadBytes = estimateDataUrlPayloadBytes(dataUrl);
    const maxBytes = getMaxPasteDataImageBytes();
    if (payloadBytes === null) {
        throw new Error('Compressed image data URL missing payload bytes');
    }
    if (payloadBytes > maxBytes) {
        throw new Error(
            `Compressed image exceeds MAX_DATA_IMAGE_BYTES: ${payloadBytes} > ${maxBytes}`,
        );
    }
    return dataUrl;
}

async function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
        throw new Error('dataUrlToBlob expects non-empty dataUrl');
    }
    if (typeof fetch !== 'function') {
        throw new Error('fetch is required for data URL decoding');
    }
    const response = await fetch(dataUrl);
    if (!response || response.ok !== true) {
        throw new HttpRequestError('Failed decoding embedded data image URL');
    }
    const blob = await response.blob();
    if (!(blob instanceof Blob)) {
        throw new Error('Decoded data image did not produce a Blob');
    }
    return blob;
}

export async function recompressDataImageUrlForEmbedding(dataUrl) {
    if (typeof dataUrl !== 'string') {
        throw new Error('recompressDataImageUrlForEmbedding expects dataUrl string');
    }
    const normalizedDataUrl = normalizeDataImageUrl(dataUrl);
    const originalPayloadBytes = estimateDataUrlPayloadBytes(normalizedDataUrl);
    if (originalPayloadBytes === null) {
        throw new Error('Input data image URL missing payload bytes');
    }

    const sourceBlob = await dataUrlToBlob(normalizedDataUrl);
    const recompressedBlob = await compressImageBlobForEmbedding(sourceBlob);
    if (!(recompressedBlob instanceof Blob)) {
        return null;
    }

    const recompressedDataUrl = await readBlobAsDataUrl(recompressedBlob);
    const recompressedPayloadBytes = estimateDataUrlPayloadBytes(recompressedDataUrl);
    if (recompressedPayloadBytes === null) {
        throw new Error('Recompressed data image URL missing payload bytes');
    }

    const maxBytes = getMaxPasteDataImageBytes();
    if (recompressedPayloadBytes > maxBytes) {
        if (originalPayloadBytes <= maxBytes) {
            return normalizedDataUrl;
        }
        return null;
    }

    if (originalPayloadBytes <= maxBytes && recompressedPayloadBytes >= originalPayloadBytes) {
        return normalizedDataUrl;
    }

    return recompressedDataUrl;
}
