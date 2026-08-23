import { afterEach, describe, expect, test, vi } from 'vitest';

import {
    buildPromptRequestMessages,
    requestRoomTitleWithRetry,
} from '../lib/chatAuxiliaryClient';
import { normalizeAiApiConfig } from '../lib/aiApi';
import type { Message, SituationParticipant } from '../lib/store';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('auxiliary chat prompt messages', () => {
    test('drops archived and blank messages and adds participant names', () => {
        const messages = [
            { id: 'u1', role: 'user', content: '質問', timestamp: 1 },
            { id: 'a1', role: 'assistant', content: '回答', characterId: 'actor-1', timestamp: 2 },
            { id: 'a2', role: 'assistant', content: '非表示', archived: true, timestamp: 3 },
            { id: 'u2', role: 'user', content: '   ', timestamp: 4 },
        ] as Message[];
        const participants = [{ id: 'actor-1', name: 'アリス' }] as SituationParticipant[];

        expect(buildPromptRequestMessages(messages, participants)).toEqual([
            { role: 'user', content: '質問' },
            { role: 'assistant', content: '回答', name: 'アリス' },
        ]);
    });
});

describe('room title generation', () => {
    const input = {
        messages: [
            { role: 'user' as const, content: 'こんにちは' },
            { role: 'assistant' as const, content: 'こんにちは！' },
        ],
        model: 'model-1',
        aiApiConfig: normalizeAiApiConfig({ aiApiType: 'openrouter' }),
    };

    test('retries unsuccessful responses and returns the generated title', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('', { status: 502 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ title: '' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ title: ' はじめての挨拶 ' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(requestRoomTitleWithRetry(input, {
            retryDelaysMs: [0, 0],
            attemptTimeoutMs: 1_000,
        })).resolves.toBe('はじめての挨拶');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    test('returns null after every response is unsuccessful', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(requestRoomTitleWithRetry(input, {
            retryDelaysMs: [0, 0],
            attemptTimeoutMs: 1_000,
        })).resolves.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});
