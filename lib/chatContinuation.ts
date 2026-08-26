import type { Message } from './store/types';

type ChatContinuationAvailability = {
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
    input,
    messages,
    blocked,
}: ChatContinuationAvailability): boolean {
    if (blocked || input.trim()) return false;
    return getLatestActiveChatMessage(messages)?.role === 'assistant';
}
