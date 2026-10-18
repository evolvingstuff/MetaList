import { NOT_IN_TAB_ORDER } from '../../dom-focus.js';
import { ApplicationState } from '../../application-state.js';
import { NotesAPI } from '../../api-client.js';
import { askExportOptions } from '../../modals/export-options-modal.js';
import { prepareExportDialog } from './export-title-service.js';
import { CommandGate } from './command-gate-service.js';

// Print a note with its children, or the view as it is shown (docs/ui/controls.md):
// the same document as Export as HTML, but light, fully expanded and without
// collapse arrows. A note being edited is saved first and stays in edit mode.
// The user sets the title, and whether passwords show (askExportOptions), then
// the browser's print dialog opens on the document in a hidden frame, Save as
// PDF included. With an AI set up, the dialog's Suggest with AI asks it for a
// title from the printed notes it may see; only pressing it does.

const PRINT_TIMEOUT_MS = 120000;

const moduleState = ApplicationState.createFields('print-service', {
    // The app's own title, while a print shows the printed one.
    appTitle: null,
});

function finishPrint() {
    for (const frame of document.querySelectorAll('iframe.print-frame')) {
        frame.remove();
    }
    if (moduleState.appTitle !== null) {
        document.title = moduleState.appTitle;
        moduleState.appTitle = null;
    }
}

// The document in a hidden frame, loaded and ready to print.
function loadPrintFrame(htmlText) {
    finishPrint();
    return new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.className = 'print-frame';
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = NOT_IN_TAB_ORDER;
        // Nothing in the printed document can run (no allow-scripts). It keeps MetaList's
        // origin so this page can print it, and Chrome prints a sandboxed frame only with
        // allow-modals.
        frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
        frame.srcdoc = htmlText;
        frame.addEventListener('load', () => {
            if (frame.contentWindow === null) {
                throw new Error('The print frame has no window');
            }
            resolve(frame.contentWindow);
        }, { once: true });
        document.body.appendChild(frame);
    });
}

// Opens the browser's print dialog, outside the command gate: Chrome holds
// print() until the dialog closes, and MetaList is not busy meanwhile.
// Browsers name the PDF and head each page after the title, so the app's own
// title carries it while the dialog is open, and comes back when printing ends.
function openPrintDialog(printedWindow, title) {
    moduleState.appTitle = document.title;
    document.title = title.trim() === '' ? 'MetaList' : title.trim();
    printedWindow.addEventListener('afterprint', finishPrint, { once: true });
    printedWindow.focus();
    printedWindow.print();
}

// aiSettings: the AI the user chose ({ provider, model, thinkingLevel }).
export async function printNotes(noteId, aiSettings) {
    const prepared = await CommandGate.run('print.prepare', async () => prepareExportDialog(noteId, aiSettings));
    if (prepared === null) {
        // Another command was running: nothing opens.
        return;
    }
    const options = await askExportOptions({ purpose: 'print', ...prepared });
    if (options === null) {
        return;
    }
    const printedWindow = await CommandGate.run('print.document', async () => {
        const htmlText = await NotesAPI.fetchPrintDocument(noteId, options.title, options.includeCredentials);
        return loadPrintFrame(htmlText);
    }, { timeoutMs: PRINT_TIMEOUT_MS });
    if (printedWindow === null) {
        return;
    }
    openPrintDialog(printedWindow, options.title);
}
