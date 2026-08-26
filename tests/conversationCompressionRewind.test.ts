import { describe, expect, test } from 'vitest';

import {
    restoreRoomCompressionState,
    rewindRoomCompressionState,
} from '../lib/conversationCompressionRewind';
import type { Message, Room } from '../lib/store';

function message(id: string, role: Message['role'], archived = false): Message {
    return {
        id,
        role,
        content: id,
        timestamp: 1,
        ...(archived ? { archived: true } : {}),
    };
}

function compressedRoom(): Room {
    return {
        id: 'room-1',
        characterId: 'character-1',
        name: '圧縮済み会話',
        messages: [
            message('user-1', 'user', true),
            message('assistant-1', 'assistant', true),
            message('user-2', 'user'),
            message('assistant-2', 'assistant'),
        ],
        summary: '既存の圧縮テキスト',
        summaryCheckpointUserMessageId: 'user-1',
        summaryHistory: [{
            text: '既存の圧縮テキスト',
            checkpointUserMessageId: 'user-1',
            createdAt: 10,
            source: 'automatic',
        }],
        createdAt: 1,
        updatedAt: 2,
    };
}

describe('conversation compression rewind', () => {
    test('restores archived messages and removes every saved summary field', () => {
        const original = compressedRoom();
        const rewind = rewindRoomCompressionState(original, 20);

        expect(rewind.room.messages.some((item) => item.archived)).toBe(false);
        expect(rewind.room.summary).toBeUndefined();
        expect(rewind.room.summaryCheckpointUserMessageId).toBeUndefined();
        expect(rewind.room.summaryHistory).toBeUndefined();
        expect(rewind.changedMessages.map((item) => item.id)).toEqual([
            'user-1',
            'assistant-1',
        ]);
        expect(rewind.snapshot.archivedMessages.map((item) => item.id)).toEqual([
            'user-1',
            'assistant-1',
        ]);
    });

    test('can restore the prior compression state after a failed edited turn', () => {
        const original = compressedRoom();
        const rewind = rewindRoomCompressionState(original, 20);
        const editedHistory: Room = {
            ...rewind.room,
            messages: original.messages.map((message) => {
                const item = { ...message };
                delete item.archived;
                return item;
            }),
        };
        const restored = restoreRoomCompressionState(editedHistory, rewind.snapshot, 30);

        expect(restored.room.messages.map((item) => item.archived === true)).toEqual([
            true,
            true,
            false,
            false,
        ]);
        expect(restored.room.summary).toBe('既存の圧縮テキスト');
        expect(restored.room.summaryCheckpointUserMessageId).toBe('user-1');
        expect(restored.room.summaryHistory).toEqual(original.summaryHistory);
    });
});
