import assert from 'node:assert/strict';

export async function checkAiSelectedNote(page) {
    const ids = await page.evaluate(async () => {
        const {NotesAPI} = await import('/static/js/modules/api-client.js');
        const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
        await CommandPalette.applyPreference('pref.show_ai_chat', true);
        const ids = [];
        for (const text of ['Selected note original', 'Other selected note']) {
            const note = await NotesAPI.createNote(null, '');
            await NotesAPI.saveNote(note.id, text, '');
            ids.push(note.id);
        }
        return ids;
    });
    await page.reload();
    await page.waitForSelector('[data-app-ready="true"]');
    await page.waitForNetworkIdle({idleTime: 100});
    await page.evaluate(async () => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        const {stateValuesEqual} = await import('/static/js/modules/application-state.js');
        const settings = AiChatPanel._getSettings();
        if (!stateValuesEqual(AiChatPanel._models, [settings.model])) AiChatPanel._models = [settings.model];
        AiChatPanel._syncSettingsControls();
        const originalFetch = window.fetch;
        window.selectedNoteTest = {requests: [], saves: [], originalFetch};
        window.fetch = async (url, options) => {
            const path = new URL(url, location.href).pathname;
            if (path === '/api2/ai/chat') {
                const request = JSON.parse(options.body);
                window.selectedNoteTest.requests.push(request);
                return new Response(JSON.stringify({
                    type: 'done',
                    content: 'Test response',
                    rendered_content: '<p>Test response</p>',
                    reference_note_ids: [],
                    reference_web_ids: [],
                }) + '\n',
                    {headers: {'Content-Type': 'application/x-ndjson'}});
            }
            const response = await originalFetch(url, options);
            if (/\/notes\/[^/]+\/save$/.test(path) && response.ok) {
                window.selectedNoteTest.saves.push(JSON.parse(options.body));
            }
            return response;
        };
    });
    const select = async id => {
        await page.click(`[data-note-id="${id}"] > .note-content`);
        await page.waitForFunction(async id => {
            const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
            return state.isEditing && state.currentNoteId === id && !state.isLoading;
        }, {}, id);
    };
    const checkSelected = async id => {
        assert.deepEqual(await page.evaluate(async id => {
            const {ModeContextInstance: state} = await import('/static/js/modules/mode-manager/mode-context.js');
            return [state.isEditing, state.currentNoteId === id,
                document.querySelector(`[data-note-id="${id}"] > .note-content`).isContentEditable];
        }, id), [true, true, true]);
    };
    await select(ids[0]);
    await page.$eval(`[data-note-id="${ids[0]}"] > .note-content`, content => {
        content.innerHTML = '<p>Latest selected note draft</p>';
        content.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText'}));
    });
    await page.click('#ai-chat-input');
    await page.type('#ai-chat-input', 'Explain the relevant details');
    await page.keyboard.press('Escape');
    await checkSelected(ids[0]);
    await page.click('#ai-chat-model');
    await page.keyboard.press('Escape');
    await checkSelected(ids[0]);
    await page.click('#ai-chat-input', {button: 'right'});
    await page.keyboard.press('Escape');
    await checkSelected(ids[0]);
    await page.click('#ai-chat-send');
    await page.waitForFunction(async () => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        return window.selectedNoteTest.requests.length === 1 && !AiChatPanel._isBusy;
    });
    await checkSelected(ids[0]);
    const first = await page.evaluate(() => window.selectedNoteTest.requests[0]);
    assert.equal(first.selected_note_id, ids[0]);
    assert.equal(first.scope.scope_kind, 'all_notes');
    assert.equal(first.message, 'Explain the relevant details');
    assert((await page.evaluate(() => window.selectedNoteTest.saves)).some(save => save.content.includes('Latest selected note draft')));

    await select(ids[1]);
    await page.click('#ai-chat-input');
    await page.type('#ai-chat-input', 'Compare the notes in this view');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.selectedNoteTest.requests.length === 2);
    assert.equal(await page.evaluate(() => window.selectedNoteTest.requests[1].selected_note_id), ids[1]);
    await checkSelected(ids[1]);
    await page.waitForFunction(async () => !(await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js')).AiChatPanel._isBusy);

    // The chat header lines up with the search bar beside it: its title and
    // buttons on the bar's middle line, its grey line where it was (57px).
    await page.setViewport({width: 1600, height: 900});
    await new Promise(resolve => setTimeout(resolve, 300));
    const header = await page.evaluate(() => {
        const middle = element => (({top, height}) => Math.round(top + height / 2))(element.getBoundingClientRect());
        return {
            title: middle(document.querySelector('.ai-chat-header h2')),
            buttons: [...new Set([...document.querySelectorAll('.ai-chat-header-actions button')].filter(button => !button.hidden).map(middle))],
            line: Math.round(document.querySelector('.ai-chat-header').getBoundingClientRect().bottom),
            bar: middle(document.querySelector('.controls')),
        };
    });
    assert.deepEqual(header, {title: header.bar, buttons: [header.bar], line: 57, bar: 39}, 'centred on the search bar, the line unchanged');
    await page.setViewport({width: 800, height: 600});
    await new Promise(resolve => setTimeout(resolve, 300));
    // Every header button sits inside the chat panel, so its clicks never reach the notes.
    const outsideButtons = await page.evaluate(() => {
        const panel = document.getElementById('ai-chat-panel').getBoundingClientRect();
        return [...document.querySelectorAll('.ai-chat-header-actions button')]
            .filter((button) => !button.hidden)
            .filter((button) => {
                const box = button.getBoundingClientRect();
                return box.left < panel.left || box.right > panel.right;
            })
            .map((button) => button.id);
    });
    assert.deepEqual(outsideButtons, []);
    await page.click('#ai-chat-close');
    await checkSelected(ids[1]);
    await page.click('#chat-toggle-button');
    await checkSelected(ids[1]);
    // Explicitly leaving the note still clears selection for a later chat turn.
    await page.click(`[data-note-id="${ids[1]}"] > .note-content`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(async () => !(await import('/static/js/modules/mode-manager/mode-context.js')).ModeContextInstance.isEditing);
    // Reopening the chat reloads its models: let that finish first, then stand
    // in for a provider with the chosen model (unless an earlier check already
    // left exactly that list, which would be no change).
    await page.waitForFunction(async () => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        return !AiChatPanel._isLoadingModels;
    });
    await page.evaluate(async () => {
        const {AiChatPanel} = await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js');
        const {stateValuesEqual} = await import('/static/js/modules/application-state.js');
        const models = [AiChatPanel._getSettings().model];
        if (!stateValuesEqual(AiChatPanel._models, models)) AiChatPanel._models = models;
        AiChatPanel._syncSettingsControls();
    });
    await page.click('#ai-chat-input');
    await page.type('#ai-chat-input', 'A general question');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.selectedNoteTest.requests.length === 3);
    assert.equal(await page.evaluate(() => window.selectedNoteTest.requests[2].selected_note_id), '');
    await page.waitForFunction(async () => !(await import('/static/js/modules/ai-chat/ai-chat-panel-controller.js')).AiChatPanel._isBusy);
    await page.evaluate(() => { window.fetch = window.selectedNoteTest.originalFetch; delete window.selectedNoteTest; });
    console.log('PASS chat preserves editing across input, Escape, menus, Send, and show/hide; latest draft saved before Send; selection changes and clears');
}
