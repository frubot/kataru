import { selectMemoryCandidates } from '../../lib/chatMemoryCandidates';
import type { RustTurnResponse } from '../../lib/conversationResult';
import type {
    AddMemoryOptions,
    Character,
    FullJsonDebugLog,
    MemoryRecord,
    Message,
    Room,
    VnTypingSpeed,
} from '../../lib/store';

type ApplyConversationResultOptions = {
    data: RustTurnResponse;
    sourceRoom: Room;
    jobId: string;
    character: Character | null;
    isSecretMode: boolean;
    isMessageMode: boolean;
    shouldStreamPreview: boolean;
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
    markMemoriesUsed: (memoryIds: string[]) => void;
    listMemoriesForCharacter: (characterId: string) => Promise<MemoryRecord[]>;
    addMemory: (characterId: string, content: string, options?: AddMemoryOptions) => Promise<void>;
    attachMemoriesToMessage: (roomId: string, messageId: string, memories: string[]) => void;
    playTypewriter: (messageId: string, content: string) => Promise<void>;
};

export async function applyConversationResult(
    options: ApplyConversationResultOptions,
    operations: ApplyConversationResultOperations,
): Promise<{ message: string; assistantMessageIds: string[] }> {
    const {
        data,
        sourceRoom,
        jobId,
        character,
        isSecretMode,
        isMessageMode,
        shouldStreamPreview,
        typingSpeed,
        debugEnabled,
    } = options;
    const assistantMessages = Array.isArray(data.messages) ? data.messages : [];

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

    if (!isSecretMode) {
        if (debugEnabled) {
            for (const log of data.fullJsonLogs ?? []) {
                if (!log.json?.trim()) continue;
                operations.addFullJsonDebugLog({
                    roomId: sourceRoom.id,
                    roomName: operations.getCurrentRoom()?.name ?? sourceRoom.name,
                    characterId: log.characterId,
                    characterName: log.characterName,
                    model: log.model,
                    status: log.status,
                    source: log.source,
                    prompt: log.prompt,
                    json: log.json,
                    httpStatus: log.httpStatus,
                    elapsedMs: log.elapsedMs,
                    errorName: log.errorName,
                });
            }
        }
        operations.markMemoriesUsed(data.usedMemoryIds ?? []);
    }

    if (
        !isSecretMode
        && character
        && assistantMessageIds.length > 0
        && data.memoryCandidates?.length
    ) {
        const existingMemories = await operations.listMemoriesForCharacter(character.id);
        const candidates = selectMemoryCandidates(data.memoryCandidates, character, existingMemories);
        await Promise.all(candidates.map((update) =>
            operations.addMemory(character.id, update.content, {
                scope: update.scope,
                kind: update.kind,
                importance: update.importance,
                confidence: update.confidence,
                sourceRoomId: sourceRoom.id,
                sourceMessageIds: assistantMessageIds,
            })
        ));
        operations.attachMemoriesToMessage(
            sourceRoom.id,
            assistantMessageIds[0],
            candidates.map((update) => update.content),
        );
    }

    if (
        !isMessageMode
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
