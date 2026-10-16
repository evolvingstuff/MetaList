import assert from 'node:assert/strict';
import test from 'node:test';

import {
    estimateDataUrlPayloadBytes,
    normalizeDataImageUrl,
    recompressDataImageUrlForEmbedding,
} from '../../app/static/js/modules/mode-manager/services/embedded-image-service.js';

function createDataUrlForBytes(mimeType, byteCount) {
    if (typeof mimeType !== 'string' || mimeType.length === 0) {
        throw new Error('createDataUrlForBytes expects mimeType string');
    }
    if (!Number.isInteger(byteCount) || byteCount <= 0) {
        throw new Error(`createDataUrlForBytes invalid byteCount: ${byteCount}`);
    }
    return `data:${mimeType};base64,${Buffer.alloc(byteCount).toString('base64')}`;
}

function installEmbeddedImageTestEnvironment(t, options) {
    if (!t || typeof t.after !== 'function') {
        throw new Error('installEmbeddedImageTestEnvironment expects test context');
    }
    if (options === null || typeof options !== 'object') {
        throw new Error('installEmbeddedImageTestEnvironment expects options object');
    }
    if (typeof options.toBlobSize !== 'function') {
        throw new Error('installEmbeddedImageTestEnvironment expects toBlobSize function');
    }

    const originalFetch = globalThis.fetch;
    const originalImage = globalThis.Image;
    const originalHtmlImageElement = globalThis.HTMLImageElement;
    const originalDocument = globalThis.document;
    const originalFileReader = globalThis.FileReader;
    const originalUrl = globalThis.URL;

    t.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.Image = originalImage;
        globalThis.HTMLImageElement = originalHtmlImageElement;
        globalThis.document = originalDocument;
        globalThis.FileReader = originalFileReader;
        globalThis.URL = originalUrl;
    });

    globalThis.fetch = async (dataUrl) => {
        const match = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl);
        assert.ok(match, 'expected data URL for fetch mock');
        const mimeType = match[1];
        const buffer = Buffer.from(match[2], 'base64');
        return {
            ok: true,
            async blob() {
                return new Blob([buffer], { type: mimeType });
            },
        };
    };

    class FakeImage {
        constructor() {
            this.naturalWidth = 2400;
            this.naturalHeight = 1600;
        }

        set src(value) {
            this._src = value;
            queueMicrotask(() => {
                this.onload();
            });
        }
    }

    class FakeFileReader {
        readAsDataURL(blob) {
            blob.arrayBuffer()
                .then((arrayBuffer) => {
                    const buffer = Buffer.from(arrayBuffer);
                    this.result = `data:${blob.type};base64,${buffer.toString('base64')}`;
                    this.onload();
                });
        }
    }

    globalThis.Image = FakeImage;
    globalThis.HTMLImageElement = FakeImage;
    globalThis.FileReader = FakeFileReader;
    globalThis.URL = {
        createObjectURL() {
            return 'blob:embedded-image-test';
        },
        revokeObjectURL() {},
    };
    globalThis.document = {
        createElement(tagName) {
            assert.equal(tagName, 'canvas');
            return {
                width: 0,
                height: 0,
                getContext(contextName) {
                    assert.equal(contextName, '2d');
                    return {
                        clearRect() {},
                        drawImage() {},
                    };
                },
                toBlob(callback, mimeType, quality) {
                    const byteCount = options.toBlobSize({
                        mimeType,
                        quality,
                        width: this.width,
                        height: this.height,
                    });
                    callback(new Blob([Buffer.alloc(byteCount)], { type: mimeType }));
                },
            };
        },
    };
}

test('recompressDataImageUrlForEmbedding returns recompressed data url when smaller', async (t) => {
    installEmbeddedImageTestEnvironment(t, {
        toBlobSize({ mimeType }) {
            if (mimeType === 'image/webp') {
                return 600;
            }
            return 700;
        },
    });

    const originalDataUrl = createDataUrlForBytes('image/png', 1800);
    const recompressedDataUrl = await recompressDataImageUrlForEmbedding(originalDataUrl);
    assert.ok(typeof recompressedDataUrl === 'string');
    assert.notEqual(recompressedDataUrl, originalDataUrl);
    assert.match(recompressedDataUrl, /^data:image\/webp;base64,/i);

    const originalBytes = estimateDataUrlPayloadBytes(originalDataUrl);
    const recompressedBytes = estimateDataUrlPayloadBytes(recompressedDataUrl);
    assert.equal(originalBytes, 1800);
    assert.equal(recompressedBytes, 600);
});

test('recompressDataImageUrlForEmbedding keeps normalized original when recompression is larger', async (t) => {
    installEmbeddedImageTestEnvironment(t, {
        toBlobSize() {
            return 900;
        },
    });

    const normalizedOriginalDataUrl = createDataUrlForBytes('image/png', 400);
    const [header, payload] = normalizedOriginalDataUrl.split(',');
    const spacedOriginalDataUrl = `${header},${payload.slice(0, 12)} \n ${payload.slice(12)}`;

    const recompressedDataUrl = await recompressDataImageUrlForEmbedding(spacedOriginalDataUrl);
    assert.equal(recompressedDataUrl, normalizeDataImageUrl(spacedOriginalDataUrl));
});
