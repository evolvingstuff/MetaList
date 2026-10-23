import assert from 'node:assert/strict';
import {waitForAppQuiet} from './browser-app-idle.mjs';

// Requests count as quiet after this long without one starting or ending.
const REQUESTS_QUIET_MS = 100;

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
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
  await page.click('#ontology-search-input');
  await page.keyboard.type('state-audit');
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
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
    await waitForAppQuiet(page, REQUESTS_QUIET_MS);
  }
  await page.click('[data-action="add-right"]');
  await page.waitForSelector('#ontology-dialog-overlay.is-visible');
  await page.click('#ontology-dialog-input');
  await page.keyboard.type('state-audit-two');
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
  await page.click('[data-action="dialog-submit"]');
  await page.waitForSelector('#ontology-dialog-overlay.is-visible', {hidden:true});
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
  await page.click('#ontology-search-input');
  await page.keyboard.type('state-audit');
  await page.waitForSelector('.ontology-search-result');
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowUp']) {
    await page.keyboard.press(key);
  }
  await page.keyboard.press('Enter');
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
  await page.click('#ontology-middle-list .ontology-tag');
  await waitForAppQuiet(page, REQUESTS_QUIET_MS);
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
    window.fetch = async (url, options) => {
      if (url === CONFIG.API.AI.CHAT) {
        const final = {type:'done', content:'Local simulated answer ', rendered_content:'<p>Local simulated answer</p>', reference_note_ids:[], reference_web_ids:[]};
        const events = scenario === 'bulk'
          ? [{type:'bulk_progress', label:'Testing unchanged completion', committing:false}, {type:'bulk_complete', changed:false}, final]
          : [{type:'thinking_delta', text:' ', rendered_text:''},
             {type:'content_delta', text:'Local simulated answer', rendered_text:final.rendered_content, reference_note_ids:[], reference_web_ids:[]},
             {type:'content_delta', text:' ', rendered_text:final.rendered_content, reference_note_ids:[], reference_web_ids:[]}, final];
        return new Response(events.map(event => JSON.stringify(event)).join('\n')+'\n', {headers:{'Content-Type':'application/x-ndjson'}});
      }
      if (url === CONFIG.API.AI.SESSION) {
        return Response.json(options.method === 'DELETE' ? {status:'success'} : {messages:panel._messages});
      }
      return originalFetch(url, options);
    };
    panel._getSettings = () => ({provider:'openai', model:'state-smoke-model', thinkingLevel:'low'});
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

  // A failed AI step explains itself in several lines; the chat keeps the lines.
  const failure = await page.evaluate(async () => {
    const {AiChatPanel: panel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
    const {CONFIG} = await import('/static/js/modules/config.js');
    const originalFetch = window.fetch;
    const originalSettings = panel._getSettings;
    const originalModels = panel._models;
    const explanation = [
      "MetaList's AI could not finish this request: it failed while deciding how to handle your request.",
      'Attempt 1: the reply was cut off at the 512-token output limit; all 512 tokens went to thinking, so no answer was written.',
      'Setup: state-smoke-model, Low thinking, web access off.',
    ].join('\n');
    window.fetch = async (url, options) => {
      if (url === CONFIG.API.AI.CHAT) {
        return new Response(JSON.stringify({type:'error', message:explanation})+'\n', {headers:{'Content-Type':'application/x-ndjson'}});
      }
      if (url === CONFIG.API.AI.SESSION) {
        return Response.json(options.method === 'DELETE' ? {status:'success'} : {messages:panel._messages});
      }
      return originalFetch(url, options);
    };
    panel._getSettings = () => ({provider:'openai', model:'state-smoke-model', thinkingLevel:'low'});
    panel._models = ['state-smoke-model'];
    try {
      panel._elements.input.value = 'Local simulated failing request';
      await panel._submitMessage();
      const shown = [...document.querySelectorAll('.ai-chat-message-error')].at(-1);
      const result = {status: panel._messages.at(-1).status, saved: panel._messages.at(-1).error,
        shown: shown ? shown.textContent : '', whiteSpace: shown ? getComputedStyle(shown).whiteSpace : ''};
      await panel._clearSession();
      return {...result, explanation};
    } finally {
      window.fetch = originalFetch;
      panel._getSettings = originalSettings;
      panel._models = originalModels;
    }
  });
  assert.equal(failure.status, 'error');
  assert.equal(failure.saved, failure.explanation, 'the explanation is saved with the turn');
  assert.equal(failure.shown, failure.explanation, 'the explanation is shown in full');
  assert.equal(failure.whiteSpace, 'pre-line', 'the explanation keeps its line breaks');
  console.log('PASS a failed AI step shows its multi-line explanation in the chat');

  // A proposed change waits for Yes/No; the answer goes to the server and the turn finishes.
  const confirmation = await page.evaluate(async () => {
    const {AiChatPanel: panel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
    const {CONFIG} = await import('/static/js/modules/config.js');
    const originalFetch = window.fetch;
    const originalSettings = panel._getSettings;
    const originalModels = panel._models;
    const answerUrl = CONFIG.API.AI.CHAT.replace(/\/chat$/u, '/proposals/answer');
    const label = 'Accept 3 pending tag proposals across 2 notes in the current view?';
    const answers = [];
    let deliverAnswer;
    const answered = new Promise((resolve) => { deliverAnswer = resolve; });
    const line = (event) => new TextEncoder().encode(JSON.stringify(event) + '\n');
    window.fetch = async (url, options) => {
      if (url === CONFIG.API.AI.CHAT) {
        const body = new ReadableStream({
          async start(controller) {
            controller.enqueue(line({type:'bulk_question', question_id:'question-1', kind:'change_confirmation', label,
              items:['https://collector.example/?d=project']}));
            await answered;
            const text = 'Accepted 3 tag proposals across 2 notes.';
            controller.enqueue(line({type:'content_delta', text, rendered_text:`<p>${text}</p>`, reference_note_ids:[], reference_web_ids:[]}));
            controller.enqueue(line({type:'done', content:text, rendered_content:`<p>${text}</p>`, reference_note_ids:[], reference_web_ids:[]}));
            controller.close();
          },
        });
        return new Response(body, {headers:{'Content-Type':'application/x-ndjson'}});
      }
      if (url === answerUrl) {
        answers.push(JSON.parse(options.body));
        deliverAnswer();
        return Response.json({status:'answered'});
      }
      if (url === CONFIG.API.AI.SESSION) {
        return Response.json(options.method === 'DELETE' ? {status:'success'} : {messages:panel._messages});
      }
      return originalFetch(url, options);
    };
    panel._getSettings = () => ({provider:'openai', model:'state-smoke-model', thinkingLevel:'low'});
    panel._models = ['state-smoke-model'];
    try {
      panel._elements.input.value = 'Accept all the tag proposals';
      const submitted = panel._submitMessage();
      const deadline = performance.now() + 5000;
      let card = null;
      while (card === null && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        card = document.querySelector('#ai-chat-panel .ai-chat-confirmation');
      }
      if (card === null) throw new Error('The confirmation card did not appear');
      const shownLabel = card.querySelector('.ai-chat-confirmation-label').textContent;
      const shownItems = [...card.querySelectorAll('.ai-chat-confirmation-items code')].map((code) => code.textContent);
      const itemFont = getComputedStyle(card.querySelector('.ai-chat-confirmation-items code')).fontFamily;
      // The chat panel may be hidden in this run, so check the computed rules, not the layout.
      const yesStyle = getComputedStyle(card.querySelector('button[data-answer="yes"]'));
      const buttonSizing = {flexGrow: yesStyle.flexGrow, width: yesStyle.width, fontSize: yesStyle.fontSize,
        justify: getComputedStyle(card.querySelector('.form-actions')).justifyContent};
      const buttons = [...card.querySelectorAll('button')].map((button) => button.textContent);
      card.querySelector('button[data-answer="yes"]').click();
      await submitted;
      const result = {shownLabel, shownItems, itemFont, buttonSizing, buttons, answers,
        cardRemains: document.querySelector('#ai-chat-panel .ai-chat-confirmation') !== null,
        status: panel._messages.at(-1).status, content: panel._messages.at(-1).content};
      await panel._clearSession();
      return result;
    } finally {
      window.fetch = originalFetch;
      panel._getSettings = originalSettings;
      panel._models = originalModels;
    }
  });
  assert.equal(confirmation.shownLabel, 'Accept 3 pending tag proposals across 2 notes in the current view?');
  assert.deepEqual(confirmation.shownItems, ['https://collector.example/?d=project']);
  assert.match(confirmation.itemFont, /monospace|Menlo|Monaco|SFMono/);
  // Compact buttons: sized by their label, not stretched across the card.
  assert.equal(confirmation.buttonSizing.flexGrow, '0', JSON.stringify(confirmation.buttonSizing));
  assert.equal(confirmation.buttonSizing.justify, 'flex-end');
  assert.equal(confirmation.buttonSizing.fontSize, '13px');
  assert.deepEqual(confirmation.buttons, ['Yes', 'No']);
  assert.deepEqual(confirmation.answers, [{question_id:'question-1', value:'yes'}]);
  assert.equal(confirmation.cardRemains, false, 'the card closes after the answer');
  assert.equal(confirmation.status, 'complete');
  assert.equal(confirmation.content, 'Accepted 3 tag proposals across 2 notes.');
  console.log('PASS a proposed change waits for Yes/No, sends the answer, and finishes the turn');
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
  await pressModified(page, 'Enter', ['Meta']);
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
  await pressModified(page, 'ArrowRight', ['Meta']);
  await page.waitForFunction((id, parentId) => document.querySelector(`[data-note-id="${id}"]`).dataset.parentId === parentId, {}, siblingId, rootId);
  await waitForIdle(page);
  await pressModified(page, 'ArrowLeft', ['Meta']);
  await page.waitForFunction(id => document.querySelector(`[data-note-id="${id}"]`).dataset.parentId === '', {}, siblingId);
  await waitForIdle(page);
  await pressModified(page, 'ArrowLeft', ['Meta']); // Already at the root boundary.
  await waitForIdle(page);
  await pressModified(page, 'Enter', ['Meta', 'Shift']);
  await page.waitForFunction(id => document.querySelector('.note.editing')?.dataset.parentId === id, {}, siblingId);
  await waitForIdle(page);
  const childId = await page.$eval('.note.editing', note => note.dataset.noteId);
  await page.keyboard.type('Keyboard child');
  await pressModified(page, 'Backspace', ['Meta']);
  await page.waitForFunction(id => document.querySelector(`[data-note-id="${id}"]`) === null, {}, childId);
  await waitForIdle(page);
  await pressModified(page, 'z', ['Meta']);
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

async function pressModified(page, key, modifiers) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}
