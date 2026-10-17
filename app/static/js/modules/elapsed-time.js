import { MS_PER_SECOND, SECONDS_PER_MINUTE } from './time-units.js';

export function formatElapsedDuration(elapsedMilliseconds) {
    if (
        typeof elapsedMilliseconds !== 'number'
        || !Number.isFinite(elapsedMilliseconds)
        || elapsedMilliseconds < 0
    ) {
        throw new Error('elapsedMilliseconds must be a non-negative finite number');
    }

    const totalSeconds = Math.floor(elapsedMilliseconds / MS_PER_SECOND);
    if (totalSeconds < SECONDS_PER_MINUTE) {
        return `${totalSeconds}s`;
    }

    const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
    const seconds = totalSeconds % SECONDS_PER_MINUTE;
    return `${minutes}m ${seconds}s`;
}
