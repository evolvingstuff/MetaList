import assert from 'node:assert/strict';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppIdle } from './browser-app-idle.mjs';

// The Reminders popup handles its own clicks (docs/ui/reminders.md): pressing
// "Got it" while a note is being edited clears the reminder on the first press,
// and the note stays in edit mode with its caret, as pressing any floating card does.

// The network counts as idle after this long without a request.
const NETWORK_IDLE_MS = 300;
const SETTLE_MS = 400;
const MS_PER_MINUTE = 60 * 1000;
const ACKNOWLEDGE_SELECTOR = '#reminder-surface [data-reminder-surface-action="acknowledge"]';
const OPEN_REMINDERS_SELECTOR = '#reminder-surface [data-reminder-surface-open-registry]';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppIdle(page);
  await page.waitForNetworkIdle({idleTime: NETWORK_IDLE_MS});
}

function modeState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {editing: mode.isEditing, current: mode.currentNoteId};
  });
}

async function createNote(page, html) {
  return page.evaluate(async html => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, html, '');
    return note.id;
  }, html);
}

// A one-time reminder that came due a minute ago, so the popup shows it at once.
async function createDueReminder(page, title) {
  return page.evaluate(async ({title, minute}) => {
    const {ReminderStore} = await import('/static/js/modules/reminder-store.js');
    await ReminderStore.create({
      note_id: null, title, details: '', attachment_type: 'unattached',
      schedule_kind: 'one_time', time_mode: 'date_time',
      scheduled_at: new Date(Date.now() - minute).toISOString(), scheduled_date: null,
      recurrence_rule: null, pre_reminder: null, persistence_mode: 'keep_until_seen', status: 'active',
    });
    const matching = ReminderStore.snapshot().reminders.filter(reminder => reminder.title === title);
    if (matching.length !== 1) throw new Error(`Expected one reminder titled ${title}`);
    return matching[0].id;
  }, {title, minute: MS_PER_MINUTE});
}

async function reminderIds(page) {
  return page.evaluate(async () => {
    const {ReminderStore} = await import('/static/js/modules/reminder-store.js');
    await ReminderStore.refresh();
    return ReminderStore.snapshot().reminders.map(reminder => reminder.id);
  });
}

export async function checkReminderSurfaceWhileEditing(page) {
  const noteId = await createNote(page, '<p>A note being edited while a reminder comes due</p>');
  let reminderId = null;
  await runThenCleanUp('reminder surface', async () => {
    reminderId = await createDueReminder(page, 'Water the plants');
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await idle(page);
    await page.waitForSelector(ACKNOWLEDGE_SELECTOR, {visible: true});

    const box = await (await page.$(`.note[data-note-id="${noteId}"] > .note-content`)).boundingBox();
    await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
    await idle(page);
    assert.deepEqual(await modeState(page), {editing: true, current: noteId}, 'the note is being edited');

    await page.click(ACKNOWLEDGE_SELECTOR);
    await pause(SETTLE_MS);
    await idle(page);
    assert.equal((await reminderIds(page)).includes(reminderId), false, 'one press of Got it clears the reminder');
    assert.deepEqual(await modeState(page), {editing: true, current: noteId}, 'the note stays in edit mode');

    // Its title opens Reminders, which saves and leaves the note first, as every dialog does.
    reminderId = await createDueReminder(page, 'Call the dentist');
    // The popup looks again when the tab becomes visible.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForSelector(OPEN_REMINDERS_SELECTOR, {visible: true});
    // The popup draws its items again as the reminder snapshot refreshes; press once it has settled.
    await pause(SETTLE_MS);
    await idle(page);
    assert.equal((await modeState(page)).editing, true, 'still editing when the second reminder shows');
    await page.click(OPEN_REMINDERS_SELECTOR);
    await page.waitForSelector('#reminder-modal', {visible: true});
    await idle(page);
    assert.equal((await modeState(page)).editing, false, 'opening Reminders leaves edit mode');
    await page.keyboard.press('Escape');
    await pause(SETTLE_MS);
    await idle(page);
  }, async () => {
    await page.evaluate(async ({noteId, reminderId}) => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      const {ReminderStore} = await import('/static/js/modules/reminder-store.js');
      await ReminderStore.refresh();
      if (reminderId !== null && ReminderStore.snapshot().reminders.some(reminder => reminder.id === reminderId)) {
        await ReminderStore.delete(reminderId);
      }
      await NotesAPI.deleteNote(noteId);
    }, {noteId, reminderId});
  });
}
