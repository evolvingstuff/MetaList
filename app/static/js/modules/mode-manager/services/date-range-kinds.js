// The date range filter's fields and ranges (app/services/root_date_filter.py), without
// the browser state the date range service keeps, so the menus can name them anywhere.

export const DATE_RANGE_FIELDS = Object.freeze({ CREATED: 'created', UPDATED: 'updated' });
export const DATE_RANGE_KINDS = Object.freeze({
    NONE: 'none',
    TODAY: 'today',
    LAST_7_DAYS: 'last-7-days',
    LAST_30_DAYS: 'last-30-days',
    THIS_YEAR: 'this-year',
    CUSTOM: 'custom',
});
// An open end of a custom range.
export const OPEN_DATE = '';
export const DATE_RANGE_PRESETS = Object.freeze([
    [DATE_RANGE_KINDS.TODAY, 'Today'],
    [DATE_RANGE_KINDS.LAST_7_DAYS, 'Last 7 days'],
    [DATE_RANGE_KINDS.LAST_30_DAYS, 'Last 30 days'],
    [DATE_RANGE_KINDS.THIS_YEAR, 'This year'],
]);
