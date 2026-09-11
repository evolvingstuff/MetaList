import assert from 'node:assert/strict';
import test from 'node:test';

import {
    generateRandomPassword,
    normalizePasswordCharset,
} from '../../app/static/js/modules/password-generator.js';

test('normalizePasswordCharset strips newline separators', () => {
    const normalized = normalizePasswordCharset('abc\nXYZ\r\n123');
    assert.equal(normalized, 'abcXYZ123');
});

test('normalizePasswordCharset removes duplicate code points in first-seen order', () => {
    assert.equal(normalizePasswordCharset('a😀a\nb😀\r\nb'), 'a😀b');
});

test('generation gives duplicate alphabet entries no extra weight', () => {
    const password = generateRandomPassword(6, 'aaabbc', (buffer) => {
        buffer.forEach((_value, index) => { buffer[index] = index; });
    });
    assert.equal(password, 'abcabc');
});

for (const charset of ['😀', 'a😀😎']) {
    for (const length of [1, 3, 4, 5]) {
        test(`generation counts Unicode code points: ${JSON.stringify(charset)}, length ${length}`, () => {
            const password = generateRandomPassword(length, charset, (buffer) => {
                buffer.forEach((_value, index) => { buffer[index] = index; });
            });
            const characters = Array.from(password);
            assert.equal(characters.length, length);
            assert.ok(characters.every(character => Array.from(charset).includes(character)));
        });
    }
}

test('rejection sampling skips the biased tail before selecting characters', () => {
    const password = generateRandomPassword(3, 'abc', (buffer) => {
        buffer.fill(0xffffffff);
        buffer.set([0xffffffff, 0, 1, 2]);
    });
    assert.equal(password, 'abc');
});

test('generateRandomPassword uses provided random source deterministically', () => {
    const deterministicRandom = (buffer) => {
        for (let index = 0; index < buffer.length; index += 1) {
            buffer[index] = index;
        }
        return buffer;
    };

    const password = generateRandomPassword(6, 'abc', deterministicRandom);
    assert.equal(password, 'abcabc');
});

test('generateRandomPassword rejects invalid length', () => {
    assert.throws(
        () => generateRandomPassword(0, 'abc', () => new Uint32Array(0)),
        /length must be a positive integer/,
    );
});

test('generateRandomPassword rejects empty charset', () => {
    assert.throws(
        () => generateRandomPassword(8, '', () => new Uint32Array(0)),
        /charset must be a non-empty string/,
    );
});
