import assert from 'node:assert/strict';
import test from 'node:test';

function parseClassSelector(selector) {
    const match = /^\.([a-z0-9-]+)(?:\[data-file-ref-id(?:="([^"]+)")?\])?$/i.exec(selector);
    if (!match) {
        throw new Error(`Unsupported selector in file image preview test: ${selector}`);
    }
    return {
        className: match[1],
        requiresFileRefId: selector.includes('[data-file-ref-id'),
        exactFileRefId: typeof match[2] === 'string' ? match[2] : null,
    };
}

function elementMatchesSelector(element, selector) {
    const parsed = parseClassSelector(selector);
    if (!(element instanceof globalThis.HTMLElement)) {
        return false;
    }
    if (!element._classNames.has(parsed.className)) {
        return false;
    }
    if (!parsed.requiresFileRefId) {
        return true;
    }
    const fileRefId = element.dataset.fileRefId;
    if (typeof fileRefId !== 'string' || fileRefId.length === 0) {
        return false;
    }
    if (parsed.exactFileRefId !== null && fileRefId !== parsed.exactFileRefId) {
        return false;
    }
    return true;
}

function installPreviewTestDom(t) {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalUrl = globalThis.URL;
    const originalHTMLElement = globalThis.HTMLElement;
    const originalHtmlImageElement = globalThis.HTMLImageElement;
    const originalSessionStorage = globalThis.sessionStorage;
    const originalLocalStorage = globalThis.localStorage;

    function createStorage() {
        const entries = new Map();
        return {
            getItem(key) {
                return entries.has(key) ? entries.get(key) : null;
            },
            setItem(key, value) {
                entries.set(key, String(value));
            },
            removeItem(key) {
                entries.delete(key);
            },
            clear() {
                entries.clear();
            },
        };
    }

    class FakeElement {
        constructor(classNames = []) {
            this._classNames = new Set(classNames);
            this.children = [];
            this.dataset = {};
            this.textContent = '';
            this.hidden = false;
        }

        appendChild(child) {
            if (!(child instanceof FakeElement)) {
                throw new Error('appendChild expects FakeElement');
            }
            child.parentNode = this;
            this.children.push(child);
            return child;
        }

        querySelector(selector) {
            const matches = this.querySelectorAll(selector);
            return matches.length > 0 ? matches[0] : null;
        }

        querySelectorAll(selector) {
            const matches = [];
            for (const child of this.children) {
                if (elementMatchesSelector(child, selector)) {
                    matches.push(child);
                }
                matches.push(...child.querySelectorAll(selector));
            }
            return matches;
        }
    }

    class FakeImageElement extends FakeElement {
        constructor(classNames = []) {
            super(classNames);
            this.src = '';
        }
    }

    const documentRoot = new FakeElement();
    let objectUrlCounter = 0;

    globalThis.HTMLElement = FakeElement;
    globalThis.HTMLImageElement = FakeImageElement;
    globalThis.document = {
        querySelectorAll(selector) {
            return documentRoot.querySelectorAll(selector);
        },
    };
    globalThis.window = {
        addEventListener() {},
    };
    globalThis.sessionStorage = createStorage();
    globalThis.localStorage = createStorage();
    globalThis.URL = {
        createObjectURL() {
            objectUrlCounter += 1;
            return `blob:preview-${objectUrlCounter}`;
        },
        revokeObjectURL() {},
    };

    t.after(() => {
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
        globalThis.URL = originalUrl;
        globalThis.HTMLElement = originalHTMLElement;
        globalThis.HTMLImageElement = originalHtmlImageElement;
        globalThis.sessionStorage = originalSessionStorage;
        globalThis.localStorage = originalLocalStorage;
    });

    return {
        FakeElement,
        FakeImageElement,
        documentRoot,
    };
}

function buildImagePreviewTarget(FakeElement, FakeImageElement, fileRefId) {
    const target = new FakeElement(['note-file-image-embed']);
    target.dataset.fileRefId = fileRefId;
    target.dataset.previewState = 'idle';

    const frame = new FakeElement(['note-file-image-preview-frame']);
    const image = new FakeImageElement(['note-file-image-preview']);
    image.dataset.fileRefId = fileRefId;
    image.hidden = true;
    const placeholder = new FakeElement(['note-file-image-preview-placeholder']);
    placeholder.textContent = 'Loading image preview...';

    frame.appendChild(image);
    frame.appendChild(placeholder);
    target.appendChild(frame);

    return {
        target,
        image,
        placeholder,
    };
}

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

test('hydrateImageFilePreviews loads one authenticated image preview per file id and reuses it', async (t) => {
    const { FakeElement, FakeImageElement, documentRoot } = installPreviewTestDom(t);
    const { FilesAPI } = await import('../../app/static/js/modules/api-client.js');
    const { hydrateImageFilePreviews } = await import('../../app/static/js/modules/mode-manager/services/file-image-preview-service.js');

    const originalDownloadFile = FilesAPI.downloadFile;
    t.after(() => {
        FilesAPI.downloadFile = originalDownloadFile;
    });

    let downloadCount = 0;
    FilesAPI.downloadFile = async (fileId) => {
        downloadCount += 1;
        return {
            blob: new Blob([Buffer.from(fileId)], { type: 'image/png' }),
            filename: 'photo.png',
        };
    };

    const first = buildImagePreviewTarget(FakeElement, FakeImageElement, 'file-1');
    const second = buildImagePreviewTarget(FakeElement, FakeImageElement, 'file-1');
    const notesContainer = new FakeElement();
    notesContainer.appendChild(first.target);
    notesContainer.appendChild(second.target);
    documentRoot.appendChild(notesContainer);

    hydrateImageFilePreviews(notesContainer);
    await flushAsyncWork();

    assert.equal(downloadCount, 1);
    assert.equal(first.target.dataset.previewState, 'loaded');
    assert.equal(second.target.dataset.previewState, 'loaded');
    assert.equal(first.image.hidden, false);
    assert.equal(second.image.hidden, false);
    assert.equal(first.image.src, 'blob:preview-1');
    assert.equal(second.image.src, 'blob:preview-1');
    assert.equal(first.placeholder.textContent, '');
    assert.equal(second.placeholder.textContent, '');

    hydrateImageFilePreviews(notesContainer);
    await flushAsyncWork();

    assert.equal(downloadCount, 1);
});

test('preview hydration propagates internal defects and clears pending requests for retry', async (t) => {
    const { FakeElement, FakeImageElement, documentRoot } = installPreviewTestDom(t);
    const { FilesAPI } = await import('../../app/static/js/modules/api-client.js');
    const { hydrateImageFilePreviews } = await import('../../app/static/js/modules/mode-manager/services/file-image-preview-service.js');
    const original = FilesAPI.downloadFile;
    t.after(() => { FilesAPI.downloadFile = original; });
    const fixture = buildImagePreviewTarget(FakeElement, FakeImageElement, 'internal-defect');
    documentRoot.appendChild(fixture.target);
    const defect = new TypeError('renderer invariant');
    FilesAPI.downloadFile = async () => { throw defect; };
    await assert.rejects(hydrateImageFilePreviews(documentRoot), error => error === defect);
    assert.equal(fixture.target.dataset.previewState, 'loading');
    FilesAPI.downloadFile = async () => ({blob: new Blob(['png'], {type: 'image/png'}), filename: 'retry.png'});
    await hydrateImageFilePreviews(documentRoot);
    assert.equal(fixture.target.dataset.previewState, 'loaded');
});

test('preview hydration handles only expected request failures', async (t) => {
    const { FakeElement, FakeImageElement, documentRoot } = installPreviewTestDom(t);
    const { FilesAPI } = await import('../../app/static/js/modules/api-client.js');
    const { HttpRequestError } = await import('../../app/static/js/modules/expected-errors.js');
    const { hydrateImageFilePreviews } = await import('../../app/static/js/modules/mode-manager/services/file-image-preview-service.js');
    const original = FilesAPI.downloadFile;
    t.after(() => { FilesAPI.downloadFile = original; });
    const fixture = buildImagePreviewTarget(FakeElement, FakeImageElement, 'expected-failure');
    documentRoot.appendChild(fixture.target);
    FilesAPI.downloadFile = async () => { throw new HttpRequestError('Image unavailable'); };
    await hydrateImageFilePreviews(documentRoot);
    assert.equal(fixture.target.dataset.previewState, 'failed');
});
