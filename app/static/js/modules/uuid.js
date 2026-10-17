const HEX_DIGITS_PER_BYTE = 2;
// RFC 4122 byte layout: time_low, time_mid, time_hi_and_version (its first
// byte holds the version), clock_seq (its first byte holds the variant), node.
const TIME_MID_START = 4;
const VERSION_BYTE = 6;
const VARIANT_BYTE = 8;
const NODE_START = 10;

export const createUuid = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
        throw new Error('Secure UUID generation unavailable');
    }

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    // RFC 4122 version 4
    bytes[VERSION_BYTE] = (bytes[VERSION_BYTE] & 0x0f) | 0x40;
    bytes[VARIANT_BYTE] = (bytes[VARIANT_BYTE] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(HEX_DIGITS_PER_BYTE, '0'));
    return [
        hex.slice(0, TIME_MID_START),
        hex.slice(TIME_MID_START, VERSION_BYTE),
        hex.slice(VERSION_BYTE, VARIANT_BYTE),
        hex.slice(VARIANT_BYTE, NODE_START),
        hex.slice(NODE_START),
    ].map((group) => group.join('')).join('-');
};
