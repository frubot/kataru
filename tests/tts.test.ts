import { describe, expect, test } from 'vitest';

import { buildSpeechSegments, buildSpeechText } from '../lib/tts';

describe('buildSpeechSegments', () => {
    test('drops action segments by default and keeps them as captions', () => {
        const segments = buildSpeechSegments('*彼は窓を開けた。*「暑いな」');
        expect(segments).toEqual([
            { text: '「暑いな」', kind: 'dialogue', caption: '彼は窓を開けた。' },
        ]);
    });

    test('speaks actions as narration when enabled and still captions dialogue', () => {
        const segments = buildSpeechSegments(
            '*彼は窓を開けた。*「暑いな」*風が吹き込む。*「涼しい」',
            true,
            true,
        );
        expect(segments).toEqual([
            { text: '彼は窓を開けた。', kind: 'narration' },
            { text: '「暑いな」', kind: 'dialogue', caption: '彼は窓を開けた。' },
            { text: '風が吹き込む。', kind: 'narration' },
            { text: '「涼しい」', kind: 'dialogue', caption: '風が吹き込む。' },
        ]);
    });

    test('produces narration segments for narration-only content', () => {
        const segments = buildSpeechSegments('*夜が更けていく。*', true, true);
        expect(segments).toEqual([
            { text: '夜が更けていく。', kind: 'narration' },
        ]);
    });

    test('strips markdown inside narration text', () => {
        const segments = buildSpeechSegments('*彼は __ゆっくり__ 頷いた。*', true, true);
        expect(segments).toEqual([
            { text: '彼は ゆっくり 頷いた。', kind: 'narration' },
        ]);
    });

    test('keeps narration out of captions for the narrator voice itself', () => {
        const segments = buildSpeechSegments('*息を吐く。*「行こう」', true, true);
        expect(segments[0]).toEqual({ text: '息を吐く。', kind: 'narration' });
        expect(segments[0].caption).toBeUndefined();
    });
});

describe('buildSpeechText', () => {
    test('returns empty for narration-only content when narration is off', () => {
        expect(buildSpeechText('*夜が更けていく。*')).toBe('');
    });

    test('includes narration text when enabled', () => {
        expect(buildSpeechText('*夜が更けていく。*', true)).toBe('夜が更けていく。');
    });
});
