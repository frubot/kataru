import { describe, expect, test, vi } from 'vitest';

import { applyConversationResult } from '../components/chat/applyConversationResult';
import type { Room } from '../lib/store';

function createOperations(sourceRoom: Room) {
    return {
        updateRoomSummary: vi.fn(),
        compressRoomHistory: vi.fn(),
        isGenerationActive: vi.fn(() => true),
        addMessage: vi.fn(() => 'local-message'),
        rememberStreamedFinalMessageIds: vi.fn(),
        refreshConversationRoom: vi.fn(async () => undefined),
        clearStreamingPreview: vi.fn(),
        addFullJsonDebugLog: vi.fn(),
        getCurrentRoom: vi.fn(() => sourceRoom),
    };
}

const sourceRoom = { id: 'room-1', name: 'Room 1' } as Room;

describe('conversation result application', () => {
    test('refreshes persisted rooms and remembers streamed server message ids', async () => {
        const operations = createOperations(sourceRoom);
        const result = await applyConversationResult(
            {
                data: {
                    messages: [{
                        id: 'server-message',
                        role: 'assistant',
                        content: 'こんにちは',
                        characterId: 'character-1',
                        timestamp: 1,
                    }],
                    usedMemoryIds: ['memory-1'],
                },
                sourceRoom,
                jobId: 'job-1',
                isSecretMode: false,
                debugEnabled: false,
            },
            operations,
        );

        expect(result.message).toBe('こんにちは');
        expect(result.assistantMessageIds).toEqual(['server-message']);
        expect(operations.refreshConversationRoom).toHaveBeenCalledWith('room-1');
        expect(operations.addMessage).not.toHaveBeenCalled();
        expect(operations.rememberStreamedFinalMessageIds).toHaveBeenCalledWith(['server-message']);
    });

    test('keeps secret results in memory and applies their summary', async () => {
        const operations = createOperations(sourceRoom);
        operations.addMessage
            .mockReturnValueOnce('local-1')
            .mockReturnValueOnce('local-2');

        const result = await applyConversationResult(
            {
                data: {
                    messages: [
                        { id: 'server-1', role: 'assistant', content: '一つ目', characterId: 'character-1', timestamp: 1 },
                        { id: 'server-2', role: 'assistant', content: '二つ目', characterId: 'character-2', timestamp: 2 },
                    ],
                    summary: { text: '秘密の要約', checkpointUserMessageId: 'user-1', keepCount: 8 },
                },
                sourceRoom,
                jobId: 'job-1',
                isSecretMode: true,
                debugEnabled: false,
            },
            operations,
        );

        expect(result.assistantMessageIds).toEqual(['local-1', 'local-2']);
        expect(operations.updateRoomSummary).toHaveBeenCalledWith('room-1', '秘密の要約', 'user-1');
        expect(operations.compressRoomHistory).toHaveBeenCalledWith('room-1', 8);
        expect(operations.addMessage).toHaveBeenCalledTimes(2);
        expect(operations.rememberStreamedFinalMessageIds).toHaveBeenCalledWith(['local-1']);
        expect(operations.rememberStreamedFinalMessageIds).toHaveBeenCalledWith(['local-2']);
        expect(operations.refreshConversationRoom).not.toHaveBeenCalled();
    });

    test('records debug logs before refreshing the persisted room', async () => {
        const operations = createOperations(sourceRoom);
        operations.refreshConversationRoom.mockRejectedValueOnce(new Error('refresh failed'));

        await expect(applyConversationResult(
            {
                data: {
                    messages: [{
                        id: 'server-message',
                        role: 'assistant',
                        content: '保存済みの返答',
                        characterId: 'character-1',
                        timestamp: 1,
                    }],
                    fullJsonLogs: [{
                        characterId: 'character-1',
                        characterName: '葵',
                        model: 'test-model',
                        status: 'error',
                        source: 'chat-http-error',
                        prompt: '[{"role":"user","content":"こんにちは"}]',
                        json: '{"error":"upstream failed"}',
                        httpStatus: 502,
                    }],
                },
                sourceRoom,
                jobId: 'job-1',
                isSecretMode: false,
                debugEnabled: true,
            },
            operations,
        )).rejects.toThrow('refresh failed');

        expect(operations.addFullJsonDebugLog).toHaveBeenCalledWith(expect.objectContaining({
            roomId: 'room-1',
            characterId: 'character-1',
            status: 'error',
            source: 'chat-http-error',
            httpStatus: 502,
        }));
        expect(operations.addFullJsonDebugLog.mock.invocationCallOrder[0])
            .toBeLessThan(operations.refreshConversationRoom.mock.invocationCallOrder[0]);
    });

    test('stringifies structured json payloads instead of crashing', async () => {
        const operations = createOperations(sourceRoom);

        await applyConversationResult(
            {
                data: {
                    messages: [{
                        id: 'server-message',
                        role: 'assistant',
                        content: '指揮役の応答',
                        characterId: 'actor-1',
                        timestamp: 1,
                    }],
                    fullJsonLogs: [{
                        characterId: 'situation-1:director',
                        characterName: '指揮役',
                        model: 'jev-latest',
                        status: 'success',
                        source: 'director-jev',
                        json: { model: 'jev-latest', answers: { next_speaker: { choice: 'actor-1' } } } as unknown as string,
                        secondJson: '{"answers":{"safe_speaker":{"choice":"actor-2"}}}',
                    }],
                },
                sourceRoom,
                jobId: 'job-1',
                isSecretMode: false,
                debugEnabled: true,
            },
            operations,
        );

        expect(operations.addFullJsonDebugLog).toHaveBeenCalledWith(expect.objectContaining({
            source: 'director-jev',
            json: expect.stringContaining('"next_speaker"'),
            secondJson: '{"answers":{"safe_speaker":{"choice":"actor-2"}}}',
        }));
    });
});
