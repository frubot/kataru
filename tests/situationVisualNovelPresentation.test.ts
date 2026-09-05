import { describe, expect, test } from 'vitest';
import type { Message, SituationPriorMessage } from '../lib/store';
import {
    advanceSituationVisualNovelPresentation,
    appendSituationVisualNovelItems,
    beginSituationVisualNovelResponse,
    buildSituationVisualNovelPriorItems,
    buildSituationVisualNovelPreviewItems,
    buildSituationVisualNovelRoomItems,
    completeSituationVisualNovelItem,
    createSituationVisualNovelPresentationState,
    finishSituationVisualNovelPreviewItems,
    getSituationVisualNovelResponseMessages,
    reconcileSituationVisualNovelPreviewItems,
    resolveSituationVisualNovelInitialCharacterId,
    syncSituationVisualNovelPreviewItems,
    syncSituationVisualNovelRoomItems,
    unlockSituationVisualNovelPresentation,
} from '../lib/situationVisualNovelPresentation';
import { VN_MESSAGE_PAGE_MAX_CHARS } from '../lib/visualNovelPresentation';

const priorMessages: SituationPriorMessage[] = [
    { id: 'prior-user-1', role: 'user', content: 'ここはどこ？' },
    { id: 'prior-assistant-1', role: 'assistant', actorId: 'actor-a', content: '放課後の教室だよ。' },
    { id: 'prior-user-2', role: 'user', content: 'そうなんだ。' },
];

function roomMessage(
    id: string,
    role: Message['role'],
    content: string,
    characterId?: string,
    expression?: string,
): Message {
    return {
        id,
        role,
        content,
        characterId,
        expression,
        timestamp: 1,
    };
}

describe('situation visual novel presentation', () => {
    test('isolates a continuation response without requiring a new user message', () => {
        const messages = [
            roomMessage('user-1', 'user', '今日は寒いね'),
            roomMessage('assistant-1', 'assistant', '雪になるかも', 'actor-a'),
            roomMessage('assistant-2', 'assistant', '窓を閉めよう', 'actor-a'),
        ];

        expect(getSituationVisualNovelResponseMessages(
            messages,
            ['user-1', 'assistant-1'],
        ).map((message) => message.id)).toEqual(['assistant-2']);
    });

    test('uses the first speaking actor as the initial character', () => {
        expect(resolveSituationVisualNovelInitialCharacterId(priorMessages, [
            { id: 'actor-b', expressions: [{ name: 'neutral', image: 'portrait-b' }] },
            { id: 'actor-a', expressions: [{ name: 'neutral', image: 'portrait-a' }] },
        ])).toBe('actor-a');
    });

    test('prefers an available portrait when the first speaking actor has none', () => {
        expect(resolveSituationVisualNovelInitialCharacterId(priorMessages, [
            { id: 'actor-a' },
            { id: 'actor-b', expressions: [{ name: 'neutral', image: 'portrait-b' }] },
        ])).toBe('actor-b');
    });

    test('uses the first participant with a portrait when the intro has no actor line', () => {
        expect(resolveSituationVisualNovelInitialCharacterId([
            { id: 'prior-user', role: 'user', content: 'こんにちは。' },
        ], [
            { id: 'actor-a' },
            { id: 'actor-b', expressions: [{ name: 'neutral', image: 'portrait-b' }] },
        ])).toBe('actor-b');
    });

    test('falls back to the first participant when nobody has a portrait', () => {
        expect(resolveSituationVisualNovelInitialCharacterId([], [
            { id: 'actor-a' },
            { id: 'actor-b' },
        ])).toBe('actor-a');
    });

    test('plays every prior message from the beginning and keeps the actor on protagonist lines', () => {
        const priorItems = buildSituationVisualNovelPriorItems(priorMessages);
        let state = createSituationVisualNovelPresentationState({
            hasRoomHistory: false,
            priorItems,
            roomItems: [],
            isLoading: false,
        });

        expect(state.current).toMatchObject({ role: 'user', content: 'ここはどこ？' });
        expect(state.pending).toHaveLength(2);
        expect(state.locked).toBe(true);
        expect(state.sceneCharacterId).toBeUndefined();

        state = completeSituationVisualNovelItem(state, state.current!.key);
        state = advanceSituationVisualNovelPresentation(state, false);
        expect(state.current).toMatchObject({ role: 'assistant', characterId: 'actor-a' });
        expect(state.sceneCharacterId).toBe('actor-a');

        state = completeSituationVisualNovelItem(state, state.current!.key);
        state = advanceSituationVisualNovelPresentation(state, false);
        expect(state.current).toMatchObject({ role: 'user', content: 'そうなんだ。' });
        expect(state.sceneCharacterId).toBe('actor-a');

        state = completeSituationVisualNovelItem(state, state.current!.key);
        state = unlockSituationVisualNovelPresentation(state, false);
        expect(state.locked).toBe(false);
    });

    test('hides a submitted protagonist line and presents all assistant turns in order', () => {
        let state = createSituationVisualNovelPresentationState({
            hasRoomHistory: false,
            priorItems: [],
            roomItems: [],
            isLoading: false,
        });
        const turnItems = buildSituationVisualNovelRoomItems([
            roomMessage('user-1', 'user', 'みんな、こんにちは。'),
            roomMessage('assistant-a', 'assistant', 'こんにちは！', 'actor-a', 'happy'),
            roomMessage('assistant-b', 'assistant', '待っていたよ。', 'actor-b', 'neutral'),
        ]);

        expect(turnItems.map((item) => item.id)).toEqual(['assistant-a', 'assistant-b']);

        state = beginSituationVisualNovelResponse(state);
        expect(state.current).toBeNull();
        expect(state.locked).toBe(true);

        state = appendSituationVisualNovelItems(state, turnItems);
        expect(state.current).toMatchObject({ id: 'assistant-a', role: 'assistant' });
        expect(state.pending.map((item) => item.id)).toEqual(['assistant-b']);

        state = completeSituationVisualNovelItem(state, state.current!.key);
        state = advanceSituationVisualNovelPresentation(state, true);
        expect(state.current?.id).toBe('assistant-b');
        expect(state.sceneCharacterId).toBe('actor-b');

        state = completeSituationVisualNovelItem(state, state.current!.key);
        state = unlockSituationVisualNovelPresentation(state, false);
        expect(state.locked).toBe(false);
    });

    test('queues completed long messages as sequential pages', () => {
        const content = 'あ'.repeat(VN_MESSAGE_PAGE_MAX_CHARS + 1);
        const items = buildSituationVisualNovelRoomItems([
            roomMessage('assistant-long', 'assistant', content, 'actor-a'),
        ]);

        expect(items).toHaveLength(2);
        expect(items.map((item) => item.key)).toEqual([
            'room:assistant-long',
            'room:assistant-long:page:1',
        ]);
        expect(items.map((item) => item.pageIndex)).toEqual([0, 1]);

        let state = createSituationVisualNovelPresentationState({
            hasRoomHistory: false,
            priorItems: [],
            roomItems: [],
            isLoading: true,
        });
        state = appendSituationVisualNovelItems(state, items);
        expect(state.current?.key).toBe('room:assistant-long');
        expect(state.pending.map((item) => item.key)).toEqual(['room:assistant-long:page:1']);

        state = completeSituationVisualNovelItem(state, state.current!.key);
        state = advanceSituationVisualNovelPresentation(state, false);
        expect(state.current?.key).toBe('room:assistant-long:page:1');
    });

    test('queues confirmed streaming pages before the turn is complete', () => {
        const content = 'あ'.repeat(VN_MESSAGE_PAGE_MAX_CHARS + 1);
        const partial = buildSituationVisualNovelPreviewItems('stream-job', [{
            turnIndex: 0,
            content,
            characterId: 'actor-a',
            complete: false,
        }]);
        const completed = buildSituationVisualNovelPreviewItems('stream-job', [{
            turnIndex: 0,
            content,
            characterId: 'actor-a',
            complete: true,
        }]);

        expect(partial).toHaveLength(2);
        expect(partial[0]).toMatchObject({
            content: 'あ'.repeat(VN_MESSAGE_PAGE_MAX_CHARS),
            streamingComplete: true,
        });
        expect(partial[1]).toMatchObject({ content: 'あ', streamingComplete: false });
        expect(completed).toHaveLength(2);
        expect(completed.map((item) => item.key)).toEqual([
            'preview:stream-job:0',
            'preview:stream-job:0:page:1',
        ]);

        let state = createSituationVisualNovelPresentationState({
            hasRoomHistory: false,
            priorItems: [],
            roomItems: [],
            isLoading: true,
        });
        state = appendSituationVisualNovelItems(state, partial);
        state = syncSituationVisualNovelPreviewItems(state, completed);

        expect(state.current).toMatchObject({
            key: 'preview:stream-job:0',
            content: completed[0].content,
        });
        expect(state.currentComplete).toBe(true);
        expect(state.pending.map((item) => item.key)).toEqual([
            'preview:stream-job:0:page:1',
        ]);
    });

    test('keeps the last read page visible while waiting for generated continuation', () => {
        const firstPageContent = `${'あ'.repeat(100)}。`;
        const first = buildSituationVisualNovelPreviewItems('stream-job', [{
            turnIndex: 0,
            content: firstPageContent,
            characterId: 'actor-a',
            complete: false,
        }]);
        let state = createSituationVisualNovelPresentationState({
            hasRoomHistory: false,
            priorItems: [],
            roomItems: [],
            isLoading: true,
        });
        state = appendSituationVisualNovelItems(state, first);
        state = advanceSituationVisualNovelPresentation(state, true);

        expect(state.current?.content).toBe(firstPageContent);
        expect(state.waitingForNextPage).toBe(true);

        const extended = buildSituationVisualNovelPreviewItems('stream-job', [{
            turnIndex: 0,
            content: `${firstPageContent}続き`,
            characterId: 'actor-a',
            complete: false,
        }]);
        state = appendSituationVisualNovelItems(state, extended.slice(1));
        state = syncSituationVisualNovelPreviewItems(state, extended);

        expect(state.current).toMatchObject({
            key: 'preview:stream-job:0:page:1',
            content: '続き',
        });
        expect(state.waitingForNextPage).toBe(false);
    });

    test('releases an unfinished preview cleanly when streaming stops', () => {
        const partial = buildSituationVisualNovelPreviewItems('stopped-job', [{
            turnIndex: 0,
            content: '生成途中',
            characterId: 'actor-a',
            complete: false,
        }]);
        let state = createSituationVisualNovelPresentationState({
            hasRoomHistory: false,
            priorItems: [],
            roomItems: [],
            isLoading: true,
        });
        state = appendSituationVisualNovelItems(state, partial);
        state = finishSituationVisualNovelPreviewItems(state);
        state = unlockSituationVisualNovelPresentation(state, false);

        expect(state.current).toMatchObject({ content: '生成途中', streamingComplete: true });
        expect(state.currentComplete).toBe(true);
        expect(state.locked).toBe(false);
    });

    test.each(['emphasis', 'quotation'] as const)(
        'preserves the current and unread pages through %s completion and persistence',
        (kind) => {
            const raw = kind === 'emphasis'
                ? `${'あ'.repeat(150)}*${'動'.repeat(10)}`
                : `「${'あ'.repeat(159)}境${'い'.repeat(20)}」`;
            const final = kind === 'emphasis'
                ? `${raw}*`
                : `${'あ'.repeat(159)}境${'い'.repeat(20)}`;
            const expectedLastPage = kind === 'emphasis'
                ? `*${'動'.repeat(10)}*`
                : `境${'い'.repeat(20)}`;
            const before = buildSituationVisualNovelPreviewItems('job', [{
                turnIndex: 0, characterId: 'actor-a', content: raw, complete: false,
            }]);
            const after = buildSituationVisualNovelPreviewItems('job', [{
                turnIndex: 0, characterId: 'actor-a', content: final, complete: true,
            }], before);
            const messages = [roomMessage('saved', 'assistant', final, 'actor-a')];
            const roomItems = buildSituationVisualNovelRoomItems(messages, after);
            const replacements = new Map(after.map((item, index) => [item.key, roomItems[index]]));

            // Exercise readers both ahead of and behind the generator.
            for (const readAhead of [false, true]) {
                let state = createSituationVisualNovelPresentationState({
                    hasRoomHistory: true, priorItems: [], roomItems: [], isLoading: true,
                });
                state = appendSituationVisualNovelItems(state, before);
                if (readAhead) state = advanceSituationVisualNovelPresentation(state, true);
                state = syncSituationVisualNovelPreviewItems(state, after);
                state = reconcileSituationVisualNovelPreviewItems(state, replacements);
                if (!readAhead) state = advanceSituationVisualNovelPresentation(state, false);
                state = completeSituationVisualNovelItem(state, state.current!.key);
                state = unlockSituationVisualNovelPresentation(state, false);
                state = syncSituationVisualNovelRoomItems(state, {
                    hasRoomHistory: true, priorItems: [], roomItems, isLoading: false,
                });
                expect(state.current?.content).toBe(expectedLastPage);
                expect(state.current?.source).toBe('room');
                expect(state.pending).toEqual([]);
                expect(state.locked).toBe(false);
            }
            expect(roomItems.map((item) => item.content).join('')).toBe(final);
        },
    );

    test('keeps each actor’s streamed boundaries associated with their saved response', () => {
        const opening = roomMessage('old', 'assistant', '以前の発言', 'actor-a');
        const raw = `「${'あ'.repeat(159)}境${'い'.repeat(20)}」`;
        const before = buildSituationVisualNovelPreviewItems('group-job', [{
            turnIndex: 0, characterId: 'actor-a', content: raw, complete: false,
        }]);
        const content = raw.slice(1, -1);
        const after = buildSituationVisualNovelPreviewItems('group-job', [
            { turnIndex: 0, characterId: 'actor-a', content, complete: true },
            { turnIndex: 1, characterId: 'actor-b', content: '次の話者', complete: true },
        ], before);
        const response = [
            roomMessage('a', 'assistant', content, 'actor-a'),
            roomMessage('b', 'assistant', '次の話者', 'actor-b'),
        ];
        const items = buildSituationVisualNovelRoomItems([opening, ...response], after, response);
        expect(items.map((item) => [item.id, item.content])).toEqual([
            ['old', '以前の発言'], ['a', 'あ'.repeat(159)],
            ['a', `境${'い'.repeat(20)}`], ['b', '次の話者'],
        ]);
    });

    test('opens existing conversations on the latest message without replaying history', () => {
        const roomItems = buildSituationVisualNovelRoomItems([
            roomMessage('user-1', 'user', '最初の発言'),
            roomMessage('assistant-1', 'assistant', '返答', 'actor-a', 'happy'),
            roomMessage('user-2', 'user', '最後の発言'),
        ]);
        const state = createSituationVisualNovelPresentationState({
            hasRoomHistory: true,
            priorItems: buildSituationVisualNovelPriorItems(priorMessages),
            roomItems,
            isLoading: false,
        });

        expect(state.current).toMatchObject({ id: 'assistant-1', role: 'assistant' });
        expect(state.pending).toEqual([]);
        expect(state.locked).toBe(false);
        expect(state.animateCurrent).toBe(false);
        expect(state.sceneCharacterId).toBe('actor-a');
        expect(state.sceneExpression).toBe('happy');
    });

    test('updates streamed actor turns in place and reconciles them with persisted messages', () => {
        let state = createSituationVisualNovelPresentationState({
            hasRoomHistory: true,
            priorItems: [],
            roomItems: [roomMessage('user-1', 'user', '話してみて。')].flatMap((message) =>
                buildSituationVisualNovelRoomItems([message])
            ),
            isLoading: true,
        });
        state = advanceSituationVisualNovelPresentation(state, true);

        const partial = buildSituationVisualNovelPreviewItems('job-1', [{
            turnIndex: 0,
            content: 'こん',
            characterId: 'actor-a',
            characterName: 'A',
            complete: false,
        }]);
        state = appendSituationVisualNovelItems(state, partial);
        expect(state.current).toMatchObject({ source: 'preview', content: 'こん' });
        expect(state.currentComplete).toBe(false);

        const completed = buildSituationVisualNovelPreviewItems('job-1', [{
            turnIndex: 0,
            content: 'こんにちは',
            characterId: 'actor-a',
            characterName: 'A',
            expression: 'happy',
            complete: true,
        }]);
        state = syncSituationVisualNovelPreviewItems(state, completed);
        expect(state.current).toMatchObject({ content: 'こんにちは', expression: 'happy' });
        expect(state.currentComplete).toBe(true);
        expect(state.sceneCharacterId).toBe('actor-a');

        const persisted = buildSituationVisualNovelRoomItems([
            roomMessage('assistant-a', 'assistant', 'こんにちは', 'actor-a', 'happy'),
        ])[0];
        state = reconcileSituationVisualNovelPreviewItems(
            state,
            new Map([[completed[0].key, persisted]]),
        );
        expect(state.current).toMatchObject({
            source: 'room',
            id: 'assistant-a',
            content: 'こんにちは',
        });
    });

    test('shows the regenerated response instead of falling back one message', () => {
        const previousMessage = roomMessage(
            'assistant-previous',
            'assistant',
            '一つ前の返答',
            'actor-a',
        );
        const regeneratedMessage = roomMessage(
            'assistant-regenerated',
            'assistant',
            '再生成対象の返答',
            'actor-b',
        );
        let state = createSituationVisualNovelPresentationState({
            hasRoomHistory: true,
            priorItems: [],
            roomItems: buildSituationVisualNovelRoomItems([
                previousMessage,
                regeneratedMessage,
            ]),
            isLoading: false,
        });

        state = syncSituationVisualNovelRoomItems(state, {
            hasRoomHistory: true,
            priorItems: [],
            roomItems: buildSituationVisualNovelRoomItems([previousMessage]),
            isLoading: true,
        });

        expect(state.current).toBeNull();
        expect(state.locked).toBe(true);

        const preview = buildSituationVisualNovelPreviewItems('regeneration-job', [{
            turnIndex: 0,
            content: '新しい返答',
            characterId: 'actor-b',
            characterName: 'B',
            complete: false,
        }]);
        state = appendSituationVisualNovelItems(state, preview);

        expect(state.current).toMatchObject({
            source: 'preview',
            content: '新しい返答',
        });
        expect(state.pending).toEqual([]);
    });
});
