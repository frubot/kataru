import type { Message } from './store/types';

/**
 * キャラ側の発言本文を差し替えた履歴を返す。
 * 対象が見つからない・ユーザー発言・本文が同じ場合は null を返す。
 */
export function replaceAssistantMessageContent(
    messages: Message[],
    messageId: string,
    content: string,
): { messages: Message[]; message: Message; isLast: boolean } | null {
    const index = messages.findIndex((message) => message.id === messageId);
    const target = messages[index];
    if (!target || target.role !== 'assistant' || target.content === content) return null;
    const message = { ...target, content };
    const nextMessages = [...messages];
    nextMessages[index] = message;
    return { messages: nextMessages, message, isLast: index === messages.length - 1 };
}
