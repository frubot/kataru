import { describe, expect, test } from 'vitest';
import { createNameRegistry, nameFromFileName, reserveUniqueName } from '../lib/nameRegistry';

describe('nameFromFileName', () => {
    test('removes only the last extension', () => {
        expect(nameFromFileName('smile.png')).toBe('smile');
        expect(nameFromFileName('school.uniform.webp')).toBe('school.uniform');
        expect(nameFromFileName('casual')).toBe('casual');
    });

    test('trims and joins whitespace with underscores', () => {
        expect(nameFromFileName('  big smile .png')).toBe('big_smile');
        expect(nameFromFileName('笑顔 2.jpg')).toBe('笑顔_2');
    });

    test('returns an empty string for extension-only names', () => {
        expect(nameFromFileName('.png')).toBe('');
    });

    test('combines with name reservation to avoid duplicates', () => {
        const reservedNames = createNameRegistry(['neutral', 'Smile']);
        expect(reserveUniqueName(nameFromFileName('smile.png'), reservedNames, '表情名')).toBe('smile_2');
    });
});
