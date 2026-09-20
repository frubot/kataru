import { describe, expect, test } from 'vitest';

import { type Character, type Room, type Situation } from '../lib/store';
import { normalizeCharacters } from '../lib/store/characters';
import { mergeStoredConversationRoom } from '../lib/store/conversations';
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
    normalizeSituationPriorMessages,
    resolveSituationParticipants,
} from '../lib/store/situations';

const TEST_MODEL = { connectionId: 'openrouter', model: 'model-1' };
const FALLBACK_MODEL = { connectionId: 'openrouter', model: 'fallback-model' };
const DIRECTOR_MODEL = { connectionId: 'openrouter', model: 'director-model' };

describe('store pure helpers', () => {
    test('removes the legacy character token limit without reusing it as a character limit', () => {
        const [character] = normalizeCharacters([{
            id: 'character-1',
            name: '葵',
            systemPrompt: '',
            model: TEST_MODEL,
            maxTokens: 1024,
            createdAt: 1,
            updatedAt: 1,
        } as Parameters<typeof normalizeCharacters>[0][number] & { maxTokens: number }], FALLBACK_MODEL);

        expect(character).not.toHaveProperty('maxTokens');
        expect(character.maxCharacters).toBeUndefined();
    });

    test('removes the former per-character conversation compression setting', () => {
        const [character] = normalizeCharacters([{
            id: 'character-1',
            name: '葵',
            systemPrompt: '',
            model: TEST_MODEL,
            enableSummary: false,
            createdAt: 1,
            updatedAt: 1,
        } as Character & { enableSummary: boolean }], FALLBACK_MODEL);

        expect(character).not.toHaveProperty('enableSummary');
    });

    test('builds a safe conversation preview', () => {
        expect(toPreview('[emotion:happy] こんにちは <memory>非表示の記憶</memory>   世界'))
            .toBe('こんにちは 世界');
        expect(toPreview('a'.repeat(60))).toHaveLength(50);
    });

    test('clears a stale draft marker after the room is found in SQLite', () => {
        const draft: Room = {
            id: 'room-1',
            characterId: 'character-1',
            name: '',
            messages: [],
            isDraft: true,
            createdAt: 1,
            updatedAt: 1,
        };
        const merged = mergeStoredConversationRoom(
            draft,
            {
                id: draft.id,
                characterId: draft.characterId,
                name: 'Saved room',
                createdAt: 1,
                updatedAt: 2,
            },
            [{ id: 'message-1', role: 'assistant', content: 'Saved', timestamp: 2 }],
            true,
        );

        expect(merged.isDraft).toBeUndefined();
        expect(merged.name).toBe('Saved room');
        expect(merged.messages).toHaveLength(1);
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
            model: TEST_MODEL,
            costumes: [{ name: '制服', image: 'uniform-image' }],
            createdAt: 1,
            updatedAt: 1,
        };
        const actor = normalizeSituationActor({
            id: 'actor-1',
            type: 'character',
            characterId: character.id,
            costumeName: ' 制服 ',
        }, new Set([character.id]), FALLBACK_MODEL);
        expect(actor).toMatchObject({ costumeName: '制服' });
        if (!actor) throw new Error('Expected a normalized actor');

        const situation: Situation = {
            id: 'situation-1',
            name: '放課後',
            actors: [actor],
            director: {
                enabled: true,
                model: TEST_MODEL,
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

    test('keeps character common rules and defaults them to an empty string', () => {
        const character: Character = {
            id: 'character-1',
            name: '葵',
            systemPrompt: '',
            model: TEST_MODEL,
            createdAt: 1,
            updatedAt: 1,
        };
        const director = {
            enabled: true,
            model: TEST_MODEL,
            maxAutoTurns: 1,
            stopPolicy: 'max-turns' as const,
        };
        const withRules: Situation = {
            id: 'situation-1',
            name: '放課後',
            actors: [{ id: 'actor-1', type: 'character', characterId: character.id }],
            director,
            memoryMode: 'off',
            characterCommonRules: '全員、敬語で話す',
            createdAt: 1,
            updatedAt: 1,
        };
        const withoutRules: Situation = {
            ...withRules,
            id: 'situation-2',
            characterCommonRules: undefined,
        };

        const normalized = normalizeGroupData({
            characters: [character],
            groups: [withRules, withoutRules],
            rooms: [],
        });

        expect(normalized.groups[0].characterCommonRules).toBe('全員、敬語で話す');
        expect(normalized.groups[1].characterCommonRules).toBe('');
    });

    test('repairs blank room names with stable default names', () => {
        const character: Character = {
            id: 'character-1',
            name: '葵',
            systemPrompt: '',
            model: TEST_MODEL,
            createdAt: 1,
            updatedAt: 1,
        };
        const rooms: Room[] = [
            {
                id: 'room-2',
                characterId: character.id,
                name: '   ',
                messages: [],
                createdAt: 2,
                updatedAt: 2,
            },
            {
                id: 'room-1',
                characterId: character.id,
                name: '',
                messages: [],
                createdAt: 1,
                updatedAt: 1,
            },
        ];

        const normalized = normalizeGroupData({ characters: [character], groups: [], rooms });

        expect(normalized.rooms.map((room) => room.name)).toEqual(['葵 2', '葵 1']);
        expect(normalized.changedRooms).toHaveLength(2);
    });

    test('keeps default and temporary situation actors out of costume selections', () => {
        expect(getSituationCostumeSelections([
            { id: 'actor-1', type: 'character', characterId: 'character-1', costumeName: 'default' },
            { id: 'actor-2', type: 'temporary', name: '通行人', systemPrompt: '' },
        ])).toBeUndefined();
    });

    test('preserves a configured expression on a prior assistant message', () => {
        expect(normalizeSituationPriorMessages([{
            id: 'prior-assistant',
            role: 'assistant',
            actorId: 'actor-1',
            content: '  こんにちは  ',
            expression: ' happy ',
        }], new Set(['actor-1']))).toEqual([{
            id: 'prior-assistant',
            role: 'assistant',
            actorId: 'actor-1',
            content: 'こんにちは',
            expression: 'happy',
        }]);
    });

    test('preserves generation settings for temporary situation actors and participants', () => {
        const actor = normalizeSituationActor({
            id: 'actor-1',
            type: 'temporary',
            name: '通行人',
            systemPrompt: '街角に立っている。',
            enableThinking: true,
            frequencyPenalty: 0,
            presencePenalty: -0.5,
            repetitionPenalty: 1.15,
        }, new Set(), FALLBACK_MODEL);

        expect(actor).toMatchObject({
            type: 'temporary',
            enableThinking: true,
            frequencyPenalty: 0,
            presencePenalty: -0.5,
            repetitionPenalty: 1.15,
        });
        if (!actor) throw new Error('Expected a normalized actor');

        const participants = resolveSituationParticipants({
            id: 'situation-1',
            name: '街角',
            actors: [actor],
            director: {
                enabled: true,
                model: DIRECTOR_MODEL,
                maxAutoTurns: 1,
                stopPolicy: 'max-turns',
            },
            memoryMode: 'off',
            createdAt: 1,
            updatedAt: 1,
        }, [], FALLBACK_MODEL);

        expect(participants[0]).toMatchObject({
            actorId: 'actor-1',
            actorType: 'temporary',
            enableThinking: true,
            frequencyPenalty: 0,
            presencePenalty: -0.5,
            repetitionPenalty: 1.15,
        });
    });
});
