import { describe, expect, test } from 'vitest';

import { formatAssistantMarkdown, splitAssistantMarkdownActions } from '../lib/markdownUtils';

describe('splitAssistantMarkdownActions', () => {
    test('merges adjacent actions separated by a space into one action', () => {
        expect(splitAssistantMarkdownActions('*彼は頷いた。* *微笑んだ。*')).toEqual([
            { type: 'action', content: '彼は頷いた。 微笑んだ。' },
        ]);
    });

    test('merges chains of adjacent actions', () => {
        expect(splitAssistantMarkdownActions('*A* *B* *C*')).toEqual([
            { type: 'action', content: 'A B C' },
        ]);
    });

    test('merges actions separated by full-width space', () => {
        expect(splitAssistantMarkdownActions('*A*　*B*')).toEqual([
            { type: 'action', content: 'A　B' },
        ]);
    });

    test('merges actions across newlines keeping the separator', () => {
        expect(splitAssistantMarkdownActions('*A*\n\n*B*')).toEqual([
            { type: 'action', content: 'A\n\nB' },
        ]);
    });

    test('does not merge actions separated by text', () => {
        expect(splitAssistantMarkdownActions('*A* text *B*')).toEqual([
            { type: 'action', content: 'A' },
            { type: 'text', content: 'text' },
            { type: 'action', content: 'B' },
        ]);
    });

    test('does not merge into bold markers', () => {
        expect(splitAssistantMarkdownActions('*A* **B**')).toEqual([
            { type: 'action', content: 'A' },
            { type: 'text', content: '**B**' },
        ]);
    });

    test('keeps unclosed markers as text after a merged run', () => {
        expect(splitAssistantMarkdownActions('*A* *B* and *unclosed')).toEqual([
            { type: 'action', content: 'A B' },
            { type: 'text', content: 'and *unclosed' },
        ]);
    });

    test('merges runs between surrounding text', () => {
        expect(splitAssistantMarkdownActions('say *A* *B* end')).toEqual([
            { type: 'text', content: 'say' },
            { type: 'action', content: 'A B' },
            { type: 'text', content: 'end' },
        ]);
    });
});

describe('formatAssistantMarkdown', () => {
    test('merges adjacent italics before paragraph wrapping', () => {
        expect(formatAssistantMarkdown('*A* *B*')).toBe('*A B*');
    });

    test('merges italics across blank lines into one italic', () => {
        expect(formatAssistantMarkdown('*A*\n\n*B*')).toBe('*A B*');
    });

    test('keeps bold markers after an action untouched', () => {
        expect(formatAssistantMarkdown('*A* **B**')).toBe('*A*\n\n**B**');
    });
});
