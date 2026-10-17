// Half of a length or span: the middle of a rect, the viewport or a search range.
// One spelling for every caller, so halving never needs its own named 2.

const HALVES_IN_A_WHOLE = 2;

export function half(value) {
    return value / HALVES_IN_A_WHOLE;
}
