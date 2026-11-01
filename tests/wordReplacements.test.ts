import { describe, expect, test } from 'vitest';

import {
    activeWordReplacements,
    MAX_WORD_REPLACEMENT_FROM_CHARS,
    MAX_WORD_REPLACEMENTS,
    normalizeWordReplacements,
} from '../lib/wordReplacements';

describe('normalizeWordReplacements', () => {
    test('keeps editing rows and drops invalid entries', () => {
        expect(normalizeWordReplacements([
            { from: '思わず', to: '' },
            { from: '', to: '' },
            'invalid',
            null,
            { from: 1, to: 'x' },
        ])).toEqual([
            { from: '思わず', to: '' },
            { from: '', to: '' },
            { from: '', to: 'x' },
        ]);
        expect(normalizeWordReplacements(undefined)).toEqual([]);
    });

    test('clips long values and the rule count', () => {
        const long = 'あ'.repeat(MAX_WORD_REPLACEMENT_FROM_CHARS + 10);
        expect(normalizeWordReplacements([{ from: long, to: '' }])[0].from).toHaveLength(MAX_WORD_REPLACEMENT_FROM_CHARS);
        const many = Array.from({ length: MAX_WORD_REPLACEMENTS + 5 }, (_, i) => ({ from: `w${i}`, to: '' }));
        expect(normalizeWordReplacements(many)).toHaveLength(MAX_WORD_REPLACEMENTS);
    });
});

describe('activeWordReplacements', () => {
    test('sends only rules with a banned word', () => {
        expect(activeWordReplacements([
            { from: 'ふふっ', to: 'えへへ' },
            { from: '  ', to: 'x' },
        ])).toEqual([{ from: 'ふふっ', to: 'えへへ' }]);
    });
});
