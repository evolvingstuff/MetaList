// Local dates, clock times and UTC offsets as text (2026-10-16, 09:05, +02:00),
// written one way for every caller.

const MINUTES_PER_HOUR = 60;
// Months, days, hours, minutes and seconds are written with this many digits.
const CLOCK_FIELD_DIGITS = 2;

export function twoDigits(value) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error('twoDigits requires a non-negative integer');
    }
    return String(value).padStart(CLOCK_FIELD_DIGITS, '0');
}

// The local calendar date of `value`: YYYY-MM-DD.
export function localDateText(value) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new Error('localDateText requires a valid Date');
    }
    return `${value.getFullYear()}-${twoDigits(value.getMonth() + 1)}-${twoDigits(value.getDate())}`;
}

// The local offset from UTC at `value`: +HH:MM or -HH:MM.
export function utcOffsetText(value) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new Error('utcOffsetText requires a valid Date');
    }
    const offsetMinutes = -value.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absolute = Math.abs(offsetMinutes);
    return `${sign}${twoDigits(Math.floor(absolute / MINUTES_PER_HOUR))}:${twoDigits(absolute % MINUTES_PER_HOUR)}`;
}
