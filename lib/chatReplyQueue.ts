import * as db from './db';
import type { ChatStreamingPreview } from './chatMessagePresentation';

/**
 * メッセージ・ベーシックモードの「連投」を支える補助関数。
 *
 * 送信してもすぐには返信を生成せず、待ち時間のあいだに入力・送信が
 * なければ、末尾の連続するユーザー発言をまとめて1回の返信で読ませる。
 * 待ち時間はメモリ上のタイマーなので、リロードで消えないよう「返信待ち」
 * の印を永続化しておき、部屋を開き直したときに再開する。
 */

type ReplyQueueMessage = {
    id: string;
    role: 'user' | 'assistant';
    archived?: boolean;
};

/** 返信待ち時間（秒）をミリ秒へ変換する。不正な値は0（即時）として扱う。 */
export function replyDelayMilliseconds(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.round(seconds * 1000);
}

/**
 * 末尾の連続するユーザー発言（まだ返信を受けていない連投）のid。
 * 末尾がアシスタント発言なら空。
 */
export function getTrailingUserMessageIds(messages: readonly ReplyQueueMessage[]): string[] {
    const ids: string[] = [];
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.role !== 'user' || message.archived) break;
        ids.push(message.id);
    }
    return ids.reverse();
}

/** 末尾が返信待ちのユーザー発言か。 */
export function hasUnansweredUserMessages(messages: readonly ReplyQueueMessage[]): boolean {
    return getTrailingUserMessageIds(messages).length > 0;
}

/**
 * `index` のユーザー発言を含む連続したユーザー発言の範囲 [start, end)。
 * ユーザー発言でなければ null。
 */
export function getUserMessageRunRange(
    messages: readonly Pick<ReplyQueueMessage, 'role'>[],
    index: number,
): { start: number; end: number } | null {
    if (messages[index]?.role !== 'user') return null;
    let start = index;
    while (start > 0 && messages[start - 1].role === 'user') start -= 1;
    let end = index + 1;
    while (end < messages.length && messages[end].role === 'user') end += 1;
    return { start, end };
}

/**
 * 既読表示の対象となるユーザー発言のid。末尾の連投のうち、AIが読んだ
 * （そのメッセージを含む生成が始まった）ものだけを返す。
 */
export function getReadTrailingUserMessageIds(
    messages: readonly ReplyQueueMessage[],
    readMessageIds: ReadonlySet<string>,
): Set<string> {
    return new Set(getTrailingUserMessageIds(messages).filter((id) => readMessageIds.has(id)));
}

export type RetainedPreviewBubble = {
    content: string;
    characterId?: string;
};

/**
 * 割り込みで生成を止めるときに残す吹き出し。画面に確定済みとして見えて
 * いたものだけを返し、書きかけの本文は捨てる。
 *
 * - 完了したターンは整形済みの各メッセージ（無ければ本文）を残す。
 * - メッセージモードの未完了ターンは、閉じた吹き出し（confirmedMessages）だけを残す。
 * - それ以外の未完了ターン（ベーシックの逐次表示）は残さない。
 */
export function collectRetainedPreviewBubbles(
    preview: Pick<ChatStreamingPreview, 'content' | 'characterId' | 'turns'> | null | undefined,
    isMessageMode: boolean,
): RetainedPreviewBubble[] {
    if (!preview?.turns?.length) return [];
    const bubbles: RetainedPreviewBubble[] = [];
    for (const turn of preview.turns) {
        const characterId = turn.characterId ?? preview.characterId;
        const formatted = turn.formattedMessages?.filter((content) => content.trim()) ?? [];
        let contents: string[];
        if (turn.complete) {
            contents = formatted.length > 0 ? formatted : [turn.content];
        } else if (isMessageMode && turn.formattedMessages === undefined) {
            contents = turn.confirmedMessages ?? [];
        } else {
            contents = [];
        }
        for (const content of contents) {
            if (!content.trim()) continue;
            bubbles.push({ content, ...(characterId ? { characterId } : {}) });
        }
    }
    return bubbles;
}

/** 返信待ちの印。待ち時間中にリロードされても返信を作り直せるよう永続化する。 */
export type PendingReplyMarker = {
    roomId: string;
    createdAt: number;
};

const PENDING_REPLY_META_KEY = 'pendingReplies';

type PendingReplyMarkerMap = Record<string, PendingReplyMarker>;

async function readPendingReplyMap(): Promise<PendingReplyMarkerMap> {
    const stored = await db.getMeta<PendingReplyMarkerMap>(PENDING_REPLY_META_KEY);
    return stored && typeof stored === 'object' ? stored : {};
}

// 書き込みが前後しないよう直列化する。
let pendingReplyWriteQueue: Promise<unknown> = Promise.resolve();

function updatePendingReplyMap(
    update: (map: PendingReplyMarkerMap) => boolean,
): Promise<void> {
    const next = pendingReplyWriteQueue.then(async () => {
        const map = await readPendingReplyMap();
        if (update(map)) {
            await db.setMeta(PENDING_REPLY_META_KEY, map);
        }
    });
    pendingReplyWriteQueue = next.catch(() => undefined);
    return next;
}

export function savePendingReplyMarker(roomId: string, createdAt = Date.now()): Promise<void> {
    return updatePendingReplyMap((map) => {
        if (map[roomId]) return false;
        map[roomId] = { roomId, createdAt };
        return true;
    });
}

export function clearPendingReplyMarker(roomId: string): Promise<void> {
    return updatePendingReplyMap((map) => {
        if (!map[roomId]) return false;
        delete map[roomId];
        return true;
    });
}

export async function getPendingReplyMarker(roomId: string): Promise<PendingReplyMarker | undefined> {
    await pendingReplyWriteQueue;
    return (await readPendingReplyMap())[roomId];
}
