import * as db from './db';
import type {
    MemoryRecord,
    Message,
    RoomCompressionSnapshot,
} from './store/types';

/**
 * メッセージ編集や再生成は生成前に既存の末尾メッセージを削除する。
 * 復元に必要なデータは実行中の関数内にしかないため、生成中にページが
 * リロードされると削除したまま戻せなくなる。バックグラウンドジョブと
 * 同じく、復元データを永続化しておけばリロード後でも取り戻せる。
 */
export type PendingTurnRestore = {
    jobId: string;
    roomId: string;
    fromIndex: number;
    messages: Message[];
    memories: MemoryRecord[];
    compressionSnapshot?: RoomCompressionSnapshot | null;
    createdAt: number;
};

const META_KEY = 'pendingTurnRestores';

type PendingTurnRestoreMap = Record<string, PendingTurnRestore>;

async function readRestoreMap(): Promise<PendingTurnRestoreMap> {
    const stored = await db.getMeta<PendingTurnRestoreMap>(META_KEY);
    return stored && typeof stored === 'object' ? stored : {};
}

async function writeRestoreMap(map: PendingTurnRestoreMap): Promise<void> {
    await db.setMeta(META_KEY, map);
}

export async function savePendingTurnRestore(restore: PendingTurnRestore): Promise<void> {
    const map = await readRestoreMap();
    map[restore.roomId] = restore;
    await writeRestoreMap(map);
}

export async function getPendingTurnRestore(roomId: string): Promise<PendingTurnRestore | undefined> {
    return (await readRestoreMap())[roomId];
}

export async function getPendingTurnRestores(): Promise<PendingTurnRestore[]> {
    return Object.values(await readRestoreMap());
}

export async function clearPendingTurnRestore(roomId: string, expectedJobId?: string): Promise<void> {
    const map = await readRestoreMap();
    const pending = map[roomId];
    if (!pending) return;
    // 別セッションが残したスナップショットを間違って消さないよう、
    // ジョブが分かるときは一致するものだけを消す。
    if (expectedJobId !== undefined && pending.jobId !== expectedJobId) return;
    delete map[roomId];
    await writeRestoreMap(map);
}

export async function clearAllPendingTurnRestores(): Promise<void> {
    await writeRestoreMap({});
}

/**
 * ジョブ結果のメッセージIDは `jobId-message-N` 形式で正規化される。
 * ジョブ記録が残っていない（サーバー再起動や保持期限切れ）ときでも、
 * 永続化された返答の有無でスナップショットを復元すべきか判断できる。
 */
export async function hasDeliveredPendingTurnRestore(restore: PendingTurnRestore): Promise<boolean> {
    const persisted = await db.getMessagesByRoom(restore.roomId);
    const prefix = `${restore.jobId}-message-`;
    return persisted.some((message) => message.id.startsWith(prefix));
}

type PendingTurnRestoreRecoveryOperations = {
    canRecover: () => boolean;
    restore: (roomId: string, expectedJobId: string, canRestore: () => boolean) => Promise<void>;
};

export async function recoverOrphanedPendingTurnRestore(
    pending: PendingTurnRestore,
    { canRecover, restore }: PendingTurnRestoreRecoveryOperations,
): Promise<void> {
    if (!canRecover()) return;
    const delivered = await hasDeliveredPendingTurnRestore(pending);
    if (!canRecover()) return;
    const current = await getPendingTurnRestore(pending.roomId);
    if (!canRecover() || current?.jobId !== pending.jobId) return;
    if (delivered) {
        await clearPendingTurnRestore(pending.roomId, pending.jobId);
    } else {
        await restore(pending.roomId, pending.jobId, canRecover);
    }
}
