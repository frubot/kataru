import { describe, expect, test } from 'vitest';
import type { Character, Room } from '../lib/store';
import {
    buildVisualNovelTypingSegments,
    getVisualNovelCostumeOptions,
    getVisualNovelExpressionNames,
    getVisualNovelPreloadCandidates,
    getVisualNovelTypingDelay,
    getStreamingVisualNovelVisibleContent,
    resolveVisualNovelCostumeName,
    resolveVisualNovelExpressionImage,
    shouldTriggerVisualNovelBounce,
    splitStreamingVisualNovelMessage,
    updateStreamingVisualNovelPagination,
    splitVisualNovelMessage,
} from '../lib/visualNovelPresentation';

const character: Character = {
    id: 'character-1',
    name: 'Alice',
    systemPrompt: '',
    model: 'test',
    icon: 'icon.png',
    expressions: [
        { name: 'neutral', image: 'neutral.png' },
        { name: 'happy', image: 'happy.png' },
    ],
    costumes: [
        {
            name: 'uniform',
            image: 'uniform.png',
            expressions: [{ name: 'happy', image: 'uniform-happy.png' }],
        },
    ],
    createdAt: 0,
    updatedAt: 0,
};

const room = {
    id: 'room-1',
    characterId: character.id,
    name: 'Room',
    messages: [],
    costumeSelections: { [character.id]: 'uniform' },
    createdAt: 0,
    updatedAt: 0,
} satisfies Room;

describe('visual novel costume and expression presentation', () => {
    test('keeps only an existing selected costume', () => {
        expect(resolveVisualNovelCostumeName(room, character)).toBe('uniform');
        expect(resolveVisualNovelCostumeName({ ...room, costumeSelections: { [character.id]: 'missing' } }, character)).toBe('default');
    });

    test('uses a costume expression before the costume or character fallback', () => {
        expect(resolveVisualNovelExpressionImage(character, 'happy', 'uniform')).toBe('uniform-happy.png');
        expect(resolveVisualNovelExpressionImage(character, 'sad', 'uniform')).toBe('uniform.png');
        expect(resolveVisualNovelExpressionImage(character, 'happy')).toBe('happy.png');
        expect(resolveVisualNovelExpressionImage(character, 'missing')).toBe('neutral.png');
    });

    test('builds a default option alongside non-default costumes', () => {
        expect(getVisualNovelCostumeOptions(character)).toEqual([
            { name: 'default', image: 'neutral.png', expressionCount: 2 },
            { name: 'uniform', image: 'uniform.png', expressionCount: 1 },
        ]);
    });

    test('lists only the expressions available for the selected costume', () => {
        expect(getVisualNovelExpressionNames(character)).toEqual(['neutral', 'happy']);
        expect(getVisualNovelExpressionNames({
            ...character,
            costumes: [{
                name: 'uniform',
                image: 'uniform.png',
                expressions: [{ name: 'wink', image: 'uniform-wink.png' }],
            }],
        }, 'uniform')).toEqual(['neutral', 'wink']);
    });

    test('prioritizes next expression variants and deduplicates the current image', () => {
        expect(getVisualNovelPreloadCandidates(character, 'uniform', 'uniform-happy.png')).toEqual([
            'uniform.png',
        ]);
        expect(getVisualNovelPreloadCandidates(character, 'default', 'neutral.png')).toEqual([
            'happy.png',
            'icon.png',
            'uniform.png',
        ]);
    });

    test('caps preload candidates without returning empty or duplicate sources', () => {
        const duplicated: Character = {
            ...character,
            expressions: [
                { name: 'neutral', image: 'same.png' },
                { name: 'happy', image: 'same.png' },
                { name: 'sad', image: 'sad.png' },
            ],
        };
        expect(getVisualNovelPreloadCandidates(duplicated, 'default', null, 2)).toEqual([
            'same.png',
            'sad.png',
        ]);
        expect(getVisualNovelPreloadCandidates(null)).toEqual([]);
    });
});

describe('visual novel typewriter presentation', () => {
    test('keeps italic actions and unicode code points intact', () => {
        expect(buildVisualNovelTypingSegments('A*微笑む*😊')).toEqual(['A', '*微笑む*', '😊']);
        expect(buildVisualNovelTypingSegments(String.raw`A\*B`)).toEqual(['A', '\\', '*', 'B']);
    });

    test('applies punctuation and speed delays', () => {
        expect(getVisualNovelTypingDelay('a', 'default')).toBe(24);
        expect(getVisualNovelTypingDelay('、', 'default')).toBe(70);
        expect(getVisualNovelTypingDelay('。', 'default')).toBe(160);
        expect(getVisualNovelTypingDelay('*action*', 'default')).toBe(90);
        expect(getVisualNovelTypingDelay('a', 'fast')).toBe(13);
        expect(getVisualNovelTypingDelay('a', 'slow')).toBe(37);
    });

    test('splits long messages at sentence boundaries', () => {
        expect(splitVisualNovelMessage(
            '最初の文です。次の文です。最後の文です。',
            8,
        )).toEqual([
            '最初の文です。',
            '次の文です。',
            '最後の文です。',
        ]);
    });

    test('keeps italic actions intact across pages', () => {
        const content = '12345*とても長い仕草*67890';
        const pages = splitVisualNovelMessage(content, 8);

        expect(pages.join('')).toBe(content);
        expect(pages.some((page) => page.includes('*とても長い仕草*'))).toBe(true);
    });

    test('keeps emitted streaming pages stable and holds an unfinished action together', () => {
        const first = splitStreamingVisualNovelMessage(`${'あ'.repeat(100)}。`, false, 160);
        const extended = splitStreamingVisualNovelMessage(
            `${'あ'.repeat(100)}。${'い'.repeat(70)}`,
            false,
            160,
        );
        const unfinishedAction = splitStreamingVisualNovelMessage(
            `${'あ'.repeat(100)}。*${'動'.repeat(180)}`,
            false,
            160,
        );

        expect(first).toMatchObject([{ content: `${'あ'.repeat(100)}。`, complete: false }]);
        expect(extended[0]).toEqual({ ...first[0], complete: true });
        expect(extended[1]).toMatchObject({ content: 'い'.repeat(70), complete: false });
        expect(unfinishedAction[1]).toMatchObject({
            content: `*${'動'.repeat(180)}`,
            complete: false,
        });
    });

    test('buffers a sentence and its closing quote across arbitrary chunks without moving visible text', () => {
        const first = '「今日はいい天気ですね。」';
        const second = 'せっかくなので公園まで歩いてみませんか。';
        const content = first + second;
        let previous: ReturnType<typeof updateStreamingVisualNovelPagination> | undefined;
        let visible: string[] = [];
        for (let end = 1; end <= content.length; end++) {
            const next = updateStreamingVisualNovelPagination(content.slice(0, end), false, previous, 24);
            const displayed = next.pages.map((page) => page.complete
                ? page.content : getStreamingVisualNovelVisibleContent(page.content));
            visible.forEach((text, index) => expect((displayed[index] ?? '').startsWith(text)).toBe(true));
            visible = displayed;
            previous = next;
        }
        const final = updateStreamingVisualNovelPagination(content, true, previous, 24);
        expect(final.pages.map((page) => page.content)).toEqual([first, second]);
        expect(getStreamingVisualNovelVisibleContent('「今日はいい天気ですね。')).toBe('');
        expect(getStreamingVisualNovelVisibleContent(first + 'せ')).toBe(first);
    });

    test('uses a comma to split an overlong sentence and keeps a quote at the page limit', () => {
        expect(splitStreamingVisualNovelMessage('あ'.repeat(12) + '、' + 'い'.repeat(12), true, 20)
            .map((page) => page.content)).toEqual(['あ'.repeat(12) + '、', 'い'.repeat(12)]);
        const quoted = '「' + 'あ'.repeat(18) + '。」';
        expect(splitStreamingVisualNovelMessage(quoted + '次', false, 20)[0].content).toBe(quoted);
    });

    test('retains a confirmed boundary when the closing emphasis marker arrives', () => {
        const partial = `${'あ'.repeat(150)}*${'動'.repeat(10)}`;
        const before = updateStreamingVisualNovelPagination(partial, false);
        const closed = updateStreamingVisualNovelPagination(`${partial}*`, false, before);
        const completed = updateStreamingVisualNovelPagination(`${partial}*`, true, closed);

        expect(before.pages[0].complete).toBe(true);
        expect(closed.pages[0]).toEqual(before.pages[0]);
        expect(completed.pages.map((page) => page.content)).toEqual([
            'あ'.repeat(150), `*${'動'.repeat(10)}*`,
        ]);
        expect(completed.pages.every((page) => page.complete)).toBe(true);
    });

    test('aligns confirmed boundaries through quotation and escaped-newline cleanup', () => {
        const raw = `「${'あ'.repeat(80)}\\n${'い'.repeat(78)}境${'う'.repeat(20)}」`;
        const before = updateStreamingVisualNovelPagination(raw, false);
        const content = `${'あ'.repeat(80)}\n${'い'.repeat(78)}境${'う'.repeat(20)}`;
        const after = updateStreamingVisualNovelPagination(content, true, before);

        expect(before.pages[0].complete).toBe(true);
        expect(after.pages[0].content).toBe(`${'あ'.repeat(80)}\n${'い'.repeat(77)}`);
        expect(after.pages[1].content).toBe(`い境${'う'.repeat(20)}`);
        expect(after.pages.map((page) => page.content).join('')).toBe(content);
    });
});

describe('visual novel character bounce', () => {
    test('runs when a new assistant message appears in the active conversation', () => {
        expect(shouldTriggerVisualNovelBounce(
            { contextKey: 'room-1:solo', messageKey: null },
            { contextKey: 'room-1:solo', messageKey: 'assistant-1' },
        )).toBe(true);
        expect(shouldTriggerVisualNovelBounce(
            { contextKey: 'room-1:solo', messageKey: 'assistant-1' },
            { contextKey: 'room-1:solo', messageKey: 'assistant-2' },
        )).toBe(true);
    });

    test('does not run for initial display, chat navigation, or returning from the log', () => {
        expect(shouldTriggerVisualNovelBounce(
            null,
            { contextKey: 'room-1:solo', messageKey: 'assistant-1' },
        )).toBe(false);
        expect(shouldTriggerVisualNovelBounce(
            { contextKey: 'room-1:solo', messageKey: 'assistant-1' },
            { contextKey: 'room-2:solo', messageKey: 'assistant-2' },
        )).toBe(false);
        expect(shouldTriggerVisualNovelBounce(
            { contextKey: null, messageKey: 'assistant-1' },
            { contextKey: 'room-1:solo', messageKey: 'assistant-1' },
        )).toBe(false);
    });

    test('does not run again when only the character image reloads', () => {
        const snapshot = { contextKey: 'room-1:solo', messageKey: 'assistant-1' };
        expect(shouldTriggerVisualNovelBounce(snapshot, snapshot)).toBe(false);
    });
});
