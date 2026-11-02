/** 記憶をまとめて抽出するかどうか。サーバーの `memoryBatchMode` と同じ値。 */
export type MemoryBatchMode = 'off' | 'shadow' | 'on';

export const DEFAULT_MEMORY_BATCH_MODE: MemoryBatchMode = 'off';

export const MEMORY_BATCH_MODE_OPTIONS: readonly { value: MemoryBatchMode; label: string; detail: string }[] = [
    { value: 'off', label: 'オフ', detail: '毎ターン抽出します（従来どおり）' },
    { value: 'shadow', label: '比較のみ', detail: '毎ターン抽出したうえで、まとめて抽出した件数をログに出します' },
    { value: 'on', label: 'オン', detail: '発言がたまったときにまとめて抽出します' },
];

export function isMemoryBatchMode(value: unknown): value is MemoryBatchMode {
    return value === 'off' || value === 'shadow' || value === 'on';
}
