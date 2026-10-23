import { ApplicationState } from '../../application-state.js';
import { localDateText } from '../../local-date-text.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { showSearchInputChip } from './search-input-chip-service.js';
import { DATE_RANGE_FIELDS, DATE_RANGE_KINDS, OPEN_DATE } from './date-range-kinds.js';

export { DATE_RANGE_FIELDS, DATE_RANGE_KINDS, DATE_RANGE_PRESETS, OPEN_DATE } from './date-range-kinds.js';

// Date range filter (app/services/root_date_filter.py): a tab shows only the root
// notes created, or last updated, in a range of local dates. The server keeps each
// tab's filter with the tab state (dateFilters) and filters the view; this keeps
// the filters it last sent, for the menus and the chip in the search input.

const FIELD_LABELS = Object.freeze({ created: 'Created', updated: 'Updated' });
const FIELD_TOOLTIP_LABELS = Object.freeze({ created: 'Created', updated: 'Last updated' });
const PRESET_CHIP_TEXT = Object.freeze({
    [DATE_RANGE_KINDS.TODAY]: 'today',
    [DATE_RANGE_KINDS.LAST_7_DAYS]: 'last 7 days',
    [DATE_RANGE_KINDS.LAST_30_DAYS]: 'last 30 days',
    [DATE_RANGE_KINDS.THIS_YEAR]: 'this year',
});
const FILTER_KEYS = Object.freeze(['field', 'rangeKind', 'fromDate', 'toDate']);
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_INDEX_OFFSET = 1;

const moduleState = ApplicationState.createFields('date-range-filter-service', {
    // Each tab's filter as the server last sent it, by tab id; a tab without one shows every date.
    filtersByTabId: Object.freeze({}),
    // Created or Last updated: the active filter's, or the one last picked.
    pickedField: DATE_RANGE_FIELDS.UPDATED,
});

function requireFilter(filter) {
    if (!filter || typeof filter !== 'object') {
        throw new Error('A date range filter must be an object');
    }
    for (const key of FILTER_KEYS) {
        if (typeof filter[key] !== 'string') {
            throw new Error(`A date range filter needs ${key}`);
        }
    }
    if (!Object.hasOwn(FIELD_LABELS, filter.field)) {
        throw new Error(`Unknown date range field: ${filter.field}`);
    }
    if (filter.rangeKind === DATE_RANGE_KINDS.NONE || !Object.values(DATE_RANGE_KINDS).includes(filter.rangeKind)) {
        throw new Error(`Unknown date range: ${filter.rangeKind}`);
    }
    return filter;
}

/** Take the filters from a tab-state response (every one carries dateFilters). */
export function recordDateFiltersFromServer(serverState) {
    if (!serverState || typeof serverState !== 'object') {
        throw new Error('recordDateFiltersFromServer requires the server tab state');
    }
    const filters = serverState.dateFilters;
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
        throw new Error('Tab state response missing dateFilters');
    }
    const next = {};
    for (const [tabId, filter] of Object.entries(filters)) {
        next[tabId] = Object.freeze({ ...requireFilter(filter) });
    }
    if (JSON.stringify(next) !== JSON.stringify(moduleState.filtersByTabId)) {
        moduleState.filtersByTabId = Object.freeze(next);
    }
}

/** The tab's filter, or null when it shows every date. */
export function getTabDateFilter(tabId) {
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('getTabDateFilter requires a tab id');
    }
    if (!Object.hasOwn(moduleState.filtersByTabId, tabId)) {
        return null;
    }
    return moduleState.filtersByTabId[tabId];
}

export function getActiveDateFilter() {
    return getTabDateFilter(ModeContext.activeTabId);
}

/** Created or Last updated, as the Date range menu ticks it. */
export function getDateRangeField() {
    const active = getActiveDateFilter();
    if (active !== null) {
        return active.field;
    }
    return moduleState.pickedField;
}

export function rememberDateRangeField(field) {
    if (!Object.hasOwn(FIELD_LABELS, field)) {
        throw new Error(`Unknown date range field: ${field}`);
    }
    if (moduleState.pickedField !== field) {
        moduleState.pickedField = field;
    }
}

function parseIsoDate(text) {
    const match = ISO_DATE_PATTERN.exec(text);
    if (match === null) {
        throw new Error(`A date range end must be YYYY-MM-DD, not ${text}`);
    }
    return new Date(Number(match[1]), Number(match[2]) - MONTH_INDEX_OFFSET, Number(match[3]));
}

function formatDay(day, options) {
    const isThisYear = day.getFullYear() === new Date().getFullYear();
    const parts = { month: options.monthStyle, day: 'numeric' };
    if (!isThisYear || options.withYear) parts.year = 'numeric';
    return day.toLocaleDateString(undefined, parts);
}

// Oct 1–23, Sep 28–Oct 23, since Oct 1, until Oct 23 (full months for the tooltip).
function describeCustomRange(filter, monthStyle) {
    const withYear = monthStyle === 'long';
    if (filter.fromDate === OPEN_DATE) {
        return `until ${formatDay(parseIsoDate(filter.toDate), { monthStyle, withYear })}`;
    }
    const first = parseIsoDate(filter.fromDate);
    if (filter.toDate === OPEN_DATE) {
        return `since ${formatDay(first, { monthStyle, withYear })}`;
    }
    const last = parseIsoDate(filter.toDate);
    if (filter.fromDate === filter.toDate) {
        return formatDay(first, { monthStyle, withYear });
    }
    const sameMonth = first.getFullYear() === last.getFullYear() && first.getMonth() === last.getMonth();
    if (sameMonth && !withYear && first.getFullYear() === new Date().getFullYear()) {
        return `${formatDay(first, { monthStyle, withYear })}–${last.getDate()}`;
    }
    return `${formatDay(first, { monthStyle, withYear })} – ${formatDay(last, { monthStyle, withYear })}`;
}

export function getDateRangeChipLabel(filter) {
    requireFilter(filter);
    if (filter.rangeKind === DATE_RANGE_KINDS.CUSTOM) {
        return `${FIELD_LABELS[filter.field]} · ${describeCustomRange(filter, 'short')}`;
    }
    return `${FIELD_LABELS[filter.field]} · ${PRESET_CHIP_TEXT[filter.rangeKind]}`;
}

export function getDateRangeTooltip(filter) {
    requireFilter(filter);
    if (filter.rangeKind === DATE_RANGE_KINDS.CUSTOM) {
        return `${FIELD_TOOLTIP_LABELS[filter.field]} ${describeCustomRange(filter, 'long')}`;
    }
    return `${FIELD_TOOLTIP_LABELS[filter.field]} ${PRESET_CHIP_TEXT[filter.rangeKind]}`;
}

/** Today as the custom range dialog starts its To date. */
export function todayDateText() {
    return localDateText(new Date());
}

/** The chip inside the search input: shown while the active tab has a date range. */
export function updateDateRangeIndicator() {
    const indicator = document.getElementById('date-range-indicator');
    if (!(indicator instanceof HTMLElement)) {
        throw new Error('date-range-indicator element missing');
    }
    const label = document.getElementById('date-range-indicator-label');
    if (!(label instanceof HTMLElement)) {
        throw new Error('date-range-indicator-label element missing');
    }
    const filter = getActiveDateFilter();
    if (filter === null) {
        // The label stays while the chip shrinks out.
        showSearchInputChip(indicator, { isShown: false });
        return;
    }
    label.textContent = getDateRangeChipLabel(filter);
    label.title = getDateRangeTooltip(filter);
    showSearchInputChip(indicator, { isShown: true });
}
