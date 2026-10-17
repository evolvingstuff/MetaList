export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 72;
export const PASSWORD_MIN_ZXCVBN_SCORE = 3;
const PERCENT_OF_WHOLE = 100;


export function calculatePasswordLengthProgress(password) {
    if (typeof password !== 'string') {
        throw new TypeError('password must be a string');
    }
    const characterCount = password.length;
    return {
        characterCount,
        remainingCharacterCount: Math.max(PASSWORD_MIN_LENGTH - characterCount, 0),
        progressPercent: Math.min(characterCount / PASSWORD_MIN_LENGTH, 1) * PERCENT_OF_WHOLE,
        meetsMinimumLength: characterCount >= PASSWORD_MIN_LENGTH,
    };
}


export function validateNewPasswordLength(password) {
    if (typeof password !== 'string') {
        throw new TypeError('password must be a string');
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
        return {
            valid: false,
            error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
        };
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
        return {
            valid: false,
            error: `Password must be no more than ${PASSWORD_MAX_LENGTH} characters`,
        };
    }
    return { valid: true };
}
