import { describe, expect, test } from 'vitest';

import {
    boundPromptInspectionHistory,
    buildPromptTokenBreakdown,
    createPromptInspectionSnapshots,
    estimatePromptTokens,
    mergePromptInspectionSnapshots,
    parseFinalPromptMessages,
    splitSystemPromptSections,
} from '../lib/promptInspector';

describe('prompt inspector', () => {
    const prompt = JSON.stringify([
        {
            role: 'system',
            content: '# 指示\n役になりきる\n\n# これまでの会話の要約\n昨日会った\n\n## 関連するメモリ\n1. 紅茶が好き\n\n# 葵の設定\n丁寧に話す',
        },
        { role: 'user', content: '今日は何を飲む？' },
    ]);

    test('parses the final logical messages JSON assembled for generation', () => {
        expect(parseFinalPromptMessages(prompt)).toHaveLength(2);
        expect(parseFinalPromptMessages('{"not":"messages"}')).toBeNull();
        expect(parseFinalPromptMessages('invalid')).toBeNull();
    });

    test('separates summary and memory sections from system blocks', () => {
        const messages = parseFinalPromptMessages(prompt)!;
        const sections = splitSystemPromptSections(String(messages[0].content));
        expect(sections.map((section) => section.category)).toEqual([
            'system',
            'summary',
            'memory',
            'system',
        ]);
        const breakdown = buildPromptTokenBreakdown(messages);
        expect(breakdown.systemBlocks.map((part) => part.label)).toEqual(['指示', '葵の設定']);
        expect(breakdown.summary.estimatedTokens).toBeGreaterThan(0);
        expect(breakdown.memory.estimatedTokens).toBeGreaterThan(0);
        expect(breakdown.history.estimatedTokens).toBeGreaterThan(0);
        expect(breakdown.totalEstimatedTokens).toBe(
            breakdown.systemBlocks.reduce((sum, part) => sum + part.estimatedTokens, 0)
                + breakdown.summary.estimatedTokens
                + breakdown.memory.estimatedTokens
                + breakdown.history.estimatedTokens,
        );
    });

    test('uses a deterministic language-aware estimate and captures valid logs only', () => {
        expect(estimatePromptTokens('')).toBe(0);
        expect(estimatePromptTokens('こんにちは')).toBeGreaterThan(estimatePromptTokens('hello'));
        const snapshots = createPromptInspectionSnapshots([
            { characterId: 'a', characterName: '葵', source: 'assistant-json', prompt },
            { characterId: 'b', characterName: '凛', source: 'error', prompt: 'not-json' },
        ], 123);
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]).toMatchObject({ capturedAt: 123, characterId: 'a' });
    });

    test('bounds snapshots across all rooms and removes deleted rooms', () => {
        const snapshot = (id: string, capturedAt: number) => createPromptInspectionSnapshots([{
            characterId: 'a',
            characterName: '葵',
            source: 'assistant-json',
            prompt,
        }], capturedAt, id)[0];
        const history = {
            'room-a': Array.from({ length: 12 }, (_, index) => snapshot(`a-${index}`, index + 1)),
            'room-b': Array.from({ length: 12 }, (_, index) => snapshot(`b-${index}`, index + 13)),
            'deleted-room': [snapshot('deleted', 100)],
        };
        const merged = mergePromptInspectionSnapshots(
            history,
            'room-c',
            [snapshot('new', 25)],
            ['room-a', 'room-b', 'room-c'],
        );
        const allSnapshots = Object.values(merged).flat();

        expect(allSnapshots).toHaveLength(20);
        expect(merged).not.toHaveProperty('deleted-room');
        expect(merged['room-c']).toHaveLength(1);
        expect(Math.min(...allSnapshots.map((item) => item.capturedAt))).toBe(6);

        expect(boundPromptInspectionHistory(merged, ['room-c'])).toEqual({
            'room-c': merged['room-c'],
        });
    });
});
