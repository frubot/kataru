import { describe, expect, test } from 'vitest';
import type { Character, Room } from '../lib/store';
import {
    buildVisualNovelTypingSegments,
    getVisualNovelCostumeOptions,
    getVisualNovelPreloadCandidates,
    getVisualNovelTypingDelay,
    resolveVisualNovelCostumeName,
    resolveVisualNovelExpressionImage,
    shouldTriggerVisualNovelBounce,
    splitVisualNovelMessage,
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

    test('prioritizes next expression variants and deduplicates the current image', () => {
        expect(getVisualNovelPreloadCandidates(character, 'uniform', 'uniform-happy.png')).toEqual([
            'uniform.png',
        ]);
        expect(getVisualNovelPreloadCandidates(character, 'default', 'neutral.png')).toEqual([
            'happy.png',
            'icon.png',
            'uniform.png',
        ]);
    });

    test('caps preload candidates without returning empty or duplicate sources', () => {
        const duplicated: Character = {
            ...character,
            expressions: [
                { name: 'neutral', image: 'same.png' },
                { name: 'happy', image: 'same.png' },
                { name: 'sad', image: 'sad.png' },
            ],
        };
        expect(getVisualNovelPreloadCandidates(duplicated, 'default', null, 2)).toEqual([
            'same.png',
            'sad.png',
        ]);
        expect(getVisualNovelPreloadCandidates(null)).toEqual([]);
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

    test('splits long messages at sentence boundaries', () => {
        expect(splitVisualNovelMessage(
            '最初の文です。次の文です。最後の文です。',
            8,
        )).toEqual([
            '最初の文です。',
            '次の文です。',
            '最後の文です。',
        ]);
    });

    test('keeps italic actions intact across pages', () => {
        const content = '12345*とても長い仕草*67890';
        const pages = splitVisualNovelMessage(content, 8);

        expect(pages.join('')).toBe(content);
        expect(pages.some((page) => page.includes('*とても長い仕草*'))).toBe(true);
    });
});

describe('visual novel character bounce', () => {
    test('runs when a new assistant message appears in the active conversation', () => {
        expect(shouldTriggerVisualNovelBounce(
            { contextKey: 'room-1:solo', messageKey: null },
            { contextKey: 'room-1:solo', messageKey: 'assistant-1' },
        )).toBe(true);
        expect(shouldTriggerVisualNovelBounce(
            { contextKey: 'room-1:solo', messageKey: 'assistant-1' },
            { contextKey: 'room-1:solo', messageKey: 'assistant-2' },
        )).toBe(true);
    });

    test('does not run for initial display, chat navigation, or returning from the log', () => {
        expect(shouldTriggerVisualNovelBounce(
            null,
            { contextKey: 'room-1:solo', messageKey: 'assistant-1' },
        )).toBe(false);
        expect(shouldTriggerVisualNovelBounce(
            { contextKey: 'room-1:solo', messageKey: 'assistant-1' },
            { contextKey: 'room-2:solo', messageKey: 'assistant-2' },
        )).toBe(false);
        expect(shouldTriggerVisualNovelBounce(
            { contextKey: null, messageKey: 'assistant-1' },
            { contextKey: 'room-1:solo', messageKey: 'assistant-1' },
        )).toBe(false);
    });

    test('does not run again when only the character image reloads', () => {
        const snapshot = { contextKey: 'room-1:solo', messageKey: 'assistant-1' };
        expect(shouldTriggerVisualNovelBounce(snapshot, snapshot)).toBe(false);
    });
});
