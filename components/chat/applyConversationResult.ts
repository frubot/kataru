import type { RustTurnResponse } from '../../lib/conversationResult';
import type {
    DebugLogUsage,
    FullJsonDebugLog,
    Message,
    Room,
} from '../../lib/store';

type ApplyConversationResultOptions = {
    data: RustTurnResponse;
    sourceRoom: Room;
    jobId: string;
    isSecretMode: boolean;
    debugEnabled: boolean;
};

type ApplyConversationResultOperations = {
    updateRoomSummary: (roomId: string, summary: string, checkpointId?: string) => void;
    compressRoomHistory: (roomId: string, keepCount: number) => void;
    isGenerationActive: () => boolean;
    addMessage: (
        roomId: string,
        role: 'user' | 'assistant',
        content: string,
        characterId?: string,
        meta?: Pick<Message, 'expression' | 'motion' | 'memories' | 'toCharacterIds' | 'continuesPrevious'>,
    ) => string;
    rememberStreamedFinalMessageIds: (messageIds: string[]) => void;
    refreshConversationRoom: (roomId: string) => Promise<void>;
    clearStreamingPreview: (jobId: string) => void;
    addFullJsonDebugLog: (log: Omit<FullJsonDebugLog, 'id' | 'createdAt'>) => void;
    getCurrentRoom: () => Room | null | undefined;
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

const DEBUG_LOG_USAGE_KEYS = [
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'tokensPerSecond',
    'timeToFirstTokenMs',
    'promptTokensPerSecond',
    'cost',
] as const satisfies readonly (keyof DebugLogUsage)[];

/** サーバーが返した使用量から、表示に使う数値だけを拾い直す。 */
function debugLogUsage(value: unknown): DebugLogUsage | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const source = value as Record<string, unknown>;
    const usage: DebugLogUsage = {};
    for (const key of DEBUG_LOG_USAGE_KEYS) {
        const field = source[key];
        if (typeof field === 'number' && Number.isFinite(field)) {
            usage[key] = field;
        }
    }
    if (typeof source.estimated === 'boolean') {
        usage.estimated = source.estimated;
    }
    return Object.keys(usage).length > 0 ? usage : undefined;
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
            reasoning: debugLogText(log.reasoning),
            secondJson: debugLogText(log.secondJson),
            httpStatus: log.httpStatus,
            elapsedMs: log.elapsedMs,
            errorName: log.errorName,
            usage: debugLogUsage(log.usage),
            secondUsage: debugLogUsage(log.secondUsage),
        });
    }
}

type SecretConversationApplyOperations = Pick<
    ApplyConversationResultOperations,
    | 'updateRoomSummary'
    | 'compressRoomHistory'
    | 'addMessage'
    | 'rememberStreamedFinalMessageIds'
>;

/**
 * Applies generated messages client-side for secret rooms, whose history never
 * reaches the server-side conversation store. `isGenerationActive` lets the
 * normal completion flow bail out mid-apply when the user aborts; cancelled-job
 * callers pass `() => true` so every retained message is applied.
 */
export function applySecretConversationMessages(
    data: RustTurnResponse,
    roomId: string,
    isGenerationActive: () => boolean,
    operations: SecretConversationApplyOperations,
): string[] {
    if (data.summary?.text) {
        operations.updateRoomSummary(
            roomId,
            data.summary.text,
            data.summary.checkpointUserMessageId,
        );
        if (Number.isInteger(data.summary.keepCount) && data.summary.keepCount > 0) {
            operations.compressRoomHistory(roomId, data.summary.keepCount);
        }
    }
    const assistantMessages = Array.isArray(data.messages) ? data.messages : [];
    const messageIds: string[] = [];
    for (const message of assistantMessages) {
        if (!message?.content?.trim()) continue;
        if (!isGenerationActive()) {
            throw new DOMException('Generation stopped', 'AbortError');
        }
        const messageId = operations.addMessage(
            roomId,
            'assistant',
            message.content,
            message.characterId,
            {
                expression: message.expression,
                motion: message.motion,
                toCharacterIds: message.toCharacterIds ?? [],
                ...(message.continuesPrevious ? { continuesPrevious: true } : {}),
            },
        );
        messageIds.push(messageId);
        operations.rememberStreamedFinalMessageIds([messageId]);
    }
    return messageIds;
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
    } = options;
    const assistantMessages = Array.isArray(data.messages) ? data.messages : [];
    recordConversationDebugLogs(options, operations);

    let assistantMessageIds = assistantMessages
        .filter((message) => message?.content?.trim() && message.id)
        .map((message) => message.id);
    if (isSecretMode) {
        assistantMessageIds = applySecretConversationMessages(
            data,
            sourceRoom.id,
            operations.isGenerationActive,
            operations,
        );
    } else {
        operations.rememberStreamedFinalMessageIds(assistantMessageIds);
        // サーバー側では既に保存が完了しているため、ここで履歴読込が失敗
        // しても生成失敗として扱わない。ロールバックすると永続化済みの新しい
        // 応答が残ったまま旧メッセージが復元され、新旧が混在してしまう。
        // 読込は一度だけやり直し、駄目なら次の同期に委ねる。
        try {
            await operations.refreshConversationRoom(sourceRoom.id);
        } catch (error) {
            console.warn('Conversation room refresh failed, retrying once:', error);
            try {
                await operations.refreshConversationRoom(sourceRoom.id);
            } catch (retryError) {
                console.warn('Conversation room refresh failed:', retryError);
            }
        }
    }
    operations.clearStreamingPreview(jobId);

    return {
        message: assistantMessages.map((message) => message.content).join('\n\n'),
        assistantMessageIds,
    };
}
