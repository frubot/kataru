import { describe, expect, test } from 'vitest';

import { getChatRegenerationCutIndex } from '../lib/chatRegeneration';

describe('chat regeneration planning', () => {
    test('cuts every assistant response after the latest user message', () => {
        const messages = [
            { role: 'user' as const },
            { role: 'assistant' as const },
            { role: 'user' as const },
            { role: 'assistant' as const },
            { role: 'assistant' as const },
        ];

        expect(getChatRegenerationCutIndex(messages, { allowEmptyReplyRound: false })).toBe(3);
        expect(getChatRegenerationCutIndex(messages, { allowEmptyReplyRound: true })).toBe(3);
    });

    test('preserves the group-mode ability to generate an empty reply round', () => {
        const messages = [
            { role: 'user' as const },
            { role: 'assistant' as const },
            { role: 'user' as const },
        ];

        expect(getChatRegenerationCutIndex(messages, { allowEmptyReplyRound: true })).toBe(3);
        expect(getChatRegenerationCutIndex(messages, { allowEmptyReplyRound: false })).toBeNull();
    });

    test('keeps every consecutive user message and regenerates only the reply', () => {
        const messages = [
            { role: 'user' as const },
            { role: 'assistant' as const },
            { role: 'user' as const },
            { role: 'user' as const },
            { role: 'user' as const },
            { role: 'assistant' as const },
            { role: 'assistant' as const },
        ];

        // 連投した3件（index 2〜4）は残し、その後の返信だけを作り直す。
        expect(getChatRegenerationCutIndex(messages, { allowEmptyReplyRound: false })).toBe(5);
        expect(getChatRegenerationCutIndex(messages, { allowEmptyReplyRound: true })).toBe(5);
    });

    test('does not regenerate unanswered consecutive user messages in single-character rooms', () => {
        const messages = [
            { role: 'assistant' as const },
            { role: 'user' as const },
            { role: 'user' as const },
        ];

        expect(getChatRegenerationCutIndex(messages, { allowEmptyReplyRound: false })).toBeNull();
        expect(getChatRegenerationCutIndex(messages, { allowEmptyReplyRound: true })).toBe(3);
    });

    test('does not regenerate a conversation without a user message', () => {
        expect(getChatRegenerationCutIndex(
            [{ role: 'assistant' }],
            { allowEmptyReplyRound: true },
        )).toBeNull();
    });
});
