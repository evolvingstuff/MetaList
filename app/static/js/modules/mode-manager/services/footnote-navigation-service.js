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
