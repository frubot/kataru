import type { Message } from './store/types';

type ChatContinuationAvailability = {
    visualNovelMode: boolean;
    input: string;
    messages: readonly Pick<Message, 'role' | 'archived'>[];
    blocked: boolean;
};

export function getLatestActiveChatMessage<TMessage extends Pick<Message, 'archived'>>(
    messages: readonly TMessage[],
): TMessage | undefined {
    return messages.findLast((message) => !message.archived);
}

export function isChatContinuationAvailable({
    visualNovelMode,
    input,
    messages,
    blocked,
}: ChatContinuationAvailability): boolean {
    if (!visualNovelMode || blocked || input.trim()) return false;
    return getLatestActiveChatMessage(messages)?.role === 'assistant';
}
