import assert from 'node:assert/strict';

export async function checkAdditionalStateTransitions(page) {
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('tabindex', '0');
    document.body.append(svg);
    for (let count = 0; count < 2; count += 1) {
      svg.focus();
      if (document.activeElement !== svg) throw new Error('SVG must own focus for palette regression');
      await CommandPalette.open();
      CommandPalette.close();
    }
    svg.remove();
  });
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    await CommandPalette.openOntologyEditor();
  });
  await page.waitForNetworkIdle({idleTime:100});
  await page.click('#ontology-search-input');
  await page.keyboard.type('state-audit');
  await page.waitForNetworkIdle({idleTime:100});
  for (let count = 0; count < 2; count += 1) {
    await page.click('[data-action="add-tag"]');
    await page.waitForSelector('#ontology-dialog-overlay.is-visible');
    await page.click('#ontology-dialog-input');
    await page.keyboard.type('state-audit-one');
    if (count === 0) {
      await page.click('.ontology-dialog-secondary[data-action="dialog-cancel"]');
    } else {
      await page.click('[data-action="dialog-submit"]');
    }
    await page.waitForSelector('#ontology-dialog-overlay.is-visible', {hidden:true});
    await page.waitForNetworkIdle({idleTime:100});
  }
  await page.click('[data-action="add-right"]');
  await page.waitForSelector('#ontology-dialog-overlay.is-visible');
  await page.click('#ontology-dialog-input');
  await page.keyboard.type('state-audit-two');
  await page.waitForNetworkIdle({idleTime:100});
  await page.click('[data-action="dialog-submit"]');
  await page.waitForSelector('#ontology-dialog-overlay.is-visible', {hidden:true});
  await page.waitForNetworkIdle({idleTime:100});
  await page.click('#ontology-search-input');
  await page.keyboard.type('state-audit');
  await page.waitForSelector('.ontology-search-result');
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowUp']) {
    await page.keyboard.press(key);
  }
  await page.keyboard.press('Enter');
  await page.waitForNetworkIdle({idleTime:100});
  await page.click('#ontology-middle-list .ontology-tag');
  await page.waitForNetworkIdle({idleTime:100});
  await page.keyboard.press('Escape');
  console.log('PASS ontology typing, dialog cancellation/reopening, relationship creation, repeated focus, and arrow boundaries');

  const completed = await page.evaluate(async () => {
    const {AiChatPanel: panel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
    const {CONFIG} = await import('/static/js/modules/config.js');
    const originalFetch = window.fetch;
    const originalSettings = panel._getSettings;
    const originalModels = panel._models;
    const completed = [];
    let scenario = 'stream';
    window.fetch = async (url, options = {}) => {
      if (url === CONFIG.API.AI.CHAT) {
        const final = {type:'done', content:'Local simulated answer ', rendered_content:'<p>Local simulated answer</p>', reference_note_ids:[]};
        const events = scenario === 'bulk'
          ? [{type:'bulk_progress', label:'Testing unchanged completion', committing:false}, {type:'bulk_complete', changed:false}, final]
          : [{type:'thinking_delta', text:' ', rendered_text:''},
             {type:'content_delta', text:'Local simulated answer', rendered_text:final.rendered_content, reference_note_ids:[]},
             {type:'content_delta', text:' ', rendered_text:final.rendered_content, reference_note_ids:[]}, final];
        return new Response(events.map(event => JSON.stringify(event)).join('\n')+'\n', {headers:{'Content-Type':'application/x-ndjson'}});
      }
      if (url === CONFIG.API.AI.SESSION) {
        return Response.json(options.method === 'DELETE' ? {status:'success'} : {messages:panel._messages});
      }
      return originalFetch(url, options);
    };
    panel._getSettings = () => ({provider:'ollama', model:'state-smoke-model', thinkingLevel:'low'});
    panel._models = ['state-smoke-model'];
    try {
      for (scenario of ['stream', 'stream', 'bulk']) {
        panel._elements.input.value = 'Local simulated request';
        await panel._submitMessage();
        completed.push({status:panel._messages.at(-1).status, content:panel._messages.at(-1).content, busy:panel._isBusy});
      }
      await panel._clearSession();
      await panel._clearSession();
      if (panel._messages.length !== 0) throw new Error('Chat clear left messages');
    } finally {
      window.fetch = originalFetch;
      panel._getSettings = originalSettings;
      panel._models = originalModels;
    }
    return completed;
  });
  assert.deepEqual(completed, Array.from({length:3}, () => ({status:'complete', content:'Local simulated answer ', busy:false})));
  console.log('PASS simulated streamed chat, unchanged bulk completion, and repeated chat clearing without an AI provider');
}

export async function checkEditingShortcutSequences(page) {
  const rootId = await page.evaluate(async () => {
    const {NotesAPI} = await import('/static/js/modules/api-client.js');
    const root = await NotesAPI.createNote(null, '');
    await NotesAPI.saveNote(root.id, 'Keyboard root', '');
    return root.id;
  });
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  await page.click(`[data-note-id="${rootId}"] > .note-content`);
  await waitForIdle(page);
  await pressModified(page, 'Enter');
  await page.waitForFunction(rootId => {
    const note = document.querySelector('.note.editing');
    return note !== null && note.dataset.noteId !== rootId;
  }, {}, rootId);
  await waitForIdle(page);
  const siblingId = await page.$eval('.note.editing', note => note.dataset.noteId);
  await page.keyboard.type('Keyboard sibling');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement.classList.contains('note-tag-bar-input'));
  await page.keyboard.type('keyboard-audit');
  await page.keyboard.press('Tab');
  await pressModified(page, 'ArrowRight');
  await page.waitForFunction((id, parentId) => document.querySelector(`[data-note-id="${id}"]`).dataset.parentId === parentId, {}, siblingId, rootId);
  await waitForIdle(page);
  await pressModified(page, 'ArrowLeft');
  await page.waitForFunction(id => document.querySelector(`[data-note-id="${id}"]`).dataset.parentId === '', {}, siblingId);
  await waitForIdle(page);
  await pressModified(page, 'ArrowLeft'); // Already at the root boundary.
  await waitForIdle(page);
  await pressModified(page, 'Enter', ['Meta', 'Shift']);
  await page.waitForFunction(id => document.querySelector('.note.editing')?.dataset.parentId === id, {}, siblingId);
  await waitForIdle(page);
  const childId = await page.$eval('.note.editing', note => note.dataset.noteId);
  await page.keyboard.type('Keyboard child');
  await pressModified(page, 'Backspace');
  await page.waitForFunction(id => document.querySelector(`[data-note-id="${id}"]`) === null, {}, childId);
  await waitForIdle(page);
  await pressModified(page, 'z');
  await page.waitForSelector(`[data-note-id="${childId}"]`);
  await waitForIdle(page);
  await page.keyboard.press('Escape');
  await waitForIdle(page);
  console.log('PASS keyboard sibling/child creation, tag editing, indent/outdent boundaries, deletion, and undo');
}

async function waitForIdle(page) {
  await page.waitForFunction(async () => {
    const {ModeContextInstance} = await import('/static/js/modules/mode-manager/mode-context.js');
    return !ModeContextInstance.isLoading;
  });
}

async function pressModified(page, key, modifiers = ['Meta']) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}
