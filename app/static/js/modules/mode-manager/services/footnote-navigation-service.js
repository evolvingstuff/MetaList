export async function navigateToFootnoteWithExpansion(button, expandNote, getNoteById) {
    const note = button.closest('.note');
    if (!note || note.dataset.isCollapsed !== 'true') {
        navigateToFootnote(button);
        return;
    }
    const noteId = note.dataset.noteId;
    const number = button.dataset.footnoteNumber;
    if (typeof noteId !== 'string' || noteId.length === 0 || !/^[1-9]\d*$/.test(number)) {
        throw new Error('Collapsed footnote requires a note id and reference number');
    }
    await expandNote(noteId);
    // Expansion replaces the rendered content; navigate using its fresh marker.
    const expandedNote = getNoteById(noteId);
    const container = expandedNote.querySelector('.meta-footnotes-note');
    if (!container) {
        throw new Error('Expanded note missing its footnote container');
    }
    const expandedButton = container.querySelector(`.meta-footnote-link[data-footnote-number="${number}"]`);
    if (!expandedButton) {
        throw new Error(`Expanded note missing footnote marker ${number}`);
    }
    navigateToFootnote(expandedButton);
}

export function navigateToFootnote(button) {
    const number = button.dataset.footnoteNumber;
    if (!/^[1-9]\d*$/.test(number)) {
        throw new Error('Footnote marker requires a positive reference number');
    }
    const container = button.closest('.meta-footnotes-note');
    if (!container) {
        throw new Error('Footnote marker missing its note container');
    }
    const reference = Array.from(container.querySelectorAll('[data-footnote-reference]'))
        .find((candidate) => candidate.dataset.footnoteReference === number
            && candidate.closest('.meta-footnotes-note') === container);
    if (!reference) {
        throw new Error(`Footnote reference ${number} missing`);
    }
    reference.focus({ preventScroll: true });
    reference.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        block: 'center',
    });
}
