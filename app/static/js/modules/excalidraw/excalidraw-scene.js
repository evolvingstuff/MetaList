// Pure helpers for Excalidraw scene files stored as MetaList attachments.
import { UserInputRejected } from '../expected-errors.js';

export const EXCALIDRAW_MIME_TYPE = 'application/vnd.excalidraw+json';
export const EXCALIDRAW_FILENAME = 'Diagram.excalidraw';
export const EXCALIDRAW_AUTOSAVE_DELAY_MS = 2000;
export const EXCALIDRAW_PREVIEW_VARIANTS = ['light', 'dark'];
const EXPORT_PADDING = 16;
const DEFAULT_BACKGROUNDS = ['#ffffff', '#fff', 'white', 'transparent'];
// The Excalidraw scene file format version a new drawing is written in.
const EXCALIDRAW_SCENE_FORMAT_VERSION = 2;

export function buildEmptySceneJson() {
    return JSON.stringify({
        type: 'excalidraw',
        version: EXCALIDRAW_SCENE_FORMAT_VERSION,
        source: 'MetaList',
        elements: [],
        appState: { viewBackgroundColor: '#ffffff' },
        files: {},
    });
}

export function parseSceneJson(sceneText) {
    if (typeof sceneText !== 'string') {
        throw new Error('parseSceneJson requires scene text');
    }
    let scene;
    try {
        scene = JSON.parse(sceneText);
    } catch (error) {
        if (!(error instanceof SyntaxError)) {
            throw error;
        }
        throw new UserInputRejected('This file is not a valid Excalidraw diagram (it is not JSON).', { cause: error });
    }
    if (scene === null || typeof scene !== 'object' || scene.type !== 'excalidraw' || !Array.isArray(scene.elements)) {
        throw new UserInputRejected('This file is not a valid Excalidraw diagram.');
    }
    return scene;
}

// Same as Excalidraw's getSceneVersion: every element edit increments that element's version.
export function computeSceneVersion(elements) {
    if (!Array.isArray(elements)) {
        throw new Error('computeSceneVersion requires the elements array');
    }
    let version = 0;
    for (const sceneElement of elements) {
        if (!Number.isInteger(sceneElement.version)) {
            throw new Error('Excalidraw element is missing its integer version');
        }
        version += sceneElement.version;
    }
    return version;
}

// Changes Excalidraw reports on every pointer move are ignored unless drawing content changed.
export function sceneFingerprint(sceneVersion, files) {
    if (!Number.isInteger(sceneVersion) || sceneVersion < 0) {
        throw new Error('sceneFingerprint requires a non-negative integer scene version');
    }
    if (files === null || typeof files !== 'object') {
        throw new Error('sceneFingerprint requires the files map');
    }
    return `${sceneVersion}:${Object.keys(files).sort().join(',')}`;
}

export function previewExportAppState(sceneAppState, variant) {
    if (sceneAppState === null || typeof sceneAppState !== 'object') {
        throw new Error('previewExportAppState requires the scene appState');
    }
    if (!EXCALIDRAW_PREVIEW_VARIANTS.includes(variant)) {
        throw new Error(`Unknown preview variant: ${variant}`);
    }
    // Previews are transparent so they sit on the note's own background, unless the drawing
    // was given a canvas colour of its own.
    const background = String(sceneAppState.viewBackgroundColor).toLowerCase();
    return {
        ...sceneAppState,
        exportBackground: !DEFAULT_BACKGROUNDS.includes(background),
        exportWithDarkMode: variant === 'dark',
        exportPadding: EXPORT_PADDING,
    };
}

export function currentPreviewVariant(rootElement) {
    if (!(rootElement instanceof Element)) {
        throw new Error('currentPreviewVariant requires the document element');
    }
    return rootElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
