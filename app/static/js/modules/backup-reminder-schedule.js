import { DAYS_PER_WEEK, MS_PER_DAY } from './time-units.js';

// When the backup reminder is due: the namespace's newest backup is older than the
// chosen period (or there is none), and the user has not hidden the reminder for now.

export const BACKUP_REMINDER_PREFERENCE = 'pref.backup_reminder';
export const BACKUP_REMINDER_HIDDEN_UNTIL_PREFERENCE = 'pref.backup_reminder_hidden_until';
export const BACKUP_REMINDER_OFF = 'off';
// Until the user picks another frequency, the reminder runs weekly.
export const BACKUP_REMINDER_DEFAULT = 'weekly';

const WEEKS_IN_A_FORTNIGHT = 2;
const DAYS_IN_A_MONTH = 30;
const PERIOD_DAYS_BY_FREQUENCY = Object.freeze({
    daily: 1,
    weekly: DAYS_PER_WEEK,
    every_2_weeks: WEEKS_IN_A_FORTNIGHT * DAYS_PER_WEEK,
    monthly: DAYS_IN_A_MONTH,
});
// Dismissing the reminder hides it for this long.
export const BACKUP_REMINDER_HIDE_MS = MS_PER_DAY;

export const BACKUP_REMINDER_OPTIONS = Object.freeze([
    { value: BACKUP_REMINDER_OFF, label: 'Off' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'every_2_weeks', label: 'Every 2 weeks' },
    { value: 'monthly', label: 'Monthly' },
]);

function requireMoment(value, name) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new Error(`${name} must be a valid Date`);
    }
}

// `newestBackupAt` and `hiddenUntil` are Dates, or null when there is none.
export function isBackupReminderDue({ frequency, newestBackupAt, hiddenUntil, now }) {
    requireMoment(now, 'now');
    if (frequency === BACKUP_REMINDER_OFF) {
        return false;
    }
    if (!Object.hasOwn(PERIOD_DAYS_BY_FREQUENCY, frequency)) {
        throw new Error(`Unknown backup reminder frequency: ${frequency}`);
    }
    if (hiddenUntil !== null) {
        requireMoment(hiddenUntil, 'hiddenUntil');
        if (now < hiddenUntil) {
            return false;
        }
    }
    if (newestBackupAt === null) {
        return true;
    }
    requireMoment(newestBackupAt, 'newestBackupAt');
    return now.getTime() - newestBackupAt.getTime() >= PERIOD_DAYS_BY_FREQUENCY[frequency] * MS_PER_DAY;
}

export function backupReminderMessage({ newestBackupAt, now }) {
    requireMoment(now, 'now');
    if (newestBackupAt === null) {
        return 'Time to back up: this namespace has no backup yet.';
    }
    requireMoment(newestBackupAt, 'newestBackupAt');
    const days = Math.floor((now.getTime() - newestBackupAt.getTime()) / MS_PER_DAY);
    if (days < 1) {
        return 'Time to back up: the last backup was today.';
    }
    const unit = days === 1 ? 'day' : 'days';
    return `Time to back up: the last backup was ${days} ${unit} ago.`;
}
