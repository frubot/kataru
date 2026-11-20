import { describe, expect, test } from 'vitest';

import { replaceAssistantMessageContent } from '../lib/messageEdit';
import type { Message } from '../lib/store';

function message(id: string, role: Message['role'], content = id): Message {
    return { id, role, content, timestamp: 1, characterId: role === 'assistant' ? 'character-1' : undefined };
}

describe('replaceAssistantMessageContent', () => {
    const messages = [
        message('user-1', 'user'),
        message('assistant-1', 'assistant'),
        message('user-2', 'user'),
        message('assistant-2', 'assistant'),
    ];

    test('rewrites only the target message and keeps the following history', () => {
        const result = replaceAssistantMessageContent(messages, 'assistant-1', '書き換えた返事');

        expect(result?.messages.map((item) => item.content)).toEqual([
            'user-1',
            '書き換えた返事',
            'user-2',
            'assistant-2',
        ]);
        expect(result?.message).toMatchObject({ id: 'assistant-1', characterId: 'character-1' });
        expect(result?.isLast).toBe(false);
        expect(messages[1].content).toBe('assistant-1');
    });

    test('reports when the last message changed', () => {
        expect(replaceAssistantMessageContent(messages, 'assistant-2', '最新')?.isLast).toBe(true);
    });

    test('ignores user messages, unknown ids and unchanged content', () => {
        expect(replaceAssistantMessageContent(messages, 'user-1', '別の文')).toBeNull();
        expect(replaceAssistantMessageContent(messages, 'missing', '別の文')).toBeNull();
        expect(replaceAssistantMessageContent(messages, 'assistant-1', 'assistant-1')).toBeNull();
    });
});
