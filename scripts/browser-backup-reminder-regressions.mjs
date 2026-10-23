import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runThenCleanUp } from './suite-outcome.mjs';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// The backup reminder (docs/ui/controls.md, "Backup reminder"), one check per agreed
// case. The card floats in the bottom-right notice stack: it takes no space, never
// takes focus or the caret (interaction principles 1 and 2), waits while a dialog or
// the menu is open, and Back Up Now saves and leaves a note being edited, as every
// dialog does (principle 6).
//
// How old the newest backup is comes from GET /api2/backup/times. The page answers
// that request from a fixture in sessionStorage (so it survives reloads) instead of
// the test changing any backup file's timestamp: existing backups are immutable
// (AGENTS.md). With no fixture the real server answers, as after a real backup.

const SETTLE_MS = 400;
// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;
// The notice stack's distance from the window's right and bottom edges (main.css).
const STACK_EDGE_PX = 18;
// Firefox lays out in sixtieths of a pixel, so two edges it places at the same spot
// can read a float's rounding apart (766.99998 and 767); anything closer than this is
// the same position.
const LAYOUT_UNIT_PX = 1 / 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_SINCE_OLD_BACKUP = 9;
const FIXTURE_KEY = 'backup-reminder-test-times';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
}

async function reloadApp(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}

// Answer GET /api2/backup/times from sessionStorage when a fixture is set.
async function installBackupTimesFixture(page) {
  await page.evaluateOnNewDocument(key => {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const fixture = sessionStorage.getItem(key);
      if (fixture !== null && url.pathname === '/api2/backup/times') {
        return Promise.resolve(new Response(fixture, {status: 200, headers: {'content-type': 'application/json'}}));
      }
      return realFetch(input, init);
    };
  }, FIXTURE_KEY);
}

async function setBackupTimes(page, times) {
  await page.evaluate((key, value) => {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify({backup_times: value}));
  }, FIXTURE_KEY, times);
}

function daysAgo(days) {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

async function setPreference(page, key, value) {
  await page.evaluate(async (key, value) => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.applyPreference(key, value);
  }, key, value);
  await idle(page);
}

async function clearPreference(page, key) {
  await page.evaluate(async key => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette._preferences.remove(key);
  }, key);
}

// Re-read the backup times and check, as after a backup or a return to the tab.
async function recheck(page) {
  await page.evaluate(async () => {
    const {BackupReminder} = await import('/static/js/modules/backup-reminder-service.js');
    await BackupReminder.backupMade();
  });
  await idle(page);
}

function cardAt(page) {
  return page.evaluate(edge => {
    const notice = document.getElementById('backup-reminder-notice');
    if (!notice) return null;
    const rect = notice.getBoundingClientRect();
    return {
      text: notice.querySelector('.backup-reminder-text').textContent,
      top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
      expectedRight: document.documentElement.clientWidth - edge,
      expectedBottom: document.documentElement.clientHeight - edge,
    };
  }, STACK_EDGE_PX);
}

// What the user is looking at and working in: the first note's position, the
// page scroll, and where focus and the caret are.
function attention(page, noteId) {
  return page.evaluate(id => {
    const note = document.querySelector(`.note[data-note-id="${id}"]`);
    const selection = window.getSelection();
    const active = document.activeElement;
    return {
      noteTop: note.getBoundingClientRect().top,
      scrollY: window.scrollY,
      focus: active === document.body ? 'body' : `${active.tagName}#${active.id}.${active.className}`,
      caretOffset: selection.rangeCount > 0 ? selection.getRangeAt(0).startOffset : null,
      caretInNote: selection.rangeCount > 0 && note.contains(selection.getRangeAt(0).startContainer),
    };
  }, noteId);
}

function modeState(page) {
  return page.evaluate(async () => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return {editing: mode.isEditing, current: mode.currentNoteId, modals: mode.modalStack.length};
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

async function startEditingAtEnd(page, noteId) {
  const box = await (await page.$(`.note[data-note-id="${noteId}"] > .note-content`)).boundingBox();
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
  await idle(page);
  const state = await modeState(page);
  assert.deepEqual([state.editing, state.current], [true, noteId], 'the note is being edited');
  await page.keyboard.press('End');
}

// The note's text as shown once it has been saved and left.
function noteText(page, noteId) {
  return page.$eval(`.note[data-note-id="${noteId}"] > .note-content`, node => node.textContent);
}

async function useBackupFolder(page, folder) {
  await page.evaluate(async folder => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    const {CONFIG} = await import('/static/js/modules/config.js');
    await CommandPalette._authRequest(CONFIG.API.BACKUP.SETTINGS, 'PUT', {
      folder_path: folder, selected_namespaces: ['default'], retention_count: 3,
    });
  }, folder);
}

function assertAtStackCorner(position, label) {
  assert.notEqual(position, null, `${label}: the card shows`);
  assert.equal(position.right, position.expectedRight, `${label}: card's right edge is ${STACK_EDGE_PX}px from the window`);
  assert.equal(position.bottom, position.expectedBottom, `${label}: card's bottom edge is ${STACK_EDGE_PX}px from the window`);
}

export async function checkBackupReminder(page) {
  await installBackupTimesFixture(page);
  const noteId = await createNote(page, '<p>A note to read and edit while the reminder comes and goes</p>');
  await runThenCleanUp('backup reminder', () => checkReminderCases(page, noteId), async () => {
    await setBackupTimes(page, null);
    await page.evaluate(async id => {
      const {NotesAPI} = await import('/static/js/modules/api-client.js');
      await NotesAPI.deleteNote(id);
    }, noteId);
  });
}

async function checkReminderCases(page, noteId) {
  await setBackupTimes(page, []);
  // The harness starts every run with the reminder Off (browser-smoke.mjs).
  await reloadApp(page);

  // 1. Due when the app opens: the card floats; the note, scroll and focus are exactly
  // where they are with the reminder off.
  assert.equal(await cardAt(page), null, 'off: no card');
  const withoutCard = await attention(page, noteId);
  await clearPreference(page, 'pref.backup_reminder');
  await reloadApp(page);
  const opening = await cardAt(page);
  assertAtStackCorner(opening, 'app opens with no backup (Weekly by default)');
  assert.equal(opening.text, 'Time to back up: this vault has no backup yet.');
  assert.deepEqual(await attention(page, noteId), withoutCard, 'app opens: nothing moves and focus stays put');

  // 9. A backup older than the period names its age.
  await setBackupTimes(page, [daysAgo(DAYS_SINCE_OLD_BACKUP)]);
  await recheck(page);
  assert.equal((await cardAt(page)).text, `Time to back up: the last backup was ${DAYS_SINCE_OLD_BACKUP} days ago.`);

  // 8. Off removes the card at once; turning it back on shows it at once.
  await setPreference(page, 'pref.backup_reminder', 'off');
  assert.equal(await cardAt(page), null, 'Off removes the card');
  await setPreference(page, 'pref.backup_reminder', 'daily');
  assertAtStackCorner(await cardAt(page), 'turned on while due');

  // 2. Comes due while editing: the caret, the note and the page stay put, typing goes on.
  await setBackupTimes(page, [daysAgo(0)]);
  await recheck(page);
  assert.equal(await cardAt(page), null, 'backed up today: no card');
  await startEditingAtEnd(page, noteId);
  await page.keyboard.type('ab');
  const editing = await attention(page, noteId);
  await setBackupTimes(page, []);
  await recheck(page);
  assertAtStackCorner(await cardAt(page), 'comes due while editing');
  assert.deepEqual(await attention(page, noteId), editing, 'comes due while editing: caret, note and page stay put');
  await page.keyboard.type('c');
  await idle(page);
  assert.equal((await modeState(page)).editing, true, 'typing goes on in the note');

  // 4. Back Up Now while editing: the note saves and leaves edit mode, then Backup Settings opens.
  await page.click('#backup-reminder-notice button:not([aria-label])');
  await page.waitForSelector('#backup-settings-modal', {visible: true});
  await idle(page);
  assert.equal((await modeState(page)).editing, false, 'Back Up Now leaves edit mode');
  assert.match(await noteText(page, noteId), /comes and goesabc/, 'the typing was saved');

  // 6. Cancelling Backup Settings keeps the card.
  await page.click('#backup-settings-cancel-btn');
  await pause(SETTLE_MS);
  await idle(page);
  assertAtStackCorner(await cardAt(page), 'cancelled Backup Settings');

  // 3. While a dialog (here, the menu) is open the card waits, then shows when it closes.
  await setPreference(page, 'pref.backup_reminder', 'off');
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.open();
  });
  await idle(page);
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.applyPreference('pref.backup_reminder', 'daily');
  });
  await idle(page);
  assert.equal((await modeState(page)).modals > 0, true, 'the menu is open');
  assert.equal(await cardAt(page), null, 'due while the menu is open: the card waits');
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  await idle(page);
  assertAtStackCorner(await cardAt(page), 'the menu closed');

  // 7. × hides it for a day, and a reload does not bring it back early.
  const before = Date.now();
  await page.click('#backup-reminder-notice button[aria-label]');
  await idle(page);
  const after = Date.now();
  assert.equal(await cardAt(page), null, '× hides the card');
  const hiddenUntil = Date.parse(await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    return CommandPalette._preferences.getRaw('pref.backup_reminder_hidden_until');
  }));
  assert.ok(hiddenUntil >= before + MS_PER_DAY && hiddenUntil <= after + MS_PER_DAY, 'hidden for exactly a day from the click');
  await reloadApp(page);
  assert.equal(await cardAt(page), null, 'a reload does not bring it back early');
  await setPreference(page, 'pref.backup_reminder_hidden_until', new Date(Date.now() - 1).toISOString());
  assertAtStackCorner(await cardAt(page), 'the day has passed');

  // 10. With a release notice too, the two stack instead of covering each other.
  const stacked = await page.evaluate(async () => {
    const {appNoticeStack} = await import('/static/js/modules/app-notice-stack.js');
    const release = document.createElement('aside');
    release.id = 'test-release-notice';
    release.className = 'app-update-notice reminder-surface-item';
    release.textContent = 'MetaList 99.0.0 is available';
    appNoticeStack().append(release);
    const a = release.getBoundingClientRect();
    const b = document.getElementById('backup-reminder-notice').getBoundingClientRect();
    const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    release.remove();
    return {overlap, rightEdgeGap: Math.abs(a.right - b.right)};
  });
  assert.equal(stacked.overlap, false, 'release notice and reminder stack instead of covering each other');
  assert.ok(stacked.rightEdgeGap < LAYOUT_UNIT_PX, `stacked notices share a right edge (off by ${stacked.rightEdgeGap}px)`);

  // 5. A successful backup removes the card and restarts the clock.
  await useBackupFolder(page, mkdtempSync(join(tmpdir(), 'metalist-backup-reminder-')));
  await setBackupTimes(page, null);
  await page.click('#backup-reminder-notice button:not([aria-label])');
  await page.waitForSelector('#backup-settings-modal', {visible: true});
  await idle(page);
  await page.click('#backup-settings-run-btn');
  await page.waitForSelector('#backup-result-modal', {visible: true});
  await idle(page);
  assert.equal(await cardAt(page), null, 'a successful backup removes the card');
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  await idle(page);
  await reloadApp(page);
  assert.equal(await cardAt(page), null, 'the clock restarted from the new backup');
}
