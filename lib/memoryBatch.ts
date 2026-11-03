/** 未反映の発言が何ターン分たまったら記憶をまとめて抽出するか。サーバーの `memoryBatchUserTurns` と同じ値。 */
export const DEFAULT_MEMORY_BATCH_USER_TURNS = 10;
export const MEMORY_BATCH_USER_TURNS_MIN = 3;
export const MEMORY_BATCH_USER_TURNS_MAX = 30;

export function normalizeMemoryBatchUserTurns(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MEMORY_BATCH_USER_TURNS;
    return Math.min(MEMORY_BATCH_USER_TURNS_MAX, Math.max(MEMORY_BATCH_USER_TURNS_MIN, Math.round(value)));
}
