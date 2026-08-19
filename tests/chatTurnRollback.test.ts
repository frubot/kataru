import { describe, expect, test, vi } from 'vitest';

import {
    removeSubmittedUserMessage,
    rollbackRestorableMessages,
} from '../lib/chatTurnRollback';

type TestMessage = { id: string };
type TestMemory = { id: string };

describe('chat turn rollback', () => {
    test('removes replacement messages before restoring the original turn', async () => {
        const deleteMessagesFrom = vi.fn(async () => []);
        const restoreMessagesAt = vi.fn(async () => undefined);
        const originalMessages: TestMessage[] = [{ id: 'old-assistant' }];
        const originalMemories: TestMemory[] = [{ id: 'old-memory' }];

        const active = await rollbackRestorableMessages(
            {
                roomId: 'room-1',
                fromIndex: 2,
                messages: originalMessages,
                memories: originalMemories,
            },
            {
                getCurrentRoom: () => ({
                    id: 'room-1',
                    messages: [{ id: 'user' }, { id: 'before' }, { id: 'replacement' }],
                }),
                deleteMessagesFrom,
                restoreMessagesAt,
            },
        );

        expect(active).toBe(true);
        expect(deleteMessagesFrom).toHaveBeenCalledWith('room-1', 2);
        expect(restoreMessagesAt).toHaveBeenCalledWith(
            'room-1',
            2,
            originalMessages,
            originalMemories,
        );
    });

    test('restores persisted history without deleting another active room', async () => {
        const deleteMessagesFrom = vi.fn(async () => []);
        const restoreMessagesAt = vi.fn(async () => undefined);

        const active = await rollbackRestorableMessages(
            { roomId: 'room-1', fromIndex: 1, messages: [{ id: 'old' }], memories: [] },
            {
                getCurrentRoom: () => ({ id: 'room-2', messages: [{ id: 'unrelated' }] }),
                deleteMessagesFrom,
                restoreMessagesAt,
            },
        );

        expect(active).toBe(false);
        expect(deleteMessagesFrom).not.toHaveBeenCalled();
        expect(restoreMessagesAt).toHaveBeenCalledOnce();
    });

    test('removes a failed submitted message only from its active room', async () => {
        const deleteMessagesFrom = vi.fn(async () => []);
        const active = await removeSubmittedUserMessage(
            { roomId: 'room-1', messageId: 'submitted' },
            {
                getCurrentRoom: () => ({
                    id: 'room-1',
                    messages: [{ id: 'older' }, { id: 'submitted' }],
                }),
                deleteMessagesFrom,
            },
        );

        expect(active).toBe(true);
        expect(deleteMessagesFrom).toHaveBeenCalledWith('room-1', 1);
    });
});
