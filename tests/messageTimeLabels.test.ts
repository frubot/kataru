import { describe, expect, test } from 'vitest';

import {
    buildMessageTimeLabels,
    formatMessageDateLabel,
    formatMessageTimeLabel,
} from '../lib/messageTimeLabels';

/** ローカル時刻でのタイムスタンプ。 */
const at = (month: number, day: number, hour: number, minute: number, second = 0, year = 2026) =>
    new Date(year, month - 1, day, hour, minute, second).getTime();

const NOW = at(11, 20, 18, 30);

describe('formatMessageDateLabel', () => {
    test('uses relative labels for today and yesterday', () => {
        expect(formatMessageDateLabel(at(11, 20, 0, 5), NOW)).toBe('今日');
        expect(formatMessageDateLabel(at(11, 19, 23, 59), NOW)).toBe('昨日');
    });

    test('shows month, day and weekday, adding the year only for other years', () => {
        expect(formatMessageDateLabel(at(11, 18, 12, 0), NOW)).toBe('11月18日(水)');
        expect(formatMessageDateLabel(at(12, 31, 12, 0, 0, 2025), NOW)).toBe('2025年12月31日(水)');
    });
});

describe('formatMessageTimeLabel', () => {
    test('formats hours and zero-padded minutes', () => {
        expect(formatMessageTimeLabel(at(11, 20, 9, 5))).toBe('9:05');
        expect(formatMessageTimeLabel(at(11, 20, 23, 45))).toBe('23:45');
    });
});

describe('buildMessageTimeLabels', () => {
    test('adds a date divider at each new day', () => {
        const labels = buildMessageTimeLabels([
            { id: 'a', role: 'user', timestamp: at(11, 19, 22, 0) },
            { id: 'b', role: 'assistant', timestamp: at(11, 19, 22, 1) },
            { id: 'c', role: 'user', timestamp: at(11, 20, 8, 0) },
        ], NOW);
        expect(labels.get('a')?.dateLabel).toBe('昨日');
        expect(labels.get('b')?.dateLabel).toBeUndefined();
        expect(labels.get('c')?.dateLabel).toBe('今日');
    });

    test('shows the time only at the end of a same-minute run from one sender', () => {
        const labels = buildMessageTimeLabels([
            { id: 'u1', role: 'user', timestamp: at(11, 20, 18, 0, 5) },
            { id: 'u2', role: 'user', timestamp: at(11, 20, 18, 0, 40) },
            { id: 'a1', role: 'assistant', characterId: 'x', timestamp: at(11, 20, 18, 0, 50) },
            { id: 'a2', role: 'assistant', characterId: 'y', timestamp: at(11, 20, 18, 0, 55) },
            { id: 'a3', role: 'assistant', characterId: 'y', timestamp: at(11, 20, 18, 1, 2) },
        ], NOW);
        expect(labels.get('u1')?.timeLabel).toBeUndefined();
        expect(labels.get('u2')?.timeLabel).toBe('18:00');
        expect(labels.get('a1')?.timeLabel).toBe('18:00');
        expect(labels.get('a2')?.timeLabel).toBe('18:00');
        expect(labels.get('a3')?.timeLabel).toBe('18:01');
    });

    test('skips merged continuations and messages without a timestamp', () => {
        const labels = buildMessageTimeLabels([
            { id: 'a', role: 'assistant', timestamp: at(11, 20, 18, 0) },
            { id: 'merged', role: 'assistant', timestamp: at(11, 20, 18, 5), mergedIntoPrevious: true },
            { id: 'none', role: 'user', timestamp: 0 },
        ], NOW);
        expect(labels.get('a')).toEqual({ dateLabel: '今日', timeLabel: '18:00' });
        expect(labels.has('merged')).toBe(false);
        expect(labels.has('none')).toBe(false);
    });
});
