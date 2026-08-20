import { describe, expect, test } from 'vitest';

import { appendSummaryRevision, createSummaryRevision } from '../lib/store/conversations';
import {
    createMemoryRecord,
    replaceMemoryContentInMessages,
    scoreMemory,
} from '../lib/store/memories';
import type { Message, SummaryRevision } from '../lib/store';
import { toStoredRoom } from '../lib/store/persistence';

describe('developer inspector data helpers', () => {
    test('keeps a bounded, deduplicated summary revision history', () => {
        const revision = {
            text: '現在の要約',
            checkpointUserMessageId: 'message-1',
            createdAt: 1,
            source: 'automatic' as const,
        };
        expect(appendSummaryRevision([revision], { ...revision, createdAt: 2 })).toEqual([revision]);

        let history: SummaryRevision[] = [];
        for (let index = 0; index < 25; index++) {
            history = appendSummaryRevision(history, {
                text: `要約${index}`,
                createdAt: index,
                source: 'manual',
            });
        }
        expect(history).toHaveLength(20);
        expect(history[0].text).toBe('要約5');
    });

    test('stores the room checkpoint using the summary revision field name', () => {
        expect(createSummaryRevision('要約', 'user-message-1', 'manual', 10)).toEqual({
            text: '要約',
            checkpointUserMessageId: 'user-message-1',
            createdAt: 10,
            source: 'manual',
        });
    });

    test('pinned memories outrank ordinary memories without changing their content', () => {
        const memory = createMemoryRecord('character-1', '紅茶が好き')!;
        const ordinary = scoreMemory(memory, '無関係な質問', null, 'embedding-model');
        const pinned = scoreMemory({ ...memory, pinned: true }, '無関係な質問', null, 'embedding-model');
        expect(pinned).toBeGreaterThan(ordinary + 1);
    });

    test('replaces legacy memory labels only on matching source messages', () => {
        const messages: Message[] = [
            {
                id: 'source-message',
                role: 'assistant',
                characterId: 'character-1',
                content: 'reply',
                memories: ['古い記憶', '新しい記憶'],
                timestamp: 1,
            },
            {
                id: 'other-message',
                role: 'assistant',
                characterId: 'character-1',
                content: 'reply',
                memories: ['古い記憶'],
                timestamp: 2,
            },
            {
                id: 'other-character-message',
                role: 'assistant',
                characterId: 'character-2',
                content: 'reply',
                memories: ['古い記憶'],
                timestamp: 3,
            },
        ];
        const replaced = replaceMemoryContentInMessages(messages, {
            characterId: 'character-1',
            sourceMessageIds: ['source-message'],
            previousContent: '古い記憶',
            nextContent: '新しい記憶',
        });

        expect(replaced[0].memories).toEqual(['新しい記憶']);
        expect(replaced[1]).toBe(messages[1]);
        expect(replaced[2]).toBe(messages[2]);
    });

    test('never includes transient summary inspector data in a secret room payload', () => {
        const stored = toStoredRoom({
            id: 'secret-room',
            characterId: 'character-1',
            name: 'secret',
            messages: [],
            secretMode: true,
            summary: '秘密の要約',
            summaryCheckpointUserMessageId: 'message-1',
            summaryHistory: [{ text: '秘密の要約', createdAt: 1, source: 'automatic' }],
            createdAt: 1,
            updatedAt: 1,
        });
        expect(stored).not.toHaveProperty('summary');
        expect(stored).not.toHaveProperty('summaryCheckpointUserMessageId');
        expect(stored).not.toHaveProperty('summaryHistory');
    });
});
