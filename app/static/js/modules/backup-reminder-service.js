// The optional reminder to back up this namespace (docs/ui/controls.md, "Backup reminder").
// It floats in the notice stack, taking no space and never taking focus. It is checked when
// the app opens, when the tab comes back, when a dialog or the menu closes, and on the
// first click or key after a while; it never polls.

import { ApplicationState } from './application-state.js';
import { appNoticeStack } from './app-notice-stack.js';
import {
    BACKUP_REMINDER_DEFAULT,
    BACKUP_REMINDER_HIDDEN_UNTIL_PREFERENCE,
    BACKUP_REMINDER_HIDE_MS,
    BACKUP_REMINDER_OFF,
    BACKUP_REMINDER_PREFERENCE,
    backupReminderMessage,
    isBackupReminderDue,
} from './backup-reminder-schedule.js';
import { ModeContextInstance as ModeContext } from './mode-manager/mode-context.js';

const NOTICE_ID = 'backup-reminder-notice';
const INTERACTION_CHECK_THROTTLE_MS = 30_000;

class BackupReminderService {
    constructor() {
        this._started = false;
        this._preferences = null;
        this._fetchBackupTimes = null;
        this._openBackup = null;
        // This namespace's backup times (ISO text), newest first; null until fetched.
        this._backupTimes = null;
        this._lastInteractionCheckAt = 0;
        this._handleInteraction = this._handleInteraction.bind(this);
        this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
        this._handleModeChange = this._handleModeChange.bind(this);
        ApplicationState.own(this, 'BackupReminderService', new.target === BackupReminderService);
    }

    async start({ preferences, fetchBackupTimes, openBackup }) {
        if (this._started) {
            return;
        }
        if (!preferences || typeof preferences.getRaw !== 'function' || typeof preferences.setRaw !== 'function') {
            throw new Error('BackupReminder.start requires a preferences store');
        }
        if (typeof fetchBackupTimes !== 'function' || typeof openBackup !== 'function') {
            throw new Error('BackupReminder.start requires fetchBackupTimes and openBackup');
        }
        this._started = true;
        this._preferences = preferences;
        this._fetchBackupTimes = fetchBackupTimes;
        this._openBackup = openBackup;
        document.addEventListener('pointerdown', this._handleInteraction, true);
        document.addEventListener('keydown', this._handleInteraction, true);
        document.addEventListener('visibilitychange', this._handleVisibilityChange);
        ModeContext.addListener(this._handleModeChange);
        await this.check();
    }

    // The reminder setting changed: show or hide the card at once.
    async preferencesChanged() {
        if (!this._started) {
            return;
        }
        await this.check();
    }

    // A backup was made: restart the clock from it.
    async backupMade() {
        if (!this._started) {
            return;
        }
        this._forgetBackupTimes();
        await this.check();
    }

    async check() {
        if (!this._started || document.visibilityState !== 'visible') {
            return;
        }
        const frequency = this._frequency();
        if (frequency === BACKUP_REMINDER_OFF) {
            this._removeNotice();
            return;
        }
        // Wait for dialogs and the menu to close; closing one checks again.
        if (ModeContext.modalStack.length > 0) {
            return;
        }
        if (this._backupTimes === null) {
            const backupTimes = await this._loadBackupTimes();
            // Another check may have loaded them meanwhile.
            if (this._backupTimes === null) {
                this._backupTimes = backupTimes;
            }
        }
        const now = new Date();
        const newestBackupAt = this._backupTimes.length === 0 ? null : parseMoment(this._backupTimes[0]);
        const isDue = isBackupReminderDue({
            frequency: this._frequency(),
            newestBackupAt,
            hiddenUntil: this._hiddenUntil(),
            now,
        });
        if (!isDue) {
            this._removeNotice();
            return;
        }
        this._showNotice(backupReminderMessage({ newestBackupAt, now }));
    }

    _frequency() {
        const stored = this._preferences.getRaw(BACKUP_REMINDER_PREFERENCE);
        return stored === null ? BACKUP_REMINDER_DEFAULT : stored;
    }

    _hiddenUntil() {
        const stored = this._preferences.getRaw(BACKUP_REMINDER_HIDDEN_UNTIL_PREFERENCE);
        return stored === null ? null : parseMoment(stored);
    }

    async _loadBackupTimes() {
        const payload = await this._fetchBackupTimes();
        if (!payload || !Array.isArray(payload.backup_times)) {
            throw new Error('Backup times response missing backup_times');
        }
        // Kept as text (owned state holds plain values); each must parse.
        payload.backup_times.forEach(parseMoment);
        return payload.backup_times.slice();
    }

    _handleInteraction() {
        const now = Date.now();
        if (now - this._lastInteractionCheckAt < INTERACTION_CHECK_THROTTLE_MS) {
            return;
        }
        this._lastInteractionCheckAt = now;
        void this.check();
    }

    _handleVisibilityChange() {
        if (document.visibilityState !== 'visible') {
            return;
        }
        // A backup may have been made from another tab or namespace meanwhile.
        this._forgetBackupTimes();
        void this.check();
    }

    _forgetBackupTimes() {
        if (this._backupTimes !== null) {
            this._backupTimes = null;
        }
    }

    _handleModeChange(property, value) {
        if (property !== 'modalStack' || value.length > 0) {
            return;
        }
        void this.check();
    }

    _showNotice(message) {
        const existing = document.getElementById(NOTICE_ID);
        if (existing) {
            existing.querySelector('.backup-reminder-text').textContent = message;
            return;
        }
        const notice = document.createElement('aside');
        notice.id = NOTICE_ID;
        notice.className = 'app-update-notice backup-reminder-notice reminder-surface-item';
        notice.setAttribute('role', 'status');
        const label = document.createElement('span');
        label.className = 'backup-reminder-text';
        label.textContent = message;
        const backUp = document.createElement('button');
        backUp.type = 'button';
        backUp.textContent = 'Back Up Now';
        backUp.addEventListener('click', async () => { await this._openBackup(); });
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.textContent = '×';
        dismiss.setAttribute('aria-label', 'Hide the backup reminder for a day');
        dismiss.title = 'Hide for a day';
        dismiss.addEventListener('click', async () => { await this._hideForADay(); });
        notice.append(label, backUp, dismiss);
        appNoticeStack().append(notice);
    }

    async _hideForADay() {
        this._removeNotice();
        const hiddenUntil = new Date(Date.now() + BACKUP_REMINDER_HIDE_MS);
        await this._preferences.setRaw(BACKUP_REMINDER_HIDDEN_UNTIL_PREFERENCE, hiddenUntil.toISOString());
    }

    _removeNotice() {
        const notice = document.getElementById(NOTICE_ID);
        if (notice) {
            notice.remove();
        }
    }
}

function parseMoment(text) {
    if (typeof text !== 'string') {
        throw new Error('Backup reminder time must be a string');
    }
    const moment = new Date(text);
    if (Number.isNaN(moment.getTime())) {
        throw new Error(`Backup reminder time is not a date: ${text}`);
    }
    return moment;
}

export const BackupReminder = new BackupReminderService();
