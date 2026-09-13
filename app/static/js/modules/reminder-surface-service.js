import { ApplicationState } from './application-state.js';
import { ReminderStore } from './reminder-store.js';
import { loadClientState, persistClientPreferences } from './client-state-api.js';

const NON_IDLE_THROTTLE_MS = 30_000;
const ELAPSED_UPDATE_MS = 1_000;
const REMINDER_RENDER_ICON = '🔔';

const OCCURRENCE_KIND_MAIN = 'main';
const OCCURRENCE_KIND_PRE = 'pre';
const REMINDER_SURFACE_TOGGLE_SELECTOR = '[data-reminder-surface-toggle]';
const REMINDER_SURFACE_OPEN_REGISTRY_SELECTOR = '[data-reminder-surface-open-registry]';
const REMINDER_SURFACE_EXPANDED_PREF = 'pref.reminder_surface_expanded';

function reminderDisplayTitle(reminder) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('reminderDisplayTitle requires reminder');
    }
    if (typeof reminder.title === 'string' && reminder.title.length > 0) {
        return reminder.title;
    }
    return 'Reminder';
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

function formatElapsedSince(value, now) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('formatElapsedSince requires value');
    }
    if (!(now instanceof Date)) {
        throw new Error('formatElapsedSince requires Date');
    }
    const dueAt = new Date(value);
    if (Number.isNaN(dueAt.getTime())) {
        throw new Error('formatElapsedSince requires valid datetime');
    }
    const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / 1000));
    if (elapsedSeconds < 1) {
        return 'Due now';
    }
    if (elapsedSeconds < 60) {
        return `Due ${elapsedSeconds} sec ago`;
    }
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    const remainingSeconds = elapsedSeconds % 60;
    if (elapsedMinutes < 60) {
        return `Due ${elapsedMinutes} min ${remainingSeconds} sec ago`;
    }
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    const remainingMinutes = elapsedMinutes % 60;
    if (elapsedHours < 24) {
        return `Due ${elapsedHours} hr ${remainingMinutes} min ago`;
    }
    const elapsedDays = Math.floor(elapsedHours / 24);
    const remainingHours = elapsedHours % 24;
    return `Due ${elapsedDays} day ${remainingHours} hr ago`;
}

function formatTimeUntilDateTime(value, now) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('formatTimeUntilDateTime requires value');
    }
    if (!(now instanceof Date)) {
        throw new Error('formatTimeUntilDateTime requires Date');
    }
    const eventAt = new Date(value);
    if (Number.isNaN(eventAt.getTime())) {
        throw new Error('formatTimeUntilDateTime requires valid datetime');
    }
    const remainingSeconds = Math.max(0, Math.ceil((eventAt.getTime() - now.getTime()) / 1000));
    if (remainingSeconds < 1) {
        return 'Event now';
    }
    if (remainingSeconds < 60) {
        return `Event in ${remainingSeconds} sec`;
    }
    const remainingMinutes = Math.floor(remainingSeconds / 60);
    const leftoverSeconds = remainingSeconds % 60;
    if (remainingMinutes < 60) {
        return `Event in ${remainingMinutes} min ${leftoverSeconds} sec`;
    }
    const remainingHours = Math.floor(remainingMinutes / 60);
    const leftoverMinutes = remainingMinutes % 60;
    if (remainingHours < 24) {
        return `Event in ${remainingHours} hr ${leftoverMinutes} min`;
    }
    const remainingDays = Math.floor(remainingHours / 24);
    const leftoverHours = remainingHours % 24;
    return `Event in ${remainingDays} day ${leftoverHours} hr`;
}

function localDateStringFromDate(value) {
    if (!(value instanceof Date)) {
        throw new Error('localDateStringFromDate requires Date');
    }
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatTimeUntilDateOnly(value, now) {
    if (typeof value !== 'string' || value.length !== 10) {
        throw new Error('formatTimeUntilDateOnly requires YYYY-MM-DD');
    }
    if (!(now instanceof Date)) {
        throw new Error('formatTimeUntilDateOnly requires Date');
    }
    const today = localDateStringFromDate(now);
    if (value < today) {
        return 'Event date passed';
    }
    if (value === today) {
        return 'Event today';
    }
    const eventDate = new Date(`${value}T00:00:00`);
    const todayDate = new Date(`${today}T00:00:00`);
    if (Number.isNaN(eventDate.getTime())) {
        throw new Error('formatTimeUntilDateOnly requires valid dates');
    }
    if (Number.isNaN(todayDate.getTime())) {
        throw new Error('formatTimeUntilDateOnly requires valid dates');
    }
    const remainingDays = Math.round((eventDate.getTime() - todayDate.getTime()) / (24 * 60 * 60 * 1000));
    if (remainingDays === 1) {
        return 'Event tomorrow';
    }
    return `Event in ${remainingDays} days`;
}

function dateOnlySurfaceLabel(eventKind) {
    if (eventKind === 'missed') {
        return 'Overdue';
    }
    if (eventKind === 'due') {
        return 'Due today';
    }
    throw new Error(`Unsupported reminder event kind: ${eventKind}`);
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

function subtractLocalDays(dateValue, days) {
    if (typeof dateValue !== 'string' || dateValue.length !== 10) {
        throw new Error('subtractLocalDays requires YYYY-MM-DD');
    }
    if (!Number.isInteger(days) || days < 1) {
        throw new Error('subtractLocalDays requires positive days');
    }
    const date = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
        throw new Error('subtractLocalDays requires valid date');
    }
    date.setDate(date.getDate() - days);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function localDateFromDateTime(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('localDateFromDateTime requires value');
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error('localDateFromDateTime requires valid datetime');
    }
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function preReminderKey(reminder, triggerValue, eventValue) {
    if (!reminder || typeof reminder !== 'object') {
        throw new Error('preReminderKey requires reminder');
    }
    if (typeof reminder.id !== 'string' || reminder.id.length === 0) {
        throw new Error('preReminderKey requires reminder id');
    }
    if (typeof triggerValue !== 'string' || triggerValue.length === 0) {
        throw new Error('preReminderKey requires triggerValue');
    }
    if (typeof eventValue !== 'string' || eventValue.length === 0) {
        throw new Error('preReminderKey requires eventValue');
    }
    return `${reminder.id}:pre:${triggerValue}:event:${eventValue}`;
}

class ReminderSurfaceService {
    constructor() {
        this._started = false;
        this._localDueTimer = null;
        this._isEvaluating = false;
        this._pendingEvaluationActivityKind = null;
        this._unsubscribeStore = null;
        this._shownOccurrenceKeys = new Set();
        this._elapsedTimers = new Map();
        this._lastNonIdleAt = 0;
        this._isExpanded = true;
        this._hasCompletedInitialEvaluation = true;
        this._handleInteraction = this._handleInteraction.bind(this);
        this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
        this._handleModalClosed = this._handleModalClosed.bind(this);
        this._handleStoreSnapshot = this._handleStoreSnapshot.bind(this);

        ApplicationState.own(this, 'ReminderSurfaceService', new.target === ReminderSurfaceService);
    }

    async start() {
        if (this._started) {
            return;
        }
        this._started = true;
        await this._loadExpandedPreference();

        this._hasCompletedInitialEvaluation = false;
        this._ensureContainer();
        document.addEventListener('pointerdown', this._handleInteraction, true);
        document.addEventListener('keydown', this._handleInteraction, true);
        document.addEventListener('visibilitychange', this._handleVisibilityChange);
        document.addEventListener('metalist:modal-closed', this._handleModalClosed);
        this._unsubscribeStore = ReminderStore.subscribe(this._handleStoreSnapshot);
        await this._refreshAndEvaluate('non_idle_use');
        this._hasCompletedInitialEvaluation = true;
    }

    stop() {
        if (!this._started) {
            return;
        }
        this._started = false;
        document.removeEventListener('pointerdown', this._handleInteraction, true);
        document.removeEventListener('keydown', this._handleInteraction, true);
        document.removeEventListener('visibilitychange', this._handleVisibilityChange);
        document.removeEventListener('metalist:modal-closed', this._handleModalClosed);
        if (typeof this._unsubscribeStore === 'function') {
            this._unsubscribeStore();
            this._unsubscribeStore = null;
        }
        this._clearLocalDueTimer();
        this._clearElapsedTimers();
        if (this._shownOccurrenceKeys.size > 0) this._shownOccurrenceKeys.clear();
        this._syncExpandedState();
    }

    async _handleInteraction() {
        if (document.visibilityState !== 'visible') {
            return;
        }
        const now = Date.now();
        if (now - this._lastNonIdleAt < NON_IDLE_THROTTLE_MS) {
            return;
        }
        this._lastNonIdleAt = now;
        await this._evaluate('non_idle_use');
    }

    _handleVisibilityChange() {
        if (document.visibilityState === 'visible') {
            void this._refreshAndEvaluate('non_idle_use');
        }
    }

    _handleModalClosed(event) {
        if (!event || typeof event !== 'object') {
            throw new Error('Reminder modal close event missing');
        }
        if (!event.detail || event.detail.modalName !== 'reminderModal') {
            return;
        }
        void this._refreshAndEvaluate('non_idle_use');
    }

    async _refreshAndEvaluate(activityKind) {
        if (activityKind !== 'idle' && activityKind !== 'non_idle_use') {
            throw new Error('Reminder refresh/evaluate activityKind invalid');
        }
        if (document.visibilityState !== 'visible') {
            return;
        }
        this._queueEvaluation(activityKind);
        await ReminderStore.refresh();
        await this._drainEvaluationQueue();
    }

    async _evaluate(activityKind) {
        if (activityKind !== 'idle' && activityKind !== 'non_idle_use') {
            throw new Error('Reminder evaluation activityKind invalid');
        }
        if (document.visibilityState !== 'visible') {
            return;
        }
        this._queueEvaluation(activityKind);
        await this._drainEvaluationQueue();
    }

    async evaluateFreshSnapshot(activityKind) {
        if (activityKind !== 'idle' && activityKind !== 'non_idle_use') {
            throw new Error('Reminder surface public evaluation activityKind invalid');
        }
        if (!this._started) {
            await this.start();
        }
        await this._evaluate(activityKind);
    }

    _handleStoreSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') {
            throw new Error('Reminder store snapshot missing');
        }
        if (!Array.isArray(snapshot.reminders)) {
            throw new Error('Reminder store snapshot missing reminders');
        }
        if (!Array.isArray(snapshot.missed)) {
            throw new Error('Reminder store snapshot missing missed');
        }
        this._reconcileRenderedItems(snapshot);
        this._scheduleNextLocalDueTimer();
        if (document.visibilityState !== 'visible') {
            return;
        }
        void this._evaluate('non_idle_use');
    }

    _queueEvaluation(activityKind) {
        if (activityKind !== 'idle' && activityKind !== 'non_idle_use') {
            throw new Error('Reminder queue activityKind invalid');
        }
        if (activityKind === 'non_idle_use' && this._pendingEvaluationActivityKind !== 'non_idle_use') {
            this._pendingEvaluationActivityKind = 'non_idle_use';
            return;
        }
        if (this._pendingEvaluationActivityKind === null) {
            this._pendingEvaluationActivityKind = 'idle';
        }
    }

    async _drainEvaluationQueue() {
        if (this._isEvaluating) {
            return;
        }
        if (this._pendingEvaluationActivityKind === null) {
            return;
        }
        const activityKind = this._pendingEvaluationActivityKind;
        this._pendingEvaluationActivityKind = null;
        this._isEvaluating = true;
        await (async () => {
            const events = this._localEvents(activityKind);
            for (const event of events) {
                this._renderEvent(event);
            }
        })().finally(() => {
            this._isEvaluating = false;
        });
        if (this._pendingEvaluationActivityKind !== null) {
            await this._drainEvaluationQueue();
        }
        this._scheduleNextLocalDueTimer();
    }

    _localEvents(activityKind) {
        if (activityKind !== 'idle' && activityKind !== 'non_idle_use') {
            throw new Error('Reminder local activityKind invalid');
        }
        const now = new Date();
        const today = this._localDate(now);
        const events = [];
        const snapshot = ReminderStore.snapshot();
        for (const reminder of snapshot.reminders) {
            const event = this._localEventForReminder(reminder, activityKind, now, today);
            if (event !== null) {
                events.push(event);
            }
        }
        return events;
    }

    _localEventForReminder(reminder, activityKind, now, today) {
        if (!reminder || typeof reminder !== 'object') {
            throw new Error('Reminder mirror entry must be object');
        }
        const event = this._currentEvent(reminder, activityKind, now, today);
        if (event === null) {
            return null;
        }
        return this._eventIfNotShown(event);
    }

    _currentEvent(reminder, activityKind, now, today) {
        if (!reminder || typeof reminder !== 'object') {
            throw new Error('Reminder occurrence requires reminder');
        }
        if (activityKind !== 'idle' && activityKind !== 'non_idle_use') {
            throw new Error('Reminder occurrence activityKind invalid');
        }
        if (!(now instanceof Date)) {
            throw new Error('Reminder occurrence requires now Date');
        }
        if (typeof today !== 'string' || today.length === 0) {
            throw new Error('Reminder occurrence requires local date');
        }
        if (reminder.status !== 'active') {
            return null;
        }
        const mainEvent = this._mainEventForReminder(reminder, activityKind, now, today);
        if (mainEvent !== null) {
            return mainEvent;
        }
        return this._preEventForReminder(reminder, activityKind, now, today);
    }

    _mainEventForReminder(reminder, activityKind, now, today) {
        if (!reminder || typeof reminder !== 'object') {
            throw new Error('_mainEventForReminder requires reminder');
        }
        if (reminder.time_mode === 'date_time') {
            if (typeof reminder.next_fire_at !== 'string' || reminder.next_fire_at.length === 0) {
                return null;
            }
            const fireAt = new Date(reminder.next_fire_at);
            if (Number.isNaN(fireAt.getTime())) {
                throw new Error('Reminder mirror has invalid next_fire_at');
            }
            if (fireAt.getTime() > now.getTime()) {
                return null;
            }
            return {
                kind: fireAt.getTime() < now.getTime() ? 'missed' : 'due',
                reminder,
                occurrenceKind: OCCURRENCE_KIND_MAIN,
                occurrenceValue: reminder.next_fire_at,
                isDateOnly: false,
            };
        }
        if (activityKind !== 'non_idle_use') {
            return null;
        }
        if (typeof reminder.next_fire_date !== 'string' || reminder.next_fire_date.length === 0) {
            return null;
        }
        if (reminder.next_fire_date > today) {
            return null;
        }
        return {
            kind: reminder.next_fire_date < today ? 'missed' : 'due',
            reminder,
            occurrenceKind: OCCURRENCE_KIND_MAIN,
            occurrenceValue: reminder.next_fire_date,
            isDateOnly: true,
        };
    }

    _preEventForReminder(reminder, activityKind, now, today) {
        if (!reminder || typeof reminder !== 'object') {
            throw new Error('_preEventForReminder requires reminder');
        }
        const preReminder = reminderPreReminder(reminder);
        if (preReminder === null) {
            return null;
        }
        const trigger = this._preTriggerForReminder(reminder, preReminder);
        if (trigger === null) {
            return null;
        }
        if (reminder.pre_reminder_last_seen_key === trigger.key) {
            return null;
        }
        if (trigger.isDateOnly) {
            if (activityKind !== 'non_idle_use') {
                return null;
            }
            if (trigger.value > today) {
                return null;
            }
            return {
                kind: trigger.value < today ? 'pre_missed' : 'pre_due',
                reminder,
                occurrenceKind: OCCURRENCE_KIND_PRE,
                occurrenceValue: trigger.value,
                isDateOnly: true,
                actualEventValue: trigger.actualEventValue,
                actualEventIsDateOnly: trigger.actualEventIsDateOnly,
                preReminderKey: trigger.key,
            };
        }
        if (trigger.fireAt.getTime() > now.getTime()) {
            return null;
        }
        return {
            kind: trigger.fireAt.getTime() < now.getTime() ? 'pre_missed' : 'pre_due',
            reminder,
            occurrenceKind: OCCURRENCE_KIND_PRE,
            occurrenceValue: trigger.value,
            isDateOnly: false,
            actualEventValue: trigger.actualEventValue,
            actualEventIsDateOnly: trigger.actualEventIsDateOnly,
            preReminderKey: trigger.key,
        };
    }

    _preTriggerForReminder(reminder, preReminder) {
        if (!reminder || typeof reminder !== 'object') {
            throw new Error('_preTriggerForReminder requires reminder');
        }
        if (!preReminder || typeof preReminder !== 'object') {
            throw new Error('_preTriggerForReminder requires preReminder');
        }
        if (reminder.time_mode === 'date_only') {
            if (preReminder.unit !== 'days') {
                return null;
            }
            if (typeof reminder.next_fire_date !== 'string' || reminder.next_fire_date.length === 0) {
                return null;
            }
            const triggerValue = subtractLocalDays(reminder.next_fire_date, preReminder.amount);
            return {
                value: triggerValue,
                isDateOnly: true,
                actualEventValue: reminder.next_fire_date,
                actualEventIsDateOnly: true,
                key: preReminderKey(reminder, triggerValue, reminder.next_fire_date),
            };
        }
        if (typeof reminder.next_fire_at !== 'string' || reminder.next_fire_at.length === 0) {
            return null;
        }
        if (preReminder.unit === 'days') {
            const eventDate = localDateFromDateTime(reminder.next_fire_at);
            const triggerValue = subtractLocalDays(eventDate, preReminder.amount);
            return {
                value: triggerValue,
                isDateOnly: true,
                actualEventValue: eventDate,
                actualEventIsDateOnly: true,
                key: preReminderKey(reminder, triggerValue, reminder.next_fire_at),
            };
        }
        const fireAt = new Date(reminder.next_fire_at);
        if (Number.isNaN(fireAt.getTime())) {
            throw new Error('Reminder mirror has invalid next_fire_at');
        }
        const offsetMs = preReminder.unit === 'hours'
            ? preReminder.amount * 60 * 60 * 1000
            : preReminder.amount * 60 * 1000;
        const triggerDate = new Date(fireAt.getTime() - offsetMs);
        const triggerValue = triggerDate.toISOString();
        return {
            value: triggerValue,
            fireAt: triggerDate,
            isDateOnly: false,
            actualEventValue: reminder.next_fire_at,
            actualEventIsDateOnly: false,
            key: preReminderKey(reminder, triggerValue, reminder.next_fire_at),
        };
    }

    _eventIfNotShown(event) {
        if (!event || typeof event !== 'object') {
            throw new Error('_eventIfNotShown requires event');
        }
        const reminder = event.reminder;
        if (typeof reminder.id !== 'string' || reminder.id.length === 0) {
            throw new Error('Reminder mirror entry missing id');
        }
        const occurrenceKey = `${reminder.id}:${event.occurrenceKind}:${event.occurrenceValue}`;
        if (this._shownOccurrenceKeys.has(occurrenceKey)) {
            return null;
        }
        this._shownOccurrenceKeys.add(occurrenceKey);
        return event;
    }

    _scheduleNextLocalDueTimer() {
        this._clearLocalDueTimer();
        const delayMs = this._nextDateTimeDelayMs();
        if (delayMs === null) {
            return;
        }
        this._localDueTimer = window.setTimeout(() => {
            this._localDueTimer = null;
            void this._evaluate('idle');
        }, delayMs);
    }

    _clearLocalDueTimer() {
        if (this._localDueTimer === null) {
            return;
        }
        window.clearTimeout(this._localDueTimer);
        this._localDueTimer = null;
    }

    _nextDateTimeDelayMs() {
        const nowMs = Date.now();
        let nearestMs = null;
        const snapshot = ReminderStore.snapshot();
        for (const reminder of snapshot.reminders) {
            if (!reminder || typeof reminder !== 'object') {
                throw new Error('Reminder mirror entry must be object');
            }
            if (reminder.status !== 'active') {
                continue;
            }
            if (reminder.time_mode !== 'date_time') {
                continue;
            }
            if (typeof reminder.next_fire_at !== 'string' || reminder.next_fire_at.length === 0) {
                continue;
            }
            const fireAt = new Date(reminder.next_fire_at);
            if (Number.isNaN(fireAt.getTime())) {
                throw new Error('Reminder mirror has invalid next_fire_at');
            }
            const fireAtMs = fireAt.getTime();
            if (fireAtMs <= nowMs) {
                continue;
            }
            if (nearestMs === null || fireAtMs < nearestMs) {
                nearestMs = fireAtMs;
            }
            const preReminder = reminderPreReminder(reminder);
            if (preReminder !== null && preReminder.unit !== 'days') {
                const trigger = this._preTriggerForReminder(reminder, preReminder);
                if (trigger !== null && trigger.isDateOnly === false && reminder.pre_reminder_last_seen_key !== trigger.key) {
                    const triggerMs = trigger.fireAt.getTime();
                    if (triggerMs > nowMs && (nearestMs === null || triggerMs < nearestMs)) {
                        nearestMs = triggerMs;
                    }
                }
            }
        }
        if (nearestMs === null) {
            return null;
        }
        return nearestMs - nowMs;
    }

    _localDate(value) {
        if (!(value instanceof Date)) {
            throw new Error('_localDate requires Date');
        }
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, '0');
        const day = String(value.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    _ensureContainer() {
        let container = document.getElementById('reminder-surface');
        if (container) {
            return container;
        }
        container = document.createElement('div');
        container.id = 'reminder-surface';
        container.className = 'reminder-surface';
        document.body.appendChild(container);
        container.addEventListener('click', (event) => {
            void this._handleSurfaceClick(event);
        });
        this._syncExpandedState();
        return container;
    }

    _renderEvent(event) {
        if (!event || typeof event !== 'object') {
            throw new Error('Reminder event must be object');
        }
        const reminder = event.reminder;
        if (!reminder || typeof reminder !== 'object') {
            throw new Error('Reminder event missing reminder');
        }
        const container = this._ensureContainer();
        if (event.occurrenceKind === OCCURRENCE_KIND_MAIN) {
            this._removeRenderedPreRemindersForReminder(reminder.id);
        }
        const item = document.createElement('div');
        item.className = 'reminder-surface-item';
        item.dataset.reminderId = reminder.id;
        item.dataset.occurrenceKind = event.occurrenceKind;
        item.dataset.occurrenceValue = event.occurrenceValue;
        if (event.occurrenceKind === OCCURRENCE_KIND_PRE) {
            item.dataset.preReminderKey = event.preReminderKey;
        }
        this._renderSurfaceItemContent(item, event);
        const toggle = container.querySelector(REMINDER_SURFACE_TOGGLE_SELECTOR);
        if (toggle instanceof HTMLElement) {
            container.insertBefore(item, toggle);
        } else {
            container.appendChild(item);
        }
        this._animateSurfaceItemEnter(item);
        if (this._hasCompletedInitialEvaluation && !this._isExpanded) {
            void this._setExpanded(true);
        } else {
            this._syncExpandedState();
        }

        this._syncToggleControl();
    }

    _removeRenderedPreRemindersForReminder(reminderId) {
        if (typeof reminderId !== 'string') {
            throw new Error('_removeRenderedPreRemindersForReminder requires reminderId');
        }
        if (reminderId.length === 0) {
            throw new Error('_removeRenderedPreRemindersForReminder requires reminderId');
        }
        const container = this._ensureContainer();
        const items = Array.from(container.querySelectorAll('.reminder-surface-item'));
        for (const item of items) {
            if (!(item instanceof HTMLElement)) {
                throw new Error('Reminder surface query returned non-element');
            }
            if (item.dataset.reminderId !== reminderId) {
                continue;
            }
            if (item.dataset.occurrenceKind !== OCCURRENCE_KIND_PRE) {
                continue;
            }
            this._removeSurfaceItem(item);
        }
    }

    _renderSurfaceItemContent(item, event) {
        if (!(item instanceof HTMLElement)) {
            throw new Error('_renderSurfaceItemContent requires item');
        }
        if (!event || typeof event !== 'object') {
            throw new Error('_renderSurfaceItemContent requires event');
        }
        const reminder = event.reminder;
        if (!reminder || typeof reminder !== 'object') {
            throw new Error('_renderSurfaceItemContent requires reminder');
        }
        const surfaceText = this._surfaceEventText(event);
        const details = reminderDetails(reminder);
        const title = reminderDisplayTitle(reminder);

        this._clearElapsedTimerForItem(item);
        item.dataset.reminderTitle = title;
        item.innerHTML = `
            <div class="reminder-surface-text">
                <button type="button" class="reminder-surface-title" data-reminder-surface-open-registry="true" title="Open in Reminders">
                    <span class="reminder-surface-icon" aria-hidden="true">${REMINDER_RENDER_ICON}</span>

                    <span class="reminder-surface-title-text">${this._escape(title)}</span>
                </button>
                ${details ? `<span class="reminder-surface-details">${this._escape(details)}</span>` : ''}
                <hr class="reminder-surface-rule">
            </div>
            <div class="reminder-surface-footer">
                <span class="reminder-surface-status" data-reminder-surface-text>${this._escape(surfaceText)}</span>
                <button type="button" data-reminder-surface-action="acknowledge" title="Clear this due or missed notice">Got it</button>
            </div>
        `;
        this._startElapsedTimerIfNeeded(item, event);
    }

    _reconcileRenderedItems(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') {
            throw new Error('_reconcileRenderedItems requires snapshot');
        }
        if (!Array.isArray(snapshot.reminders)) {
            throw new Error('_reconcileRenderedItems requires reminders');
        }
        const container = this._ensureContainer();
        const items = Array.from(container.querySelectorAll('.reminder-surface-item'));
        if (items.length === 0) {
            this._syncToggleControl();
            return;
        }
        const activeOccurrenceEvents = this._activeOccurrenceEvents(snapshot.reminders);
        const activeOccurrenceKeys = new Set(activeOccurrenceEvents.keys());
        this._pruneShownOccurrenceKeys(activeOccurrenceKeys);
        for (const item of items) {
            if (!(item instanceof HTMLElement)) {
                throw new Error('Reminder surface query returned non-element');
            }
            const reminderId = item.dataset.reminderId;
            const occurrenceKind = item.dataset.occurrenceKind;
            const occurrenceValue = item.dataset.occurrenceValue;
            if (typeof reminderId !== 'string' || reminderId.length === 0) {
                throw new Error('Reminder surface item missing reminder id');
            }
            if (typeof occurrenceKind !== 'string' || occurrenceKind.length === 0) {
                throw new Error('Reminder surface item missing occurrence kind');
            }
            if (typeof occurrenceValue !== 'string' || occurrenceValue.length === 0) {
                throw new Error('Reminder surface item missing occurrence value');
            }
            const occurrenceKey = `${reminderId}:${occurrenceKind}:${occurrenceValue}`;
            const activeEvent = activeOccurrenceEvents.get(occurrenceKey);
            if (activeEvent === undefined) {
                this._removeSurfaceItem(item);
                continue;
            }
            this._renderSurfaceItemContent(item, activeEvent);
        }
        this._syncToggleControl();
    }

    _activeOccurrenceEvents(reminders) {
        if (!Array.isArray(reminders)) {
            throw new Error('_activeOccurrenceEvents requires reminders');
        }
        const events = new Map();
        const now = new Date();
        const today = this._localDate(now);
        for (const reminder of reminders) {
            if (!reminder || typeof reminder !== 'object') {
                throw new Error('Reminder mirror entry must be object');
            }
            const event = this._currentEvent(reminder, 'non_idle_use', now, today);
            if (event === null) {
                continue;
            }
            if (typeof reminder.id !== 'string' || reminder.id.length === 0) {
                throw new Error('Reminder mirror entry missing id');
            }
            events.set(`${reminder.id}:${event.occurrenceKind}:${event.occurrenceValue}`, event);
        }
        return events;
    }

    _pruneShownOccurrenceKeys(activeOccurrenceKeys) {
        if (!(activeOccurrenceKeys instanceof Set)) {
            throw new Error('_pruneShownOccurrenceKeys requires Set');
        }
        for (const occurrenceKey of Array.from(this._shownOccurrenceKeys)) {
            if (!activeOccurrenceKeys.has(occurrenceKey)) {
                this._shownOccurrenceKeys.delete(occurrenceKey);
            }
        }
    }

    async _handleSurfaceClick(event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }
        const toggleButton = target.closest(REMINDER_SURFACE_TOGGLE_SELECTOR);
        if (toggleButton instanceof HTMLElement) {
            await this._setExpanded(!this._isExpanded);
            return;
        }
        const item = target.closest('.reminder-surface-item');
        if (!(item instanceof HTMLElement)) {
            return;
        }
        const openRegistryButton = target.closest(REMINDER_SURFACE_OPEN_REGISTRY_SELECTOR);
        if (openRegistryButton instanceof HTMLElement) {
            const reminderTitle = item.dataset.reminderTitle;
            if (typeof reminderTitle !== 'string' || reminderTitle.length === 0) {
                throw new Error('Reminder surface item missing title');
            }
            document.dispatchEvent(new CustomEvent('metalist:open-reminders', {
                detail: { search: reminderTitle },
            }));
            return;
        }
        const actionButton = target.closest('[data-reminder-surface-action]');
        if (!(actionButton instanceof HTMLElement)) {
            return;
        }
        const reminderId = item.dataset.reminderId;
        if (typeof reminderId !== 'string' || reminderId.length === 0) {
            throw new Error('Reminder surface item missing reminder id');
        }
        let actionName = actionButton.getAttribute('data-reminder-surface-action');
        if (typeof actionName !== 'string' || actionName.length === 0) {
            throw new Error('Reminder surface action missing');
        }
        let actionPayload = {};
        if (item.dataset.occurrenceKind === OCCURRENCE_KIND_PRE) {
            actionName = 'pre_acknowledge';
            const preReminderKey = item.dataset.preReminderKey;
            if (typeof preReminderKey !== 'string' || preReminderKey.length === 0) {
                throw new Error('Pre-reminder surface item missing key');
            }
            actionPayload = { pre_reminder_key: preReminderKey };
        }
        const snapshot = ReminderStore.snapshot();
        const reminder = snapshot.reminders.find((entry) => entry.id === reminderId);
        if (!reminder) {
            throw new Error(`Reminder not found in store snapshot: ${reminderId}`);
        }
        await ReminderStore.action(reminderId, actionName, actionPayload);

        this._removeSurfaceItem(item);
    }

    async _setExpanded(isExpanded) {
        if (typeof isExpanded !== 'boolean') {
            throw new Error('_setExpanded requires boolean');
        }
        this._isExpanded = isExpanded;
        this._animateExpandedStateChange(isExpanded);
        this._syncToggleControl();
        await this._persistExpandedPreference();
    }

    _syncExpandedState() {
        const container = document.getElementById('reminder-surface');
        if (!(container instanceof HTMLElement)) {
            return;
        }
        container.classList.toggle('is-collapsed', this._isExpanded === false);
        const items = Array.from(container.querySelectorAll('.reminder-surface-item'));
        for (const item of items) {
            if (!(item instanceof HTMLElement)) {
                throw new Error('Reminder surface query returned non-element');
            }
            if (this._isExpanded) {
                item.classList.remove('is-stack-collapsed');
                item.removeAttribute('aria-hidden');
                item.style.height = '';
            } else {
                item.classList.add('is-stack-collapsed');
                item.setAttribute('aria-hidden', 'true');
                item.style.height = '0px';
            }
        }
    }

    _animateExpandedStateChange(isExpanded) {
        if (typeof isExpanded !== 'boolean') {
            throw new Error('_animateExpandedStateChange requires boolean');
        }
        const container = document.getElementById('reminder-surface');
        if (!(container instanceof HTMLElement)) {
            return;
        }
        container.classList.toggle('is-collapsed', isExpanded === false);
        const items = Array.from(container.querySelectorAll('.reminder-surface-item'));
        for (const item of items) {
            if (!(item instanceof HTMLElement)) {
                throw new Error('Reminder surface query returned non-element');
            }
            if (item.classList.contains('is-exiting')) {
                continue;
            }
            if (isExpanded) {
                this._animateSurfaceItemStackExpand(item);
            } else {
                this._animateSurfaceItemStackCollapse(item);
            }
        }
    }

    _syncToggleControl() {
        const container = this._ensureContainer();
        const itemCount = this._surfaceItemCount(container);
        let toggle = container.querySelector(REMINDER_SURFACE_TOGGLE_SELECTOR);
        if (itemCount === 0) {
            if (toggle instanceof HTMLElement) {
                toggle.remove();
            }
            return;
        }
        if (!(toggle instanceof HTMLElement)) {
            toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'reminder-surface-toggle';
            toggle.setAttribute('data-reminder-surface-toggle', 'true');
            container.appendChild(toggle);
        }
        this._renderToggleControl(toggle, itemCount);
        if (toggle.parentElement === container && container.lastElementChild !== toggle) {
            container.appendChild(toggle);
        }
    }

    async _loadExpandedPreference() {
        const clientState = await loadClientState();
        if (!clientState || typeof clientState !== 'object') {
            throw new Error('Reminder surface client state missing');
        }
        const preferences = clientState.preferences;
        if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
            throw new Error('Reminder surface client preferences missing');
        }
        if (!Object.prototype.hasOwnProperty.call(preferences, REMINDER_SURFACE_EXPANDED_PREF)) {
            if (!this._isExpanded) this._isExpanded = true;
            return;
        }
        const raw = preferences[REMINDER_SURFACE_EXPANDED_PREF];
        if (raw === 'true') {
            if (!this._isExpanded) this._isExpanded = true;
            return;
        }
        if (raw === 'false') {
            if (this._isExpanded) this._isExpanded = false;
            return;
        }
        throw new Error(`Invalid stored boolean for ${REMINDER_SURFACE_EXPANDED_PREF}`);
    }

    async _persistExpandedPreference() {
        const clientState = await loadClientState();
        if (!clientState || typeof clientState !== 'object') {
            throw new Error('Reminder surface client state missing');
        }
        const preferences = clientState.preferences;
        if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
            throw new Error('Reminder surface client preferences missing');
        }
        await persistClientPreferences({
            ...preferences,
            [REMINDER_SURFACE_EXPANDED_PREF]: this._isExpanded ? 'true' : 'false',
        });
    }

    _surfaceItemCount(container) {
        if (!(container instanceof HTMLElement)) {
            throw new Error('_surfaceItemCount requires container');
        }
        return container.querySelectorAll('.reminder-surface-item').length;
    }

    _renderToggleControl(toggle, itemCount) {
        if (!(toggle instanceof HTMLElement)) {
            throw new Error('_renderToggleControl requires toggle');
        }
        if (!Number.isInteger(itemCount) || itemCount < 1) {
            throw new Error('_renderToggleControl requires positive itemCount');
        }
        const action = this._isExpanded ? 'Collapse' : 'Expand';
        const arrow = this._isExpanded ? '↑' : '↓';
        toggle.setAttribute('aria-label', `${action} ${itemCount} active reminder${itemCount === 1 ? '' : 's'}`);
        toggle.setAttribute('title', `${action} reminders`);
        toggle.setAttribute('aria-expanded', this._isExpanded ? 'true' : 'false');
        toggle.innerHTML = `
            <span class="reminder-surface-icon" aria-hidden="true">${REMINDER_RENDER_ICON}</span>
            <span class="reminder-surface-toggle-arrow" aria-hidden="true">${arrow}</span>
        `;
    }

    _surfaceEventText(event) {
        if (!event || typeof event !== 'object') {
            throw new Error('Reminder surface text requires event');
        }
        const reminder = event.reminder;
        if (!reminder || typeof reminder !== 'object') {
            throw new Error('Reminder surface text requires reminder');
        }
        if (event.occurrenceKind === OCCURRENCE_KIND_PRE) {
            if (typeof event.actualEventValue !== 'string') {
                throw new Error('Pre-reminder event missing actualEventValue');
            }
            if (event.actualEventValue.length === 0) {
                throw new Error('Pre-reminder event missing actualEventValue');
            }
            if (event.actualEventIsDateOnly === true) {
                return `Pre-reminder · ${formatTimeUntilDateOnly(event.actualEventValue, new Date())}`;
            }
            return `Pre-reminder · ${formatTimeUntilDateTime(event.actualEventValue, new Date())}`;
        }
        if (reminder.time_mode === 'date_time') {
            if (typeof event.occurrenceValue !== 'string' || event.occurrenceValue.length === 0) {
                throw new Error('date-time reminder event requires occurrenceValue');
            }
            return formatElapsedSince(event.occurrenceValue, new Date());
        }
        return dateOnlySurfaceLabel(event.kind);
    }

    _startElapsedTimerIfNeeded(item, event) {
        if (!(item instanceof HTMLElement)) {
            throw new Error('_startElapsedTimerIfNeeded requires HTMLElement');
        }
        if (!event || typeof event !== 'object') {
            throw new Error('_startElapsedTimerIfNeeded requires event');
        }
        const reminder = event.reminder;
        if (!reminder || typeof reminder !== 'object') {
            throw new Error('_startElapsedTimerIfNeeded requires reminder');
        }
        if (event.occurrenceKind === OCCURRENCE_KIND_PRE && event.actualEventIsDateOnly === true) {
            return;
        }
        if (event.occurrenceKind !== OCCURRENCE_KIND_PRE && event.isDateOnly === true) {
            return;
        }
        if (event.occurrenceKind === OCCURRENCE_KIND_PRE) {
            if (typeof event.actualEventValue !== 'string') {
                throw new Error('pre-reminder event requires actualEventValue');
            }
            if (event.actualEventValue.length === 0) {
                throw new Error('pre-reminder event requires actualEventValue');
            }
        }
        if (event.occurrenceKind !== OCCURRENCE_KIND_PRE) {
            if (typeof event.occurrenceValue !== 'string') {
                throw new Error('date-time reminder event requires occurrenceValue');
            }
            if (event.occurrenceValue.length === 0) {
                throw new Error('date-time reminder event requires occurrenceValue');
            }
        }
        const textElement = item.querySelector('[data-reminder-surface-text]');
        if (!(textElement instanceof HTMLElement)) {
            throw new Error('reminder surface text element missing');
        }
        const timerId = window.setInterval(() => {
            textElement.textContent = this._surfaceEventText(event);
        }, ELAPSED_UPDATE_MS);
        this._elapsedTimers.set(item, timerId);
    }

    _removeSurfaceItem(item) {
        if (!(item instanceof HTMLElement)) {
            throw new Error('_removeSurfaceItem requires HTMLElement');
        }
        if (item.classList.contains('is-exiting')) {
            return;
        }
        this._clearElapsedTimerForItem(item);
        const currentHeight = item.getBoundingClientRect().height;
        item.style.height = `${currentHeight}px`;
        item.getBoundingClientRect();
        item.classList.add('is-exiting');
        let didRemove = false;
        const removeAfterTransition = () => {
            if (didRemove) {
                return;
            }
            didRemove = true;
            item.remove();
            this._syncToggleControl();
        };
        item.addEventListener('transitionend', (event) => {
            if (event.propertyName !== 'height') {
                return;
            }
            removeAfterTransition();
        }, { once: true });
        window.requestAnimationFrame(() => {
            item.style.height = '0px';
        });
        window.setTimeout(removeAfterTransition, 240);
    }

    _animateSurfaceItemEnter(item) {
        if (!(item instanceof HTMLElement)) {
            throw new Error('_animateSurfaceItemEnter requires HTMLElement');
        }
        const targetHeight = item.getBoundingClientRect().height;
        item.style.height = '0px';
        item.classList.add('is-entering');
        item.getBoundingClientRect();
        let didFinish = false;
        const finishEnter = () => {
            if (didFinish) {
                return;
            }
            didFinish = true;
            item.style.height = '';
        };
        item.addEventListener('transitionend', (event) => {
            if (event.propertyName !== 'height') {
                return;
            }
            finishEnter();
        }, { once: true });
        window.requestAnimationFrame(() => {
            item.classList.remove('is-entering');
            item.style.height = `${targetHeight}px`;
        });
        window.setTimeout(finishEnter, 240);
    }

    _animateSurfaceItemStackCollapse(item) {
        if (!(item instanceof HTMLElement)) {
            throw new Error('_animateSurfaceItemStackCollapse requires HTMLElement');
        }
        if (item.classList.contains('is-stack-collapsed')) {
            return;
        }
        const currentHeight = item.getBoundingClientRect().height;
        item.style.height = `${currentHeight}px`;
        item.getBoundingClientRect();
        window.requestAnimationFrame(() => {
            item.classList.add('is-stack-collapsed');
            item.setAttribute('aria-hidden', 'true');
            item.style.height = '0px';
        });
    }

    _animateSurfaceItemStackExpand(item) {
        if (!(item instanceof HTMLElement)) {
            throw new Error('_animateSurfaceItemStackExpand requires HTMLElement');
        }
        if (!item.classList.contains('is-stack-collapsed')) {
            return;
        }
        const targetHeight = this._measureExpandedSurfaceItemHeight(item);
        item.style.height = '0px';
        item.getBoundingClientRect();
        let didFinish = false;
        const finishExpand = () => {
            if (didFinish) {
                return;
            }
            didFinish = true;
            item.style.height = '';
        };
        item.addEventListener('transitionend', (event) => {
            if (event.propertyName !== 'height') {
                return;
            }
            finishExpand();
        }, { once: true });
        window.requestAnimationFrame(() => {
            item.classList.remove('is-stack-collapsed');
            item.removeAttribute('aria-hidden');
            item.style.height = `${targetHeight}px`;
        });
        window.setTimeout(finishExpand, 240);
    }

    _measureExpandedSurfaceItemHeight(item) {
        if (!(item instanceof HTMLElement)) {
            throw new Error('_measureExpandedSurfaceItemHeight requires HTMLElement');
        }
        const previousHeight = item.style.height;
        const previousTransition = item.style.transition;
        item.style.transition = 'none';
        item.classList.remove('is-stack-collapsed');
        item.style.height = '';
        const targetHeight = item.getBoundingClientRect().height;
        item.classList.add('is-stack-collapsed');
        item.style.height = previousHeight;
        item.getBoundingClientRect();
        item.style.transition = previousTransition;
        return targetHeight;
    }

    _clearElapsedTimerForItem(item) {
        if (!(item instanceof HTMLElement)) {
            throw new Error('_clearElapsedTimerForItem requires HTMLElement');
        }
        const timerId = this._elapsedTimers.get(item);
        if (timerId !== undefined) {
            window.clearInterval(timerId);
            this._elapsedTimers.delete(item);
        }
    }

    _clearElapsedTimers() {
        for (const timerId of this._elapsedTimers.values()) {
            window.clearInterval(timerId);
        }
        if (this._elapsedTimers.size > 0) this._elapsedTimers.clear();
    }

    _escape(value) {
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
}

export const ReminderSurface = new ReminderSurfaceService();
