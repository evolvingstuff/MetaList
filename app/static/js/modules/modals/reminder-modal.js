import { ApplicationState, stateValuesEqual } from '../application-state.js';
import { ReminderStore } from '../reminder-store.js';
import { ReminderSurface } from '../reminder-surface-service.js';

import { BaseModal } from './base-modal.js';

const REMINDER_RENDER_ICON = '🔔';

function escapeHtml(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function normalizeReminderSearchText(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.toLocaleLowerCase();
}

function todayLocalDate() {
    const now = new Date();
    return formatDateInput(now);
}

function formatDateInput(value) {
    if (!(value instanceof Date)) {
        throw new Error('formatDateInput requires Date');
    }
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatTimeInput(value) {
    if (!(value instanceof Date)) {
        throw new Error('formatTimeInput requires Date');
    }
    const hour = String(value.getHours()).padStart(2, '0');
    const minute = String(value.getMinutes()).padStart(2, '0');
    return `${hour}:${minute}`;
}

function localDateTimeIso(dateValue, timeValue) {
    if (typeof dateValue !== 'string' || dateValue.length === 0) {
        throw new Error('localDateTimeIso requires dateValue');
    }
    if (typeof timeValue !== 'string' || timeValue.length === 0) {
        throw new Error('localDateTimeIso requires timeValue');
    }
    const local = new Date(`${dateValue}T${timeValue}:00`);
    if (Number.isNaN(local.getTime())) {
        throw new Error('Invalid local date/time');
    }
    const offsetMinutes = -local.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absolute = Math.abs(offsetMinutes);
    const offsetHours = String(Math.floor(absolute / 60)).padStart(2, '0');
    const offsetRemainder = String(absolute % 60).padStart(2, '0');
    return `${dateValue}T${timeValue}:00${sign}${offsetHours}:${offsetRemainder}`;
}

function toInputDate(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return todayLocalDate();
    }
    return value.slice(0, 10);
}

function toInputTime(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return '09:00';
    }
    if (value.includes('T')) {
        return value.slice(11, 16);
    }
    return value.slice(0, 5);
}

function displayTime(value) {
    const inputTime = toInputTime(value);
    const pieces = inputTime.split(':');
    if (pieces.length !== 2) {
        throw new Error('displayTime requires HH:mm time');
    }
    const hour = Number.parseInt(pieces[0], 10);
    const minute = Number.parseInt(pieces[1], 10);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
        throw new Error('displayTime requires numeric time');
    }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        throw new Error('displayTime time out of range');
    }
    const period = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 === 0 ? 12 : hour % 12;
    return `${displayHour}:${String(minute).padStart(2, '0')} ${period}`;
}

function parseLocalDateInput(value) {
    if (typeof value !== 'string' || value.length !== 10) {
        throw new Error('parseLocalDateInput requires YYYY-MM-DD');
    }
    const year = Number.parseInt(value.slice(0, 4), 10);
    const month = Number.parseInt(value.slice(5, 7), 10);
    const day = Number.parseInt(value.slice(8, 10), 10);
    return new Date(year, month - 1, day);
}

function wholeDayDelta(fromDate, toDate) {
    if (!(fromDate instanceof Date) || !(toDate instanceof Date)) {
        throw new Error('wholeDayDelta requires Date values');
    }
    const fromDay = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
    const toDay = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
    return Math.round((toDay.getTime() - fromDay.getTime()) / 86400000);
}

function relativeDayLabel(value) {
    const delta = wholeDayDelta(new Date(), parseLocalDateInput(value));
    if (delta === 0) {
        return 'today';
    }
    if (delta === 1) {
        return 'tomorrow';
    }
    if (delta === -1) {
        return 'yesterday';
    }
    if (delta > 1) {
        return `in ${delta} days`;
    }
    return `${Math.abs(delta)} days ago`;
}

function relativeDateTimeLabel(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('relativeDateTimeLabel requires value');
    }
    const target = new Date(value);
    if (Number.isNaN(target.getTime())) {
        throw new Error('relativeDateTimeLabel requires valid datetime');
    }
    const deltaMinutes = Math.round((target.getTime() - Date.now()) / 60000);
    if (Math.abs(deltaMinutes) < 1) {
        return 'now';
    }
    const absoluteMinutes = Math.abs(deltaMinutes);
    if (absoluteMinutes < 60) {
        return deltaMinutes > 0 ? `in ${absoluteMinutes} minutes` : `${absoluteMinutes} minutes ago`;
    }
    const absoluteHours = Math.round(absoluteMinutes / 60);
    if (absoluteHours < 48) {
        return deltaMinutes > 0 ? `in ${absoluteHours} hours` : `${absoluteHours} hours ago`;
    }
    const absoluteDays = Math.round(absoluteHours / 24);
    return deltaMinutes > 0 ? `in ${absoluteDays} days` : `${absoluteDays} days ago`;
}

function reminderScheduleLabel(reminder) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('reminderScheduleLabel requires reminder');
    }
    if (reminder.time_mode === 'date_only') {
        if (reminder.schedule_kind === 'recurring') {
            return recurrenceLabel(reminder.recurrence_rule);
        }
        return reminder.scheduled_date;
    }
    if (reminder.schedule_kind === 'recurring') {
        return `${recurrenceLabel(reminder.recurrence_rule)} at ${displayTime(reminder.scheduled_at)}`;
    }
    return `${toInputDate(reminder.scheduled_at)} ${displayTime(reminder.scheduled_at)}`;
}

function reminderDisplayTitle(reminder) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('reminderDisplayTitle requires reminder');
    }
    if (typeof reminder.title === 'string' && reminder.title.length > 0) {
        return reminder.title;
    }
    return 'Untitled reminder';
}

function reminderDetails(reminder) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('reminderDetails requires reminder');
    }
    if (typeof reminder.details !== 'string') {
        return '';
    }
    return reminder.details.trim();
}

function reminderPreReminder(reminder) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('reminderPreReminder requires reminder');
    }
    if (reminder.pre_reminder === null || reminder.pre_reminder === undefined) {
        return null;
    }
    if (typeof reminder.pre_reminder !== 'object') {
        throw new Error('reminder pre_reminder must be object');
    }
    if (!Number.isInteger(reminder.pre_reminder.amount) || reminder.pre_reminder.amount < 1) {
        throw new Error('reminder pre_reminder amount invalid');
    }
    if (!['minutes', 'hours', 'days'].includes(reminder.pre_reminder.unit)) {
        throw new Error('reminder pre_reminder unit invalid');
    }
    return reminder.pre_reminder;
}

function preReminderLabel(reminder) {
    const preReminder = reminderPreReminder(reminder);
    if (preReminder === null) {
        return '';
    }
    const unit = preReminder.amount === 1
        ? preReminder.unit.slice(0, -1)
        : preReminder.unit;
    return `Pre-reminder: ${preReminder.amount} ${unit} before`;
}

function reminderDueValueLabel(reminder, value) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('reminderDueValueLabel requires reminder');
    }
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('reminderDueValueLabel requires value');
    }
    if (
        reminder.schedule_kind === 'recurring'
        && reminder.time_mode === 'date_only'
        && !value.includes('T')
    ) {
        return recurringDateOnlyOccurrenceLabel(reminder, value);
    }
    if (value.includes('T')) {
        return `${toInputDate(value)} ${displayTime(value)} (${relativeDateTimeLabel(value)})`;
    }
    return `${value} (${relativeDayLabel(value)})`;
}

function recurringDateOnlyOccurrenceLabel(reminder, value) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('recurringDateOnlyOccurrenceLabel requires reminder');
    }
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('recurringDateOnlyOccurrenceLabel requires value');
    }
    const rule = reminder.recurrence_rule;
    if (!rule || typeof rule !== 'object') {
        throw new Error('recurring reminder requires recurrence_rule');
    }
    const frequency = rule.frequency;
    const relative = relativeDayLabel(value);
    if (frequency === 'weekly') {
        return `${weekdayNameForDate(value)} (${relative})`;
    }
    if (frequency === 'monthly') {
        if (typeof rule.day_of_month !== 'number') {
            throw new Error('monthly recurrence requires day_of_month');
        }
        return `the ${monthlyDayLabel(rule.day_of_month)} (${relative})`;
    }
    if (frequency === 'yearly') {
        if (typeof rule.month !== 'number' || typeof rule.day !== 'number') {
            throw new Error('yearly recurrence requires month and day');
        }
        return `${monthDayLabel(rule.month, rule.day)} (${relative})`;
    }
    if (frequency === 'daily') {
        return relative;
    }
    throw new Error(`Unsupported recurrence frequency: ${frequency}`);
}

function weekdayNameForDate(value) {
    const dateValue = parseLocalDateInput(value);
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return labels[dateValue.getDay()];
}

function dueStatusForValue(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('dueStatusForValue requires value');
    }
    if (value.includes('T')) {
        const target = new Date(value);
        if (Number.isNaN(target.getTime())) {
            throw new Error('dueStatusForValue requires valid datetime');
        }
        const deltaMinutes = Math.round((target.getTime() - Date.now()) / 60000);
        if (deltaMinutes < 0) {
            return 'overdue';
        }
        if (deltaMinutes === 0) {
            return 'due';
        }
        return 'future';
    }
    const dayDelta = wholeDayDelta(new Date(), parseLocalDateInput(value));
    if (dayDelta < 0) {
        return 'overdue';
    }
    if (dayDelta === 0) {
        return 'due';
    }
    return 'future';
}

function dueStatusPrefix(value) {
    const status = dueStatusForValue(value);
    if (status === 'overdue') {
        return 'Overdue ⚠️';
    }
    if (status === 'due') {
        return 'Due';
    }
    if (status === 'future') {
        return 'Next';
    }
    throw new Error(`Unsupported due status: ${status}`);
}

function reminderPastDueLabel(reminder) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('reminderPastDueLabel requires reminder');
    }
    if (reminder.is_currently_missed !== true) {
        return '';
    }
    if (typeof reminder.missed_since !== 'string' || reminder.missed_since.length === 0) {
        throw new Error('missed reminder requires missed_since');
    }
    return `Overdue ⚠️: ${reminderDueValueLabel(reminder, reminder.missed_since)}`;
}

function reminderNextLabel(reminder) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('reminderNextLabel requires reminder');
    }
    if (typeof reminder.next_fire_at === 'string' && reminder.next_fire_at.length > 0) {
        return `${dueStatusPrefix(reminder.next_fire_at)}: ${reminderDueValueLabel(reminder, reminder.next_fire_at)}`;
    }
    if (typeof reminder.next_fire_date === 'string' && reminder.next_fire_date.length > 0) {
        return `${dueStatusPrefix(reminder.next_fire_date)}: ${reminderDueValueLabel(reminder, reminder.next_fire_date)}`;
    }
    return '';
}

function recurrenceLabel(rule) {
    if (!rule || typeof rule !== 'object') {
        return 'Repeats';
    }
    const interval = typeof rule.interval === 'number' ? rule.interval : 1;
    const frequency = typeof rule.frequency === 'string' ? rule.frequency : 'daily';
    if (frequency === 'daily' && interval === 1) {
        return 'Daily';
    }
    if (frequency === 'weekly' && interval === 1) {
        if (Array.isArray(rule.weekdays) && rule.weekdays.length > 0) {
            return `Weekly on ${weekdayListLabel(rule.weekdays)}`;
        }
        return 'Weekly';
    }
    if (frequency === 'monthly' && interval === 1) {
        if (typeof rule.day_of_month === 'number') {
            return `Monthly on the ${monthlyDayLabel(rule.day_of_month)}`;
        }
        return 'Monthly';
    }
    if (frequency === 'yearly' && interval === 1) {
        if (typeof rule.month === 'number' && typeof rule.day === 'number') {
            return `Yearly on ${monthDayLabel(rule.month, rule.day)}`;
        }
        return 'Yearly';
    }
    if (frequency === 'weekly' && Array.isArray(rule.weekdays) && rule.weekdays.length > 0) {
        return `Every ${interval} weeks on ${weekdayListLabel(rule.weekdays)}`;
    }
    if (frequency === 'monthly' && typeof rule.day_of_month === 'number') {
        return `Every ${interval} months on the ${monthlyDayLabel(rule.day_of_month)}`;
    }
    if (frequency === 'yearly' && typeof rule.month === 'number' && typeof rule.day === 'number') {
        return `Every ${interval} years on ${monthDayLabel(rule.month, rule.day)}`;
    }
    return `Every ${interval} ${frequency}`;
}

function ordinalDay(day) {
    if (!Number.isInteger(day) || day < 1 || day > 31) {
        throw new Error('ordinalDay requires day 1-31');
    }
    const remainder100 = day % 100;
    if (remainder100 >= 11 && remainder100 <= 13) {
        return `${day}th`;
    }
    const remainder10 = day % 10;
    if (remainder10 === 1) {
        return `${day}st`;
    }
    if (remainder10 === 2) {
        return `${day}nd`;
    }
    if (remainder10 === 3) {
        return `${day}rd`;
    }
    return `${day}th`;
}

function monthlyDayLabel(day) {
    const label = ordinalDay(day);
    if (day > 28) {
        return `${label} or last day`;
    }
    return label;
}

function weekdayListLabel(weekdays) {
    if (!Array.isArray(weekdays)) {
        throw new Error('weekdayListLabel requires weekdays array');
    }
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const selectedLabels = weekdays.map((weekday) => {
        if (!Number.isInteger(weekday) || weekday < 0 || weekday >= labels.length) {
            throw new Error('weekdayListLabel received invalid weekday');
        }
        return labels[weekday];
    });
    return selectedLabels.join(', ');
}

function monthDayLabel(month, day) {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new Error('monthDayLabel requires month 1-12');
    }
    const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${labels[month - 1]} ${ordinalDay(day)}`;
}

function defaultFormState() {
    const now = new Date();
    return {
        id: '',
        title: '',
        details: '',
        schedule_kind: 'one_time',
        time_mode: 'date_only',
        date: formatDateInput(now),
        time: formatTimeInput(now),
        frequency: 'daily',
        interval: '1',
        weekdays: [now.getDay() === 0 ? 6 : now.getDay() - 1],
        end_type: 'never',
        end_value: '',
        pre_reminder_enabled: false,
        pre_reminder_amount: '1',
        pre_reminder_unit: 'days',
        persistence_mode: 'keep_until_seen',

        status: 'active',
    };
}

function stateFromReminder(reminder) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('stateFromReminder requires reminder');
    }
    const rule = reminder.recurrence_rule && typeof reminder.recurrence_rule === 'object'
        ? reminder.recurrence_rule
        : {};
    const end = rule.end && typeof rule.end === 'object' ? rule.end : { type: 'never' };
    const preReminder = reminderPreReminder(reminder);
    return {
        id: reminder.id,
        title: reminder.title,
        details: typeof reminder.details === 'string' ? reminder.details : '',
        schedule_kind: reminder.schedule_kind,
        time_mode: reminder.time_mode,
        date: reminder.time_mode === 'date_time'
            ? toInputDate(reminder.scheduled_at)
            : reminder.scheduled_date,
        time: reminder.time_mode === 'date_time' ? toInputTime(reminder.scheduled_at) : '09:00',
        frequency: typeof rule.frequency === 'string' ? rule.frequency : 'daily',
        interval: typeof rule.interval === 'number' ? String(rule.interval) : '1',
        weekdays: Array.isArray(rule.weekdays) ? rule.weekdays : [],
        end_type: typeof end.type === 'string' ? end.type : 'never',
        end_value: end.value === undefined ? '' : String(end.value),
        pre_reminder_enabled: preReminder !== null,
        pre_reminder_amount: preReminder === null ? '1' : String(preReminder.amount),
        pre_reminder_unit: preReminder === null ? 'days' : preReminder.unit,
        persistence_mode: reminder.persistence_mode,

        status: reminder.status,
    };
}

function buildPayloadFromForm(form) {
    if (!form || typeof form !== 'object') {
        throw new Error('buildPayloadFromForm requires form');
    }
    const title = form.title.trim();
    const details = form.details.trim();
    const timeMode = form.time_mode;
    const scheduleKind = form.schedule_kind;
    const payload = {
        note_id: null,
        title,
        details,
        attachment_type: 'unattached',
        schedule_kind: scheduleKind,
        time_mode: timeMode,
        scheduled_at: timeMode === 'date_time' ? localDateTimeIso(form.date, form.time) : null,
        scheduled_date: timeMode === 'date_only' ? form.date : null,
        recurrence_rule: null,
        pre_reminder: form.pre_reminder_enabled
            ? {
                amount: Number.parseInt(form.pre_reminder_amount, 10),
                unit: timeMode === 'date_only' ? 'days' : form.pre_reminder_unit,
            }
            : null,
        persistence_mode: form.persistence_mode,

        status: scheduleKind === 'recurring' ? form.status : 'active',
    };
    if (scheduleKind === 'recurring') {
        payload.recurrence_rule = {
            frequency: form.frequency,
            interval: Number.parseInt(form.interval, 10),
            end: buildRecurrenceEnd(form),
        };
        if (form.frequency === 'weekly') {
            payload.recurrence_rule.weekdays = form.weekdays.slice();
        }
        if (form.frequency === 'monthly') {
            payload.recurrence_rule.day_of_month = Number.parseInt(form.date.slice(8, 10), 10);
        }
        if (form.frequency === 'yearly') {
            payload.recurrence_rule.month = Number.parseInt(form.date.slice(5, 7), 10);
            payload.recurrence_rule.day = Number.parseInt(form.date.slice(8, 10), 10);
        }
        if (timeMode === 'date_time') {
            payload.recurrence_rule.time_of_day = form.time;
        } else {
            payload.recurrence_rule.date_trigger_policy = 'on_first_non_idle_use';
        }
    }
    return payload;
}

function buildRecurrenceEnd(form) {
    if (form.end_type === 'never') {
        return { type: 'never' };
    }
    if (form.end_type === 'on_date') {
        return { type: 'on_date', value: form.end_value };
    }
    if (form.end_type === 'after_count') {
        return { type: 'after_count', value: Number.parseInt(form.end_value, 10) };
    }
    throw new Error(`Unsupported recurrence end type: ${form.end_type}`);
}

function reminderFormWarning(form) {
    if (!form || typeof form !== 'object') {
        throw new Error('reminderFormWarning requires form');
    }
    if (form.time_mode === 'date_only' && form.date < todayLocalDate()) {
        if (form.persistence_mode === 'drop_if_missed') {
            if (form.schedule_kind === 'recurring') {
                return 'The first occurrence is in the past. Because missed is Forget if missed, past occurrences will be skipped silently.';
            }
            return 'This date is in the past. Because missed is Forget if missed, this reminder will be completed silently.';
        }
        if (form.schedule_kind === 'recurring') {
            return 'The first occurrence is in the past. It will show as missed on the next app use.';
        }
        return 'This date is in the past. It will show as missed on the next app use.';
    }
    if (
        form.time_mode === 'date_time'
        && typeof form.date === 'string'
        && form.date.length === 10
        && typeof form.time === 'string'
        && form.time.length === 5
        && localDateTimeIso(form.date, form.time) < new Date().toISOString()
    ) {
        if (form.persistence_mode === 'drop_if_missed') {
            return 'This time is in the past. Because missed is Forget if missed, this reminder will be completed silently.';
        }
        return 'This time is in the past. It will be due immediately after saving.';
    }
    if (
        form.schedule_kind === 'recurring'
        && form.frequency === 'monthly'
        && typeof form.date === 'string'
        && form.date.length === 10
        && Number.parseInt(form.date.slice(8, 10), 10) > 28
    ) {
        return `Months without the ${ordinalDay(Number.parseInt(form.date.slice(8, 10), 10))} use that month's last day.`;
    }
    return '';
}

function shouldShowDateField(form) {
    if (!form || typeof form !== 'object') {
        throw new Error('shouldShowDateField requires form');
    }
    if (form.schedule_kind !== 'recurring') {
        return true;
    }
    return form.frequency !== 'weekly';
}

function dateFieldLabel(form) {
    if (!form || typeof form !== 'object') {
        throw new Error('dateFieldLabel requires form');
    }
    if (form.schedule_kind !== 'recurring') {
        return 'Date';
    }
    if (form.frequency === 'monthly') {
        return 'Start Date (day of month)';
    }
    if (form.frequency === 'yearly') {
        return 'Start Date (month and day)';
    }
    return 'Start Date';
}

function recurrenceIntervalUnit(form) {
    if (!form || typeof form !== 'object') {
        throw new Error('recurrenceIntervalUnit requires form');
    }
    const interval = Number.parseInt(form.interval, 10);
    const isSingular = interval === 1;
    if (form.frequency === 'daily') {
        return isSingular ? 'day' : 'days';
    }
    if (form.frequency === 'weekly') {
        return isSingular ? 'week' : 'weeks';
    }
    if (form.frequency === 'monthly') {
        return isSingular ? 'month' : 'months';
    }
    if (form.frequency === 'yearly') {
        return isSingular ? 'year' : 'years';
    }
    throw new Error(`Unsupported recurrence frequency: ${form.frequency}`);
}

function reminderMatchesScheduleFilter(reminder, scheduleFilter) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('reminderMatchesScheduleFilter requires reminder');
    }
    if (typeof scheduleFilter !== 'string' || scheduleFilter.length === 0) {
        throw new Error('reminderMatchesScheduleFilter requires scheduleFilter');
    }
    if (scheduleFilter === 'all_schedules') {
        return true;
    }
    if (scheduleFilter === 'one_time') {
        return reminder.schedule_kind === 'one_time';
    }
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(scheduleFilter)) {
        throw new Error(`Unsupported schedule filter: ${scheduleFilter}`);
    }
    if (reminder.schedule_kind !== 'recurring') {
        return false;
    }
    const rule = reminder.recurrence_rule;
    if (!rule || typeof rule !== 'object') {
        throw new Error('recurring reminder requires recurrence_rule');
    }
    return rule.frequency === scheduleFilter;
}

function reminderSearchHaystack(reminder) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('reminderSearchHaystack requires reminder');
    }
    const parts = [
        reminderDisplayTitle(reminder),
        reminderDetails(reminder),
        preReminderLabel(reminder),
        reminderScheduleLabel(reminder),
        reminder.status,
        reminder.persistence_mode,
    ];
    return normalizeReminderSearchText(parts.join(' '));
}

function defaultReminderModalState() {
    return {
        loading: false,
        error: '',
        query: '',
        scheduleFilter: 'all_schedules',
        reminders: [],
        missed: [],
        form: defaultFormState(),
        editingId: '',
        unsubscribe: null,
        saving: false,

    };
}

export class ReminderModal extends BaseModal {
    constructor() {
        super('reminderModal', 'reminder-modal');
        this._state = defaultReminderModalState();
        this._handleInput = this._handleInput.bind(this);
        this._handleClick = this._handleClick.bind(this);

        ApplicationState.own(this, 'ReminderModal', new.target === ReminderModal);
    }

    open(options = {}) {
        if (!options || typeof options !== 'object') {
            throw new Error('ReminderModal.open options must be object');
        }
        const search = Object.prototype.hasOwnProperty.call(options, 'search') ? options.search : '';
        if (typeof search !== 'string') {
            throw new Error('ReminderModal.open search must be string');
        }
        if (this.isOpen) throw new Error('Reminder modal already open');
        this._state = { ...defaultReminderModalState(), loading: true, query: search };
        super.open();
    }

    setSearchQuery(search) {
        if (typeof search !== 'string') {
            throw new Error('ReminderModal.setSearchQuery requires string');
        }
        if (!this.isOpen) {
            throw new Error('ReminderModal.setSearchQuery requires open modal');
        }
        this._state.query = search;
        this._render();
        this._focusSearchInput(search.length, search.length);
    }

    getInitialModalState() {
        // Reminder records are owned by ApplicationState through this._state;
        // the modal lifecycle must not maintain a second copy of their fields.
        return {};
    }

    showModalElement() {
        let modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            modalElement = document.createElement('div');
            modalElement.id = this.modalElementId;
            modalElement.className = 'modal';
            modalElement.style.display = 'none';
            document.body.appendChild(modalElement);
        }
        this._render();
        modalElement.style.display = 'block';
    }

    onOpen() {
        this._render();
        const modalElement = this._modalElement();
        modalElement.addEventListener('input', this._handleInput);
        modalElement.addEventListener('change', this._handleInput);
        modalElement.addEventListener('click', this._handleClick);
        this._state.unsubscribe = ReminderStore.subscribe((snapshot) => {
            this._applySnapshot(snapshot);
        });
        void this._load();
    }

    onClose() {
        const modalElement = this._modalElement();
        modalElement.removeEventListener('input', this._handleInput);
        modalElement.removeEventListener('change', this._handleInput);
        modalElement.removeEventListener('click', this._handleClick);
        if (typeof this._state.unsubscribe === 'function') {
            this._state.unsubscribe();
            this._state.unsubscribe = null;
        }
        this._state = null;
    }

    _modalElement() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error('Reminder modal element missing');
        }
        return modalElement;
    }

    async _load() {
        // The subscription publishes this response once.
        await ReminderStore.refresh();
    }

    _applySnapshot(payload) {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Reminder snapshot missing payload');
        }
        if (!Array.isArray(payload.reminders)) {
            throw new Error('Reminder snapshot missing reminders');
        }
        if (!Array.isArray(payload.missed)) {
            throw new Error('Reminder snapshot missing missed');
        }
        if (!this.isOpen) return;
        const next = { ...this._state, loading: false, reminders: payload.reminders, missed: payload.missed };
        if (!stateValuesEqual(this._state, next)) this._state = next;
        this._render();
        void ReminderSurface.evaluateFreshSnapshot('non_idle_use');
    }

    _filteredReminders() {
        const query = normalizeReminderSearchText(this._state.query.trim());
        return this._state.reminders.filter((reminder) => {
            if (!reminderMatchesScheduleFilter(reminder, this._state.scheduleFilter)) {
                return false;
            }
            if (query.length === 0) {
                return true;
            }
            const haystack = reminderSearchHaystack(reminder);
            return haystack.includes(query);
        });
    }

    _render() {
        const modalElement = this._modalElement();
        const form = this._state.form;
        const formWarning = reminderFormWarning(form);
        const filtered = this._filteredReminders();
        modalElement.innerHTML = `
            <div class="modal-content reminder-modal-content">
                <div class="reminder-modal-header">
                    <h3>Reminders</h3>
                </div>
                <div class="reminder-modal-layout">
                    <section class="reminder-registry-pane">
                        <div class="reminder-toolbar">
                            <input id="reminder-search" type="search" placeholder="Search reminders" value="${escapeHtml(this._state.query)}">
                            <select id="reminder-schedule-filter">
                                ${this._option('all_schedules', 'All schedules', this._state.scheduleFilter)}
                                ${this._option('one_time', 'One Time', this._state.scheduleFilter)}
                                ${this._option('daily', 'Daily', this._state.scheduleFilter)}
                                ${this._option('weekly', 'Weekly', this._state.scheduleFilter)}
                                ${this._option('monthly', 'Monthly', this._state.scheduleFilter)}
                                ${this._option('yearly', 'Yearly', this._state.scheduleFilter)}
                            </select>
                        </div>
                        ${this._state.missed.length > 0 ? this._renderMissed() : ''}
                        <div class="reminder-list">
                            ${this._state.loading ? '<p class="reminder-empty">Loading...</p>' : ''}
                            ${!this._state.loading && filtered.length === 0 ? '<p class="reminder-empty">No reminders</p>' : ''}
                            ${filtered.map((reminder) => this._renderReminderRow(reminder)).join('')}
                        </div>
                    </section>
                    <section class="reminder-form-pane">
                        <h4>${this._state.editingId ? 'Edit reminder' : 'New reminder'}</h4>
                        <div class="reminder-form-grid">
                            <label class="reminder-field">
                                <span class="reminder-field-label">Title</span>
                                <input id="reminder-title" type="text" value="${escapeHtml(form.title)}">
                            </label>
                            <label class="reminder-field">
                                <span class="reminder-field-label">Schedule</span>
                                <select id="reminder-schedule-kind">
                                    ${this._option('one_time', 'Once', form.schedule_kind)}
                                    ${this._option('recurring', 'Repeat', form.schedule_kind)}
                                </select>
                            </label>
                            <label class="reminder-field reminder-field-wide reminder-details-field">
                                <span class="reminder-field-label">Details</span>
                                <textarea id="reminder-details">${escapeHtml(form.details)}</textarea>
                            </label>
                            ${this._renderDateField(form)}
                            <label class="reminder-field">
                                <span class="reminder-field-label">Time mode</span>
                                <select id="reminder-time-mode">
                                    ${this._option('date_time', 'Date and time', form.time_mode)}
                                    ${this._option('date_only', 'Date only', form.time_mode)}
                                </select>
                            </label>
                            <label class="reminder-field ${form.time_mode === 'date_time' ? '' : 'reminder-hidden'}">
                                <span class="reminder-field-label">Time</span>
                                <input id="reminder-time" type="time" value="${escapeHtml(form.time)}">
                            </label>
                            ${this._renderRepeatsField(form)}
                            ${this._renderPreReminderFields(form)}
                            ${this._renderRecurrenceDetails(form)}
                            <label class="reminder-field">
                                <span class="reminder-field-label">Behavior</span>
                                <select id="reminder-persistence-mode">
                                    ${this._option('keep_until_seen', 'Keep until seen', form.persistence_mode)}
                                    ${this._option('drop_if_missed', 'Forget if missed', form.persistence_mode)}
                                </select>
                            </label>
                            <label class="reminder-field ${form.schedule_kind === 'recurring' ? '' : 'reminder-hidden'}">
                                <span class="reminder-field-label">Status</span>
                                <select id="reminder-status">
                                    ${this._option('active', 'Active', form.status)}
                                    ${this._option('paused', 'Paused', form.status)}
                                </select>
                            </label>
                        </div>

                        <div class="reminder-form-actions">
                            <button type="button" class="primary-btn" data-reminder-save data-modal-enter-action ${this._state.saving ? 'disabled' : ''}>${this._state.editingId ? 'Save changes' : 'Add reminder'}</button>
                            <button type="button" class="secondary-btn" data-reminder-new ${this._state.saving ? 'disabled' : ''}>Clear form</button>
                        </div>
                        <p class="reminder-modal-warning">${escapeHtml(formWarning)}</p>
                        <p class="reminder-modal-error">${escapeHtml(this._state.error)}</p>
                    </section>
                </div>

            </div>
        `;
        this._installModalCloseButton();
    }

    _renderPreReminderFields(form) {
        return `
            <div class="reminder-field reminder-field-wide reminder-pre-field">
                <label class="reminder-field-label reminder-check-label" for="reminder-pre-enabled">
                    <input id="reminder-pre-enabled" type="checkbox" ${form.pre_reminder_enabled ? 'checked' : ''}>
                    <span>Pre-reminder</span>
                </label>
                ${form.pre_reminder_enabled ? `
                    <span class="reminder-pre-control">
                        <input id="reminder-pre-amount" type="number" min="1" step="1" value="${escapeHtml(form.pre_reminder_amount)}">
                        <select id="reminder-pre-unit">
                            ${form.time_mode === 'date_time' ? this._option('minutes', 'Minutes', form.pre_reminder_unit) : ''}
                            ${form.time_mode === 'date_time' ? this._option('hours', 'Hours', form.pre_reminder_unit) : ''}
                            ${this._option('days', 'Days', form.pre_reminder_unit)}
                        </select>
                    </span>
                ` : '<span class="reminder-pre-empty"></span>'}
            </div>
        `;
    }

    _renderDateField(form) {
        if (!shouldShowDateField(form)) {
            return '';
        }
        return `
            <label class="reminder-field">
                <span class="reminder-field-label">${escapeHtml(dateFieldLabel(form))}</span>
                <input id="reminder-date" type="date" value="${escapeHtml(form.date)}">
            </label>
        `;
    }

    _renderRepeatsField(form) {
        if (form.schedule_kind !== 'recurring') {
            return '';
        }
        return `
            <label class="reminder-field">
                <span class="reminder-field-label">Repeats</span>
                <select id="reminder-frequency">
                    ${this._option('daily', 'Daily', form.frequency)}
                    ${this._option('weekly', 'Weekly', form.frequency)}
                    ${this._option('monthly', 'Monthly', form.frequency)}
                    ${this._option('yearly', 'Yearly', form.frequency)}
                </select>
            </label>
        `;
    }

    _renderRecurrenceDetails(form) {
        if (form.schedule_kind !== 'recurring') {
            return '';
        }
        return `
            <label class="reminder-field">
                <span class="reminder-field-label">Repeat every</span>
                <span class="reminder-interval-control">
                    <input id="reminder-interval" type="number" min="1" step="1" value="${escapeHtml(form.interval)}">
                    <span>${escapeHtml(recurrenceIntervalUnit(form))}</span>
                </span>
            </label>
            <div class="reminder-field ${form.frequency === 'weekly' ? '' : 'reminder-hidden'}">
                <span class="reminder-field-label">Weekdays</span>
                <div class="reminder-weekdays">
                    ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, index) => `
                        <label>
                            <input type="checkbox" data-reminder-weekday="${index}" ${form.weekdays.includes(index) ? 'checked' : ''}>
                            ${label}
                        </label>
                    `).join('')}
                </div>
            </div>
            <label class="reminder-field">
                <span class="reminder-field-label">Ends</span>
                <select id="reminder-end-type">
                    ${this._option('never', 'Never', form.end_type)}
                    ${this._option('on_date', 'On date', form.end_type)}
                    ${this._option('after_count', 'After count', form.end_type)}
                </select>
            </label>
            <label class="reminder-field ${form.end_type === 'never' ? 'reminder-hidden' : ''}">
                <span class="reminder-field-label">End value</span>
                <input id="reminder-end-value" type="${form.end_type === 'on_date' ? 'date' : 'number'}" min="1" value="${escapeHtml(form.end_value)}">
            </label>
        `;
    }

    _renderMissed() {
        return `
            <div class="reminder-missed-bucket">
                <h4>Missed</h4>
                ${this._state.missed.map((reminder) => this._renderReminderRow(reminder)).join('')}
            </div>
        `;
    }

    _renderReminderRow(reminder) {
        const isMissed = reminder.is_currently_missed === true;
        const isRecurring = reminder.schedule_kind === 'recurring';
        const details = reminderDetails(reminder);
        const preReminder = preReminderLabel(reminder);
        const pastDueLabel = reminderPastDueLabel(reminder);
        const nextLabel = reminderNextLabel(reminder);
        const nextLabelClass = nextLabel.startsWith('Overdue')
            ? 'reminder-row-overdue'
            : (nextLabel.startsWith('Due:') ? 'reminder-row-due' : 'reminder-row-next');

        return `
            <article class="reminder-row ${isMissed ? 'reminder-row-missed' : ''} ${reminder.status === 'paused' ? 'reminder-row-paused' : ''}" data-reminder-id="${escapeHtml(reminder.id)}">
                <div class="reminder-row-main">
                    <strong><span class="reminder-row-icon" aria-hidden="true">${REMINDER_RENDER_ICON}</span> ${escapeHtml(reminderDisplayTitle(reminder))}</strong>
                    ${details ? `<small class="reminder-row-details">${escapeHtml(details)}</small>` : ''}
                    <span>${escapeHtml(reminderScheduleLabel(reminder))}</span>
                    ${preReminder ? `<small class="reminder-row-next">${escapeHtml(preReminder)}</small>` : ''}
                    ${pastDueLabel ? `<small class="reminder-row-past-due">${escapeHtml(pastDueLabel)}</small>` : ''}
                    ${nextLabel ? `<small class="${nextLabelClass}">${escapeHtml(nextLabel)}</small>` : ''}
                </div>
                <div class="reminder-row-actions">
                    ${isMissed ? '<button type="button" data-reminder-action="acknowledge" title="Clear this due or missed notice">Got it</button>' : ''}
                    <button type="button" data-reminder-edit>Edit</button>
                    ${isRecurring ? `<button type="button" data-reminder-action="${reminder.status === 'paused' ? 'resume' : 'pause'}">${reminder.status === 'paused' ? 'Resume' : 'Pause'}</button>` : ''}
                    <button type="button" data-reminder-delete>Delete</button>
                </div>
            </article>
        `;
    }

    _option(value, label, current) {
        return `<option value="${escapeHtml(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }

    _focusSearchInput(selectionStart, selectionEnd) {
        if (!Number.isInteger(selectionStart) || !Number.isInteger(selectionEnd)) {
            throw new Error('_focusSearchInput requires numeric selection');
        }
        const searchInput = document.getElementById('reminder-search');
        if (!(searchInput instanceof HTMLInputElement)) {
            throw new Error('Reminder search input missing');
        }
        searchInput.focus({ preventScroll: true });
        searchInput.setSelectionRange(selectionStart, selectionEnd);
    }

    _handleInput(event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }
        const form = this._state.form;
        if (target.id === 'reminder-search') {
            if (!(target instanceof HTMLInputElement)) {
                throw new Error('Reminder search event target must be input');
            }
            const selectionStart = target.selectionStart;
            const selectionEnd = target.selectionEnd;
            if (!Number.isInteger(selectionStart) || !Number.isInteger(selectionEnd)) {
                throw new Error('Reminder search selection missing');
            }
            this._state.query = target.value;
            this._render();
            this._focusSearchInput(selectionStart, selectionEnd);
            return;
        }
        if (target.id === 'reminder-schedule-filter') {
            this._state.scheduleFilter = target.value;
            this._render();
            return;
        }
        if (target.id === 'reminder-pre-enabled') {
            if (!(target instanceof HTMLInputElement)) {
                throw new Error('Pre-reminder toggle must be input');
            }
            form.pre_reminder_enabled = target.checked;
            this._render();
            return;
        }

        const mapping = {
            'reminder-title': 'title',
            'reminder-details': 'details',
            'reminder-time-mode': 'time_mode',
            'reminder-schedule-kind': 'schedule_kind',
            'reminder-date': 'date',
            'reminder-time': 'time',
            'reminder-frequency': 'frequency',
            'reminder-interval': 'interval',
            'reminder-pre-amount': 'pre_reminder_amount',
            'reminder-pre-unit': 'pre_reminder_unit',
            'reminder-end-type': 'end_type',
            'reminder-end-value': 'end_value',
            'reminder-persistence-mode': 'persistence_mode',
            'reminder-status': 'status',
        };
        if (Object.prototype.hasOwnProperty.call(mapping, target.id)) {
            form[mapping[target.id]] = target.value;
            if (target.id === 'reminder-time-mode' && form.time_mode === 'date_only') {
                form.pre_reminder_unit = 'days';
            }
            const rerenderIds = new Set([
                'reminder-time-mode',
                'reminder-schedule-kind',
                'reminder-date',
                'reminder-time',
                'reminder-frequency',
                'reminder-pre-unit',
                'reminder-end-type',
                'reminder-persistence-mode',
            ]);
            if (rerenderIds.has(target.id)) {
                this._render();
            }
            return;
        }
        const weekday = target.getAttribute('data-reminder-weekday');
        if (weekday !== null) {
            const value = Number.parseInt(weekday, 10);
            if (target.checked) {
                if (!form.weekdays.includes(value)) {
                    form.weekdays.push(value);
                    form.weekdays.sort();
                }
            } else {
                form.weekdays = form.weekdays.filter((entry) => entry !== value);
            }
        }
    }

    async _handleClick(event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }
        if (target.closest('[data-reminder-new]')) {
            this._state.form = defaultFormState();
            this._state.editingId = '';
            this._state.error = '';
            this._render();
            return;
        }
        if (target.closest('[data-reminder-save]')) {
            await this._save();
            return;
        }
        const row = target.closest('[data-reminder-id]');
        if (!(row instanceof HTMLElement)) {
            return;
        }
        const reminderId = row.getAttribute('data-reminder-id');
        if (typeof reminderId !== 'string' || reminderId.length === 0) {
            throw new Error('Reminder row missing id');
        }
        if (target.closest('[data-reminder-edit]')) {
            const reminder = this._state.reminders.find((entry) => entry.id === reminderId);
            if (!reminder) {
                throw new Error(`Reminder not found in modal state: ${reminderId}`);
            }
            this._state.form = stateFromReminder(reminder);
            this._state.editingId = reminderId;
            this._state.error = '';
            this._render();
            return;
        }
        if (target.closest('[data-reminder-delete]')) {
            await ReminderStore.delete(reminderId);
            return;
        }
        const actionButton = target.closest('[data-reminder-action]');
        if (actionButton instanceof HTMLElement) {
            const actionName = actionButton.getAttribute('data-reminder-action');
            const reminder = this._state.reminders.find((entry) => entry.id === reminderId);
            if (!reminder) {
                throw new Error(`Reminder not found in modal state: ${reminderId}`);
            }
            await ReminderStore.action(reminderId, actionName, {});
        }
    }

    async _save() {
        if (this._state.saving) {
            return;
        }
        this._state.error = '';
        this._state.saving = true;
        this._render();
        const payload = buildPayloadFromForm(this._state.form);
        await (async () => {
            if (this._state.editingId) {
                await ReminderStore.update(this._state.editingId, payload);
            } else {
                await ReminderStore.create(payload);
            }
            this._state.form = defaultFormState();
            this._state.editingId = '';
        })().finally(() => {
            this._state.saving = false;
            this._render();
        });
    }

}
