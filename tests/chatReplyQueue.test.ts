import { afterEach, describe, expect, test, vi } from 'vitest';

import * as db from '../lib/db';
import {
    clearPendingReplyMarker,
    collectRetainedPreviewBubbles,
    getPendingReplyMarker,
    getReadUserMessageIds,
    getTrailingUserMessageIds,
    getUserMessageRunRange,
    hasUnansweredUserMessages,
    REPLY_TYPING_GRACE_MS,
    replyDelayMilliseconds,
    resolvePendingReplyWaitMs,
    savePendingReplyMarker,
} from '../lib/chatReplyQueue';
import {
    DEFAULT_REPLY_DELAY_SECONDS,
    MAX_REPLY_DELAY_SECONDS,
    normalizeReplyDelaySeconds,
} from '../lib/store/settings';

const metaStore = new Map<string, unknown>();

afterEach(() => {
    vi.restoreAllMocks();
    metaStore.clear();
});

function mockMetaStorage() {
    vi.spyOn(db, 'getMeta').mockImplementation(async (key) => metaStore.get(key) as never);
    vi.spyOn(db, 'setMeta').mockImplementation(async (key, value) => {
        metaStore.set(key, value);
    });
}

const user = (id: string, archived = false) => ({ id, role: 'user' as const, archived });
const assistant = (id: string) => ({ id, role: 'assistant' as const });

describe('reply delay setting', () => {
    test('clamps the delay to half-second steps within the allowed range', () => {
        expect(normalizeReplyDelaySeconds(2.26)).toBe(2.5);
        expect(normalizeReplyDelaySeconds(-1)).toBe(0);
        expect(normalizeReplyDelaySeconds(MAX_REPLY_DELAY_SECONDS + 10)).toBe(MAX_REPLY_DELAY_SECONDS);
        expect(normalizeReplyDelaySeconds('3')).toBe(DEFAULT_REPLY_DELAY_SECONDS);
        expect(normalizeReplyDelaySeconds(Number.NaN)).toBe(DEFAULT_REPLY_DELAY_SECONDS);
    });

    test('treats zero or invalid seconds as an immediate reply', () => {
        expect(replyDelayMilliseconds(0)).toBe(0);
        expect(replyDelayMilliseconds(-2)).toBe(0);
        expect(replyDelayMilliseconds(Number.NaN)).toBe(0);
        expect(replyDelayMilliseconds(1.5)).toBe(1500);
    });
});

describe('consecutive user messages', () => {
    test('collects the unanswered trailing user messages in order', () => {
        const messages = [user('u1'), assistant('a1'), user('u2'), user('u3')];
        expect(getTrailingUserMessageIds(messages)).toEqual(['u2', 'u3']);
        expect(hasUnansweredUserMessages(messages)).toBe(true);
    });

    test('has no unanswered messages after a reply', () => {
        const messages = [user('u1'), user('u2'), assistant('a1')];
        expect(getTrailingUserMessageIds(messages)).toEqual([]);
        expect(hasUnansweredUserMessages(messages)).toBe(false);
        expect(hasUnansweredUserMessages([])).toBe(false);
    });

    test('stops at archived messages', () => {
        expect(getTrailingUserMessageIds([user('u1', true), user('u2')])).toEqual(['u2']);
    });

    test('finds the run of consecutive user messages around an index', () => {
        const messages = [user('u1'), assistant('a1'), user('u2'), user('u3'), user('u4'), assistant('a2')];
        expect(getUserMessageRunRange(messages, 3)).toEqual({ start: 2, end: 5 });
        expect(getUserMessageRunRange(messages, 0)).toEqual({ start: 0, end: 1 });
        expect(getUserMessageRunRange(messages, 1)).toBeNull();
        expect(getUserMessageRunRange(messages, 10)).toBeNull();
    });

    test('keeps answered messages read and marks unanswered ones once reading starts', () => {
        const messages = [user('u1'), user('u2'), assistant('a1'), user('u3'), user('u4')];
        // 返信を受けた u1・u2 は記録が無くても（リロード後でも）既読のまま。
        const read = getReadUserMessageIds(messages, new Set(['u3']));
        expect([...read].sort()).toEqual(['u1', 'u2', 'u3']);
        expect([...getReadUserMessageIds(messages, new Set())].sort()).toEqual(['u1', 'u2']);
    });
});

describe('pending reply wait time', () => {
    test('waits the configured delay only while the next message is being typed', () => {
        expect(resolvePendingReplyWaitMs(10_000, true)).toBe(10_000);
        expect(resolvePendingReplyWaitMs(10_000, false)).toBe(REPLY_TYPING_GRACE_MS);
    });

    test('never waits longer than a short configured delay', () => {
        expect(resolvePendingReplyWaitMs(500, false)).toBe(500);
        expect(resolvePendingReplyWaitMs(500, true)).toBe(500);
    });

    test('replies immediately without a grace period when the delay is zero', () => {
        expect(resolvePendingReplyWaitMs(0, false)).toBe(0);
        expect(resolvePendingReplyWaitMs(0, true)).toBe(0);
        expect(resolvePendingReplyWaitMs(Number.NaN, true)).toBe(0);
    });
});

describe('retained preview bubbles on interruption', () => {
    test('keeps confirmed message-mode bubbles and drops the bubble still being written', () => {
        const bubbles = collectRetainedPreviewBubbles({
            content: 'おはよう\n\n今日は',
            characterId: 'rin',
            turns: [{
                turnIndex: 0,
                content: 'おはよう\n\n今日は',
                characterId: 'rin',
                confirmedMessages: ['おはよう'],
                complete: false,
            }],
        }, true);
        expect(bubbles).toEqual([{ content: 'おはよう', characterId: 'rin' }]);
    });

    test('keeps completed ensemble turns and confirmed bubbles of the current turn', () => {
        const bubbles = collectRetainedPreviewBubbles({
            content: '',
            turns: [
                { turnIndex: 0, content: 'A1\n\nA2', characterId: 'a', formattedMessages: ['A1', 'A2'], complete: true },
                { turnIndex: 1, content: 'B1 書きかけ', characterId: 'b', confirmedMessages: ['B1'], complete: false },
            ],
        }, true);
        expect(bubbles).toEqual([
            { content: 'A1', characterId: 'a' },
            { content: 'A2', characterId: 'a' },
            { content: 'B1', characterId: 'b' },
        ]);
    });

    test('drops a partially streamed basic-mode reply', () => {
        expect(collectRetainedPreviewBubbles({
            content: '書きかけの返信',
            characterId: 'rin',
            turns: [{ turnIndex: 0, content: '書きかけの返信', characterId: 'rin', complete: false }],
        }, false)).toEqual([]);
        expect(collectRetainedPreviewBubbles(null, true)).toEqual([]);
    });
});

describe('pending reply markers', () => {
    test('persists a marker per room until it is cleared', async () => {
        mockMetaStorage();
        await savePendingReplyMarker('room-1', 100);
        await savePendingReplyMarker('room-2', 200);
        // 既にある印は上書きしない。
        await savePendingReplyMarker('room-1', 300);

        expect(await getPendingReplyMarker('room-1')).toEqual({ roomId: 'room-1', createdAt: 100 });
        await clearPendingReplyMarker('room-1');
        expect(await getPendingReplyMarker('room-1')).toBeUndefined();
        expect(await getPendingReplyMarker('room-2')).toEqual({ roomId: 'room-2', createdAt: 200 });
    });
});
