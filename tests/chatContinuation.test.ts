import { describe, expect, test } from 'vitest';

import {
    getLatestActiveChatMessage,
    isChatContinuationAvailable,
} from '../lib/chatContinuation';

describe('chat continuation', () => {
    test('is available only for an empty game-mode input after an assistant response', () => {
        expect(isChatContinuationAvailable({
            visualNovelMode: true,
            input: '   ',
            messages: [
                { role: 'user' },
                { role: 'assistant' },
            ],
            blocked: false,
        })).toBe(true);
    });

    test('is unavailable while typing, outside game mode, or while blocked', () => {
        const messages = [{ role: 'assistant' as const }];
        expect(isChatContinuationAvailable({
            visualNovelMode: true,
            input: '続きを指定する',
            messages,
            blocked: false,
        })).toBe(false);
        expect(isChatContinuationAvailable({
            visualNovelMode: false,
            input: '',
            messages,
            blocked: false,
        })).toBe(false);
        expect(isChatContinuationAvailable({
            visualNovelMode: true,
            input: '',
            messages,
            blocked: true,
        })).toBe(false);
    });

    test('uses the latest non-archived message', () => {
        const messages = [
            { role: 'assistant' as const },
            { role: 'user' as const, archived: true },
        ];

        expect(getLatestActiveChatMessage(messages)?.role).toBe('assistant');
        expect(isChatContinuationAvailable({
            visualNovelMode: true,
            input: '',
            messages,
            blocked: false,
        })).toBe(true);
    });

    test('is unavailable when the active history ends with the user or is empty', () => {
        expect(isChatContinuationAvailable({
            visualNovelMode: true,
            input: '',
            messages: [{ role: 'user' }],
            blocked: false,
        })).toBe(false);
        expect(isChatContinuationAvailable({
            visualNovelMode: true,
            input: '',
            messages: [],
            blocked: false,
        })).toBe(false);
    });
});
