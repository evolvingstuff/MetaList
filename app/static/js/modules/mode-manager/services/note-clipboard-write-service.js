import { rethrowUnexpectedError } from '../../expected-errors.js';
function normalizeClipboardText(value, fieldName) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string when provided`);
    }
    return value;
}

function resolveClipboardApi(clipboardApi) {
    if (clipboardApi !== undefined) {
        return clipboardApi;
    }
    if (typeof navigator === 'undefined') {
        return null;
    }
    return navigator.clipboard;
}

function resolveDocument(documentRef) {
    if (documentRef !== undefined) {
        return documentRef;
    }
    if (typeof document === 'undefined') {
        return null;
    }
    return document;
}

function resolveClipboardItemClass(clipboardItemClass) {
    if (clipboardItemClass !== undefined) {
        return clipboardItemClass;
    }
    if (typeof ClipboardItem === 'undefined') {
        return null;
    }
    return ClipboardItem;
}

function resolveBlobClass(blobClass) {
    if (blobClass !== undefined) {
        return blobClass;
    }
    if (typeof Blob === 'undefined') {
        return null;
    }
    return Blob;
}

function logClipboardFailure(logger, message, error) {
    if (!logger || typeof logger.logDebug !== 'function') {
        return;
    }
    const errorMessage = error && typeof error.message === 'string'
        ? error.message
        : String(error);
    logger.logDebug(message, { error: errorMessage }, logger.LogCategory?.EVENT);
}

function writeRichClipboardWithCopyEvent({ renderedHtml, renderedPlainText, documentRef, logger }) {
    if (!documentRef || typeof documentRef.addEventListener !== 'function') {
        return false;
    }
    if (typeof documentRef.removeEventListener !== 'function' || typeof documentRef.execCommand !== 'function') {
        return false;
    }

    let didSetClipboardData = false;
    const copyHandler = (event) => {
        if (!event.clipboardData || typeof event.clipboardData.setData !== 'function') {
            return;
        }
        event.clipboardData.setData('text/html', renderedHtml);
        event.clipboardData.setData('text/plain', renderedPlainText);
        if (typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        didSetClipboardData = true;
    };

    documentRef.addEventListener('copy', copyHandler);
    const commandSucceeded = documentRef.execCommand('copy');
    documentRef.removeEventListener('copy', copyHandler);
    return Boolean(commandSucceeded && didSetClipboardData);
}

function writePlainTextWithTextarea({ renderedPlainText, documentRef, logger }) {
    if (!renderedPlainText) {
        return false;
    }
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        return false;
    }
    if (!documentRef.body || typeof documentRef.body.appendChild !== 'function') {
        return false;
    }
    if (typeof documentRef.execCommand !== 'function') {
        return false;
    }

    const textarea = documentRef.createElement('textarea');
    textarea.value = renderedPlainText;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    documentRef.body.appendChild(textarea);
    textarea.select();
    const commandSucceeded = documentRef.execCommand('copy');
    documentRef.body.removeChild(textarea);
    return Boolean(commandSucceeded);
}

function renderedNoteToClipboardPayload(renderedNote) {
    if (renderedNote === null) {
        return {
            renderedHtml: null,
            renderedPlainText: null,
        };
    }
    if (!renderedNote || typeof renderedNote !== 'object') {
        throw new Error('renderedNote must be an object or null');
    }
    return {
        renderedHtml: normalizeClipboardText(renderedNote.html, 'renderedNote.html'),
        renderedPlainText: normalizeClipboardText(renderedNote.plain_text, 'renderedNote.plain_text'),
    };
}

export async function writeRenderedNoteToSystemClipboard({
    renderedHtml,
    renderedPlainText,
    clipboardApi,
    documentRef,
    clipboardItemClass,
    blobClass,
    logger,
}) {
    const html = normalizeClipboardText(renderedHtml, 'renderedHtml');
    const plainTextValue = normalizeClipboardText(renderedPlainText, 'renderedPlainText');
    if (html === null && plainTextValue === null) {
        return false;
    }

    const plainText = plainTextValue === null ? '' : plainTextValue;
    const resolvedClipboardApi = resolveClipboardApi(clipboardApi);
    const resolvedDocument = resolveDocument(documentRef);
    const ResolvedClipboardItem = resolveClipboardItemClass(clipboardItemClass);
    const ResolvedBlob = resolveBlobClass(blobClass);

    if (
        html
        && resolvedClipboardApi
        && typeof resolvedClipboardApi.write === 'function'
        && typeof ResolvedClipboardItem === 'function'
        && typeof ResolvedBlob === 'function'
    ) {
        const htmlBlob = new ResolvedBlob([html], { type: 'text/html' });
        const plainTextBlob = new ResolvedBlob([plainText], { type: 'text/plain' });
        const clipboardItem = new ResolvedClipboardItem({
            'text/html': htmlBlob,
            'text/plain': plainTextBlob,
        });
        const wroteClipboard = await resolvedClipboardApi.write([clipboardItem]).then(
            () => true,
            (error) => {
            rethrowUnexpectedError(error);
                logClipboardFailure(logger, 'Error copying rendered HTML to system clipboard', error);
                return false;
            },
        );
        if (wroteClipboard) {
            return true;
        }
    }

    if (html) {
        const wroteRichFallback = writeRichClipboardWithCopyEvent({
            renderedHtml: html,
            renderedPlainText: plainText,
            documentRef: resolvedDocument,
            logger,
        });
        if (wroteRichFallback) {
            return true;
        }
    }

    if (plainTextValue !== null && resolvedClipboardApi && typeof resolvedClipboardApi.writeText === 'function') {
        const wroteText = await resolvedClipboardApi.writeText(plainTextValue).then(
            () => true,
            (error) => {
            rethrowUnexpectedError(error);
                logClipboardFailure(logger, 'Error copying rendered text to system clipboard', error);
                return false;
            },
        );
        if (wroteText) {
            return true;
        }
    }

    if (plainTextValue !== null) {
        return writePlainTextWithTextarea({
            renderedPlainText: plainTextValue,
            documentRef: resolvedDocument,
            logger,
        });
    }

    return false;
}

export async function writeRenderedNotePromiseToSystemClipboard({
    renderedNotePromise,
    clipboardApi,
    documentRef,
    clipboardItemClass,
    blobClass,
    logger,
}) {
    if (!renderedNotePromise || typeof renderedNotePromise.then !== 'function') {
        throw new Error('renderedNotePromise must be a Promise');
    }

    const resolvedClipboardApi = resolveClipboardApi(clipboardApi);
    const ResolvedClipboardItem = resolveClipboardItemClass(clipboardItemClass);
    const ResolvedBlob = resolveBlobClass(blobClass);
    const payloadPromise = renderedNotePromise.then((renderedNote) => {
        return renderedNoteToClipboardPayload(renderedNote);
    });

    let clipboardWritePromise = Promise.resolve(false);
    if (
        resolvedClipboardApi
        && typeof resolvedClipboardApi.write === 'function'
        && typeof ResolvedClipboardItem === 'function'
        && typeof ResolvedBlob === 'function'
    ) {
        const htmlBlobPromise = payloadPromise.then((payload) => {
            const renderedHtml = payload.renderedHtml;
            const renderedPlainText = payload.renderedPlainText;
            if (renderedHtml === null && renderedPlainText === null) {
                throw new Error('Rendered note clipboard payload has no HTML or plain text');
            }
            const html = renderedHtml === null ? '' : renderedHtml;
            return new ResolvedBlob([html], { type: 'text/html' });
        });
        const plainTextBlobPromise = payloadPromise.then((payload) => {
            const plainText = payload.renderedPlainText === null ? '' : payload.renderedPlainText;
            return new ResolvedBlob([plainText], { type: 'text/plain' });
        });
        const clipboardItem = new ResolvedClipboardItem({
            'text/html': htmlBlobPromise,
            'text/plain': plainTextBlobPromise,
        });
        clipboardWritePromise = resolvedClipboardApi.write([clipboardItem]).then(
            () => true,
            (error) => {
            rethrowUnexpectedError(error);
                logClipboardFailure(logger, 'Error copying promised rendered HTML to system clipboard', error);
                return false;
            },
        );
    }

    const renderedNote = await renderedNotePromise;
    const payload = await payloadPromise;
    let didWrite = await clipboardWritePromise;
    if (!didWrite) {
        didWrite = await writeRenderedNoteToSystemClipboard({
            renderedHtml: payload.renderedHtml,
            renderedPlainText: payload.renderedPlainText,
            clipboardApi: resolvedClipboardApi,
            documentRef,
            clipboardItemClass,
            blobClass,
            logger,
        });
    }

    return {
        renderedNote,
        didWrite,
    };
}
