import { afterEach, describe, expect, test, vi } from 'vitest';

import * as db from '../lib/db';
import {
    clearPendingTurnRestore,
    getPendingTurnRestore,
    getPendingTurnRestores,
    hasDeliveredPendingTurnRestore,
    savePendingTurnRestore,
} from '../lib/pendingTurnRestore';
import { useStore, type Message, type Room } from '../lib/store';

const initialState = useStore.getState();
const metaStore = new Map<string, unknown>();

afterEach(() => {
    vi.restoreAllMocks();
    useStore.setState(initialState, true);
    metaStore.clear();
});

function mockMetaStorage() {
    vi.spyOn(db, 'getMeta').mockImplementation(async (key) => metaStore.get(key) as never);
    vi.spyOn(db, 'setMeta').mockImplementation(async (key, value) => {
        metaStore.set(key, value);
    });
    vi.spyOn(db, 'deleteMeta').mockImplementation(async (key) => {
        metaStore.delete(key);
    });
}

function message(id: string, timestamp: number, role: 'user' | 'assistant' = 'user'): Message {
    return { id, role, content: `${id} content`, timestamp };
}

function restore(roomId: string, jobId = 'job-12345678') {
    return {
        jobId,
        roomId,
        fromIndex: 1,
        messages: [message('old-user', 2), message('old-assistant', 3, 'assistant')],
        memories: [],
        compressionSnapshot: null,
        createdAt: 10,
    };
}

describe('pending turn restore storage', () => {
    test('saves, reads and clears room snapshots', async () => {
        mockMetaStorage();
        await savePendingTurnRestore(restore('room-1'));
        await savePendingTurnRestore(restore('room-2', 'job-87654321'));

        expect(await getPendingTurnRestore('room-1')).toMatchObject({
            roomId: 'room-1',
            fromIndex: 1,
        });
        expect(await getPendingTurnRestores()).toHaveLength(2);

        await clearPendingTurnRestore('room-1');
        expect(await getPendingTurnRestore('room-1')).toBeUndefined();
        expect(await getPendingTurnRestores()).toHaveLength(1);
    });

    test('saving the same room twice keeps the latest snapshot', async () => {
        mockMetaStorage();
        await savePendingTurnRestore(restore('room-1'));
        await savePendingTurnRestore({ ...restore('room-1'), fromIndex: 4 });

        expect(await getPendingTurnRestores()).toHaveLength(1);
        expect((await getPendingTurnRestore('room-1'))?.fromIndex).toBe(4);
    });

    test('detects job-delivered messages by the normalized id prefix', async () => {
        mockMetaStorage();
        const pending = restore('room-1');
        vi.spyOn(db, 'getMessagesByRoom')
            .mockResolvedValueOnce([
                message('m0', 1),
                message('job-12345678-message-0', 4, 'assistant'),
            ])
            .mockResolvedValueOnce([message('m0', 1)]);

        await expect(hasDeliveredPendingTurnRestore(pending)).resolves.toBe(true);
        await expect(hasDeliveredPendingTurnRestore(pending)).resolves.toBe(false);
    });
});

describe('deleteMessagesFrom persisted tail', () => {
    function room(id: string, messages: Message[]): Room {
        return { id, characterId: 'actor', name: id, messages, createdAt: 1, updatedAt: 1 };
    }

    function mockDeletableStorage(persisted: Message[]) {
        vi.spyOn(db, 'getMessagesByRoom').mockResolvedValue(persisted);
        const deleteIds = vi.spyOn(db, 'deleteMessagesByIds').mockResolvedValue(undefined);
        vi.spyOn(db, 'getMemoriesBySourceMessageIds').mockResolvedValue([]);
        vi.spyOn(db, 'getMemoriesByCharacter').mockResolvedValue([]);
        vi.spyOn(db, 'deleteMemories').mockResolvedValue(undefined);
        vi.spyOn(db, 'deleteMemoriesBySourceMessageIds').mockResolvedValue(undefined);
        vi.spyOn(db, 'putRoom').mockResolvedValue(undefined);
        return deleteIds;
    }

    test('removes persisted messages the room never loaded into memory', async () => {
        // 画面への反映に失敗した応答がストレージに残っていても、
        // メモリ上の末尾だけでなく永続化済みの末尾もまとめて消す。
        useStore.setState({
            rooms: [room('room-1', [message('m0', 1), message('m1', 2)])],
            currentRoomId: 'room-1',
        });
        const deleteIds = mockDeletableStorage([
            message('m0', 1),
            message('m1', 2),
            message('job-x-message-0', 3, 'assistant'),
        ]);

        await useStore.getState().deleteMessagesFrom('room-1', 1);

        expect(deleteIds).toHaveBeenCalledWith(['m1', 'job-x-message-0']);
    });

    test('removes the persisted tail for a room that is not loaded', async () => {
        // 別の部屋を開いている部屋はメモリ上のメッセージが空。それでも
        // ストレージの末尾から削除しないと編集前後のメッセージが混在する。
        useStore.setState({
            rooms: [room('room-1', []), room('room-2', [message('b0', 1)])],
            currentRoomId: 'room-2',
        });
        const deleteIds = mockDeletableStorage([
            message('m0', 1),
            message('edited-user', 2),
        ]);

        await useStore.getState().deleteMessagesFrom('room-1', 1);

        expect(deleteIds).toHaveBeenCalledWith(['edited-user']);
        expect(useStore.getState().rooms.find((r) => r.id === 'room-2')?.messages)
            .toHaveLength(1);
    });
});
