import type { Message } from './store/types';

type ChatContinuationAvailability = {
    input: string;
    hasAttachments?: boolean;
    messages: readonly Pick<Message, 'role' | 'archived'>[];
    blocked: boolean;
};

export function getLatestActiveChatMessage<TMessage extends Pick<Message, 'archived'>>(
    messages: readonly TMessage[],
): TMessage | undefined {
    return messages.findLast((message) => !message.archived);
}

export function isChatContinuationAvailable({
    input,
    hasAttachments = false,
    messages,
    blocked,
}: ChatContinuationAvailability): boolean {
    if (blocked || input.trim() || hasAttachments) return false;
    return getLatestActiveChatMessage(messages)?.role === 'assistant';
}
