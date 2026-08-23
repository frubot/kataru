import { describe, expect, test } from 'vitest';

import { useStore, type Character, type Room, type Situation } from '../lib/store';
import { normalizeCharacters } from '../lib/store/characters';
import {
    createMemoryRecord,
    inferMemoryKind,
    memoryTextSimilarity,
    normalizeMemoryContent,
} from '../lib/store/memories';
import { toPreview } from '../lib/store/persistence';
import { resolveThemeSelection } from '../lib/store/settings';
import {
    getSituationCostumeSelections,
    normalizeGroupData,
    normalizeSituationActor,
} from '../lib/store/situations';

describe('store composition', () => {
    test('assembles state and actions from every slice', () => {
        const state = useStore.getState();

        expect(state.hydrated).toBe(false);
        expect(state.characters).toEqual([]);
        expect(state.groups).toEqual([]);
        expect(state.rooms).toEqual([]);
        expect(state.usageRecords).toEqual([]);
        expect(state.themeMode).toBe('dark');
        expect(state.themePalette).toBe('mono');

        for (const action of [
            'hydrate',
            'createCharacter',
            'addMemory',
            'createRoom',
            'addMessage',
            'addUsageRecord',
            'mergeBackup',
            'resetApplication',
        ] as const) {
            expect(state[action], action).toBeTypeOf('function');
        }
    });
});

describe('store pure helpers', () => {
    test('removes the legacy character token limit without reusing it as a character limit', () => {
        const [character] = normalizeCharacters([{
            id: 'character-1',
            name: '葵',
            systemPrompt: '',
            model: 'model-1',
            maxTokens: 1024,
            createdAt: 1,
            updatedAt: 1,
        } as Parameters<typeof normalizeCharacters>[0][number] & { maxTokens: number }], 'fallback-model');

        expect(character).not.toHaveProperty('maxTokens');
        expect(character.maxCharacters).toBeUndefined();
    });

    test('builds a safe conversation preview', () => {
        expect(toPreview('[emotion:happy] こんにちは <memory>非表示の記憶</memory>   世界'))
            .toBe('こんにちは 世界');
        expect(toPreview('a'.repeat(60))).toHaveLength(50);
    });

    test('normalizes theme values independently', () => {
        expect(resolveThemeSelection({ mode: 'light', palette: 'sakura' }))
            .toEqual({ mode: 'light', palette: 'sakura' });
        expect(resolveThemeSelection({ mode: 'invalid', palette: null }))
            .toEqual({ mode: 'dark', palette: 'mono' });
    });

    test('normalizes, classifies, and compares memory text', () => {
        expect(normalizeMemoryContent('  紅茶が\n  好き  ')).toBe('紅茶が 好き');
        expect(inferMemoryKind('紅茶が好き')).toBe('preference');
        expect(inferMemoryKind('前回の出来事')).toBe('event');
        expect(memoryTextSimilarity('「紅茶」が好き。', '紅茶 が好き')).toBe(1);
        expect(memoryTextSimilarity('紅茶が好き', '宇宙船を修理した')).toBeLessThan(0.5);
    });

    test('creates a normalized memory record with defaults', () => {
        const record = createMemoryRecord('character-1', '  紅茶が好き  ');

        expect(record).toMatchObject({
            characterId: 'character-1',
            content: '紅茶が好き',
            kind: 'preference',
            scope: 'character',
            importance: 0.6,
            confidence: 0.85,
            sourceMessageIds: [],
            usageCount: 0,
        });
        expect(createMemoryRecord('character-1', '   ')).toBeNull();
    });

    test('normalizes situation costumes and applies them to situation rooms', () => {
        const character: Character = {
            id: 'character-1',
            name: '葵',
            systemPrompt: '',
            model: 'model-1',
            costumes: [{ name: '制服', image: 'uniform-image' }],
            createdAt: 1,
            updatedAt: 1,
        };
        const actor = normalizeSituationActor({
            id: 'actor-1',
            type: 'character',
            characterId: character.id,
            costumeName: ' 制服 ',
        }, new Set([character.id]), 'fallback-model');
        expect(actor).toMatchObject({ costumeName: '制服' });
        if (!actor) throw new Error('Expected a normalized actor');

        const situation: Situation = {
            id: 'situation-1',
            name: '放課後',
            actors: [actor],
            director: {
                enabled: true,
                model: 'model-1',
                maxAutoTurns: 1,
                stopPolicy: 'max-turns',
            },
            memoryMode: 'off',
            createdAt: 1,
            updatedAt: 1,
        };
        const room: Room = {
            id: 'room-1',
            characterId: actor.id,
            groupId: situation.id,
            name: 'チャット 1',
            messages: [],
            createdAt: 1,
            updatedAt: 1,
        };
        const normalized = normalizeGroupData({
            characters: [character],
            groups: [situation],
            rooms: [room],
        });

        expect(getSituationCostumeSelections(situation.actors)).toEqual({ 'actor-1': '制服' });
        expect(normalized.rooms[0].costumeSelections).toEqual({ 'actor-1': '制服' });
        expect(normalized.changedRooms).toHaveLength(1);
    });

    test('keeps default and temporary situation actors out of costume selections', () => {
        expect(getSituationCostumeSelections([
            { id: 'actor-1', type: 'character', characterId: 'character-1', costumeName: 'default' },
            { id: 'actor-2', type: 'temporary', name: '通行人', systemPrompt: '' },
        ])).toBeUndefined();
    });
});
