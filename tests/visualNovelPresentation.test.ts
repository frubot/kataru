import { describe, expect, test } from 'vitest';
import type { Character, Room } from '../lib/store';
import {
    buildVisualNovelTypingSegments,
    getVisualNovelCostumeOptions,
    getVisualNovelTypingDelay,
    resolveVisualNovelCostumeName,
    resolveVisualNovelExpressionImage,
} from '../lib/visualNovelPresentation';

const character: Character = {
    id: 'character-1',
    name: 'Alice',
    systemPrompt: '',
    model: 'test',
    icon: 'icon.png',
    expressions: [
        { name: 'neutral', image: 'neutral.png' },
        { name: 'happy', image: 'happy.png' },
    ],
    costumes: [
        {
            name: 'uniform',
            image: 'uniform.png',
            expressions: [{ name: 'happy', image: 'uniform-happy.png' }],
        },
    ],
    createdAt: 0,
    updatedAt: 0,
};

const room = {
    id: 'room-1',
    characterId: character.id,
    name: 'Room',
    messages: [],
    costumeSelections: { [character.id]: 'uniform' },
    createdAt: 0,
    updatedAt: 0,
} satisfies Room;

describe('visual novel costume and expression presentation', () => {
    test('keeps only an existing selected costume', () => {
        expect(resolveVisualNovelCostumeName(room, character)).toBe('uniform');
        expect(resolveVisualNovelCostumeName({ ...room, costumeSelections: { [character.id]: 'missing' } }, character)).toBe('default');
    });

    test('uses a costume expression before the costume or character fallback', () => {
        expect(resolveVisualNovelExpressionImage(character, 'happy', 'uniform')).toBe('uniform-happy.png');
        expect(resolveVisualNovelExpressionImage(character, 'sad', 'uniform')).toBe('uniform.png');
        expect(resolveVisualNovelExpressionImage(character, 'happy')).toBe('happy.png');
        expect(resolveVisualNovelExpressionImage(character, 'missing')).toBe('neutral.png');
    });

    test('builds a default option alongside non-default costumes', () => {
        expect(getVisualNovelCostumeOptions(character)).toEqual([
            { name: 'default', image: 'neutral.png', expressionCount: 2 },
            { name: 'uniform', image: 'uniform.png', expressionCount: 1 },
        ]);
    });
});

describe('visual novel typewriter presentation', () => {
    test('keeps italic actions and unicode code points intact', () => {
        expect(buildVisualNovelTypingSegments('A*微笑む*😊')).toEqual(['A', '*微笑む*', '😊']);
        expect(buildVisualNovelTypingSegments(String.raw`A\*B`)).toEqual(['A', '\\', '*', 'B']);
    });

    test('applies punctuation and speed delays', () => {
        expect(getVisualNovelTypingDelay('a', 'default')).toBe(24);
        expect(getVisualNovelTypingDelay('、', 'default')).toBe(70);
        expect(getVisualNovelTypingDelay('。', 'default')).toBe(160);
        expect(getVisualNovelTypingDelay('*action*', 'default')).toBe(90);
        expect(getVisualNovelTypingDelay('a', 'fast')).toBe(13);
        expect(getVisualNovelTypingDelay('a', 'slow')).toBe(37);
    });
});
