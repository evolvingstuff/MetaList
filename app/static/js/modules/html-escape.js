// The one HTML escaper: text made safe to place in markup, in element text and
// in quoted attribute values alike (it escapes & < > " and ').

export function escapeHtml(value) {
    if (typeof value !== 'string') {
        throw new TypeError(`escapeHtml requires a string, got ${typeof value}`);
    }
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
