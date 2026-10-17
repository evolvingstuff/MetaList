// Full-screen Excalidraw editor for diagrams attached to notes as .excalidraw files.
// Changes autosave after 2 seconds of inactivity; Done (or Ctrl/Cmd+Enter) saves, renders the
// light and dark previews shown in view mode, and closes. Escape belongs to Excalidraw.
// The server snapshots the diagram when the editor opens, so the whole session is one undo
// step and Discard can restore exactly what was there.
import { ApplicationState } from '../application-state.js';
import { FilesAPI } from '../api-client.js';
import { settleResult } from '../async-result.js';
import { ErrorHandler } from '../error-handler.js';
import { FileRevisionConflictError, UserInputRejected } from '../expected-errors.js';
import { AUTOSAVE_STATUS, createAutosaveController } from './excalidraw-autosave.js';
import { isExcalidrawEditorOpen, setExcalidrawEditorOpen } from './excalidraw-editor-state.js';
import { loadExcalidraw } from './excalidraw-loader.js';
import { refreshExcalidrawEmbeds } from './excalidraw-preview-service.js';
import { MS_PER_SECOND } from '../time-units.js';
import {
    EXCALIDRAW_AUTOSAVE_DELAY_MS,
    EXCALIDRAW_MIME_TYPE,
    EXCALIDRAW_PREVIEW_VARIANTS,
    computeSceneVersion,
    currentPreviewVariant,
    parseSceneJson,
    previewExportAppState,
    sceneFingerprint,
} from './excalidraw-scene.js';

const STATUS_TEXT = Object.freeze({
    [AUTOSAVE_STATUS.SAVED]: 'All changes saved',
    [AUTOSAVE_STATUS.UNSAVED]: 'Unsaved changes',
    [AUTOSAVE_STATUS.SAVING]: 'Saving…',
    [AUTOSAVE_STATUS.ERROR]: 'Could not save. Retrying…',
    [AUTOSAVE_STATUS.CONFLICT]: 'This diagram was changed in another window. Close the editor and reopen the diagram to continue.',
});
const DISCARD_CONFIRM_MS = 4000;
const EDITOR_START_TIMEOUT_MS = 10000;
const EDITOR_START_POLL_MS = 25;
const UNDO_HISTORY_PROBLEM_BANNER_SECONDS = 8;
const DIAGRAM_SAVE_PROBLEM_BANNER_SECONDS = 10;

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== null) {
        node.textContent = text;
    }
    return node;
}

function buildOverlay(filename) {
    const overlay = element('section', 'excalidraw-editor-overlay', null);
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `Diagram editor: ${filename}`);
    const bar = element('header', 'excalidraw-editor-bar', null);
    bar.append(
        element('span', 'excalidraw-editor-title', 'Diagram'),
        element('span', 'excalidraw-editor-status', STATUS_TEXT[AUTOSAVE_STATUS.SAVED]),
        element('button', 'excalidraw-editor-discard', 'Discard changes'),
        element('button', 'excalidraw-editor-done', 'Done'),
    );
    for (const button of bar.querySelectorAll('button')) {
        button.type = 'button';
    }
    bar.querySelector('.excalidraw-editor-status').setAttribute('aria-live', 'polite');
    bar.querySelector('.excalidraw-editor-done').title = 'Save and close (Ctrl/Cmd+Enter)';
    overlay.append(bar, element('div', 'excalidraw-editor-canvas', null));
    return overlay;
}

function overlayPart(overlay, selector) {
    const part = overlay.querySelector(selector);
    if (!(part instanceof HTMLElement)) {
        throw new Error(`Excalidraw editor overlay is missing ${selector}`);
    }
    return part;
}

async function renderPreviews(bundle, scene) {
    const previews = {};
    for (const variant of EXCALIDRAW_PREVIEW_VARIANTS) {
        const appState = previewExportAppState(scene.appState, variant);
        const svg = await bundle.exportToSvg({
            elements: scene.elements,
            appState,
            files: scene.files,
            exportPadding: appState.exportPadding,
        });
        previews[variant] = new XMLSerializer().serializeToString(svg);
    }
    return previews;
}

function toSaveResult(settled) {
    if (settled.ok) {
        return { ok: true };
    }
    return { ok: false, conflict: settled.error instanceof FileRevisionConflictError };
}

// One open editor. Resource handles (the Excalidraw API and React root) stay in this closure;
// the session's own progress lives in ApplicationState.
function startEditorSession(setup) {
    const { bundle, fileId, hostNoteId, sessionId, isNewDiagram, filename, restoredScene, onClosed } = setup;
    const session = ApplicationState.createFields('excalidraw-editor-session', {
        revision: setup.revision,
        lastFingerprint: null,
        discardArmed: false,
        discardTimer: null,
        finishing: false,
        closed: false,
    });
    const overlay = buildOverlay(filename);
    const statusElement = overlayPart(overlay, '.excalidraw-editor-status');
    const discardButton = overlayPart(overlay, '.excalidraw-editor-discard');
    const buttons = Array.from(overlay.querySelectorAll('.excalidraw-editor-bar button'));
    const handles = { api: null, root: null };
    Object.seal(handles);

    const showStatus = (text) => {
        statusElement.textContent = text;
    };
    const setButtonsDisabled = (isDisabled) => {
        for (const button of buttons) {
            button.disabled = isDisabled;
        }
    };
    const currentScene = () => ({
        elements: handles.api.getSceneElements(),
        appState: handles.api.getAppState(),
        files: handles.api.getFiles(),
    });

    async function writeSceneText(text) {
        const blob = new Blob([text], { type: EXCALIDRAW_MIME_TYPE });
        const settled = await settleResult(() => FilesAPI.replaceFileContent(fileId, blob, filename, session.revision));
        if (settled.ok) {
            const nextRevision = settled.value.content_revision;
            if (nextRevision !== session.revision + 1) {
                throw new Error(`Unexpected diagram revision after save: ${nextRevision}`);
            }
            session.revision = nextRevision;
        }
        return toSaveResult(settled);
    }

    async function storePreviews(scene) {
        const previews = await renderPreviews(bundle, scene);
        return toSaveResult(await settleResult(() => FilesAPI.storeFilePreviews(fileId, previews, session.revision)));
    }

    const controller = createAutosaveController({
        delayMs: EXCALIDRAW_AUTOSAVE_DELAY_MS,
        save: () => {
            const scene = currentScene();
            return writeSceneText(bundle.serializeAsJSON(scene.elements, scene.appState, scene.files, 'local'));
        },
        schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
        cancel: (timer) => window.clearTimeout(timer),
        onStatus: (status) => showStatus(STATUS_TEXT[status]),
    });

    function handleSceneChange(elements, appState, files) {
        if (session.finishing) {
            return;
        }
        const fingerprint = sceneFingerprint(computeSceneVersion(elements), files);
        if (fingerprint === session.lastFingerprint) {
            return;
        }
        const isInitialReport = session.lastFingerprint === null;
        session.lastFingerprint = fingerprint;
        // Excalidraw reports the scene once when it mounts; that is not an edit.
        if (!isInitialReport) {
            controller.noteChange();
        }
    }

    function handleBeforeUnload(event) {
        if (controller.isDirty || controller.status === AUTOSAVE_STATUS.SAVING) {
            event.preventDefault();
            event.returnValue = '';
        }
    }

    // Later saves by another window move the diagram past this editor's own revision.
    function adoptRevision(revision) {
        if (revision !== session.revision) {
            session.revision = revision;
        }
    }

    // Done ends the server session, which records it as one undo step when it changed the diagram.
    async function endSession() {
        const settled = await settleResult(
            () => FilesAPI.finishEditSession(fileId, sessionId, hostNoteId, session.revision, isNewDiagram),
        );
        if (!settled.ok) {
            ErrorHandler.showErrorBanner('The diagram is saved, but this edit could not be added to undo history.', 'error', UNDO_HISTORY_PROBLEM_BANNER_SECONDS * MS_PER_SECOND, { closable: true });
            return;
        }
        adoptRevision(settled.value.contentRevision);
    }

    function close() {
        if (session.closed) {
            throw new Error('Excalidraw editor session closed twice');
        }
        session.closed = true;
        controller.stop();
        if (session.discardTimer !== null) {
            window.clearTimeout(session.discardTimer);
        }
        window.removeEventListener('beforeunload', handleBeforeUnload);
        window.removeEventListener('keydown', handleOverlayKeydown, { capture: true });
        handles.root.unmount();
        overlay.remove();
        setExcalidrawEditorOpen(false);
        void refreshExcalidrawEmbeds(fileId, session.revision);
        onClosed({ fileId, hostNoteId, revision: session.revision });
    }

    async function finish() {
        if (session.finishing) {
            return;
        }
        session.finishing = true;
        setButtonsDisabled(true);
        const status = await controller.flush();
        if (status === AUTOSAVE_STATUS.CONFLICT) {
            ErrorHandler.showErrorBanner('The diagram was changed in another window, so your latest edits were not saved.', 'error', DIAGRAM_SAVE_PROBLEM_BANNER_SECONDS * MS_PER_SECOND, { closable: true });
            await endSession();
            close();
            return;
        }
        if (status !== AUTOSAVE_STATUS.SAVED) {
            session.finishing = false;
            setButtonsDisabled(false);
            showStatus('Could not save the diagram. Check the connection and press Done again.');
            return;
        }
        showStatus('Rendering preview…');
        const stored = await storePreviews(currentScene());
        if (!stored.ok && !stored.conflict) {
            session.finishing = false;
            setButtonsDisabled(false);
            showStatus('The diagram is saved, but its preview could not be saved. Press Done to try again.');
            return;
        }
        await endSession();
        close();
    }

    async function discard() {
        if (session.finishing) {
            return;
        }
        if (!session.discardArmed) {
            session.discardArmed = true;
            discardButton.textContent = 'Click again to discard';
            session.discardTimer = window.setTimeout(() => {
                session.discardTimer = null;
                session.discardArmed = false;
                discardButton.textContent = 'Discard changes';
            }, DISCARD_CONFIRM_MS);
            return;
        }
        session.finishing = true;
        setButtonsDisabled(true);
        controller.stop();
        await controller.waitForIdle();
        showStatus('Restoring the original diagram…');
        const settled = await settleResult(() => FilesAPI.discardEditSession(fileId, sessionId, session.revision));
        if (settled.ok) {
            adoptRevision(settled.value.contentRevision);
        } else if (settled.error instanceof FileRevisionConflictError) {
            adoptRevision(settled.error.currentRevision);
            ErrorHandler.showErrorBanner('The diagram was changed in another window, so it was left as that window saved it.', 'error', DIAGRAM_SAVE_PROBLEM_BANNER_SECONDS * MS_PER_SECOND, { closable: true });
        } else {
            ErrorHandler.showErrorBanner('The original diagram could not be restored; your edits are still saved.', 'error', DIAGRAM_SAVE_PROBLEM_BANNER_SECONDS * MS_PER_SECOND, { closable: true });
        }
        close();
    }

    function handleOverlayKeydown(event) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.stopPropagation();
            void finish();
        }
    }

    overlayPart(overlay, '.excalidraw-editor-done').addEventListener('click', () => { void finish(); });
    discardButton.addEventListener('click', () => { void discard(); });
    // On the window, so Done's shortcut works wherever focus is while the editor is open.
    window.addEventListener('keydown', handleOverlayKeydown, { capture: true });
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.body.appendChild(overlay);

    handles.root = bundle.createRoot(overlayPart(overlay, '.excalidraw-editor-canvas'));
    handles.root.render(bundle.createElement(bundle.Excalidraw, {
        initialData: {
            elements: restoredScene.elements,
            appState: { ...restoredScene.appState, zenModeEnabled: false },
            files: restoredScene.files,
            scrollToContent: true,
        },
        excalidrawAPI: (api) => {
            if (handles.api === null && api !== null) {
                handles.api = api;
            }
        },
        onChange: handleSceneChange,
        theme: currentPreviewVariant(document.documentElement),
        langCode: 'en',
        autoFocus: true,
        name: filename,
        aiEnabled: false,
        UIOptions: {
            canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                toggleTheme: false,
            },
        },
    }));

    return new Promise((resolve, reject) => {
        const startedAt = performance.now();
        const poll = () => {
            if (handles.api !== null) {
                resolve();
                return;
            }
            if (performance.now() - startedAt > EDITOR_START_TIMEOUT_MS) {
                reject(new Error('Excalidraw editor did not start'));
                return;
            }
            window.setTimeout(poll, EDITOR_START_POLL_MS);
        };
        poll();
    });
}

// Opens the editor for fileId. onClosed({ fileId, hostNoteId, revision }) runs after it closes.
// A new diagram gets previews of its empty drawing first, so undoing its first session shows an
// empty diagram rather than one that was never rendered.
export async function openExcalidrawEditor(options) {
    if (options === null || typeof options !== 'object') {
        throw new Error('openExcalidrawEditor requires options');
    }
    const { fileId, hostNoteId, isNewDiagram, onClosed } = options;
    if (typeof fileId !== 'string' || fileId.length === 0) {
        throw new Error('openExcalidrawEditor requires fileId');
    }
    if (typeof hostNoteId !== 'string' || hostNoteId.length === 0) {
        throw new Error('openExcalidrawEditor requires hostNoteId');
    }
    if (typeof isNewDiagram !== 'boolean') {
        throw new Error('openExcalidrawEditor requires isNewDiagram boolean');
    }
    if (typeof onClosed !== 'function') {
        throw new Error('openExcalidrawEditor requires onClosed');
    }
    if (isExcalidrawEditorOpen()) {
        throw new Error('The Excalidraw editor is already open');
    }

    const [bundle, downloaded] = await Promise.all([loadExcalidraw(), FilesAPI.downloadFile(fileId)]);
    const restoredScene = bundle.restore(parseSceneJson(await downloaded.blob.text()), null, null);
    if (typeof downloaded.filename !== 'string' || downloaded.filename.length === 0) {
        throw new Error('Diagram download is missing its filename');
    }
    if (isNewDiagram) {
        await FilesAPI.storeFilePreviews(fileId, await renderPreviews(bundle, restoredScene), downloaded.revision);
    }
    const started = await FilesAPI.startEditSession(fileId);
    if (downloaded.revision !== started.contentRevision) {
        throw new UserInputRejected('The diagram was saved in another window while it was opening. Open it again.');
    }
    setExcalidrawEditorOpen(true);
    await startEditorSession({
        bundle,
        fileId,
        hostNoteId,
        sessionId: started.sessionId,
        isNewDiagram,
        filename: downloaded.filename,
        revision: downloaded.revision,
        restoredScene,
        onClosed,
    });
}
