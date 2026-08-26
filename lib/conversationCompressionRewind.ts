import type {
    Message,
    Room,
    RoomCompressionSnapshot,
    SummaryRevision,
} from './store/types';

type CompressionStateChange = {
    room: Room;
    changedMessages: Message[];
};

function cloneSummaryHistory(history: SummaryRevision[] | undefined): SummaryRevision[] | undefined {
    return history?.map((revision) => ({ ...revision }));
}

export function rewindRoomCompressionState(
    room: Room,
    updatedAt = Date.now(),
): CompressionStateChange & { snapshot: RoomCompressionSnapshot } {
    const snapshot: RoomCompressionSnapshot = {
        archivedMessages: room.messages
            .filter((message) => message.archived === true)
            .map((message) => ({ ...message })),
        summary: room.summary,
        summaryCheckpointUserMessageId: room.summaryCheckpointUserMessageId,
        summaryHistory: cloneSummaryHistory(room.summaryHistory),
    };
    const changedMessages: Message[] = [];
    const messages = room.messages.map((message) => {
        if (message.archived !== true) return message;
        const restored = { ...message };
        delete restored.archived;
        changedMessages.push(restored);
        return restored;
    });

    return {
        snapshot,
        changedMessages,
        room: {
            ...room,
            messages,
            summary: undefined,
            summaryCheckpointUserMessageId: undefined,
            summaryHistory: undefined,
            updatedAt,
        },
    };
}

export function restoreRoomCompressionState(
    room: Room,
    snapshot: RoomCompressionSnapshot,
    updatedAt = Date.now(),
): CompressionStateChange {
    const archivedMessageIds = new Set(snapshot.archivedMessages.map((message) => message.id));
    const changedMessages: Message[] = [];
    const messages = room.messages.map((message) => {
        const shouldBeArchived = archivedMessageIds.has(message.id);
        if (shouldBeArchived === (message.archived === true)) return message;
        if (shouldBeArchived) {
            const archived = { ...message, archived: true };
            changedMessages.push(archived);
            return archived;
        }
        const restored = { ...message };
        delete restored.archived;
        changedMessages.push(restored);
        return restored;
    });

    return {
        changedMessages,
        room: {
            ...room,
            messages,
            summary: snapshot.summary,
            summaryCheckpointUserMessageId: snapshot.summaryCheckpointUserMessageId,
            summaryHistory: cloneSummaryHistory(snapshot.summaryHistory),
            updatedAt,
        },
    };
}
