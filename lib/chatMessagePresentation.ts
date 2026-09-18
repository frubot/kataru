import { getMessageMemories } from './chatAssistantResponse';
import { isConversationResponseEnd } from './conversationBranch';
import type { ConversationJobPreviewTurn } from './conversationJobClient';
import type {
    Character,
    Message,
    Room,
    SituationParticipant,
    SituationPriorMessage,
} from './store/types';

export type ChatStreamingPreview = {
    roomId: string;
    jobId: string;
    content: string;
    characterId?: string;
    characterName?: string;
    formattedMessages?: string[];
    expression?: string;
    turns?: ConversationJobPreviewTurn[];
    generationBaselineMessageIds?: string[];
};

export type PriorMessagePresentation = {
    message: SituationPriorMessage;
    character?: Character;
    isAssistantContinuation: boolean;
};

export type ChatMessagePresentation = Message & {
    displayContent: string;
    emotion?: string;
    isArchived: boolean;
    isAssistantContinuation: boolean;
    showAssistantActions: boolean;
    showBranchAction: boolean;
    showArchiveDivider: boolean;
    showMemoryIndicator: boolean;
    msgCharacterIcon?: string;
    msgCharacterName?: string;
};

export function buildChatCharacterMap(
    isGroupRoom: boolean,
    groupCharacters?: SituationParticipant[] | null,
): Map<string, Character> | null {
    if (!isGroupRoom || !groupCharacters) return null;
    return new Map(groupCharacters.map((participant) => [participant.id, participant]));
}

export function buildPriorMessagePresentations(
    messages: SituationPriorMessage[],
    characterMap: Map<string, Character> | null,
): PriorMessagePresentation[] {
    return messages.map((message, index) => {
        const previousMessage = messages[index - 1];
        return {
            message,
            character: message.role === 'assistant' ? characterMap?.get(message.actorId) : undefined,
            isAssistantContinuation: message.role === 'assistant'
                && previousMessage?.role === 'assistant'
                && previousMessage.actorId === message.actorId,
        };
    });
}

type BuildChatMessagePresentationsOptions = {
    room: Room | null;
    characterMap: Map<string, Character> | null;
    character: Character | null;
    isGroupRoom: boolean;
    isSecretMode: boolean;
    typingMessageId: string | null;
    typedContent: string;
};

export function buildChatMessagePresentations({
    room,
    characterMap,
    character,
    isGroupRoom,
    isSecretMode,
    typingMessageId,
    typedContent,
}: BuildChatMessagePresentationsOptions): ChatMessagePresentation[] {
    if (!room) return [];
    return room.messages.map((message, index) => {
        const isArchived = !!message.archived;
        const showArchiveDivider = isArchived && (index === 0 || !room.messages[index - 1].archived)
            ? false
            : !isArchived && index > 0 && !!room.messages[index - 1].archived;
        const previousMessage = room.messages[index - 1];
        const nextMessage = room.messages[index + 1];
        const messageCharacterKey = message.characterId ?? (!isGroupRoom ? character?.id : undefined);
        const previousCharacterKey = previousMessage?.characterId ?? (!isGroupRoom ? character?.id : undefined);
        const nextCharacterKey = nextMessage?.characterId ?? (!isGroupRoom ? character?.id : undefined);
        const isAssistantContinuation = message.role === 'assistant'
            && previousMessage?.role === 'assistant'
            && messageCharacterKey === previousCharacterKey
            && !showArchiveDivider;
        const hasNextAssistantContinuation = message.role === 'assistant'
            && nextMessage?.role === 'assistant'
            && messageCharacterKey === nextCharacterKey
            && !nextMessage.archived;
        const memories = message.role === 'assistant' ? getMessageMemories(message) : [];
        const displayContent = message.role === 'assistant' && message.id === typingMessageId
            ? typedContent
            : message.content;
        const messageCharacter = message.characterId && characterMap
            ? characterMap.get(message.characterId)
            : null;

        return {
            ...message,
            displayContent,
            emotion: message.expression,
            isArchived,
            isAssistantContinuation,
            showAssistantActions: !hasNextAssistantContinuation,
            showBranchAction: !isSecretMode && isConversationResponseEnd(room.messages, index),
            showArchiveDivider,
            showMemoryIndicator: memories.length > 0,
            msgCharacterIcon: messageCharacter?.icon ?? (isGroupRoom ? undefined : character?.icon),
            msgCharacterName: messageCharacter?.name ?? (isGroupRoom ? undefined : character?.name),
        };
    });
}

export type ChatStreamingPreviewBubble = {
    key: string;
    content: string;
    characterId?: string;
    characterName?: string;
    character?: Character | null;
    streaming: boolean;
    continuation: boolean;
};

type ResolveStreamingPresentationOptions = {
    streamingPreview: ChatStreamingPreview | null;
    room: Room | null;
    isLoading: boolean;
    characterMap: Map<string, Character> | null;
    character: Character | null;
};

export function resolveChatStreamingPresentation({
    streamingPreview,
    room,
    isLoading,
    characterMap,
    character,
}: ResolveStreamingPresentationOptions) {
    const currentReplyAssistantMessages = (() => {
        if (!room) return [];
        let latestUserIndex = -1;
        for (let index = room.messages.length - 1; index >= 0; index--) {
            if (room.messages[index].role === 'user') {
                latestUserIndex = index;
                break;
            }
        }
        return room.messages
            .slice(latestUserIndex + 1)
            .filter((message) => message.role === 'assistant');
    })();
    const availableFormattedMessages = streamingPreview?.formattedMessages
        ?.filter((content) => content.trim())
        ?? [];
    const previewForRoom = streamingPreview?.roomId === room?.id
        ? streamingPreview
        : null;
    const persisted = (contents: string[], characterId?: string) => (
        contents.length > 0
        && contents.every((content) =>
            currentReplyAssistantMessages.some((message) =>
                message.content === content
                && (!characterId || message.characterId === characterId)
            )
        )
    );
    const resolveBubbleCharacter = (characterId?: string) => (
        characterId && characterMap ? characterMap.get(characterId) : character
    );
    const allBubbles: ChatStreamingPreviewBubble[] = [];
    const pushBubble = (bubble: Omit<ChatStreamingPreviewBubble, 'continuation'>) => {
        const previous = allBubbles.at(-1);
        allBubbles.push({
            ...bubble,
            continuation: !!previous && previous.characterId === bubble.characterId,
        });
    };
    if (previewForRoom?.turns?.length) {
        for (const turn of previewForRoom.turns) {
            const formatted = turn.formattedMessages?.filter((content) => content.trim()) ?? [];
            const contents = (formatted.length > 0 ? formatted : [turn.content])
                .filter((content) => content.trim());
            const characterId = turn.characterId ?? previewForRoom.characterId;
            if (contents.length === 0 || persisted(contents, characterId)) continue;
            const bubbleCharacter = resolveBubbleCharacter(characterId);
            contents.forEach((content, index) => pushBubble({
                key: `${previewForRoom.jobId}:${turn.turnIndex}:${index}`,
                content,
                characterId,
                characterName: turn.characterName ?? previewForRoom.characterName,
                character: bubbleCharacter,
                streaming: !turn.complete,
            }));
        }
    } else if (previewForRoom) {
        const contents = (
            availableFormattedMessages.length > 0
                ? availableFormattedMessages
                : [previewForRoom.content]
        ).filter((content) => content.trim());
        if (contents.length > 0 && !persisted(contents, previewForRoom.characterId)) {
            const bubbleCharacter = resolveBubbleCharacter(previewForRoom.characterId);
            contents.forEach((content, index) => pushBubble({
                key: `${previewForRoom.jobId}:${index}`,
                content,
                characterId: previewForRoom.characterId,
                characterName: previewForRoom.characterName,
                character: bubbleCharacter,
                streaming: true,
            }));
        }
    }
    const activePreview = previewForRoom && isLoading && allBubbles.length > 0
        ? previewForRoom
        : null;
    const previewCharacter = activePreview?.characterId && characterMap
        ? characterMap.get(activePreview.characterId)
        : character;

    return {
        activePreview,
        previewCharacter,
        formattedMessages: activePreview ? availableFormattedMessages : [],
        bubbles: activePreview ? allBubbles : [],
    };
}
