import { describe, expect, test } from 'vitest';

import {
    markdownToSections,
    sectionsToMarkdown,
} from '../components/PromptSectionEditor';

type Sections = ReturnType<typeof markdownToSections>;

function withoutIds(sections: Sections) {
    return sections.map((section) => {
        const { id, ...withoutId } = section;
        void id;
        return withoutId;
    });
}

describe('markdownToSections and sectionsToMarkdown', () => {
    test('groups content under headings and round-trips', () => {
        const markdown = [
            '# 登場人物',
            '',
            '最初の行',
            '続きの行',
            '',
            '- 一つ目',
            '',
            '* 二つ目',
            '',
            '## 次の章',
            '',
            '最後の段落',
        ].join('\n');

        const sections = markdownToSections(markdown);

        expect(withoutIds(sections)).toEqual([
            { title: '登場人物', level: 1, body: '最初の行\n続きの行\n\n- 一つ目\n\n* 二つ目' },
            { title: '次の章', level: 2, body: '最後の段落' },
        ]);
        expect(sectionsToMarkdown(sections)).toBe(markdown);
    });

    test('keeps leading text without a heading as an untitled section', () => {
        const markdown = '前置きの説明\n\n## 名前\n\nタロウ';
        const sections = markdownToSections(markdown);

        expect(withoutIds(sections)).toEqual([
            { title: null, level: 2, body: '前置きの説明' },
            { title: '名前', level: 2, body: 'タロウ' },
        ]);
        expect(sectionsToMarkdown(sections)).toBe(markdown);
    });

    test('normalizes CRLF and trims line-end whitespace without changing body indentation', () => {
        const sections = markdownToSections('\r\n### 見出し  \r\n  本文  \r\n  続き\r\n');

        expect(withoutIds(sections)).toEqual([
            { title: '見出し', level: 3, body: '  本文\n  続き' },
        ]);
        expect(sectionsToMarkdown(sections)).toBe('### 見出し\n\n  本文\n  続き');
    });

    test('does not treat marker-like text without required spaces as headings', () => {
        const sections = markdownToSections('#no-heading\n-not-a-list\nplain text');

        expect(withoutIds(sections)).toEqual([
            { title: null, level: 2, body: '#no-heading\n-not-a-list\nplain text' },
        ]);
    });

    test('treats a bare heading marker as an empty-title section that round-trips', () => {
        const sections = markdownToSections('##\n\n本文');

        expect(withoutIds(sections)).toEqual([
            { title: '', level: 2, body: '本文' },
        ]);
        expect(sectionsToMarkdown(sections)).toBe('##\n\n本文');
    });

    test('keeps a titled section with an empty body and drops fully empty sections', () => {
        const sections = markdownToSections('## ラベルだけ');

        expect(withoutIds(sections)).toEqual([
            { title: 'ラベルだけ', level: 2, body: '' },
        ]);
        expect(sectionsToMarkdown(sections)).toBe('## ラベルだけ');
        expect(sectionsToMarkdown([{ id: 'x', title: '', level: 2, body: '  ' }])).toBe('');
        expect(sectionsToMarkdown([{ id: 'x', title: null, level: 2, body: '' }])).toBe('');
    });

    test('returns an empty markdown string for empty items and empty input', () => {
        expect(markdownToSections(' \n\r\n')).toEqual([]);
        expect(sectionsToMarkdown([])).toBe('');
    });
});
