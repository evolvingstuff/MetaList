// Loads the vendored Excalidraw bundle (built by scripts/vendor/excalidraw) only when a diagram is opened.
import { ApplicationState } from '../application-state.js';

const EXCALIDRAW_VERSION = '0.18.1';
const BUNDLE_URL = `/static/js/vendor/excalidraw-${EXCALIDRAW_VERSION}.min.js`;
// Fonts and the stylesheet are served by MetaList; the bundle never falls back to a CDN.
const ASSET_PATH = `/static/js/vendor/excalidraw-${EXCALIDRAW_VERSION}-assets/`;
const STYLESHEET_ID = 'excalidraw-stylesheet';
const REQUIRED_EXPORTS = [
    'Excalidraw', 'MainMenu', 'createElement', 'createRoot', 'exportToSvg', 'getSceneVersion', 'restore', 'serializeAsJSON',
];

const loaderState = ApplicationState.createFields('excalidraw-loader', {
    loading: null,
});

function ensureStylesheet() {
    if (document.getElementById(STYLESHEET_ID) !== null) {
        return;
    }
    const link = document.createElement('link');
    link.id = STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.href = `${ASSET_PATH}excalidraw.css`;
    document.head.appendChild(link);
}

function requireBundleExports(bundle) {
    for (const name of REQUIRED_EXPORTS) {
        if (!(name in bundle)) {
            throw new Error(`Excalidraw bundle is missing export: ${name}`);
        }
    }
    return bundle;
}

export function loadExcalidraw() {
    if (loaderState.loading !== null) {
        return loaderState.loading;
    }
    window.EXCALIDRAW_ASSET_PATH = ASSET_PATH;
    ensureStylesheet();
    const loading = import(BUNDLE_URL).then(requireBundleExports, (error) => { // shockharness: ignore[EXC001] reason="the handler only resets state, then rethrows the error unchanged"
        // Allow a later attempt after a failed download (for example while offline).
        loaderState.loading = null;
        throw error;
    });
    loaderState.loading = loading;
    return loading;
}
