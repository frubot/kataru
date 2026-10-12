import { afterEach, describe, expect, test, vi } from 'vitest';

import * as db from '../lib/db';
import {
    clearPendingTurnRestore,
    getPendingTurnRestore,
    getPendingTurnRestores,
    hasDeliveredPendingTurnRestore,
    recoverOrphanedPendingTurnRestore,
    savePendingTurnRestore,
} from '../lib/pendingTurnRestore';
import { getChatRegenerationCutIndex } from '../lib/chatRegeneration';
import { rollbackRestorableMessages } from '../lib/chatTurnRollback';
import { useStore, type Character, type Message, type Room } from '../lib/store';

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

describe('orphaned pending turn recovery', () => {
    function recoveryOperations(canRecover = () => true) {
        return { canRecover, restore: vi.fn(async () => undefined) };
    }

    test('leaves an active generation alone before its job is registered', async () => {
        mockMetaStorage();
        const pending = restore('room-1');
        await savePendingTurnRestore(pending);
        const readHistory = vi.spyOn(db, 'getMessagesByRoom').mockResolvedValue([]);
        const operations = recoveryOperations(() => false);

        await recoverOrphanedPendingTurnRestore(pending, operations);

        expect(readHistory).not.toHaveBeenCalled();
        expect(operations.restore).not.toHaveBeenCalled();
        expect(await getPendingTurnRestore(pending.roomId)).toEqual(pending);
    });

    test('does not restore when generation starts during the delivery check', async () => {
        mockMetaStorage();
        const pending = restore('room-1');
        await savePendingTurnRestore(pending);
        let resolveHistory!: (messages: Message[]) => void;
        vi.spyOn(db, 'getMessagesByRoom').mockReturnValue(new Promise((resolve) => { resolveHistory = resolve; }));
        let generating = false;
        const operations = recoveryOperations(() => !generating);
        const recovery = recoverOrphanedPendingTurnRestore(pending, operations);

        generating = true;
        resolveHistory([]);
        await recovery;

        expect(operations.restore).not.toHaveBeenCalled();
        expect(await getPendingTurnRestore(pending.roomId)).toEqual(pending);
    });

    test('does not restore when generation starts during the snapshot read', async () => {
        mockMetaStorage();
        const pending = restore('room-1');
        await savePendingTurnRestore(pending);
        vi.spyOn(db, 'getMessagesByRoom').mockResolvedValue([]);
        let generating = false;
        vi.mocked(db.getMeta).mockImplementationOnce(async (key) => {
            generating = true;
            return metaStore.get(key) as never;
        });
        const operations = recoveryOperations(() => !generating);

        await recoverOrphanedPendingTurnRestore(pending, operations);

        expect(operations.restore).not.toHaveBeenCalled();
        expect(await getPendingTurnRestore(pending.roomId)).toEqual(pending);
    });

    test.each([true, false])('leaves a newer snapshot untouched when delivered=%s', async (delivered) => {
        mockMetaStorage();
        const pending = restore('room-1');
        const newer = restore('room-1', 'job-87654321');
        await savePendingTurnRestore(pending);
        let resolveHistory!: (messages: Message[]) => void;
        vi.spyOn(db, 'getMessagesByRoom').mockReturnValue(new Promise((resolve) => { resolveHistory = resolve; }));
        const operations = recoveryOperations();
        const recovery = recoverOrphanedPendingTurnRestore(pending, operations);

        await savePendingTurnRestore(newer);
        resolveHistory(delivered ? [message(`${pending.jobId}-message-0`, 4, 'assistant')] : []);
        await recovery;

        expect(operations.restore).not.toHaveBeenCalled();
        expect(await getPendingTurnRestore(pending.roomId)).toEqual(newer);
    });

    test('still restores a missing job when its room is idle', async () => {
        mockMetaStorage();
        const pending = restore('room-1');
        await savePendingTurnRestore(pending);
        vi.spyOn(db, 'getMessagesByRoom').mockResolvedValue([]);
        const operations = recoveryOperations();

        await recoverOrphanedPendingTurnRestore(pending, operations);

        expect(operations.restore).toHaveBeenCalledWith(pending.roomId, pending.jobId, operations.canRecover);
    });

    test('clears the matching snapshot when the job already delivered its response', async () => {
        mockMetaStorage();
        const pending = restore('room-1');
        await savePendingTurnRestore(pending);
        vi.spyOn(db, 'getMessagesByRoom').mockResolvedValue([message(`${pending.jobId}-message-0`, 4, 'assistant')]);
        const operations = recoveryOperations();

        await recoverOrphanedPendingTurnRestore(pending, operations);

        expect(operations.restore).not.toHaveBeenCalled();
        expect(await getPendingTurnRestore(pending.roomId)).toBeUndefined();
    });

    test('keeps only the regenerated first response after a model change and concurrent recovery', async () => {
        mockMetaStorage();
        const user = message('user-1', 1);
        const oldReply = message('old-job-message-0', 2, 'assistant');
        const newReply = message('new-job-message-0', 3, 'assistant');
        const room: Room = { id: 'room-1', characterId: 'actor', name: 'Room', viewMode: 'vn', messages: [user, oldReply], createdAt: 1, updatedAt: 1 };
        const character: Character = { id: 'actor', name: 'Actor', systemPrompt: '', model: { connectionId: 'openrouter', model: 'model-a' }, createdAt: 1, updatedAt: 1 };
        const persisted = new Map(room.messages.map((message) => [message.id, message]));
        vi.spyOn(db, 'getMessagesByRoom').mockImplementation(async () => [...persisted.values()].sort((a, b) => a.timestamp - b.timestamp));
        vi.spyOn(db, 'deleteMessagesByIds').mockImplementation(async (ids) => { ids.forEach((id) => persisted.delete(id)); });
        vi.spyOn(db, 'putMessages').mockImplementation(async (_roomId, messages) => { messages.forEach((message) => persisted.set(message.id, message)); });
        vi.spyOn(db, 'getMemoriesBySourceMessageIds').mockResolvedValue([]);
        vi.spyOn(db, 'getMemoriesByCharacter').mockResolvedValue([]);
        vi.spyOn(db, 'deleteMemoriesBySourceMessageIds').mockResolvedValue(undefined);
        vi.spyOn(db, 'deleteMemories').mockResolvedValue(undefined);
        vi.spyOn(db, 'putMemories').mockResolvedValue(undefined);
        vi.spyOn(db, 'putRoom').mockResolvedValue(undefined);
        vi.spyOn(db, 'putCharacter').mockImplementation(async (value) => value);
        vi.spyOn(db, 'getAllRooms').mockResolvedValue([{ id: room.id, characterId: room.characterId, name: room.name, viewMode: 'vn', createdAt: 1, updatedAt: 1 }]);
        vi.spyOn(db, 'getAllUsageRecords').mockResolvedValue([]);
        useStore.setState({ rooms: [room], currentRoomId: room.id, characters: [character] });
        useStore.getState().updateCharacter(character.id, { model: { connectionId: 'openrouter', model: 'model-b' } });

        const sourceRoom = useStore.getState().getCurrentRoom()!;
        const cutFrom = getChatRegenerationCutIndex(sourceRoom.messages, { allowEmptyReplyRound: false })!;
        const pending = { ...restore(room.id, 'new-job'), fromIndex: cutFrom, messages: sourceRoom.messages.slice(cutFrom) };
        await savePendingTurnRestore(pending);
        await useStore.getState().deleteMessagesFrom(room.id, cutFrom);
        await recoverOrphanedPendingTurnRestore(pending, {
            canRecover: () => false,
            restore: async (roomId, expectedJobId) => {
                const snapshot = await getPendingTurnRestore(roomId);
                if (!snapshot || snapshot.jobId !== expectedJobId) return;
                await rollbackRestorableMessages(snapshot, useStore.getState());
            },
        });

        expect(sourceRoom.messages.slice(0, cutFrom)).toEqual([user]);
        expect(useStore.getState().characters[0].model.model).toBe('model-b');
        persisted.set(newReply.id, newReply);
        await useStore.getState().refreshConversationRoom(room.id);

        expect(useStore.getState().getCurrentRoom()?.messages).toEqual([user, newReply]);
        expect(await db.getMessagesByRoom(room.id)).toEqual([user, newReply]);
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
