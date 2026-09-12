# Reminders

Reminders are privacy-first in-app scheduled prompts. They are not a task manager, calendar, habit tracker, or background notification system.

## Scope

Implemented now:

- Standalone reminders only.
- One-time and recurring schedules.
- Date-time and date-only time modes.
- Optional details text beyond the title.
- One optional pre-reminder per reminder.
- In-app popup surface with one action: `Got it`.
- Registry search and schedule filters: `All schedules`, `One Time`, `Daily`, `Weekly`, `Monthly`, `Yearly`.
- Pause/resume for recurring reminders.
- Delete for all reminders.

Intentionally not implemented:

- Note-attached reminders. The backend model keeps `attachment_type`, but attached reminders are rejected until there is a real note picker/search UX.
- Raw note ID entry in the UI.
- Browser/system push notifications, service workers, notification permissions, Web Push/VAPID, or OS-level reminder delivery.
- Reminder history/archive. When a one-time reminder is acknowledged, it is removed.
- Manual skip-next controls in the registry. Skipping a visible occurrence should happen from the reminder surface if that behavior is reintroduced.

## Privacy Model

Reminders only surface inside the visible, authenticated MetaList app.

They must not appear when the app is closed, logged out, backgrounded, or as browser/OS notifications. This is deliberate: reminder text can be private note-adjacent content, and it should not appear to another person using the laptop.

## Data Ownership

The server owns reminder truth.

- Backend service: `app/services/reminders.py`
- API routes: `app/api/routes/reminders.py`
- Client mirror: `app/static/js/modules/reminder-store.js`
- Registry/builder modal: `app/static/js/modules/modals/reminder-modal.js`
- Popup surface: `app/static/js/modules/reminder-surface-service.js`

The browser keeps an in-memory mirror only so it can surface due reminders without polling. After any create/update/delete/action, the client sends the mutation to the server and then refreshes the full reminder snapshot from the server. The client should not try to locally mutate its own reminder truth.

## Persistence

Reminders are namespace-local.

Rows live in the `reminders` table, but the payload is loaded into the in-memory reminder store at startup or after encrypted hydration. When namespace encryption is enabled, the full reminder JSON payload is encrypted at rest like other namespace-owned data.

Reminder ids are server-generated UUID strings. The client treats them as opaque ids.

## Scheduling

### Time Modes

`date_time` reminders fire at a specific local instant and use `scheduled_at` / `next_fire_at`.

`date_only` reminders are calendar-day prompts. They do not fire at midnight, morning, or any default wall-clock time. They become eligible on the relevant local date and surface on the first non-idle app use that day.

### Schedule Kinds

`one_time` reminders have one occurrence. Acknowledging that occurrence deletes the reminder from the store.

`recurring` reminders can be daily, weekly, monthly, or yearly. For monthly reminders, if the selected day does not exist in a later month, the occurrence rolls back to the last valid day of that month.

Weekly reminders use selected weekdays, not the creation date. Monthly/yearly reminders display the day/month pattern rather than the original creation date.

## Pre-reminders

A pre-reminder is optional extra data on the reminder definition. It is not stored as a separate reminder row.

V1 supports at most one pre-reminder per reminder. The actual reminder remains the canonical event; the pre-reminder is derived from the next event occurrence.

Supported offsets:

- Minutes before
- Hours before
- Days before

Date-only reminders only support day-based pre-reminders.

For date-time reminders:

- Minute/hour pre-reminders are exact instants: event time minus the offset.
- Day-based pre-reminders are date-only prompts. For example, a Wednesday 9:30 AM appointment with a 1-day pre-reminder surfaces on Tuesday on first app use, not exactly Tuesday at 9:30 AM.

`Got it` on a pre-reminder only marks that pre-reminder occurrence as seen. It does not advance, complete, or delete the actual reminder. If the actual reminder is already due, it takes priority over any unacknowledged pre-reminder; any visible pre-reminder for that same occurrence is removed when the actual reminder surfaces.

## Missed Behavior

Each reminder has a missed policy:

- `keep_until_seen`: the reminder remains due/overdue until acknowledged.
- `drop_if_missed`: the reminder can be advanced or removed without entering the visible missed state.

Visible due/overdue state is shown in the registry. Date-time popups display elapsed due time live. Date-only popups show calendar-day status such as due today or overdue.

## Popup Surface

The popup surface is intentionally compact:

- Fixed reminder icon is render-only; it is not stored.
- Title and optional details are shown.
- A horizontal rule separates content from the due status/action row.
- Due status is italic and shares a row with `Got it`.
- `Got it` acknowledges the current visible occurrence.
- When at least one popup is waiting for `Got it`, a bell plus up/down arrow appears below the stack.
- The arrow collapses or expands the stack; no arrow appears when nothing is waiting for `Got it`.
- The expanded/collapsed state is stored as the namespace-scoped `pref.reminder_surface_expanded` client preference in the main database, not in browser storage.
- Existing waiting popups use that stored state after browser refresh; a newly surfaced reminder automatically expands the stack and persists the expanded state.
- Popup items animate when they appear, disappear, and when the user manually expands/collapses the stack.

The surface reconciles rendered popups against each fresh server snapshot. If a reminder is deleted, paused, advanced, acknowledged, or otherwise no longer due, the stale popup is removed. If the same occurrence remains due but title/details changed, the popup content is re-rendered from the fresh snapshot. Pre-reminders use separate occurrence keys from actual reminders so acknowledging a pre-reminder cannot accidentally resolve the event itself.

## Silent reminders

Reminder popups and acknowledgment are silent. Sound settings and the reusable sound library have been removed; see [migration behavior](sounds.md).

## Client Evaluation

The client does not repeatedly poll the server for due reminders.

Snapshot refresh happens on app load, visibility return, reminder modal close, and after reminder mutations/actions. App load and visibility return count as non-idle visible app use for reminder evaluation. Date-time reminders use local timers against the in-memory mirror.

This keeps the server authoritative while avoiding pointless server traffic during idle time.

## UI Semantics

`Add reminder` and `Save changes` always clear back to the default new-reminder form after a successful create/update.

`Clear form` discards the current form state.

`Pause` is only shown for recurring reminders. One-time reminders can be edited or deleted; once acknowledged, they disappear.

`Delete` permanently removes the reminder definition.

`Got it` resolves the currently visible due/overdue occurrence. For one-time reminders this removes the reminder. For recurring reminders this advances to the next occurrence.

For pre-reminders, `Got it` only records the pre-reminder occurrence as seen.
