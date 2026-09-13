import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { actionSaveNoteOnIdle } from '../actions/content-actions.js';
import { CommandGate } from '../services/command-gate-service.js';
import { prefetchEditingLinkTitles } from '../services/link-title-prefetch-service.js';

const CHECK_INTERVAL = 500;
const CONTENT_INACTIVITY_THRESHOLD = 60000;  // 60 seconds for debugging 

const moduleState = ApplicationState.createFields('inactivity-events', {
    contentCheckTimer: null,
});

function initContentAutoSave() {
    
    moduleState.contentCheckTimer = setInterval(checkAndSaveContent, CHECK_INTERVAL);
    
    Logger.logInit('Content auto-save initialized');
}

function checkAndSaveContent() {
    void prefetchEditingLinkTitles();
    
    if (!ModeContext.isEditing || !ModeContext.isDirty) {
        return;
    }
    
    const lastChangeTime = ModeContext.lastContentChangeTime;

    const timeSinceLastChange = Date.now() - lastChangeTime;

    if (timeSinceLastChange >= CONTENT_INACTIVITY_THRESHOLD) {
        Logger.logDebug('Auto-saving content after inactivity', {
            noteId: ModeContext.currentNoteId,
            inactivityDuration: timeSinceLastChange
        });

        void CommandGate.run('autosave', async () => {
            await actionSaveNoteOnIdle(ModeContext.currentNoteId);
        });

    }
}

export { initContentAutoSave };
