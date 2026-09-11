export const DEFAULT_PASSWORD_LENGTH = 16;
export const DEFAULT_PASSWORD_CHARSET = `abcdefghijklmnopqrstuvwxyz
ABCDEFGHIJKLMNOPQRSTUVWXYZ
0123456789
@%+\\/\'!#$^?:,.(){}[]~`;

function resolveRandomValuesFunction(fillRandomValues) {
    if (typeof fillRandomValues === 'function') {
        return fillRandomValues;
    }
    const cryptoObject = globalThis.crypto;
    if (!cryptoObject || typeof cryptoObject.getRandomValues !== 'function') {
        throw new Error('Secure random source unavailable');
    }
    return (buffer) => cryptoObject.getRandomValues(buffer);
}

export function normalizePasswordCharset(rawCharsetInput) {
    if (typeof rawCharsetInput !== 'string') {
        throw new Error('normalizePasswordCharset requires string input');
    }

    const withoutCarriageReturns = rawCharsetInput.replace(/\r/g, '');
    let normalized = '';
    for (const character of withoutCarriageReturns) {
        if (character === '\n') {
            continue;
        }
        normalized += character;
    }

    if (normalized.length === 0) {
        throw new Error('Character set must not be empty');
    }
    return Array.from(new Set(normalized)).join('');
}

export function generateRandomPassword(length, charset, fillRandomValues) {
    if (!Number.isInteger(length) || length <= 0) {
        throw new Error('length must be a positive integer');
    }
    if (typeof charset !== 'string' || charset.length === 0) {
        throw new Error('charset must be a non-empty string');
    }

    const characters = Array.from(normalizePasswordCharset(charset));
    if (characters.length === 0) {
        throw new Error('charset must contain at least one character');
    }

    const randomValues = resolveRandomValuesFunction(fillRandomValues);
    const charsetLength = characters.length;
    const unbiasedUpperBound = Math.floor(0x100000000 / charsetLength) * charsetLength;

    const result = [];
    while (result.length < length) {
        const remaining = length - result.length;
        const sampleCount = remaining * 2;
        const randomBuffer = new Uint32Array(sampleCount);
        randomValues(randomBuffer);

        for (const value of randomBuffer) {
            if (value >= unbiasedUpperBound) {
                continue;
            }
            const nextCharacter = characters[value % charsetLength];
            result.push(nextCharacter);
            if (result.length === length) {
                return result.join('');
            }
        }
    }

    return result.join('');
}
