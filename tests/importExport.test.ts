import { afterEach, describe, expect, test, vi } from 'vitest';

import {
    createFullBackup,
    parseFullBackup,
    reassignIds,
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
        model: 'test-model',
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
            model: 'director-model',
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
        createdAt: 1,
        updatedAt: 2,
    };
    const olderMessage: Message = {
        id: 'message-1',
        role: 'assistant',
        content: '古い返答',
        characterId: 'actor-b',
        toCharacterIds: ['actor-a'],
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

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('createFullBackup and parseFullBackup', () => {
    test('round-trips the database collections and sorts messages per room', async () => {
        const backup = validBackup();
        const responses: Record<string, unknown> = {
            get_all_characters_with_images: backup.data.characters,
            get_all_situations: backup.data.situations,
            get_all_rooms: backup.data.rooms,
            get_all_messages: backup.data.messages,
            get_all_memories: backup.data.memories,
            get_all_usage_records: backup.data.usageRecords,
        };
        const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
            const request = JSON.parse(String(init?.body)) as { op: string };
            return {
                ok: true,
                json: async () => ({ result: responses[request.op] }),
            };
        });
        vi.stubGlobal('fetch', fetchMock);

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
        expect(fetchMock).toHaveBeenCalledTimes(6);
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
        expect(newMemory.characterId).toBe(reassigned.characters[0].id);
        expect(newMemory.roomId).toBe(newRoom.id);
        expect(newMemory.sourceRoomId).toBe(newRoom.id);
        expect(newMemory.sourceMessageIds).toEqual([newMessage.id]);
        expect(reassigned.usageRecords[0].characterId).toBe(reassigned.characters[0].id);
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
