type RegenerationMessage = {
    role: 'user' | 'assistant';
};

type ChatRegenerationOptions = {
    allowEmptyReplyRound: boolean;
};

export function getChatRegenerationCutIndex(
    messages: RegenerationMessage[],
    { allowEmptyReplyRound }: ChatRegenerationOptions,
): number | null {
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role === 'user') {
            lastUserIndex = index;
            break;
        }
    }
    if (lastUserIndex < 0) return null;

    const cutFrom = lastUserIndex + 1;
    if (!allowEmptyReplyRound && cutFrom >= messages.length) return null;
    if (!allowEmptyReplyRound && !messages.slice(cutFrom).some((message) => message.role === 'assistant')) {
        return null;
    }
    return cutFrom;
}
