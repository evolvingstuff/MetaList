import { ApplicationState } from '../../application-state.js';
import { HttpRequestError, rethrowUnexpectedError } from '../../expected-errors.js';
import { buildSessionHeaders } from '../../session-auth.js';


const moduleState = ApplicationState.createFields('remote-image-proxy-service', {
    objectUrlCache: new Map(),
    pendingRequests: new Map(),

    cleanupRegistered: false,
});
const REGISTRATION_PATH = '/api2/remote-images/registrations';
const MAX_REGISTRATION_IMAGES = 100;
const REMOTE_IMAGE_SOURCE_PATTERN = /^https?:\/\//i;
const PROXY_PATH_PATTERN = /^\/api2\/remote-images\/[A-Za-z0-9_-]{32}$/;

function requireQueryableRoot(rootNode, functionName) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') {
        throw new Error(`${functionName} expects root node with querySelectorAll`);
    }
}

function isRemoteImageSource(source) {
    return typeof source === 'string' && REMOTE_IMAGE_SOURCE_PATTERN.test(source.trim());
}

export async function prepareRemoteImageElementsForEditing(rootNode) {
    requireQueryableRoot(rootNode, 'prepareRemoteImageElementsForEditing');
    const candidates = Array.from(rootNode.querySelectorAll('img[src]')).filter((image) => {
        if (!(image instanceof HTMLImageElement)) {
            throw new Error('Remote editor image target must be an HTMLImageElement');
        }
        return isRemoteImageSource(image.getAttribute('src'));
    });
    if (candidates.length === 0) {
        return false;
    }

    const sourceUrls = Array.from(new Set(candidates.map((image) => image.getAttribute('src').trim())));
    if (sourceUrls.length > MAX_REGISTRATION_IMAGES) {
        throw new Error(`A paste may contain at most ${MAX_REGISTRATION_IMAGES} remote images`);
    }
    const response = await fetch(REGISTRATION_PATH, {
        method: 'POST',
        headers: buildSessionHeaders(true),
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ source_urls: sourceUrls }),
    });
    if (!response || response.ok !== true) {
        throw new HttpRequestError('Remote image proxy registration failed');
    }
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.images) || payload.images.length !== sourceUrls.length) {
        throw new Error('Remote image proxy registration returned an invalid image list');
    }

    const proxyPathBySource = new Map();
    for (let index = 0; index < payload.images.length; index += 1) {
        const entry = payload.images[index];
        if (!entry || entry.source_url !== sourceUrls[index]) {
            throw new Error('Remote image proxy registration returned an unexpected source URL');
        }
        if (typeof entry.proxy_path !== 'string' || !PROXY_PATH_PATTERN.test(entry.proxy_path)) {
            throw new Error('Remote image proxy registration returned an invalid proxy path');
        }
        proxyPathBySource.set(entry.source_url, entry.proxy_path);
    }

    for (const image of candidates) {
        const sourceUrl = image.getAttribute('src').trim();
        const proxyPath = proxyPathBySource.get(sourceUrl);
        if (typeof proxyPath !== 'string') {
            throw new Error('Remote image proxy registration omitted a requested source URL');
        }
        image.dataset.remoteImageSourceUrl = sourceUrl;
        image.dataset.remoteImageProxySrc = proxyPath;
        image.removeAttribute('src');
    }
    return true;
}

export function restoreRemoteImageElementsForStorage(rootNode) {
    requireQueryableRoot(rootNode, 'restoreRemoteImageElementsForStorage');
    const images = Array.from(rootNode.querySelectorAll('img[data-remote-image-source-url]'));
    for (const image of images) {
        if (!(image instanceof HTMLImageElement)) {
            throw new Error('Stored remote image target must be an HTMLImageElement');
        }
        const sourceUrl = image.dataset.remoteImageSourceUrl;
        if (!isRemoteImageSource(sourceUrl)) {
            throw new Error('Stored remote image target has an invalid original source URL');
        }
        image.setAttribute('src', sourceUrl.trim());
        delete image.dataset.remoteImageSourceUrl;
        delete image.dataset.remoteImageProxySrc;
        delete image.dataset.remoteImageProxyState;
    }
}

function ensureCleanupHandlerRegistered() {
    if (moduleState.cleanupRegistered) {
        return;
    }
    if (typeof window === 'undefined') {
        return;
    }
    window.addEventListener('beforeunload', () => {
        for (const objectUrl of moduleState.objectUrlCache.values()) {
            URL.revokeObjectURL(objectUrl);
        }
        if (moduleState.objectUrlCache.size > 0) moduleState.objectUrlCache.clear();
        if (moduleState.pendingRequests.size > 0) moduleState.pendingRequests.clear();
    });
    moduleState.cleanupRegistered = true;
}

function getTargets(rootNode) {
    requireQueryableRoot(rootNode, 'hydrateRemoteImageProxies');
    return Array.from(rootNode.querySelectorAll('img[data-remote-image-proxy-src]'));
}

function applyObjectUrl(target, objectUrl) {
    if (!(target instanceof HTMLImageElement)) {
        throw new Error('Remote image proxy target must be an HTMLImageElement');
    }
    if (typeof objectUrl !== 'string' || objectUrl.length === 0) {
        throw new Error('Remote image proxy object URL must be non-empty');
    }
    target.src = objectUrl;
    target.dataset.remoteImageProxyState = 'loaded';
}

function applyFailure(target) {
    if (!(target instanceof HTMLImageElement)) {
        throw new Error('Remote image proxy target must be an HTMLImageElement');
    }
    target.removeAttribute('src');
    target.dataset.remoteImageProxyState = 'failed';
}

async function fetchObjectUrl(proxyPath) {
    if (typeof proxyPath !== 'string' || !proxyPath.startsWith('/api2/remote-images/')) {
        throw new Error('Remote image proxy path is invalid');
    }
    if (moduleState.objectUrlCache.has(proxyPath)) {
        return moduleState.objectUrlCache.get(proxyPath);
    }
    if (moduleState.pendingRequests.has(proxyPath)) {
        return await moduleState.pendingRequests.get(proxyPath);
    }

    ensureCleanupHandlerRegistered();
    const request = fetch(proxyPath, {
        method: 'GET',
        headers: buildSessionHeaders(false),
        credentials: 'same-origin',
        cache: 'no-store',
    })
        .then(async (response) => {
            if (!response || response.ok !== true) {
                throw new HttpRequestError('Remote image proxy request failed');
            }
            const blob = await response.blob();
            if (!(blob instanceof Blob)) {
                throw new Error('Remote image proxy response missing blob');
            }
            const mimeType = typeof blob.type === 'string' ? blob.type.toLowerCase() : '';
            if (!mimeType.startsWith('image/')) {
                throw new Error('Remote image proxy response is not an image');
            }
            const objectUrl = URL.createObjectURL(blob);
            moduleState.objectUrlCache.set(proxyPath, objectUrl);
            moduleState.pendingRequests.delete(proxyPath);
            return objectUrl;
        })
        .catch((error) => {
            moduleState.pendingRequests.delete(proxyPath);
            throw error;
        });
    moduleState.pendingRequests.set(proxyPath, request);
    return await request;
}

function matchingDocumentTargets(proxyPath) {
    return Array.from(document.querySelectorAll('img[data-remote-image-proxy-src]')).filter(
        (target) => target.dataset.remoteImageProxySrc === proxyPath,
    );
}

export function hydrateRemoteImageProxies(rootNode) {
    const targets = getTargets(rootNode);
    const proxyPaths = new Set();
    for (const target of targets) {
        if (!(target instanceof HTMLImageElement)) {
            throw new Error('Remote image proxy target must be an HTMLImageElement');
        }
        const proxyPath = target.dataset.remoteImageProxySrc;
        if (typeof proxyPath !== 'string' || proxyPath.length === 0) {
            throw new Error('Remote image proxy target is missing its proxy path');
        }
        if (target.dataset.remoteImageProxyState === 'loaded') {
            continue;
        }
        target.dataset.remoteImageProxyState = 'loading';
        proxyPaths.add(proxyPath);
    }

    const requests = [];
    for (const proxyPath of proxyPaths) {
        requests.push(fetchObjectUrl(proxyPath)
            .then((objectUrl) => {
                for (const target of matchingDocumentTargets(proxyPath)) {
                    applyObjectUrl(target, objectUrl);
                }
            })
            .catch((error) => {
            rethrowUnexpectedError(error);
                for (const target of matchingDocumentTargets(proxyPath)) {
                    applyFailure(target);
                }
            }));
    }
    return Promise.all(requests);
}
