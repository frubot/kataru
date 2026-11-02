import { describe, expect, test } from 'vitest';

import { wrapNarrationForDialogue } from '../lib/narration';

describe('wrapNarrationForDialogue', () => {
    test('wraps narration in full-width parentheses', () => {
        expect(wrapNarrationForDialogue('  夕暮れの教室に風が吹き込む。\n')).toBe('（夕暮れの教室に風が吹き込む。）');
    });

    test('keeps multi-paragraph narration inside one pair', () => {
        expect(wrapNarrationForDialogue('雨が降り出した。\n\n誰も傘を持っていない。'))
            .toBe('（雨が降り出した。\n\n誰も傘を持っていない。）');
    });

    test('leaves empty content alone', () => {
        expect(wrapNarrationForDialogue('')).toBe('');
        expect(wrapNarrationForDialogue('  ')).toBe('  ');
    });

    test('does not double-wrap narration that is already parenthesized', () => {
        expect(wrapNarrationForDialogue('（静まり返った。）')).toBe('（静まり返った。）');
        expect(wrapNarrationForDialogue('(silence)')).toBe('(silence)');
    });
});
