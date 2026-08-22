import { describe, expect, test, vi } from 'vitest';

import { applyConversationResult } from '../components/chat/applyConversationResult';
import type { Room } from '../lib/store';

function createOperations(sourceRoom: Room) {
    return {
        updateRoomSummary: vi.fn(),
        compressRoomHistory: vi.fn(),
        isGenerationActive: vi.fn(() => true),
        waitForMessageModeBubbleDelay: vi.fn(async () => undefined),
        addMessage: vi.fn(() => 'local-message'),
        rememberStreamedFinalMessageIds: vi.fn(),
        refreshConversationRoom: vi.fn(async () => undefined),
        clearStreamingPreview: vi.fn(),
        addFullJsonDebugLog: vi.fn(),
        getCurrentRoom: vi.fn(() => sourceRoom),
        markMemoriesUsed: vi.fn(),
        listMemoriesForCharacter: vi.fn(async () => []),
        addMemory: vi.fn(async () => undefined),
        attachMemoriesToMessage: vi.fn(),
        playTypewriter: vi.fn(async () => undefined),
    };
}

const sourceRoom = { id: 'room-1', name: 'Room 1' } as Room;

describe('conversation result application', () => {
    test('refreshes persisted rooms and starts the typewriter from server message ids', async () => {
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
                character: null,
                isSecretMode: false,
                isMessageMode: false,
                shouldStreamPreview: false,
                typingSpeed: 'default',
                debugEnabled: false,
            },
            operations,
        );

        expect(result.message).toBe('こんにちは');
        expect(result.assistantMessageIds).toEqual(['server-message']);
        expect(operations.refreshConversationRoom).toHaveBeenCalledWith('room-1');
        expect(operations.addMessage).not.toHaveBeenCalled();
        expect(operations.markMemoriesUsed).toHaveBeenCalledWith(['memory-1']);
        expect(operations.playTypewriter).toHaveBeenCalledWith('server-message', 'こんにちは');
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
                character: null,
                isSecretMode: true,
                isMessageMode: true,
                shouldStreamPreview: false,
                typingSpeed: 'default',
                debugEnabled: false,
            },
            operations,
        );

        expect(result.assistantMessageIds).toEqual(['local-1', 'local-2']);
        expect(operations.updateRoomSummary).toHaveBeenCalledWith('room-1', '秘密の要約', 'user-1');
        expect(operations.compressRoomHistory).toHaveBeenCalledWith('room-1', 8);
        expect(operations.waitForMessageModeBubbleDelay).toHaveBeenCalledOnce();
        expect(operations.addMessage).toHaveBeenCalledTimes(2);
        expect(operations.refreshConversationRoom).not.toHaveBeenCalled();
        expect(operations.markMemoriesUsed).not.toHaveBeenCalled();
    });

    test('defers typewriter playback to the situation visual novel queue', async () => {
        const operations = createOperations(sourceRoom);
        await applyConversationResult(
            {
                data: {
                    messages: [{
                        id: 'server-message',
                        role: 'assistant',
                        content: '順番に表示する返答',
                        characterId: 'actor-1',
                        timestamp: 1,
                    }],
                },
                sourceRoom,
                jobId: 'job-1',
                character: null,
                isSecretMode: false,
                isMessageMode: false,
                shouldStreamPreview: false,
                deferTypewriter: true,
                typingSpeed: 'default',
                debugEnabled: false,
            },
            operations,
        );

        expect(operations.playTypewriter).not.toHaveBeenCalled();
    });
});
