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

    test('does not regenerate a conversation without a user message', () => {
        expect(getChatRegenerationCutIndex(
            [{ role: 'assistant' }],
            { allowEmptyReplyRound: true },
        )).toBeNull();
    });
});
