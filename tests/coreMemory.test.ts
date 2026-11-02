import { describe, expect, test } from 'vitest';

import {
    CORE_MEMORY_ENTRY_MAX_CHARS,
    CORE_MEMORY_MAX_CHARS,
    coreMemoryDraftProblems,
    countCoreMemoryChars,
    totalCoreMemoryChars,
} from '../lib/coreMemory';

describe('core memory limits', () => {
    test('counts characters like the server after collapsing whitespace', () => {
        expect(countCoreMemoryChars('  週末に   水族館 ')).toBe(7);
        // 絵文字はUTF-16では2単位だが、サーバーと同じく1文字として数える。
        expect(countCoreMemoryChars('🐟が好き')).toBe(4);
        expect(totalCoreMemoryChars([{ text: 'あい' }, { text: 'う' }])).toBe(3);
    });

    test('reports lines and totals over the limits', () => {
        expect(coreMemoryDraftProblems([{ text: 'あ' }])).toEqual([]);
        expect(coreMemoryDraftProblems([{ text: 'あ'.repeat(CORE_MEMORY_ENTRY_MAX_CHARS + 1) }]))
            .toEqual(['entryTooLong']);
        const lines = Array.from(
            { length: CORE_MEMORY_MAX_CHARS / CORE_MEMORY_ENTRY_MAX_CHARS + 1 },
            () => ({ text: 'あ'.repeat(CORE_MEMORY_ENTRY_MAX_CHARS) }),
        );
        expect(coreMemoryDraftProblems(lines)).toEqual(['totalTooLong']);
    });
});
