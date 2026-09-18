import type { RustTurnResponse } from '../../lib/conversationResult';
import type {
    FullJsonDebugLog,
    Message,
    Room,
    VnTypingSpeed,
} from '../../lib/store';

type ApplyConversationResultOptions = {
    data: RustTurnResponse;
    sourceRoom: Room;
    jobId: string;
    isSecretMode: boolean;
    isMessageMode: boolean;
    shouldStreamPreview: boolean;
    deferTypewriter?: boolean;
    typingSpeed: VnTypingSpeed;
    debugEnabled: boolean;
};

type ApplyConversationResultOperations = {
    updateRoomSummary: (roomId: string, summary: string, checkpointId?: string) => void;
    compressRoomHistory: (roomId: string, keepCount: number) => void;
    isGenerationActive: () => boolean;
    waitForMessageModeBubbleDelay: () => Promise<void>;
    addMessage: (
        roomId: string,
        role: 'user' | 'assistant',
        content: string,
        characterId?: string,
        meta?: Pick<Message, 'expression' | 'memories' | 'toCharacterIds'>,
    ) => string;
    rememberStreamedFinalMessageIds: (messageIds: string[]) => void;
    refreshConversationRoom: (roomId: string) => Promise<void>;
    clearStreamingPreview: (jobId: string) => void;
    addFullJsonDebugLog: (log: Omit<FullJsonDebugLog, 'id' | 'createdAt'>) => void;
    getCurrentRoom: () => Room | null | undefined;
    playTypewriter: (messageId: string, content: string) => Promise<void>;
};

type RecordConversationDebugLogsOptions = Pick<
    ApplyConversationResultOptions,
    'data' | 'sourceRoom' | 'isSecretMode' | 'debugEnabled'
>;

type RecordConversationDebugLogsOperations = Pick<
    ApplyConversationResultOperations,
    'addFullJsonDebugLog' | 'getCurrentRoom'
>;

function debugLogText(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value == null) return undefined;
    return JSON.stringify(value, null, 2);
}

export function recordConversationDebugLogs(
    options: RecordConversationDebugLogsOptions,
    operations: RecordConversationDebugLogsOperations,
): void {
    const { data, sourceRoom, isSecretMode, debugEnabled } = options;
    if (isSecretMode || !debugEnabled) return;

    const currentRoom = operations.getCurrentRoom();
    const roomName = currentRoom?.id === sourceRoom.id ? currentRoom.name : sourceRoom.name;
    for (const log of data.fullJsonLogs ?? []) {
        const json = debugLogText(log.json);
        if (!json?.trim()) continue;
        operations.addFullJsonDebugLog({
            roomId: sourceRoom.id,
            roomName,
            characterId: log.characterId,
            characterName: log.characterName,
            model: log.model,
            status: log.status,
            source: log.source,
            prompt: log.prompt,
            json,
            secondJson: debugLogText(log.secondJson),
            httpStatus: log.httpStatus,
            elapsedMs: log.elapsedMs,
            errorName: log.errorName,
        });
    }
}

export async function applyConversationResult(
    options: ApplyConversationResultOptions,
    operations: ApplyConversationResultOperations,
): Promise<{ message: string; assistantMessageIds: string[] }> {
    const {
        data,
        sourceRoom,
        jobId,
        isSecretMode,
        isMessageMode,
        shouldStreamPreview,
        deferTypewriter = false,
        typingSpeed,
    } = options;
    const assistantMessages = Array.isArray(data.messages) ? data.messages : [];
    recordConversationDebugLogs(options, operations);

    if (isSecretMode && data.summary?.text) {
        operations.updateRoomSummary(
            sourceRoom.id,
            data.summary.text,
            data.summary.checkpointUserMessageId,
        );
        if (Number.isInteger(data.summary.keepCount) && data.summary.keepCount > 0) {
            operations.compressRoomHistory(sourceRoom.id, data.summary.keepCount);
        }
    }

    let assistantMessageIds = assistantMessages
        .filter((message) => message?.content?.trim() && message.id)
        .map((message) => message.id);
    if (isSecretMode) {
        assistantMessageIds = [];
        for (let index = 0; index < assistantMessages.length; index++) {
            const message = assistantMessages[index];
            if (!message?.content?.trim()) continue;
            if (isMessageMode && index > 0 && !shouldStreamPreview) {
                await operations.waitForMessageModeBubbleDelay();
            }
            if (!operations.isGenerationActive()) {
                throw new DOMException('Generation stopped', 'AbortError');
            }
            const messageId = operations.addMessage(
                sourceRoom.id,
                'assistant',
                message.content,
                message.characterId,
                {
                    expression: message.expression,
                    toCharacterIds: message.toCharacterIds ?? [],
                },
            );
            assistantMessageIds.push(messageId);
            if (shouldStreamPreview) operations.rememberStreamedFinalMessageIds([messageId]);
        }
    } else {
        if (shouldStreamPreview) operations.rememberStreamedFinalMessageIds(assistantMessageIds);
        await operations.refreshConversationRoom(sourceRoom.id);
    }
    operations.clearStreamingPreview(jobId);

    if (
        !isMessageMode
        && !deferTypewriter
        && typingSpeed !== 'streaming'
        && operations.getCurrentRoom()?.id === sourceRoom.id
        && assistantMessageIds[0]
        && assistantMessages[0]?.content
    ) {
        await operations.playTypewriter(assistantMessageIds[0], assistantMessages[0].content);
    }

    return {
        message: assistantMessages.map((message) => message.content).join('\n\n'),
        assistantMessageIds,
    };
}
