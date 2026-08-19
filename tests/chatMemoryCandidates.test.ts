import { describe, expect, test } from 'vitest';

import { selectMemoryCandidates } from '../lib/chatMemoryCandidates';

const character = {
    systemPrompt: '猫が好き。',
    speechStyle: '',
    protagonistPrompt: '',
    userConstraints: '',
};

describe('memory candidate selection', () => {
    test('filters weak, configured, existing, and same-turn duplicate memories', () => {
        const selected = selectMemoryCandidates([
            { content: '猫が好き。', kind: 'preference', scope: 'character', importance: 0.9, confidence: 0.9 },
            { content: '京都へ旅行した。', kind: 'event', scope: 'character', importance: 0.9, confidence: 0.9 },
            { content: '京都へ旅行した', kind: 'event', scope: 'character', importance: 0.8, confidence: 0.9 },
            { content: '紅茶を毎朝飲む。', kind: 'preference', scope: 'character', importance: 0.8, confidence: 0.9 },
            { content: '信頼度が低い。', kind: 'fact', scope: 'character', importance: 0.9, confidence: 0.2 },
        ], character, [{ content: '紅茶を毎朝飲む。' }]);

        expect(selected.map((candidate) => candidate.content)).toEqual(['京都へ旅行した。']);
    });

    test('keeps at most five candidates ordered by weighted quality', () => {
        const events = [
            '富士山頂で日の出を見た。',
            '青い自転車を購入した。',
            '陶芸教室で茶碗を作った。',
            '海辺で珍しい貝殻を拾った。',
            '友人の結婚式で司会を務めた。',
            '庭にレモンの木を植えた。',
            '冬祭りで雪像を完成させた。',
        ];
        const selected = selectMemoryCandidates(
            events.map((content, index) => ({
                content,
                kind: 'event' as const,
                scope: 'character' as const,
                importance: 0.5 + index * 0.05,
                confidence: 0.9,
            })),
            { ...character, systemPrompt: '' },
            [],
        );

        expect(selected).toHaveLength(5);
        expect(selected[0].importance).toBeGreaterThanOrEqual(selected[4].importance);
    });
});
