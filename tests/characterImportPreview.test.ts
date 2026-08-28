import { describe, expect, test } from 'vitest';
import { resolveCharacterImportPreviewImage } from '../lib/characterImportPreview';
import type { Character } from '../lib/store';

function characterWithImages(overrides: Partial<Character>): Character {
    return {
        id: 'character-1',
        name: '葵',
        systemPrompt: '',
        model: 'test-model',
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

describe('resolveCharacterImportPreviewImage', () => {
    test('prioritizes the neutral expression from the default costume', () => {
        const character = characterWithImages({
            icon: 'icon.png',
            expressions: [{ name: 'neutral', image: 'top-neutral.png' }],
            costumes: [{
                name: 'DEFAULT',
                image: 'default.png',
                expressions: [{ name: 'Neutral', image: 'default-neutral.png' }],
            }],
        });

        expect(resolveCharacterImportPreviewImage(character)).toBe('default-neutral.png');
    });

    test('uses the default costume base image before the top-level neutral expression', () => {
        const character = characterWithImages({
            icon: 'icon.png',
            expressions: [{ name: 'neutral', image: 'top-neutral.png' }],
            costumes: [{ name: 'default', image: 'default.png' }],
        });

        expect(resolveCharacterImportPreviewImage(character)).toBe('default.png');
    });

    test('falls back to the top-level neutral expression and then the icon', () => {
        const neutralCharacter = characterWithImages({
            icon: 'icon.png',
            expressions: [{ name: 'neutral', image: 'top-neutral.png' }],
        });
        const iconCharacter = characterWithImages({ icon: 'icon.png' });

        expect(resolveCharacterImportPreviewImage(neutralCharacter)).toBe('top-neutral.png');
        expect(resolveCharacterImportPreviewImage(iconCharacter)).toBe('icon.png');
    });
});
