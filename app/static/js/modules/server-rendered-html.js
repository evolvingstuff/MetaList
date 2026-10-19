import { produces } from '../shockharness/contracts.js';

// HTML the server sent for the page: a note's view, a full-screen or floating note, a
// chat reply or its thinking text, or a note's stored HTML. The server sanitizes each
// rendering last (app/security/rendered_html.py) and stored HTML on every save
// (app/security/note_html.py), so it is safe to assign.
export function serverRenderedHtml(html) {
    if (typeof html !== 'string') {
        throw new Error('serverRenderedHtml requires a string');
    }
    return produces(html, 'sanitized_html');
}
