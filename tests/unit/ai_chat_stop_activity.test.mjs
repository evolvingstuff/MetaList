import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Pressing Stop adds a "Cancelling request" activity to the answer being
// streamed; the next render validates it. It once lacked the token and duration
// fields, so every Stop ended in a fatal error instead of stopping.
const source = readFileSync(new URL('../../app/static/js/modules/ai-chat/ai-chat-panel-controller.js', import.meta.url), 'utf8');
const actionsSource = source.slice(source.indexOf('const AI_ACTIVITY_ACTIONS'), source.indexOf(';', source.indexOf('const AI_ACTIVITY_ACTIONS')) + 1);
const validateSource = source.slice(source.indexOf('function validateActivity('), source.indexOf('class AiChatPanelController'));
const cancellingSource = source.slice(source.indexOf('function cancellingActivity('), source.indexOf('function validateActivity('));

const { validateActivity, cancellingActivity } = new Function(
    `${actionsSource}\n${cancellingSource}\n${validateSource}\nreturn { validateActivity, cancellingActivity };`,
)();

test('the activity Stop adds passes the activity check', () => {
    const activity = cancellingActivity(3);
    assert.equal(validateActivity(activity), activity);
    assert.equal(activity.action, 'cancel');
    assert.equal(activity.status, 'started');
    assert.equal(activity.label, 'Cancelling request');
    assert.equal(activity.sequence, 3);
});

test('Stop uses that activity', () => {
    const cancelSource = source.slice(source.indexOf('    _cancelActiveRequest() {'), source.indexOf('    _setBusy(isBusy) {'));
    assert.match(cancelSource, /assistantMessage\.activities\.push\(cancellingActivity\(assistantMessage\.activities\.length \+ 1\)\)/);
});

// Until the provider's first signal the heading says "Waiting for OpenAI", so a
// network stall does not look like thinking.
const waitingSource = source.slice(source.indexOf('function isWaitingForProvider('), source.indexOf('function cancellingActivity('));
const isWaitingForProvider = new Function(`${waitingSource}\nreturn isWaitingForProvider;`)();

test('the heading waits for the provider until its first signal', () => {
    const thinking = { action: 'agent_turn', status: 'started', label: 'Thinking' };
    const waiting = { action: 'provider_wait', status: 'started', label: 'Waiting for OpenAI' };
    const responded = { action: 'provider_wait', status: 'completed', label: 'OpenAI responded' };
    assert.equal(isWaitingForProvider([]), '');
    assert.equal(isWaitingForProvider([thinking, waiting]), 'Waiting for OpenAI');
    assert.equal(isWaitingForProvider([thinking, waiting, responded]), '');
    // A second model turn waits again.
    assert.equal(isWaitingForProvider([thinking, waiting, responded, thinking, waiting]), 'Waiting for OpenAI');
    const headingSource = source.slice(source.indexOf("heading.className = 'ai-chat-thinking-heading';"), source.indexOf("heading.className = 'ai-chat-thinking-heading';") + 600);
    assert.match(headingSource, /isWaitingForProvider\(message\.activities\)/);
});
