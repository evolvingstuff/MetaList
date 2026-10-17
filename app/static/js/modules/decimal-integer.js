// Reading a whole number written in base 10, the way every form field and data
// attribute in MetaList writes one.

const DECIMAL_RADIX = 10;

export function parseDecimalInteger(text) {
    return Number.parseInt(text, DECIMAL_RADIX);
}
