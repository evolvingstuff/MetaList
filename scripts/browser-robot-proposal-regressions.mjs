import assert from 'node:assert/strict';
import { waitForAppQuiet } from './browser-app-idle.mjs';

// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 300;

// The robot count on a note with AI tag proposals (🤖 N; docs/ui/tag-bar.md,
// docs/ui/interaction-principles.md). On a collapsed note it also counts the
// proposals of its hidden children. Clicking it opens the note for editing, as
// any click does, and opens the collapsed notes on the way to every proposal it
// counts, so each such note shows its own robot; branches without proposals
// stay collapsed, the openings stay after editing, the clicked note stays where
// it is and nothing scrolls. Right-clicking it offers Accept All and Reject All
// Suggested Tags for exactly what it counts: one undo step, nothing opens,
// collapses or scrolls, and a note being edited keeps its caret.

const SETTLE_MS = 400;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function idle(page) {
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
}

// A tree: root (proposal japan) > days > day1 (temples gion); root > costs > hotel;
// root > food (ramen). Every note in it collapsed. Then a separate note, edited
// in the case where Accept All happens on another note.
async function createTree(page, label) {
  const ids = await page.evaluate(async label => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = async (created, html, tags, proposals) => {
      await NotesAPI.saveNote(created.id, html, tags);
      if (proposals.length > 0) await NotesAPI.addTagProposals(created.id, {[created.id]: proposals});
      return created.id;
    };
    const root = await note(await NotesAPI.createNote(null, ''), `<p>${label} trip plan</p>`, 'travel', ['japan']);
    const days = await note(await NotesAPI.createChild(root, ''), '<p>Days</p>', '', []);
    const costs = await note(await NotesAPI.createSibling(days, ''), '<p>Costs</p>', '', []);
    const food = await note(await NotesAPI.createSibling(costs, ''), '<p>Food</p>', 'food', ['ramen']);
    const day1 = await note(await NotesAPI.createChild(days, ''), '<p>Day 1</p>', '', ['temples', 'gion']);
    const hotel = await note(await NotesAPI.createChild(costs, ''), '<p>Hotel</p>', '', []);
    await NotesAPI.setCollapsedSubtree(root, true);
    return {root, days, costs, food, day1, hotel};
  }, label);
  return ids;
}

async function reloadApp(page) {
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await idle(page);
}

function viewState(page, ids) {
  return page.evaluate(async ids => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    const notes = {};
    for (const [name, id] of Object.entries(ids)) {
      const note = document.querySelector(`.note[data-note-id="${id}"]`);
      const shown = note !== null && note.getBoundingClientRect().height > 0;
      const robot = shown ? note.querySelector(':scope > .note-proposal-indicator') : null;
      notes[name] = !shown ? 'hidden' : {
        collapsed: note.classList.contains('collapsed'),
        robot: robot === null ? null : robot.textContent,
        tags: note.dataset.noteTags,
      };
    }
    const root = document.querySelector(`.note[data-note-id="${ids.root}"]`);
    return {
      notes,
      editingNoteId: mode.isEditing ? mode.currentNoteId : null,
      rootTop: root.getBoundingClientRect().top,
      scrollY: window.scrollY,
    };
  }, ids);
}

// The robot's middle, checked to be what the pointer would press there.
async function robotPoint(page, noteId) {
  const isOnScreen = await page.$eval(`.note[data-note-id="${noteId}"] > .note-proposal-indicator`, robot => {
    const box = robot.getBoundingClientRect();
    return box.top >= 120 && box.bottom <= window.innerHeight - 40;
  });
  if (!isOnScreen) {
    await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).scrollIntoView({block: 'center'}), noteId);
    await pause(SETTLE_MS);
  }
  const point = await page.$eval(`.note[data-note-id="${noteId}"] > .note-proposal-indicator`, robot => {
    const box = robot.getBoundingClientRect();
    return {x: box.left + box.width / 2, y: box.top + box.height / 2};
  });
  const under = await page.evaluate(({x, y}) => {
    const element = document.elementFromPoint(x, y);
    if (element === null) return 'nothing';
    return `${element.tagName}.${element.getAttribute('class')}`;
  }, point);
  assert(under.includes('note-proposal-indicator'), `the robot must be clear to press, but ${under} is there`);
  return point;
}

// The caret's position in the note's text (a redraw may rebuild its nodes).
function caretTextOffset(page, noteId) {
  return page.evaluate(id => {
    const content = document.querySelector(`.note[data-note-id="${id}"] > .note-content`);
    const range = window.getSelection().getRangeAt(0);
    const before = document.createRange();
    before.setStart(content, 0);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().length;
  }, noteId);
}

async function leaveEditing(page) {
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);
  await idle(page);
}

function menuLabels(page) {
  return page.$$eval('.context-menu.is-visible:not(.context-menu-submenu) .context-menu-item-label',
    labels => labels.map(label => label.textContent));
}

async function chooseMenuItem(page, label) {
  const items = await page.$$('.context-menu.is-visible:not(.context-menu-submenu) .context-menu-item');
  for (const item of items) {
    if (await item.$eval('.context-menu-item-label', node => node.textContent) === label) {
      await item.click();
      await pause(SETTLE_MS);
      await idle(page);
      return;
    }
  }
  throw new Error(`${label} is not in the menu`);
}

async function clickRobotCase(page, ids) {
  await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).scrollIntoView({block: 'center'}), ids.root);
  await pause(SETTLE_MS);
  const before = await viewState(page, ids);
  assert.deepEqual(before.notes.root, {collapsed: true, robot: '🤖 4', tags: 'travel'}, 'the robot counts the hidden children');
  assert.equal(before.notes.days, 'hidden');

  const point = await robotPoint(page, ids.root);
  // A hand's click: the press opens the note for editing well before the release.
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await pause(SETTLE_MS);
  await idle(page);
  await page.mouse.up();
  await pause(SETTLE_MS);
  await idle(page);
  const after = await viewState(page, ids);
  assert.equal(after.editingNoteId, ids.root, 'the note opens for editing, as before');
  assert.deepEqual(
    Object.fromEntries(Object.entries(after.notes).map(([name, note]) => [name, note === 'hidden' ? 'hidden' : [note.collapsed, note.robot]])),
    // Notes without children (day1, food) never show collapsed.
    {
      root: [false, '🤖 1'],
      days: [false, null],
      day1: [false, '🤖 2'],
      costs: [true, null],
      hotel: 'hidden',
      food: [false, '🤖 1'],
    },
    'the way to every proposal opens; each note with proposals shows its own robot; costs stays collapsed',
  );
  assert.equal(after.rootTop, before.rootTop, 'the clicked note stays where it is');
  assert.equal(after.scrollY, before.scrollY, 'nothing scrolls');

  await leaveEditing(page);
  const left = await viewState(page, ids);
  assert.equal(left.notes.root.collapsed, false, 'the openings stay after editing');
  assert.equal(left.notes.days.collapsed, false);
}

async function clickRobotOnOpenNoteCase(page, ids) {
  // days is open now: its children show, its own robot would count only its own proposals.
  const point = await robotPoint(page, ids.day1);
  const before = await viewState(page, ids);
  await page.mouse.click(point.x, point.y);
  await pause(SETTLE_MS);
  await idle(page);
  const after = await viewState(page, ids);
  assert.equal(after.editingNoteId, ids.day1, 'clicking opens the note for editing, as before');
  assert.equal(after.notes.costs.collapsed, true, 'nothing else opens');
  assert.equal(after.scrollY, before.scrollY, 'nothing scrolls');
  await leaveEditing(page);
}

// A collapsed note with no proposals of its own: pressing its robot opens it and
// edits the first note below it that has some, showing them; a note being edited
// is saved first.
async function robotEditsTheHighestNoteWithProposalsCase(page, plan, ids) {
  await page.click(`.note[data-note-id="${ids.food}"] > .note-content`);
  await page.waitForSelector(`.note.editing[data-note-id="${ids.food}"]`);
  await idle(page);
  await page.evaluate(id => {
    const content = document.querySelector(`.note[data-note-id="${id}"] > .note-content`);
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }, ids.food);
  await page.keyboard.type(' and tea');

  const point = await robotPoint(page, plan.plan);
  const before = await viewState(page, {root: plan.plan, bags: plan.bags});
  assert.deepEqual(before.notes.root, {collapsed: true, robot: '🤖 1', tags: ''});
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await pause(SETTLE_MS);
  await page.mouse.up();
  await pause(SETTLE_MS);
  await idle(page);
  const after = await viewState(page, {root: plan.plan, bags: plan.bags});
  assert.equal(after.editingNoteId, plan.bags, 'the first note with proposals is edited, not the pressed one');
  assert.equal(after.notes.root.collapsed, false, 'the pressed note opens');
  assert.equal(await page.$eval(`.note[data-note-id="${plan.bags}"] > .note-tag-proposals`, row => row.textContent.includes('luggage')), true,
    'its proposals show under its tag bar');
  assert.equal(after.rootTop, before.rootTop, 'the pressed note stays where it is');
  assert.equal(after.scrollY, before.scrollY, 'nothing scrolls');
  await leaveEditing(page);
  await reloadApp(page);
  assert(await page.$eval(`.note[data-note-id="${ids.food}"] > .note-content`, content => content.textContent.includes('and tea')),
    'the note being edited was saved first');
}

async function acceptAllCase(page, ids) {
  await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).scrollIntoView({block: 'center'}), ids.root);
  await pause(SETTLE_MS);
  const before = await viewState(page, ids);
  assert.deepEqual(before.notes.root, {collapsed: true, robot: '🤖 4', tags: 'travel'});

  // Elsewhere on the note: the note menu, as before.
  const rootBox = await (await page.$(`.note[data-note-id="${ids.root}"] > .note-content`)).boundingBox();
  await page.mouse.click(rootBox.x + 10, rootBox.y + rootBox.height / 2, {button: 'right'});
  await pause(SETTLE_MS);
  assert((await menuLabels(page)).includes('Copy Note'), 'right-clicking the note itself opens the note menu');
  await page.keyboard.press('Escape');
  await pause(SETTLE_MS);

  const point = await robotPoint(page, ids.root);
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await pause(SETTLE_MS);
  assert.deepEqual(await menuLabels(page), ['Accept All Suggested Tags', 'Reject All Suggested Tags']);
  assert.equal((await viewState(page, ids)).editingNoteId, null, 'right-clicking the robot does not open the note');
  await chooseMenuItem(page, 'Accept All Suggested Tags');
  const after = await viewState(page, ids);
  assert.deepEqual(after.notes.root, {collapsed: true, robot: null, tags: 'travel japan'}, 'every counted proposal is accepted');
  assert.equal(after.notes.days, 'hidden', 'nothing opens');
  assert.equal(after.rootTop, before.rootTop, 'the note stays put');
  assert.equal(after.scrollY, before.scrollY, 'nothing scrolls');

  // One undo (⌘Z outside edit mode) brings all four back.
  await page.keyboard.down('Meta');
  await page.keyboard.press('z');
  await page.keyboard.up('Meta');
  await pause(SETTLE_MS);
  await idle(page);
  const undone = await viewState(page, ids);
  assert.deepEqual(undone.notes.root, {collapsed: true, robot: '🤖 4', tags: 'travel'}, 'one undo restores them all');
}

async function rejectAllWhileEditingCase(page, ids) {
  // Editing the note whose robot is used: the caret stays, the tag bar keeps its tags.
  await page.click(`.note[data-note-id="${ids.root}"] > .note-content`);
  await page.waitForSelector(`.note.editing[data-note-id="${ids.root}"] .note-tag-bar-input`);
  await idle(page);
  // Mid-text, so a caret sent to either end would show.
  await page.evaluate(id => {
    const text = document.querySelector(`.note[data-note-id="${id}"] > .note-content p`).firstChild;
    window.getSelection().collapse(text, 5);
  }, ids.root);
  const caretBefore = await caretTextOffset(page, ids.root);
  assert.equal(caretBefore, 5);
  const point = await robotPoint(page, ids.root);
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await pause(SETTLE_MS);
  assert.equal(await caretTextOffset(page, ids.root), caretBefore, 'right-clicking the robot leaves the caret');
  await chooseMenuItem(page, 'Reject All Suggested Tags');
  const after = await viewState(page, ids);
  assert.equal(after.editingNoteId, ids.root, 'still editing');
  assert.equal(after.notes.root.robot, null, 'every counted proposal is gone');
  assert.equal(after.notes.root.tags, 'travel', 'no tag is added');
  assert.equal(await caretTextOffset(page, ids.root), caretBefore, 'the caret stays');
  assert.equal(await page.$eval(`.note.editing[data-note-id="${ids.root}"] .note-tag-bar-input`, input => input.value.trim()), 'travel');
  await leaveEditing(page);
}

// Editing another note: it is saved first, and stays edited.
async function acceptAllWhileEditingAnotherCase(page, ids, other) {
  await page.evaluate(id => document.querySelector(`.note[data-note-id="${id}"]`).scrollIntoView({block: 'center'}), other.root);
  await pause(SETTLE_MS);
  await page.click(`.note[data-note-id="${ids.root}"] > .note-content`);
  await page.waitForSelector(`.note.editing[data-note-id="${ids.root}"]`);
  await idle(page);
  await page.evaluate(id => {
    const content = document.querySelector(`.note[data-note-id="${id}"] > .note-content`);
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }, ids.root);
  await page.keyboard.type(' and more');
  const point = await robotPoint(page, other.root);
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await pause(SETTLE_MS);
  await chooseMenuItem(page, 'Accept All Suggested Tags');
  const after = await viewState(page, {...other, edited: ids.root});
  assert.equal(after.editingNoteId, ids.root, 'the edited note stays edited');
  assert.equal(after.notes.root.robot, null, "the other note's proposals are accepted");
  assert.equal(after.notes.root.tags, 'travel japan');
  await leaveEditing(page);
  await reloadApp(page);
  assert(await page.$eval(`.note[data-note-id="${ids.root}"] > .note-content`, content => content.textContent.includes('and more')),
    'the edited note was saved first');
}

export async function checkRobotProposals(page) {
  await reloadApp(page);
  const other = await createTree(page, 'Second');
  const ids = await createTree(page, 'First');
  const plan = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const planNote = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(planNote.id, '<p>Packing plan</p>', '');
    const bags = await NotesAPI.createChild(planNote.id, '');
    await NotesAPI.saveNote(bags.id, '<p>Bags</p>', '');
    await NotesAPI.addTagProposals(bags.id, {[bags.id]: ['luggage']});
    await NotesAPI.setCollapsedSubtree(planNote.id, true);
    return {plan: planNote.id, bags: bags.id};
  });
  // Notes above the trees, so they sit mid-window, clear of the window's top-right controls.
  const fillers = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const ids = [];
    for (let index = 0; index < 6; index += 1) {
      const note = await NotesAPI.createNote(null, '');
      await NotesAPI.saveNote(note.id, `<p>Filler ${index + 1}</p>`, '');
      ids.push(note.id);
    }
    return ids;
  });
  await reloadApp(page);
  await clickRobotCase(page, ids);
  await clickRobotOnOpenNoteCase(page, ids);
  await robotEditsTheHighestNoteWithProposalsCase(page, plan, ids);
  // Collapse the first tree again for the menu cases.
  await page.evaluate(async id => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.setCollapsedSubtree(id, true);
  }, ids.root);
  await reloadApp(page);
  await acceptAllCase(page, ids);
  await rejectAllWhileEditingCase(page, ids);
  await acceptAllWhileEditingAnotherCase(page, ids, other);
  await page.evaluate(async roots => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    for (const id of roots) await NotesAPI.deleteNote(id);
  }, [ids.root, other.root, plan.plan, ...fillers]);
  await reloadApp(page);
}
