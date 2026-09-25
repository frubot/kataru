import { afterEach, describe, expect, test, vi } from 'vitest';

import { clearAiConnectionsCache } from '../lib/aiConnections';

import {
    createCharacterBackup,
    createCharacterBackupFilename,
    createFullBackup,
    parseCharacterBackup,
    parseFullBackup,
    parseImportFile,
    reassignIds,
    shareJsonFile,
    type CharacterBackup,
    type FullBackup,
} from '../lib/importExport';
import type {
    Character,
    MemoryRecord,
    Message,
    Room,
    Situation,
    UsageRecord,
} from '../lib/store';

function character(id: string, name: string): Character {
    return {
        id,
        name,
        systemPrompt: `${name}のシステムプロンプト`,
        model: { connectionId: 'openrouter', model: 'test-model' },
        createdAt: 1,
        updatedAt: 2,
    };
}

function validBackup(): FullBackup {
    const firstCharacter = character('character-a', 'アリス');
    const secondCharacter = character('character-b', 'ボブ');
    const situation: Situation = {
        id: 'situation-1',
        name: 'テストシチュエーション',
        actors: [
            { id: 'actor-a', type: 'character', characterId: firstCharacter.id },
            { id: 'actor-b', type: 'character', characterId: secondCharacter.id },
        ],
        director: {
            enabled: false,
            model: { connectionId: 'openrouter', model: 'director-model' },
            maxAutoTurns: 3,
            stopPolicy: 'after-one',
        },
        memoryMode: 'off',
        createdAt: 1,
        updatedAt: 2,
    };
    const room: Omit<Room, 'messages'> = {
        id: 'room-1',
        characterId: 'actor-a',
        groupId: situation.id,
        name: 'テストルーム',
        summary: '既存の要約',
        summaryCheckpointUserMessageId: 'message-1',
        summaryHistory: [{
            text: '既存の要約',
            checkpointUserMessageId: 'message-1',
            createdAt: 15,
            source: 'automatic',
        }],
        createdAt: 1,
        updatedAt: 2,
    };
    const olderMessage: Message = {
        id: 'message-1',
        role: 'assistant',
        content: '古い返答',
        characterId: 'actor-b',
        toCharacterIds: ['actor-a'],
        usedMemoryIds: ['memory-1'],
        timestamp: 10,
    };
    const newerMessage: Message = {
        id: 'message-2',
        role: 'user',
        content: '新しい発言',
        timestamp: 20,
    };
    const memory: MemoryRecord = {
        id: 'memory-1',
        scope: 'character',
        characterId: firstCharacter.id,
        roomId: room.id,
        sourceRoomId: room.id,
        content: 'アリスは紅茶が好き',
        kind: 'preference',
        importance: 0.8,
        confidence: 0.9,
        sourceMessageIds: [olderMessage.id],
        createdAt: 1,
        updatedAt: 2,
        usageCount: 0,
    };
    const usageRecord: UsageRecord = {
        id: 'usage-1',
        characterId: firstCharacter.id,
        timestamp: 20,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cost: 0.01,
    };

    return {
        version: 1,
        exportedAt: 123,
        type: 'full',
        data: {
            characters: [firstCharacter, secondCharacter],
            situations: [situation],
            rooms: [room],
            // Deliberately reversed to verify the parser's timestamp ordering.
            messages: [
                { ...newerMessage, roomId: room.id },
                { ...olderMessage, roomId: room.id },
            ],
            memories: [memory],
            usageRecords: [usageRecord],
        },
    };
}

function backupJson(backup = validBackup()): string {
    return JSON.stringify(backup);
}

function validCharacterBackup(): CharacterBackup {
    return {
        version: 1,
        exportedAt: 123,
        type: 'character',
        data: {
            character: {
                name: 'アリス',
                systemPrompt: 'アリスのシステムプロンプト',
                speechStyle: '丁寧に話す',
                model: { connectionId: 'openrouter', model: 'test-model' },
                icon: 'data:image/png;base64,AA==',
                expressions: [{
                    name: 'neutral',
                    image: 'data:image/png;base64,AQ==',
                }],
            },
        },
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('createFullBackup and parseFullBackup', () => {
    test('round-trips the database collections and sorts messages per room', async () => {
        const backup = validBackup();
        const responses: Record<string, unknown> = {
            get_all_characters_with_images: backup.data.characters,
            get_all_situations_with_images: backup.data.situations,
            get_all_rooms: backup.data.rooms,
            get_all_messages: backup.data.messages,
            get_all_memories: backup.data.memories,
            get_all_usage_records: backup.data.usageRecords,
        };
        const connectionsResponse = {
            connections: [
                {
                    id: 'openrouter',
                    name: 'OpenRouter',
                    kind: 'openrouter',
                    baseUrl: 'https://openrouter.ai/api/v1',
                    baseUrlSource: 'default',
                    baseUrlEditable: false,
                    apiKey: { configured: true, source: 'stored', editable: true },
                    builtin: true,
                    editable: true,
                    deletable: false,
                    embeddingsEnabled: true,
                    imageGenerationEnabled: false,
                    ttsEnabled: false,
                    ignoredProviders: [],
                },
                {
                    id: 'voicevox',
                    name: 'VOICEVOX',
                    kind: 'voicevox',
                    baseUrl: 'http://127.0.0.1:50021',
                    baseUrlSource: 'default',
                    baseUrlEditable: true,
                    apiKey: { configured: false, source: null, editable: true },
                    builtin: true,
                    editable: true,
                    deletable: true,
                    embeddingsEnabled: false,
                    imageGenerationEnabled: false,
                    ttsEnabled: false,
                    ignoredProviders: [],
                },
                {
                    id: 'cx_local',
                    name: 'ローカルLLM',
                    kind: 'openai-compatible',
                    baseUrl: 'http://localhost:1234/v1',
                    baseUrlSource: 'stored',
                    baseUrlEditable: true,
                    apiKey: { configured: false, source: null, editable: true },
                    builtin: false,
                    editable: true,
                    deletable: true,
                    embeddingsEnabled: true,
                    imageGenerationEnabled: false,
                    ttsEnabled: true,
                    ignoredProviders: [],
                },
            ],
            secretStoreAvailable: true,
        };
        const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
            if (init?.body === undefined) {
                return {
                    ok: true,
                    json: async () => connectionsResponse,
                };
            }
            const request = JSON.parse(String(init.body)) as { op: string };
            return {
                ok: true,
                json: async () => ({ result: responses[request.op] }),
            };
        });
        vi.stubGlobal('fetch', fetchMock);
        clearAiConnectionsCache();

        const json = await createFullBackup();
        const envelope = JSON.parse(json) as FullBackup;
        const restored = parseFullBackup(json);

        expect(envelope.version).toBe(1);
        expect(envelope.type).toBe('full');
        expect(envelope.data.rooms).toEqual(backup.data.rooms);
        expect(restored.characters).toEqual(backup.data.characters);
        expect(restored.groups).toEqual(backup.data.situations);
        expect(restored.rooms).toEqual([{
            ...backup.data.rooms[0],
            messages: [
                backup.data.messages[1],
                backup.data.messages[0],
            ].map((storedMessage) => {
                const { roomId, ...message } = storedMessage;
                void roomId;
                return message;
            }),
        }]);
        expect(restored.memories).toEqual(backup.data.memories);
        expect(restored.usageRecords).toEqual(backup.data.usageRecords);
        expect(envelope.data.connections).toEqual([
            {
                id: 'openrouter',
                name: 'OpenRouter',
                kind: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                embeddingsEnabled: true,
                imageGenerationEnabled: false,
                ttsEnabled: false,
                ignoredProviders: [],
            },
            {
                id: 'voicevox',
                name: 'VOICEVOX',
                kind: 'voicevox',
                baseUrl: 'http://127.0.0.1:50021',
                embeddingsEnabled: false,
                imageGenerationEnabled: false,
                ttsEnabled: false,
                ignoredProviders: [],
            },
            {
                id: 'cx_local',
                name: 'ローカルLLM',
                kind: 'openai-compatible',
                baseUrl: 'http://localhost:1234/v1',
                embeddingsEnabled: true,
                imageGenerationEnabled: false,
                ttsEnabled: true,
                ignoredProviders: [],
            },
        ]);
        expect(JSON.stringify(envelope.data.connections)).not.toContain('apiKey');
        expect(restored.connections).toEqual(envelope.data.connections);
        expect(fetchMock).toHaveBeenCalledTimes(7);
    });

    test('reassigns IDs while preserving cross-collection references', () => {
        const parsed = parseFullBackup(backupJson());
        const reassigned = reassignIds(parsed);
        const original = validBackup();
        const originalGroup = original.data.situations[0];
        const newGroup = reassigned.groups[0];
        const newRoom = reassigned.rooms[0];
        const newMessage = newRoom.messages[0];
        const newMemory = reassigned.memories[0];
        const newFirstActor = newGroup.actors[0];

        if (newFirstActor.type !== 'character') {
            throw new Error('Expected the first actor to be a character');
        }

        expect(reassigned.characters.map(({ id }) => id)).not.toEqual(
            original.data.characters.map(({ id }) => id),
        );
        expect(newGroup.id).not.toBe(originalGroup.id);
        expect(newGroup.actors[0].id).not.toBe(originalGroup.actors[0].id);
        expect(newFirstActor.characterId).toBe(reassigned.characters[0].id);
        expect(newRoom.groupId).toBe(newGroup.id);
        expect(newRoom.characterId).toBe(newFirstActor.id);
        expect(newMessage.characterId).toBe(newGroup.actors[1].id);
        expect(newMessage.toCharacterIds).toEqual([newGroup.actors[0].id]);
        expect(newMessage.usedMemoryIds).toEqual([newMemory.id]);
        expect(newRoom.summaryCheckpointUserMessageId).toBe(newMessage.id);
        expect(newRoom.summaryHistory?.[0].checkpointUserMessageId).toBe(newMessage.id);
        expect(newMemory.characterId).toBe(reassigned.characters[0].id);
        expect(newMemory.roomId).toBe(newRoom.id);
        expect(newMemory.sourceRoomId).toBe(newRoom.id);
        expect(newMemory.sourceMessageIds).toEqual([newMessage.id]);
        expect(reassigned.usageRecords[0].characterId).toBe(reassigned.characters[0].id);
    });
});

describe('character sharing', () => {
    test('exports one character with inline images and without local metadata', async () => {
        const source: Character & { enableSummary: boolean } = {
            ...character('character-a', 'アリス'),
            favorite: true,
            enableThinking: true,
            enableSummary: false,
            frequencyPenalty: 0,
            presencePenalty: -0.5,
            repetitionPenalty: 1.15,
            icon: 'data:image/png;base64,AA==',
            expressions: [{ name: 'neutral', image: 'data:image/png;base64,AQ==' }],
        };
        const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
            const request = JSON.parse(String(init?.body)) as { op: string; character_id?: string };
            expect(request).toEqual({
                op: 'get_character_with_images',
                character_id: source.id,
            });
            return {
                ok: true,
                json: async () => ({ result: source }),
            };
        });
        vi.stubGlobal('fetch', fetchMock);

        const json = await createCharacterBackup(source.id);
        const envelope = JSON.parse(json) as CharacterBackup;

        expect(envelope.type).toBe('character');
        expect(envelope.version).toBe(1);
        expect(envelope.data.character).toMatchObject({
            name: source.name,
            icon: source.icon,
            expressions: source.expressions,
            frequencyPenalty: 0,
            presencePenalty: -0.5,
            repetitionPenalty: 1.15,
        });
        expect(parseCharacterBackup(json).characters[0]).toMatchObject(envelope.data.character);
        expect(envelope.data.character).not.toHaveProperty('id');
        expect(envelope.data.character).not.toHaveProperty('favorite');
        expect(envelope.data.character).not.toHaveProperty('enableThinking');
        expect(envelope.data.character).not.toHaveProperty('enableSummary');
        expect(envelope.data.character).not.toHaveProperty('createdAt');
        expect(envelope.data.character).not.toHaveProperty('updatedAt');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('round-trips VRM settings and can share only the 2D thumbnail', async () => {
        const source = character('vrm-character', 'VRM Character');
        source.costumes = [{ name: '3d', kind: 'vrm', image: 'data:image/png;base64,aW1hZ2U=', vrm: {
            source: 'data:model/gltf-binary;base64,Z2xURg==',
            framing: { scale: 1.2, offsetY: 0.1, rotation: 15 }, expressionMap: { smile: 'happy' },
        } }];
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ result: source }), { status: 200 })));
        const included = parseCharacterBackup(await createCharacterBackup(source.id, true));
        expect(included.characters[0].costumes).toEqual(source.costumes);
        const thumbnailOnly = parseCharacterBackup(await createCharacterBackup(source.id, false));
        expect(thumbnailOnly.characters[0].costumes?.[0]).toEqual({ name: '3d', kind: 'image', image: source.costumes[0].image });
        for (const invalid of ['https://example.com/model.vrm', `asset:${'a'.repeat(64)}`]) {
            source.costumes[0].vrm!.source = invalid;
            const backup = validCharacterBackup();
            backup.data.character.costumes = source.costumes;
            expect(() => parseCharacterBackup(JSON.stringify(backup))).toThrow();
        }
    });

    test('round-trips VRM motion settings and rejects invalid animation entries', () => {
        const vrm = {
            source: 'data:model/gltf-binary;base64,Z2xURg==',
            framing: { scale: 1.2, offsetY: 0.1, rotation: 15 },
            expressionMap: { smile: 'happy' },
            idleAnimation: 'idle',
            animations: [
                { name: 'idle', source: 'data:application/x-vrma;base64,AAAA', loop: true },
                { name: 'wave', source: 'data:application/x-vrma;base64,BBBB', useExpressions: true },
            ],
        };
        const costume = { name: '3d', kind: 'vrm' as const, image: 'data:image/png;base64,aW1hZ2U=', vrm };
        const backup = validCharacterBackup();
        backup.data.character.costumes = [costume];
        expect(parseCharacterBackup(JSON.stringify(backup)).characters[0].costumes).toEqual([costume]);

        for (const patch of [
            { idleAnimation: 1 },
            { idleAnimation: 'x'.repeat(257) },
            { idleAnimation: 'ghost' },
            { idleAnimation: 'idle', animations: undefined },
            { animations: 'inline' },
            { animations: [{ name: '   ', source: 'data:application/x-vrma;base64,AAAA' }] },
            { animations: [{ name: 'x'.repeat(65), source: 'data:application/x-vrma;base64,AAAA' }] },
            { animations: [{ name: '🎉'.repeat(65), source: 'data:application/x-vrma;base64,AAAA' }] },
            { animations: [{ name: 'none', source: 'data:application/x-vrma;base64,AAAA' }] },
            { animations: [{ name: ' NoNe ', source: 'data:application/x-vrma;base64,AAAA' }] },
            { animations: [{ name: 'a', source: `asset:${'a'.repeat(64)}` }] },
            { animations: [{ name: 'a', source: 'data:model/gltf-binary;base64,AAAA' }] },
            { animations: [{ name: 'a', source: 'data:application/x-vrma;base64,AAAA', loop: 'yes' }] },
            { animations: [{ name: 'a', source: 'data:application/x-vrma;base64,AAAA', useExpressions: 1 }] },
            { animations: [{ name: 'a' }] },
            { animations: new Array(33).fill({ name: 'a', source: 'data:application/x-vrma;base64,AAAA' }) },
        ]) {
            const broken = validCharacterBackup();
            broken.data.character.costumes = [{ ...costume, vrm: { ...vrm, ...patch } as never }];
            expect(() => parseCharacterBackup(JSON.stringify(broken))).toThrow('キャラクターファイルの形式が正しくありません');
        }

        const astralName = '🎉'.repeat(64);
        const astral = validCharacterBackup();
        astral.data.character.costumes = [{
            ...costume,
            vrm: {
                ...vrm,
                idleAnimation: astralName,
                animations: [{ name: astralName, source: 'data:application/x-vrma;base64,AAAA' }],
            } as never,
        }];
        expect(() => parseCharacterBackup(JSON.stringify(astral))).not.toThrow();
    });

    test('parses a character as a new import without conversation data', () => {
        const backup = validCharacterBackup();
        const parsed = parseCharacterBackup(JSON.stringify(backup));

        expect(parsed.characters).toHaveLength(1);
        expect(parsed.characters[0]).toMatchObject(backup.data.character);
        expect(parsed.characters[0].model).toEqual({ connectionId: 'openrouter', model: 'test-model' });
        expect(parsed.characters[0].id).toEqual(expect.any(String));
        expect(parsed.characters[0].createdAt).toEqual(expect.any(Number));
        expect(parsed.characters[0].updatedAt).toEqual(expect.any(Number));
        expect(parsed.groups).toEqual([]);
        expect(parsed.rooms).toEqual([]);
        expect(parsed.memories).toEqual([]);
        expect(parsed.usageRecords).toEqual([]);
    });

    test('accepts legacy string and aiApiType model fields in character files', () => {
        const legacyString = validCharacterBackup();
        legacyString.data.character.model = 'legacy-model' as never;
        const parsedString = parseCharacterBackup(JSON.stringify(legacyString));
        expect(parsedString.characters[0].model).toEqual({
            connectionId: 'openrouter',
            model: 'legacy-model',
        });

        const legacyRef = validCharacterBackup();
        legacyRef.data.character.model = { model: 'legacy-model', aiApiType: 'anthropic' } as never;
        const parsedRef = parseCharacterBackup(JSON.stringify(legacyRef));
        expect(parsedRef.characters[0].model).toEqual({
            connectionId: 'anthropic',
            model: 'legacy-model',
        });
    });

    test('recognizes both full backups and character files', () => {
        expect(parseImportFile(backupJson()).type).toBe('full');
        expect(parseImportFile(JSON.stringify(validCharacterBackup())).type).toBe('character');
    });

    test('rejects invalid settings and machine-local image references', () => {
        const invalidTemperature = validCharacterBackup();
        invalidTemperature.data.character.temperature = 3;
        expect(() => parseCharacterBackup(JSON.stringify(invalidTemperature)))
            .toThrow('キャラクターファイルの形式が正しくありません');

        for (const [key, value] of [
            ['frequencyPenalty', -2.1],
            ['presencePenalty', 2.1],
            ['repetitionPenalty', -0.1],
            ['repetitionPenalty', 2.1],
            ['frequencyPenalty', '0.5'],
        ] as const) {
            const invalidPenalty = validCharacterBackup();
            Object.assign(invalidPenalty.data.character, { [key]: value });
            expect(() => parseCharacterBackup(JSON.stringify(invalidPenalty)))
                .toThrow('キャラクターファイルの形式が正しくありません');
        }

        const localAsset = validCharacterBackup();
        localAsset.data.character.icon = `asset:${'a'.repeat(64)}`;
        expect(() => parseCharacterBackup(JSON.stringify(localAsset)))
            .toThrow('キャラクターファイルの形式が正しくありません');
    });

    test('creates a filesystem-safe character filename', () => {
        expect(createCharacterBackupFilename(' Alice: test/01. '))
            .toBe('Alice_ test_01.kataru-character.json');
        expect(createCharacterBackupFilename('   '))
            .toBe('character.kataru-character.json');
    });

    test('uses native file sharing when it is available', async () => {
        const share = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', {
            canShare: vi.fn(() => true),
            share,
        });

        await expect(shareJsonFile('{}', 'alice.json', 'Alice')).resolves.toBe('shared');

        const shareData = share.mock.calls[0][0] as ShareData;
        expect(shareData.title).toBe('Alice');
        expect(shareData.files?.[0]).toBeInstanceOf(File);
        expect(shareData.files?.[0].name).toBe('alice.json');
    });

    test('downloads the JSON when native file sharing is unavailable', async () => {
        const click = vi.fn();
        const createObjectURL = vi.fn(() => 'blob:character');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('navigator', {
            canShare: vi.fn(() => false),
            share: vi.fn(),
        });
        vi.stubGlobal('document', {
            createElement: vi.fn(() => ({ href: '', download: '', click })),
        });
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

        await expect(shareJsonFile('{}', 'alice.json', 'Alice')).resolves.toBe('downloaded');
        expect(createObjectURL).toHaveBeenCalledOnce();
        expect(click).toHaveBeenCalledOnce();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:character');
    });
});

describe('parseFullBackup validation', () => {
    test('rejects malformed JSON and an invalid backup envelope', () => {
        expect(() => parseFullBackup('{')).toThrow('JSONの解析に失敗しました');
        expect(() => parseFullBackup(JSON.stringify({ version: 1, type: 'full', data: {} })))
            .toThrow('バックアップファイルの形式が正しくありません');
    });

    test('rejects character data without required identity fields', () => {
        const backup = validBackup();
        backup.data.characters[0] = {
            ...backup.data.characters[0],
            name: undefined,
        } as unknown as Character;

        expect(() => parseFullBackup(backupJson(backup))).toThrow('キャラクターデータが不正です');
    });

    test('rejects situations whose actors reference an unknown character', () => {
        const backup = validBackup();
        const situation = backup.data.situations[0];
        situation.actors[0] = {
            id: 'actor-a',
            type: 'character',
            characterId: 'missing-character',
        };

        expect(() => parseFullBackup(backupJson(backup))).toThrow('シチュエーションが存在しないキャラクターを参照しています');
    });

    test('rejects rooms whose character reference is not a group actor', () => {
        const backup = validBackup();
        backup.data.rooms[0] = {
            ...backup.data.rooms[0],
            characterId: 'missing-actor',
        };

        expect(() => parseFullBackup(backupJson(backup))).toThrow('ルームが存在しないキャラクターを参照しています');
    });

    test('rejects messages with unknown speaker or recipient references', () => {
        const backup = validBackup();
        backup.data.messages[0] = {
            ...backup.data.messages[0],
            characterId: 'missing-actor',
            toCharacterIds: ['actor-a', 'missing-recipient'],
        };

        expect(() => parseFullBackup(backupJson(backup))).toThrow('メッセージが存在しないキャラクターを参照しています');
    });

    test('drops orphaned memories and usage records while retaining valid records', () => {
        const backup = validBackup();
        backup.data.memories.push({
            ...backup.data.memories[0],
            id: 'orphan-memory',
            characterId: 'missing-character',
        });
        backup.data.usageRecords.push({
            ...backup.data.usageRecords[0],
            id: 'orphan-usage',
            characterId: 'missing-character',
        });

        const restored = parseFullBackup(backupJson(backup));

        expect(restored.memories.map(({ id }) => id)).toEqual(['memory-1']);
        expect(restored.usageRecords.map(({ id }) => id)).toEqual(['usage-1']);
    });
});
