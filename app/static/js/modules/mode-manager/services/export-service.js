import { NotesAPI } from '../../api-client.js';
import { askExportOptions } from '../../modals/export-options-modal.js';
import { CommandGate } from './command-gate-service.js';
import { prepareExportDialog } from './export-title-service.js';

// Export as HTML a note with its children, or the view as it is shown
// (docs/ui/controls.md): one self-contained file in the current theme, fully
// expanded, with MetaList's collapse arrows. A note being edited is saved
// first and stays in edit mode. The dialog sets its title (the file's heading,
// tab title and name), with Suggest with AI, and whether passwords show.

const EXPORT_TIMEOUT_MS = 120000;

function resolveEffectiveTheme() {
    const explicitTheme = document.documentElement.getAttribute('data-theme');
    if (explicitTheme === 'dark' || explicitTheme === 'light') {
        return explicitTheme;
    }
    if (
        typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
        return 'dark';
    }
    return 'light';
}

function downloadExport(payload) {
    if (!payload || !(payload.blob instanceof Blob)) {
        throw new Error('HTML export response missing blob');
    }
    if (typeof payload.filename !== 'string' || payload.filename.length === 0) {
        throw new Error('HTML export response missing filename');
    }
    const objectUrl = URL.createObjectURL(payload.blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = payload.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 0);
}

// aiSettings: the AI the user chose ({ provider, model, thinkingLevel }).
export async function exportNotes(noteId, aiSettings) {
    const prepared = await CommandGate.run('export.prepare', async () => prepareExportDialog(noteId, aiSettings));
    if (prepared === null) {
        // Another command was running: nothing happens.
        return;
    }
    const options = await askExportOptions({ purpose: 'download', ...prepared });
    if (options === null) {
        return;
    }
    const theme = resolveEffectiveTheme();
    await CommandGate.run('export.download', async () => {
        downloadExport(await NotesAPI.exportCurrentViewAsHtml(theme, {
            noteId, includeCredentials: options.includeCredentials, title: options.title,
        }));
    }, { timeoutMs: EXPORT_TIMEOUT_MS });
}
