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
import {
    DEFAULT_TTS_CHUNK_MIN_CHARS,
    DEFAULT_TTS_FIRST_CHUNK_MIN_CHARS,
    getAiApiConfigFromState,
    normalizeTtsChunkMinChars,
    normalizeTtsFirstChunkMinChars,
    normalizeTtsModel,
    resolveThemeSelection,
} from '../lib/store/settings';
import { getDefaultModelDefaults } from '../lib/modelDefaults';
import {
    getSituationCostumeSelections,
    normalizeGroupData,
    normalizeSituationActor,
    normalizeSituationPriorMessages,
    resolveSituationParticipants,
} from '../lib/store/situations';


describe('store pure helpers', () => {
    test('removes the legacy character token limit without reusing it as a character limit', () => {
        const [character] = normalizeCharacters([{
            id: 'character-1',
            name: '葵',
            systemPrompt: '',
            maxTokens: 1024,
            createdAt: 1,
            updatedAt: 1,
        } as Parameters<typeof normalizeCharacters>[0][number] & { maxTokens: number }]);

        expect(character).not.toHaveProperty('maxTokens');
        expect(character.maxCharacters).toBeUndefined();
    });

    test('removes the former per-character conversation compression setting', () => {
        const [character] = normalizeCharacters([{
            id: 'character-1',
            name: '葵',
            systemPrompt: '',
            enableSummary: false,
            createdAt: 1,
            updatedAt: 1,
        } as Character & { enableSummary: boolean }]);

        expect(character).not.toHaveProperty('enableSummary');
    });

    test('builds a safe conversation preview', () => {
        expect(toPreview('[emotion:happy] こんにちは <memory>非表示の記憶</memory>   世界'))
            .toBe('こんにちは 世界');
        expect(toPreview('a'.repeat(60))).toHaveLength(50);
        expect(toPreview('', [
            { id: '1', kind: 'image', name: 'photo.png', mimeType: 'image/png', data: 'data:image/png;base64,AA' },
            { id: '2', kind: 'file', name: 'memo.txt', mimeType: 'text/plain', data: 'hello' },
        ])).toBe('photo.png, memo.txt');
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

    test('normalizes the built-in VOICEVOX connection to its virtual model', () => {
        expect(normalizeTtsModel('voicevox', 'deepgram/aura-2')).toBe('voicevox');
        expect(normalizeTtsModel('openrouter', ' deepgram/aura-2 ')).toBe('deepgram/aura-2');
    });

    test('clamps the Irodori chunk thresholds to their slider ranges', () => {
        expect(normalizeTtsChunkMinChars(30)).toBe(30);
        expect(normalizeTtsChunkMinChars(1)).toBe(10);
        expect(normalizeTtsChunkMinChars(500)).toBe(80);
        expect(normalizeTtsChunkMinChars(24.6)).toBe(25);
        expect(normalizeTtsChunkMinChars('30')).toBe(DEFAULT_TTS_CHUNK_MIN_CHARS);
        expect(normalizeTtsChunkMinChars(undefined)).toBe(DEFAULT_TTS_CHUNK_MIN_CHARS);

        expect(normalizeTtsFirstChunkMinChars(8)).toBe(8);
        expect(normalizeTtsFirstChunkMinChars(0)).toBe(1);
        expect(normalizeTtsFirstChunkMinChars(500)).toBe(40);
        expect(normalizeTtsFirstChunkMinChars(NaN)).toBe(DEFAULT_TTS_FIRST_CHUNK_MIN_CHARS);
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
            costumes: [{ name: '制服', image: 'uniform-image' }],
            createdAt: 1,
            updatedAt: 1,
        };
        const actor = normalizeSituationActor({
            id: 'actor-1',
            type: 'character',
            characterId: character.id,
            costumeName: ' 制服 ',
        }, new Set([character.id]));
        expect(actor).toMatchObject({ costumeName: '制服' });
        if (!actor) throw new Error('Expected a normalized actor');

        const situation: Situation = {
            id: 'situation-1',
            name: '放課後',
            actors: [actor],
            maxTurns: 1,
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
            createdAt: 1,
            updatedAt: 1,
        };
        const withRules: Situation = {
            id: 'situation-1',
            name: '放課後',
            actors: [{ id: 'actor-1', type: 'character', characterId: character.id }],
            maxTurns: 1,
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

    test('keeps prior narration without an actor', () => {
        expect(normalizeSituationPriorMessages([
            { id: 'prior-narration', role: 'narration', content: '  放課後の教室。  ', actorId: 'ignored' },
            { id: 'prior-empty', role: 'narration', content: '   ' },
        ], new Set(['actor-1']))).toEqual([{
            id: 'prior-narration',
            role: 'narration',
            content: '放課後の教室。',
        }]);
    });

    test('temporary actors and participants carry no per-actor generation settings', () => {
        const actor = normalizeSituationActor({
            id: 'actor-1',
            type: 'temporary',
            name: '通行人',
            systemPrompt: '街角に立っている。',
            reasoningEffort: 'low',
            frequencyPenalty: 0,
            enableThinking: true,
        }, new Set());

        expect(actor).not.toHaveProperty('reasoningEffort');
        expect(actor).not.toHaveProperty('frequencyPenalty');
        expect(actor).not.toHaveProperty('enableThinking');
        if (!actor) throw new Error('Expected a normalized actor');

        const participants = resolveSituationParticipants({
            id: 'situation-1',
            name: '街角',
            actors: [actor],
            maxTurns: 1,
            memoryMode: 'off',
            createdAt: 1,
            updatedAt: 1,
        }, []);

        expect(participants[0]).toMatchObject({ actorId: 'actor-1', actorType: 'temporary' });
        expect(participants[0]).not.toHaveProperty('model');
    });

    test('drops the former thinking toggle and reasoning level from characters', () => {
        const [character] = normalizeCharacters([{
            id: 'character-1',
            name: '葵',
            systemPrompt: '',
            enableThinking: true,
            reasoningEffort: 'high',
            createdAt: 1,
            updatedAt: 1,
        } as Character & { enableThinking: boolean; reasoningEffort: string }]);

        expect(character).not.toHaveProperty('enableThinking');
        expect(character).not.toHaveProperty('reasoningEffort');
    });

    test('migrates the former director turn limit into the situation turn limit', () => {
        const character: Character = { id: 'character-1', name: '葵', systemPrompt: '', createdAt: 1, updatedAt: 1 };
        const legacy = (director: Record<string, unknown>, id: string) => ({
            id,
            name: '放課後',
            actors: [{ id: 'actor-1', type: 'character', characterId: character.id }],
            director,
            memoryMode: 'off',
            createdAt: 1,
            updatedAt: 1,
        }) as unknown as Situation;

        const normalized = normalizeGroupData({
            characters: [character],
            groups: [
                legacy({ enabled: true, model: 'm', maxAutoTurns: 5, stopPolicy: 'max-turns' }, 'situation-1'),
                legacy({ enabled: true, model: 'm', maxAutoTurns: 5, stopPolicy: 'after-one' }, 'situation-2'),
                legacy({ enabled: true, model: 'm', maxAutoTurns: 40, stopPolicy: 'max-turns' }, 'situation-3'),
            ],
            rooms: [],
        });

        expect(normalized.groups.map((group) => group.maxTurns)).toEqual([5, 1, 10]);
        for (const group of normalized.groups) expect(group).not.toHaveProperty('director');
        // 旧形式から変換したシチュエーションは保存し直す。
        expect(normalized.changedGroups).toHaveLength(3);
    });

    test('passes the trimmed user name to AI requests and omits blank names', () => {
        const modelDefaults = getDefaultModelDefaults();

        expect(getAiApiConfigFromState({ ...modelDefaults, userName: ' アリス ' }).userName)
            .toBe('アリス');
        expect(getAiApiConfigFromState({ ...modelDefaults, userName: '   ' }))
            .not.toHaveProperty('userName');
    });
});
