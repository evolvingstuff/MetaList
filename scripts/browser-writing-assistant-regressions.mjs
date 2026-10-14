import assert from 'node:assert/strict';

async function openFixture(page) {
  const noteId = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const note = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(note.id, '<p>Foundation and <em>Choas</em></p>', '');
    return note.id;
  });
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await page.click(`[data-note-id="${noteId}"] > .note-content`);
  await page.waitForFunction(async noteId => {
    const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
    return mode.isEditing && mode.currentNoteId === noteId && !mode.isLoading;
  }, {}, noteId);
  return noteId;
}

async function assertCorrectionPersisted(page, noteId) {
  await page.waitForNetworkIdle({idleTime:100});
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  assert.equal(await page.$eval(`[data-note-id="${noteId}"] > .note-content em`, el => el.textContent),
    'Chaos', 'External correction must survive saving and reloading, with formatting intact');
  await page.evaluate(async noteId => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    await NotesAPI.deleteNote(noteId);
  }, noteId);
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
}

export async function checkWritingAssistantCorrections(page) {
  // Synthetic assistant UI, not a live Grammarly installation. Exercise both
  // light DOM and shadow retargeting, and pointer versus keyboard activation.
  // Grammarly renames its elements between versions (a reported revert came
  // from a card in an element MetaList did not know): any grammarly-* element,
  // or a host marked data-grammarly-shadow-root, is the assistant's.
  for (const [hostName, shadowMode, keyboard, hostAttribute] of [
    ['grammarly-extension', 'closed', false, null],
    ['grammarly-desktop-integration', 'open', false, null],
    ['grammarly-extension', null, true, null],
    ['grammarly-popups', 'closed', false, null],
    ['div', 'closed', false, 'data-grammarly-shadow-root'],
  ]) {
    const noteId = await openFixture(page);
    await page.evaluate(({noteId, hostName, shadowMode, hostAttribute}) => {
      const host = document.createElement(hostName);
      if (hostAttribute !== null) host.setAttribute(hostAttribute, 'true');
      host.id = 'writing-assistant-fixture';
      host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647';
      const root = shadowMode ? host.attachShadow({mode:shadowMode}) : host;
      const button = document.createElement('button');
      button.textContent = 'Chaos';
      button.style.cssText = 'width:160px;height:60px';
      button.addEventListener('click', () => {
        host.dataset.accepted = 'true';
        const editor = document.querySelector(`[data-note-id="${noteId}"] > .note-content`);
        editor.querySelector('em').firstChild.data = 'Chaos';
        editor.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertReplacementText', data:'Chaos'}));
      });
      root.append(button);
      document.body.append(host);
      button.focus();
    }, {noteId, hostName, shadowMode, hostAttribute});
    if (keyboard) await page.keyboard.press('Enter');
    else await page.click('#writing-assistant-fixture');
    await page.waitForNetworkIdle({idleTime:100});
    const state = await page.evaluate(async noteId => {
      const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
      return {editing:mode.isEditing, noteId:mode.currentNoteId,
        accepted:document.querySelector('#writing-assistant-fixture').dataset.accepted,
        text:document.querySelector(`[data-note-id="${noteId}"] > .note-content em`).textContent};
    }, noteId);
    assert.deepEqual(state, {editing:true, noteId, accepted:'true', text:'Chaos'},
      `Accepting an assistant suggestion in <${hostName}${hostAttribute === null ? '' : ` ${hostAttribute}`}> must leave the corrected note in edit mode`);
    await page.evaluate(() => document.querySelector('#writing-assistant-fixture').remove());
    // Ordinary outside clicks must still save and exit editing.
    await page.mouse.click(5, 500);
    await page.waitForFunction(async () => {
      const {ModeContextInstance: mode} = await import('/static/js/modules/mode-manager/mode-context.js');
      return !mode.isEditing && !mode.isLoading;
    });
    await assertCorrectionPersisted(page, noteId);
  }
  console.log('PASS simulated assistant popup corrections, shadow DOM, keyboard activation, outside-click save and reload');

  const noteId = await openFixture(page);
  await page.evaluate(noteId => {
    // Some external editors change the DOM without delivering an input event.
    document.querySelector(`[data-note-id="${noteId}"] > .note-content em`).firstChild.data = 'Chaos';
  }, noteId);
  await page.keyboard.press('Escape');
  await assertCorrectionPersisted(page, noteId);
  console.log('PASS external DOM correction without input event persists on editor exit');
}
