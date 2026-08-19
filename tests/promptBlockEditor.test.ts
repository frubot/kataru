import { describe, expect, test } from 'vitest';

import {
    blockItemsToMarkdown,
    markdownToBlockItems,
} from '../components/PromptBlockEditor';

type BlockItems = ReturnType<typeof markdownToBlockItems>;

function withoutIds(items: BlockItems) {
    return items.map((item) => {
        const { id, ...withoutId } = item;
        void id;
        return withoutId;
    });
}

describe('markdownToBlockItems and blockItemsToMarkdown', () => {
    test('round-trips headings, paragraphs, multiline text, and lists canonically', () => {
        const markdown = [
            '# 登場人物',
            '',
            '最初の行',
            '続きの行',
            '',
            '- 一つ目',
            '* 二つ目',
            '',
            '## 次の章',
            '',
            '最後の段落',
        ].join('\n');

        const items = markdownToBlockItems(markdown);

        expect(withoutIds(items)).toEqual([
            { type: 'heading', level: 1, text: '登場人物' },
            { type: 'paragraph', text: '最初の行\n続きの行' },
            { type: 'bulletList', items: ['一つ目', '二つ目'] },
            { type: 'heading', level: 2, text: '次の章' },
            { type: 'paragraph', text: '最後の段落' },
        ]);
        expect(blockItemsToMarkdown(items)).toBe([
            '# 登場人物',
            '',
            '最初の行\n続きの行',
            '',
            '- 一つ目',
            '',
            '- 二つ目',
            '',
            '## 次の章',
            '',
            '最後の段落',
        ].join('\n'));
    });

    test('normalizes CRLF and trims line-end whitespace without changing paragraph indentation', () => {
        const items = markdownToBlockItems('\r\n### 見出し  \r\n  本文  \r\n  続き\r\n\r\n+ 項目  \r\n');

        expect(withoutIds(items)).toEqual([
            { type: 'heading', level: 3, text: '見出し' },
            { type: 'paragraph', text: '  本文\n  続き' },
            { type: 'bulletList', items: ['項目'] },
        ]);
        expect(blockItemsToMarkdown(items)).toBe('### 見出し\n\n  本文\n  続き\n\n- 項目');
    });

    test('keeps blank lines inside a consecutive list and supports all list markers', () => {
        const items = markdownToBlockItems('- one\n\n* two\n+ three');

        expect(withoutIds(items)).toEqual([
            { type: 'bulletList', items: ['one', 'two', 'three'] },
        ]);
    });

    test('does not treat marker-like text without required spaces as headings or lists', () => {
        const items = markdownToBlockItems('#no-heading\n-not-a-list\nplain text');

        expect(withoutIds(items)).toEqual([
            { type: 'paragraph', text: '#no-heading\n-not-a-list\nplain text' },
        ]);
    });

    test('returns an empty markdown string for empty items and empty input', () => {
        expect(markdownToBlockItems(' \n\r\n')).toEqual([]);
        expect(blockItemsToMarkdown([])).toBe('');
    });
});
