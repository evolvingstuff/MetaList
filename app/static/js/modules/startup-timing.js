import { ApplicationState, stateValuesEqual } from './application-state.js';
import { MS_PER_SECOND } from './time-units.js';

// How long the browser's part of the last unlock took, stage by stage, from sending the
// password to the workspace being ready (the Memory Usage dialog's Last unlock).
const moduleState = ApplicationState.createFields('startup-timing', {
    isRunning: false,
    startedAt: 0,
    stage: '',
    stageStartedAt: 0,
    stages: [],
    lastStages: [],
    lastTotalSeconds: 0,
});

// ApplicationState refuses a write that changes nothing (a second unlock starts from the
// same empty stages): write only what differs.
function setField(name, value) {
    if (!stateValuesEqual(moduleState[name], value)) {
        moduleState[name] = value;
    }
}

function secondsSince(startedAt) {
    return (performance.now() - startedAt) / MS_PER_SECOND;
}

export function beginStartupTiming(stage) {
    if (typeof stage !== 'string' || stage === '') {
        throw new Error('beginStartupTiming requires a stage');
    }
    const now = performance.now();
    setField('isRunning', true);
    setField('startedAt', now);
    setField('stage', stage);
    setField('stageStartedAt', now);
    setField('stages', []);
}

// Closes the current stage and starts the next; returns its name for the caller's
// record of where startup is.
export function enterStartupStage(stage) {
    if (typeof stage !== 'string' || stage === '') {
        throw new Error('enterStartupStage requires a stage');
    }
    if (!moduleState.isRunning) {
        throw new Error('enterStartupStage called before beginStartupTiming');
    }
    setField('stages', [...moduleState.stages, { stage: moduleState.stage, seconds: secondsSince(moduleState.stageStartedAt) }]);
    setField('stage', stage);
    setField('stageStartedAt', performance.now());
    return stage;
}

export function finishStartupTiming() {
    if (!moduleState.isRunning) {
        throw new Error('finishStartupTiming called before beginStartupTiming');
    }
    setField('lastStages', [...moduleState.stages, { stage: moduleState.stage, seconds: secondsSince(moduleState.stageStartedAt) }]);
    setField('lastTotalSeconds', secondsSince(moduleState.startedAt));
    setField('isRunning', false);
}

export function lastStartupTiming() {
    return { stages: moduleState.lastStages, totalSeconds: moduleState.lastTotalSeconds };
}
