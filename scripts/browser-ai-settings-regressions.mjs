import assert from 'node:assert/strict';

export async function checkOpenAiSettings(page) {
  await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    const settings = CommandPalette.getAiSettings();
    if (settings.provider !== 'openai' || settings.model !== 'gpt-5.6-luna') {
      throw new Error('Fresh AI settings must use the default OpenAI model');
    }
    await CommandPalette.openAiAgentSettings(false);
  });
  await page.waitForFunction(() => {
    const select = document.getElementById('ai-agent-installed-model');
    return select && !select.disabled && select.options.length > 1;
  });
  const initial = await page.evaluate(() => ({
    text: document.getElementById('ai-agent-settings-modal').textContent,
    providerSelector: Boolean(document.getElementById('ai-agent-provider')),
    download: Boolean(document.getElementById('ai-agent-download')),
    model: document.getElementById('ai-agent-installed-model').value,
    webAccessMode: document.getElementById('ai-agent-web-access-mode').value,
    evidence: document.getElementById('ai-agent-max-page-approximate-tokens').value,
    tagging: document.getElementById('ai-agent-tagging-batch-tokens').value,
  }));
  assert.match(initial.text, /OpenAI API/);
  assert.doesNotMatch(initial.text, /Ollama|Download an/);
  assert.equal(initial.providerSelector, false);
  assert.equal(initial.download, false);
  assert.equal(initial.model, 'gpt-5.6-luna');
  assert.equal(initial.webAccessMode, 'none');
  assert.equal(initial.evidence, '500000');
  assert.equal(initial.tagging, '100000');
  await page.select('#ai-agent-installed-model', 'gpt-5.6-sol');
  await page.select('#ai-agent-web-access-mode', 'contextual');
  await page.click('#ai-agent-save');
  await page.waitForSelector('#ai-agent-settings-modal', {hidden: true});
  await page.reload();
  await page.waitForSelector('[data-app-ready="true"]');
  const saved = await page.evaluate(async () => {
    const {CommandPalette} = await import('/static/js/modules/command-palette/command-palette-controller.js');
    return CommandPalette.getAiSettings();
  });
  assert.equal(saved.provider, 'openai');
  assert.equal(saved.model, 'gpt-5.6-sol');
  assert.equal(saved.webAccessMode, 'contextual');
  assert.equal(saved.maxPageApproximateTokens, 500000);
  assert.equal(saved.taggingBatchTokens, 100000);
  console.log('PASS OpenAI defaults, web mode and model selection save and reload');
}
