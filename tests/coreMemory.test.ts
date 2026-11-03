import { describe, expect, test } from 'vitest';

import {
    CORE_MEMORY_ENTRY_MAX_CHARS,
    CORE_MEMORY_MAX_CHARS_MAX,
    CORE_MEMORY_MAX_CHARS_MIN,
    DEFAULT_CORE_MEMORY_MAX_CHARS,
    coreMemoryDraftProblems,
    coreMemorySectionToText,
    countCoreMemoryChars,
    isLockedCoreMemoryLine,
    normalizeCoreMemoryMaxChars,
    parseCoreMemorySectionText,
    tooLongCoreMemoryLines,
    totalCoreMemoryChars,
} from '../lib/coreMemory';
import type { CoreMemoryEntry } from '../lib/store';

describe('core memory limits', () => {
    test('counts characters like the server after collapsing whitespace', () => {
        expect(countCoreMemoryChars('  週末に   水族館 ')).toBe(7);
        // 絵文字はUTF-16では2単位だが、サーバーと同じく1文字として数える。
        expect(countCoreMemoryChars('🐟が好き')).toBe(4);
        expect(totalCoreMemoryChars([{ text: 'あい' }, { text: 'う' }])).toBe(3);
    });

    test('reports lines and totals over the limits', () => {
        const max = DEFAULT_CORE_MEMORY_MAX_CHARS;
        expect(coreMemoryDraftProblems([{ text: 'あ' }], max)).toEqual([]);
        expect(coreMemoryDraftProblems([{ text: 'あ'.repeat(CORE_MEMORY_ENTRY_MAX_CHARS + 1) }], max))
            .toEqual(['entryTooLong']);
        const lines = Array.from(
            { length: max / CORE_MEMORY_ENTRY_MAX_CHARS + 1 },
            () => ({ text: 'あ'.repeat(CORE_MEMORY_ENTRY_MAX_CHARS) }),
        );
        expect(coreMemoryDraftProblems(lines, max)).toEqual(['totalTooLong']);
        // 上限を上げれば同じ内容でも収まる。
        expect(coreMemoryDraftProblems(lines, max + CORE_MEMORY_ENTRY_MAX_CHARS)).toEqual([]);
    });

    test('normalizes the configured total limit', () => {
        expect(normalizeCoreMemoryMaxChars(undefined)).toBe(DEFAULT_CORE_MEMORY_MAX_CHARS);
        expect(normalizeCoreMemoryMaxChars('2000')).toBe(DEFAULT_CORE_MEMORY_MAX_CHARS);
        expect(normalizeCoreMemoryMaxChars(2000)).toBe(2000);
        expect(normalizeCoreMemoryMaxChars(1)).toBe(CORE_MEMORY_MAX_CHARS_MIN);
        expect(normalizeCoreMemoryMaxChars(99999)).toBe(CORE_MEMORY_MAX_CHARS_MAX);
    });
});
describe('core memory section text', () => {
    const entries: CoreMemoryEntry[] = [
        { id: 'u1', section: 'user', text: '名前はミナ', locked: true, author: 'user', updatedAt: 1 },
        { id: 'u2', section: 'user', text: '辛いものが苦手', author: 'ai', updatedAt: 2 },
        { id: 'r3', section: 'relationship', text: '週末に水族館へ行く約束', author: 'ai', updatedAt: 3 },
    ];

    test('writes one line per entry and marks locked lines with !', () => {
        expect(coreMemorySectionToText(entries, 'user')).toBe(['!名前はミナ', '辛いものが苦手'].join('\n'));
        expect(coreMemorySectionToText(entries, 'self')).toBe('');
    });

    test('keeps ids of unchanged lines and clears ids of changed or new lines', () => {
        const text = ['辛いものが苦手', '', '  !名前は  ミナ ', '！朝が弱い'].join('\n');
        expect(parseCoreMemorySectionText(text, 'user', entries)).toEqual([
            { id: 'u2', section: 'user', text: '辛いものが苦手', locked: false, author: 'ai', updatedAt: 2 },
            { id: '', section: 'user', text: '名前は ミナ', locked: true },
            { id: '', section: 'user', text: '朝が弱い', locked: true },
        ]);
    });

    test('unlocks a line when its ! is removed and drops empty lines', () => {
        expect(parseCoreMemorySectionText(['名前はミナ', '!', ''].join('\n'), 'user', entries)).toEqual([
            { id: 'u1', section: 'user', text: '名前はミナ', locked: false, author: 'user', updatedAt: 1 },
        ]);
    });

    test('does not reuse an id from another section', () => {
        expect(parseCoreMemorySectionText('週末に水族館へ行く約束', 'self', entries)).toEqual([
            { id: '', section: 'self', text: '週末に水族館へ行く約束', locked: false },
        ]);
    });

    test('tells which lines are locked', () => {
        expect(isLockedCoreMemoryLine(' !名前はミナ')).toBe(true);
        expect(isLockedCoreMemoryLine('！朝が弱い')).toBe(true);
        expect(isLockedCoreMemoryLine('!')).toBe(false);
        expect(isLockedCoreMemoryLine('名前は!ミナ')).toBe(false);
    });

    test('reports the line numbers that are too long, not counting the ! mark', () => {
        const text = ['短い', '', 'あ'.repeat(CORE_MEMORY_ENTRY_MAX_CHARS + 1), `!${'あ'.repeat(CORE_MEMORY_ENTRY_MAX_CHARS)}`].join('\n');
        expect(tooLongCoreMemoryLines(text)).toEqual([3]);
    });
});
