import type { Message, Room } from './store/types';

type IdGenerator = () => string;

function nextBranchedRoomName(sourceName: string, existingRoomNames: string[]): string {
    const baseName = (sourceName.trim() || 'チャット').replace(/\s*\(分岐(?: \d+)?\)$/, '');
    const existingNames = new Set(existingRoomNames);
    const firstCandidate = `${baseName} (分岐)`;
    if (!existingNames.has(firstCandidate)) return firstCandidate;

    let suffix = 2;
    while (existingNames.has(`${baseName} (分岐 ${suffix})`)) suffix++;
    return `${baseName} (分岐 ${suffix})`;
}

export function isConversationResponseEnd(messages: Message[], index: number): boolean {
    const message = messages[index];
    const nextMessage = messages[index + 1];
    return message?.role === 'assistant' && (!nextMessage || nextMessage.role === 'user');
}

export function buildConversationBranch(
    sourceRoom: Room,
    existingRoomNames: string[],
    messageId: string,
    now: number,
    generateId: IdGenerator,
): Room {
    if (sourceRoom.secretMode === true) {
        throw new Error('シークレットモードの会話は分岐できません。');
    }

    const targetIndex = sourceRoom.messages.findIndex((message) => message.id === messageId);
    if (!isConversationResponseEnd(sourceRoom.messages, targetIndex)) {
        throw new Error('分岐できる応答地点が見つかりませんでした。');
    }

    const targetMessage = sourceRoom.messages[targetIndex];
    const restoreSummarizedHistory = targetMessage.archived === true;
    const sourceMessages = sourceRoom.messages.slice(0, targetIndex + 1);
    const messageIdMap = new Map<string, string>();
    for (const message of sourceMessages) {
        messageIdMap.set(message.id, generateId());
    }

    let previousTimestamp = Number.MIN_SAFE_INTEGER;
    const messages = sourceMessages.map((message): Message => {
        const copy = { ...message };
        delete copy.archived;
        delete copy.memories;
        const timestamp = Math.max(message.timestamp, previousTimestamp + 1);
        previousTimestamp = timestamp;
        return {
            ...copy,
            id: messageIdMap.get(message.id)!,
            timestamp,
            ...(!restoreSummarizedHistory && message.archived ? { archived: true } : {}),
        };
    });
    const mappedSummaryCheckpoint = sourceRoom.summary && sourceRoom.summaryCheckpointUserMessageId
        ? messageIdMap.get(sourceRoom.summaryCheckpointUserMessageId)
        : undefined;
    const summaryHistory = restoreSummarizedHistory
        ? undefined
        : sourceRoom.summaryHistory?.flatMap((revision) => {
            if (!revision.checkpointUserMessageId) return [{ ...revision }];
            const checkpointUserMessageId = messageIdMap.get(revision.checkpointUserMessageId);
            return checkpointUserMessageId ? [{ ...revision, checkpointUserMessageId }] : [];
        });
    const lastMessage = messages[messages.length - 1];

    return {
        ...sourceRoom,
        id: generateId(),
        name: nextBranchedRoomName(sourceRoom.name, existingRoomNames),
        messages,
        summary: restoreSummarizedHistory ? undefined : sourceRoom.summary,
        summaryCheckpointUserMessageId: restoreSummarizedHistory
            ? undefined
            : mappedSummaryCheckpoint,
        summaryHistory,
        replySuggestions: undefined,
        secretMode: undefined,
        isDraft: undefined,
        lastMessagePreview: undefined,
        lastMessageAt: lastMessage.timestamp,
        createdAt: now,
        updatedAt: now,
    };
}
