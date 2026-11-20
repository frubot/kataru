import { describe, expect, test } from 'vitest';

import {
    describeReplyPacing,
    REPLY_BUBBLE_GAP_MS,
    REPLY_READ_DELAY_RANGE_MS,
    REPLY_TYPING_START_DELAY_RANGE_MS,
    replyTypingDurationMs,
    stepReplyPacing,
    type ReplyPacingInput,
    type ReplyPacingState,
} from '../lib/messageReplyPacing';

/** 乱数を0に固定し、待ち時間を各範囲の最小値にする。 */
const minRandom = () => 0;
const READ_MS = REPLY_READ_DELAY_RANGE_MS[0];
const TYPING_START_MS = READ_MS + REPLY_TYPING_START_DELAY_RANGE_MS[0];

function run(
    state: ReplyPacingState | null,
    input: ReplyPacingInput,
    now: number,
) {
    const step = stepReplyPacing(state, input, now, minRandom);
    return { ...step, view: describeReplyPacing(step.state, input, now) };
}

describe('replyTypingDurationMs', () => {
    test('grows with length within bounds', () => {
        expect(replyTypingDurationMs(0)).toBe(700);
        expect(replyTypingDurationMs(20)).toBe(1700);
        expect(replyTypingDurationMs(1000)).toBe(3500);
        expect(replyTypingDurationMs(Number.NaN)).toBe(700);
    });
});

describe('stepReplyPacing', () => {
    test('shows existing bubbles immediately when no reply is being generated', () => {
        const { state, wakeAt, view } = run(null, { epochKey: 'r:u1', bubbleLengths: [5, 5], isLoading: false }, 1000);
        expect(state.armed).toBe(false);
        expect(wakeAt).toBeNull();
        expect(view).toMatchObject({ revealedCount: 2, readVisible: true, typingVisible: false, holding: false });

        // 履歴の読み込みで増えた吹き出しも待たせない。
        const loaded = run(state, { epochKey: 'r:u1', bubbleLengths: [5, 5, 5], isLoading: false }, 1100);
        expect(loaded.view.revealedCount).toBe(3);
    });

    test('delays the read receipt and typing indicator after generation starts', () => {
        const idle = run(null, { epochKey: 'r:u1', bubbleLengths: [], isLoading: false }, 0).state;
        const started = run(idle, { epochKey: 'r:u1', bubbleLengths: [], isLoading: true }, 1000);
        expect(started.view).toMatchObject({ readVisible: false, typingVisible: false });
        expect(started.wakeAt).toBe(1000 + READ_MS);

        const read = run(started.state, { epochKey: 'r:u1', bubbleLengths: [], isLoading: true }, 1000 + READ_MS);
        expect(read.view).toMatchObject({ readVisible: true, typingVisible: false });
        expect(read.wakeAt).toBe(1000 + TYPING_START_MS);

        const typing = run(read.state, { epochKey: 'r:u1', bubbleLengths: [], isLoading: true }, 1000 + TYPING_START_MS);
        expect(typing.view).toMatchObject({ readVisible: true, typingVisible: true });
    });

    test('reveals bubbles one by one at typing speed even after generation finished', () => {
        const start = 1000;
        const typingAt = start + TYPING_START_MS;
        let state = run(null, { epochKey: 'r:u1', bubbleLengths: [], isLoading: false }, 0).state;
        state = run(state, { epochKey: 'r:u1', bubbleLengths: [], isLoading: true }, start).state;

        // 生成は打鍵より速く終わり、3つの吹き出しが一度に揃う。
        const done: ReplyPacingInput = { epochKey: 'r:u1', bubbleLengths: [10, 0, 20], isLoading: false };
        const arrived = run(state, done, start + 200);
        expect(arrived.view).toMatchObject({ revealedCount: 0, holding: true });

        const firstAt = typingAt + replyTypingDurationMs(10);
        const first = run(arrived.state, done, firstAt);
        expect(first.view).toMatchObject({ revealedCount: 1, holding: true, typingVisible: false });
        expect(first.wakeAt).toBe(firstAt + REPLY_BUBBLE_GAP_MS);

        const resumed = run(first.state, done, firstAt + REPLY_BUBBLE_GAP_MS);
        expect(resumed.view).toMatchObject({ revealedCount: 1, typingVisible: true });

        const secondAt = firstAt + REPLY_BUBBLE_GAP_MS + replyTypingDurationMs(0);
        const second = run(resumed.state, done, secondAt);
        expect(second.view.revealedCount).toBe(2);

        const thirdAt = secondAt + REPLY_BUBBLE_GAP_MS + replyTypingDurationMs(20);
        const early = run(second.state, done, thirdAt - 1);
        expect(early.view.revealedCount).toBe(2);
        const third = run(early.state, done, thirdAt);
        expect(third.view).toMatchObject({ revealedCount: 3, holding: false, typingVisible: false, readVisible: true });
        expect(third.state.armed).toBe(false);
        expect(third.wakeAt).toBeNull();
    });

    test('shows a bubble as soon as it arrives when generation was slower than typing', () => {
        let state = run(null, { epochKey: 'r:u1', bubbleLengths: [], isLoading: false }, 0).state;
        state = run(state, { epochKey: 'r:u1', bubbleLengths: [], isLoading: true }, 1000).state;
        const late = run(state, { epochKey: 'r:u1', bubbleLengths: [10], isLoading: true }, 20_000);
        expect(late.view.revealedCount).toBe(1);
    });

    test('a new user message starts a fresh reply', () => {
        let state = run(null, { epochKey: 'r:u1', bubbleLengths: [], isLoading: false }, 0).state;
        state = run(state, { epochKey: 'r:u1', bubbleLengths: [5, 5], isLoading: true }, 1000).state;
        expect(describeReplyPacing(state, { epochKey: 'r:u1', bubbleLengths: [5, 5], isLoading: true }, 1000).holding)
            .toBe(true);

        // 送信で返信のまとまりが変わると、待たせていた吹き出しは対象から外れる。
        const next = run(state, { epochKey: 'r:u2', bubbleLengths: [], isLoading: false }, 1100);
        expect(next.state.armed).toBe(false);
        expect(next.view).toMatchObject({ revealedCount: 0, readVisible: true, holding: false });
    });

    test('clamps revealed bubbles when a regeneration removes them', () => {
        let state = run(null, { epochKey: 'r:u1', bubbleLengths: [5, 5], isLoading: false }, 0).state;
        const regenerating = run(state, { epochKey: 'r:u1', bubbleLengths: [], isLoading: true }, 1000);
        state = regenerating.state;
        expect(state.revealedCount).toBe(0);

        const arrived = run(state, { epochKey: 'r:u1', bubbleLengths: [5], isLoading: true }, 1100);
        expect(arrived.view).toMatchObject({ revealedCount: 0, holding: true });
    });

    test('describe ignores state from another reply', () => {
        const state = run(null, { epochKey: 'r:u1', bubbleLengths: [], isLoading: true }, 0).state;
        const view = describeReplyPacing(state, { epochKey: 'r:u2', bubbleLengths: [3], isLoading: false }, 10);
        expect(view).toMatchObject({ epochKey: 'r:u2', revealedCount: 1, readVisible: true, holding: false });
    });
});
