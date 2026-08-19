type RollbackRoom<TMessage> = {
    id: string;
    messages: TMessage[];
};

type RollbackOperations<TMessage, TMemory> = {
    getCurrentRoom: () => RollbackRoom<TMessage> | null | undefined;
    deleteMessagesFrom: (roomId: string, fromIndex: number) => Promise<unknown>;
    restoreMessagesAt: (
        roomId: string,
        fromIndex: number,
        messages: TMessage[],
        memories: TMemory[],
    ) => Promise<void>;
};

type RestorableMessages<TMessage, TMemory> = {
    roomId: string;
    fromIndex: number;
    messages: TMessage[];
    memories: TMemory[];
};

export async function rollbackRestorableMessages<TMessage, TMemory>(
    rollback: RestorableMessages<TMessage, TMemory>,
    operations: RollbackOperations<TMessage, TMemory>,
): Promise<boolean> {
    const currentRoom = operations.getCurrentRoom();
    const isCurrentRoomActive = currentRoom?.id === rollback.roomId;
    if (isCurrentRoomActive && currentRoom.messages.length > rollback.fromIndex) {
        await operations.deleteMessagesFrom(rollback.roomId, rollback.fromIndex);
    }
    await operations.restoreMessagesAt(
        rollback.roomId,
        rollback.fromIndex,
        rollback.messages,
        rollback.memories,
    );
    return isCurrentRoomActive;
}

type SubmittedUserMessage = {
    roomId: string;
    messageId: string;
};

export async function removeSubmittedUserMessage<TMessage extends { id: string }>(
    submitted: SubmittedUserMessage,
    operations: Pick<RollbackOperations<TMessage, never>, 'getCurrentRoom' | 'deleteMessagesFrom'>,
): Promise<boolean> {
    const currentRoom = operations.getCurrentRoom();
    if (currentRoom?.id !== submitted.roomId) return false;

    const messageIndex = currentRoom.messages.findIndex((message) => message.id === submitted.messageId);
    if (messageIndex >= 0) {
        await operations.deleteMessagesFrom(submitted.roomId, messageIndex);
    }
    return true;
}
