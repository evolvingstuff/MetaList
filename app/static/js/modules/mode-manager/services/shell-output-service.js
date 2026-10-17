export const SHELL_SELECTOR = '.meta-shell';
export const SHELL_OUTPUT_SELECTOR = '.meta-shell-output';
export const SHELL_CLOSE_SELECTOR = '.meta-shell-output-close';
export const SHELL_RUNNING_CLASS = 'meta-shell-running';
// Durations shorter than this show tenths of a second.
const TENTHS_SHOWN_BELOW_SECONDS = 10;

export function ensureShellOutputElement(shellElement) {
    if (!(shellElement instanceof HTMLElement)) {
        throw new Error('ensureShellOutputElement requires shellElement');
    }
    let outputElement = shellElement.querySelector(SHELL_OUTPUT_SELECTOR);
    if (outputElement instanceof HTMLElement) {
        return outputElement;
    }
    outputElement = document.createElement('div');
    outputElement.className = 'meta-shell-output';
    outputElement.setAttribute('aria-live', 'polite');
    shellElement.appendChild(outputElement);
    return outputElement;
}

function dismissShellOutputFromButton(outputElement) {
    if (!(outputElement instanceof HTMLElement)) {
        throw new Error('dismissShellOutputFromButton requires outputElement');
    }
    const shellElement = outputElement.closest(SHELL_SELECTOR);
    if (!(shellElement instanceof HTMLElement)) {
        throw new Error('Shell output close button missing parent shell element');
    }
    dismissShellOutput(outputElement, shellElement);
}

export function dismissShellOutput(outputElement, shellElement) {
    if (!(outputElement instanceof HTMLElement)) {
        throw new Error('dismissShellOutput requires outputElement');
    }
    if (!(shellElement instanceof HTMLElement)) {
        throw new Error('dismissShellOutput requires shellElement');
    }
    shellElement.classList.remove(SHELL_RUNNING_CLASS);
    outputElement.remove();
}

export function ensureShellOutputStructure(outputElement, noteId) {
    if (!(outputElement instanceof HTMLElement)) {
        throw new Error('ensureShellOutputStructure requires outputElement');
    }
    if (typeof noteId !== 'string' || noteId === '') {
        throw new Error('ensureShellOutputStructure requires noteId');
    }
    outputElement.dataset.noteId = noteId;

    let header = outputElement.querySelector('.meta-shell-output-header');
    if (!(header instanceof HTMLElement)) {
        header = document.createElement('div');
        header.className = 'meta-shell-output-header';
        outputElement.appendChild(header);
    }

    let statusBadge = outputElement.querySelector('.meta-shell-output-status');
    if (!(statusBadge instanceof HTMLElement)) {
        statusBadge = document.createElement('span');
        statusBadge.className = 'meta-shell-output-status';
        header.appendChild(statusBadge);
    }

    let duration = outputElement.querySelector('.meta-shell-output-duration');
    if (!(duration instanceof HTMLElement)) {
        duration = document.createElement('span');
        duration.className = 'meta-shell-output-duration';
        header.appendChild(duration);
    }

    let closeButton = outputElement.querySelector(SHELL_CLOSE_SELECTOR);
    if (!(closeButton instanceof HTMLButtonElement)) {
        closeButton = document.createElement('button');
        closeButton.className = 'meta-shell-output-close';
        closeButton.type = 'button';
        closeButton.textContent = 'Close';
        closeButton.setAttribute('aria-label', 'Close terminal feedback');
        closeButton.title = 'Close terminal feedback';
        closeButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            dismissShellOutputFromButton(outputElement);
        });
        header.appendChild(closeButton);
    }

    let errorRow = outputElement.querySelector('.meta-shell-output-message-error');
    if (!(errorRow instanceof HTMLElement)) {
        errorRow = document.createElement('div');
        errorRow.className = 'meta-shell-output-message meta-shell-output-message-error';
        outputElement.appendChild(errorRow);
    }

    let stdoutBlock = outputElement.querySelector('.meta-shell-output-stdout');
    if (!(stdoutBlock instanceof HTMLElement)) {
        stdoutBlock = document.createElement('pre');
        stdoutBlock.className = 'meta-shell-output-stdout';
        outputElement.appendChild(stdoutBlock);
    }

    let stderrBlock = outputElement.querySelector('.meta-shell-output-stderr');
    if (!(stderrBlock instanceof HTMLElement)) {
        stderrBlock = document.createElement('pre');
        stderrBlock.className = 'meta-shell-output-stderr';
        outputElement.appendChild(stderrBlock);
    }

    let emptyRow = outputElement.querySelector('.meta-shell-output-empty');
    if (!(emptyRow instanceof HTMLElement)) {
        emptyRow = document.createElement('div');
        emptyRow.className = 'meta-shell-output-empty';
        outputElement.appendChild(emptyRow);
    }
}

function formatShellDuration(durationMs) {
    if (!Number.isInteger(durationMs) || durationMs < 0) {
        throw new Error('formatShellDuration requires non-negative integer durationMs');
    }
    if (durationMs === 0) {
        return '0s';
    }
    const durationSeconds = durationMs / 1000;
    if (durationSeconds < TENTHS_SHOWN_BELOW_SECONDS) {
        return `${durationSeconds.toFixed(1)}s`;
    }
    return `${Math.round(durationSeconds)}s`;
}

export function renderShellSnapshot(outputElement, shellElement, result) {
    if (!(outputElement instanceof HTMLElement)) {
        throw new Error('renderShellSnapshot requires outputElement');
    }
    if (!(shellElement instanceof HTMLElement)) {
        throw new Error('renderShellSnapshot requires shellElement');
    }
    if (result === null || typeof result !== 'object') {
        throw new Error('renderShellSnapshot requires result object');
    }

    const runId = result.runId;
    const status = result.status;
    const exitCode = result.exitCode;
    const stdoutText = result.stdout;
    const stderrText = result.stderr;
    const durationMs = result.durationMs;
    const errorMessage = result.errorMessage;

    if (typeof runId !== 'string') {
        throw new Error('Shell result runId must be a string');
    }
    if (typeof status !== 'string') {
        throw new Error('Shell result status must be a string');
    }
    if (!Number.isInteger(exitCode)) {
        throw new Error('Shell result exitCode must be an integer');
    }
    if (typeof stdoutText !== 'string') {
        throw new Error('Shell result stdout must be a string');
    }
    if (typeof stderrText !== 'string') {
        throw new Error('Shell result stderr must be a string');
    }
    if (!Number.isInteger(durationMs) || durationMs < 0) {
        throw new Error('Shell result durationMs must be a non-negative integer');
    }
    if (typeof errorMessage !== 'string') {
        throw new Error('Shell result errorMessage must be a string');
    }

    const noteId = outputElement.dataset.noteId;
    if (typeof noteId !== 'string' || noteId === '') {
        throw new Error('Shell output element missing noteId');
    }

    outputElement.dataset.runId = runId;
    outputElement.dataset.status = status;

    const header = outputElement.querySelector('.meta-shell-output-header');
    const statusBadge = outputElement.querySelector('.meta-shell-output-status');
    const duration = outputElement.querySelector('.meta-shell-output-duration');
    const closeButton = outputElement.querySelector(SHELL_CLOSE_SELECTOR);
    const errorRow = outputElement.querySelector('.meta-shell-output-message-error');
    const stdoutBlock = outputElement.querySelector('.meta-shell-output-stdout');
    const stderrBlock = outputElement.querySelector('.meta-shell-output-stderr');
    const emptyRow = outputElement.querySelector('.meta-shell-output-empty');

    if (!(header instanceof HTMLElement)) {
        throw new Error('Shell output header missing');
    }
    if (!(statusBadge instanceof HTMLElement)) {
        throw new Error('Shell output status badge missing');
    }
    if (!(duration instanceof HTMLElement)) {
        throw new Error('Shell output duration missing');
    }
    if (!(closeButton instanceof HTMLButtonElement)) {
        throw new Error('Shell output close button missing');
    }
    if (!(errorRow instanceof HTMLElement)) {
        throw new Error('Shell output error row missing');
    }
    if (!(stdoutBlock instanceof HTMLElement)) {
        throw new Error('Shell output stdout block missing');
    }
    if (!(stderrBlock instanceof HTMLElement)) {
        throw new Error('Shell output stderr block missing');
    }
    if (!(emptyRow instanceof HTMLElement)) {
        throw new Error('Shell output empty row missing');
    }

    statusBadge.className = 'meta-shell-output-status';
    if (status === 'running') {
        statusBadge.textContent = 'Running';
    } else if (status === 'success') {
        statusBadge.classList.add('meta-shell-output-status-ok');
        statusBadge.textContent = `Exit ${exitCode}`;
    } else if (status === 'timeout') {
        statusBadge.classList.add('meta-shell-output-status-timeout');
        statusBadge.textContent = 'Timed out';
    } else {
        statusBadge.classList.add('meta-shell-output-status-error');
        statusBadge.textContent = `Exit ${exitCode}`;
    }
    duration.textContent = formatShellDuration(durationMs);

    closeButton.hidden = status === 'running';
    closeButton.disabled = status === 'running';

    if (errorMessage === '') {
        errorRow.style.display = 'none';
        errorRow.textContent = '';
    } else {
        errorRow.style.display = '';
        errorRow.textContent = errorMessage;
    }

    if (stdoutText === '') {
        stdoutBlock.style.display = 'none';
        stdoutBlock.textContent = '';
    } else {
        stdoutBlock.style.display = '';
        stdoutBlock.textContent = stdoutText;
    }

    if (stderrText === '') {
        stderrBlock.style.display = 'none';
        stderrBlock.textContent = '';
    } else {
        stderrBlock.style.display = '';
        stderrBlock.textContent = stderrText;
    }

    if (stdoutText === '' && stderrText === '' && errorMessage === '') {
        emptyRow.style.display = '';
        emptyRow.textContent = status === 'running' ? 'Waiting for output...' : 'No output';
    } else {
        emptyRow.style.display = 'none';
        emptyRow.textContent = '';
    }

    if (status === 'running') {
        shellElement.classList.add(SHELL_RUNNING_CLASS);
    } else {
        shellElement.classList.remove(SHELL_RUNNING_CLASS);
    }
}

export function renderShellError(outputElement, shellElement, error) {
    if (!(outputElement instanceof HTMLElement)) {
        throw new Error('renderShellError requires outputElement');
    }
    if (!(shellElement instanceof HTMLElement)) {
        throw new Error('renderShellError requires shellElement');
    }
    const noteId = outputElement.dataset.noteId;
    if (typeof noteId !== 'string' || noteId === '') {
        throw new Error('Shell output element missing noteId');
    }

    let message = 'Shell run failed';
    if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
        message = error.message;
    }

    let runId = outputElement.dataset.runId;
    if (typeof runId !== 'string') {
        runId = '';
    }
    renderShellSnapshot(outputElement, shellElement, {
        runId,
        status: 'error',
        exitCode: -1,
        stdout: '',
        stderr: '',
        durationMs: 0,
        errorMessage: message,
    });
}
