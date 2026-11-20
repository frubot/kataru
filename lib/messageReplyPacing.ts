/**
 * メッセージモードの返信を、人がスマホで打っているような間で表示するための計算。
 *
 * 生成の速さとは切り離し、次の順で見せる。
 * 1. 返信の生成が始まってから少し置いて「既読」を付ける。
 * 2. さらに少し置いて「入力中…」を出す。
 * 3. 吹き出しは文字数に応じた打鍵時間ぶん待ってから1つずつ出す。
 *    出した直後は「入力中…」をいったん消し、次を打ち始めたように見せる。
 *
 * 返信の生成中に見え始めた吹き出しだけを対象にし、履歴の読み込みや部屋の
 * 切り替えで既にある吹き出しはすぐに表示する。
 */

/** 生成開始から「既読」を付けるまで（ミリ秒）。 */
export const REPLY_READ_DELAY_RANGE_MS = [600, 1600] as const;
/** 「既読」から「入力中…」を出すまで（ミリ秒）。 */
export const REPLY_TYPING_START_DELAY_RANGE_MS = [500, 1400] as const;
/** 吹き出しを出してから、次の「入力中…」を出すまでの間（ミリ秒）。 */
export const REPLY_BUBBLE_GAP_MS = 350;

const TYPING_BASE_MS = 300;
const TYPING_PER_CHARACTER_MS = 70;
const TYPING_MIN_MS = 700;
const TYPING_MAX_MS = 3500;

/** 吹き出し1つを打つのにかかったことにする時間。 */
export function replyTypingDurationMs(length: number): number {
    const characters = Number.isFinite(length) ? Math.max(0, length) : 0;
    const duration = TYPING_BASE_MS + characters * TYPING_PER_CHARACTER_MS;
    return Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, duration));
}

export type ReplyPacingState = {
    /** 返信のまとまりを識別するキー。部屋と最新のユーザー発言で決まる。 */
    epochKey: string;
    /** 返信の生成を見ていて、吹き出しの表示を待たせている状態か。 */
    armed: boolean;
    readAt: number;
    typingAt: number;
    revealedCount: number;
    /** 最後に吹き出しを出した時刻。まだ出していなければ0。 */
    lastRevealAt: number;
};

export type ReplyPacingInput = {
    epochKey: string;
    /** 今回の返信として表示できる吹き出しの文字数（表示順）。 */
    bubbleLengths: readonly number[];
    isLoading: boolean;
};

export type ReplyPacingView = {
    epochKey: string;
    revealedCount: number;
    /** 末尾のユーザー発言に「既読」を付けてよいか。 */
    readVisible: boolean;
    /** 「入力中…」を出すか。 */
    typingVisible: boolean;
    /** まだ出していない吹き出しがあるか。 */
    holding: boolean;
};

function randomBetween([min, max]: readonly [number, number], random: () => number): number {
    return Math.round(min + (max - min) * random());
}

function nextRevealAt(state: ReplyPacingState, bubbleLengths: readonly number[]): number {
    const base = state.lastRevealAt === 0
        ? state.typingAt
        : state.lastRevealAt + REPLY_BUBBLE_GAP_MS;
    return base + replyTypingDurationMs(bubbleLengths[state.revealedCount] ?? 0);
}

/**
 * 現在時刻まで状態を進め、次に見た目が変わる時刻（`wakeAt`）を返す。
 * 変わる予定が無ければ `wakeAt` は null。
 */
export function stepReplyPacing(
    previous: ReplyPacingState | null,
    { epochKey, bubbleLengths, isLoading }: ReplyPacingInput,
    now: number,
    random: () => number = Math.random,
): { state: ReplyPacingState; wakeAt: number | null } {
    const count = bubbleLengths.length;
    let state: ReplyPacingState = previous && previous.epochKey === epochKey
        ? { ...previous }
        : {
            epochKey,
            armed: false,
            readAt: 0,
            typingAt: 0,
            revealedCount: count,
            lastRevealAt: 0,
        };

    if (!state.armed && isLoading) {
        const readAt = now + randomBetween(REPLY_READ_DELAY_RANGE_MS, random);
        state = {
            ...state,
            armed: true,
            readAt,
            typingAt: readAt + randomBetween(REPLY_TYPING_START_DELAY_RANGE_MS, random),
            revealedCount: Math.min(state.revealedCount, count),
            lastRevealAt: 0,
        };
    }

    if (!state.armed) {
        return { state: { ...state, revealedCount: count }, wakeAt: null };
    }

    // 再生成などで吹き出しが減ったら、出した数もそれに合わせる。
    if (state.revealedCount > count) state.revealedCount = count;

    if (state.revealedCount < count && now >= nextRevealAt(state, bubbleLengths)) {
        state.revealedCount += 1;
        state.lastRevealAt = now;
    }

    if (!isLoading && state.revealedCount >= count) {
        return {
            state: { ...state, armed: false, revealedCount: count },
            wakeAt: null,
        };
    }

    const upcoming = [
        state.readAt,
        state.typingAt,
        state.lastRevealAt === 0 ? 0 : state.lastRevealAt + REPLY_BUBBLE_GAP_MS,
        state.revealedCount < count ? nextRevealAt(state, bubbleLengths) : 0,
    ].filter((time) => time > now);
    return {
        state,
        wakeAt: upcoming.length > 0 ? Math.min(...upcoming) : null,
    };
}

export function describeReplyPacing(
    state: ReplyPacingState | null,
    { epochKey, bubbleLengths, isLoading }: ReplyPacingInput,
    now: number,
): ReplyPacingView {
    const count = bubbleLengths.length;
    if (!state || state.epochKey !== epochKey || !state.armed) {
        return {
            epochKey,
            revealedCount: count,
            readVisible: true,
            typingVisible: false,
            holding: false,
        };
    }
    const revealedCount = Math.min(state.revealedCount, count);
    const holding = revealedCount < count;
    const pausedAfterBubble = state.lastRevealAt !== 0
        && now < state.lastRevealAt + REPLY_BUBBLE_GAP_MS;
    return {
        epochKey,
        revealedCount,
        readVisible: now >= state.readAt,
        typingVisible: now >= state.typingAt && !pausedAfterBubble && (holding || isLoading),
        holding,
    };
}
