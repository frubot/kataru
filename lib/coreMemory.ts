import type { CoreMemory, CoreMemoryEntry, CoreMemorySection } from './store/types';

/** サーバー（src/core_memory.rs）と同じ上限。 */
export const CORE_MEMORY_MAX_CHARS = 1000;
export const CORE_MEMORY_ENTRY_MAX_CHARS = 200;

export const CORE_MEMORY_SECTIONS: { value: CoreMemorySection; label: string; hint: string }[] = [
    { value: 'user', label: 'ユーザーについて', hint: '名前、呼び方、苦手なこと、大事な属性など' },
    { value: 'relationship', label: '関係', hint: '今の関係、距離感、まだ果たしていない約束など' },
    { value: 'self', label: '自分の今', hint: '会話の中で変わったキャラクター自身の状態など' },
];

/** サーバーと同じく、連続する空白を1つにまとめる。 */
export function normalizeCoreMemoryText(text: string): string {
    return text.split(/\s+/).filter(Boolean).join(' ');
}

/** サーバーの `chars().count()` に合わせ、コードポイント単位で数える。 */
export function countCoreMemoryChars(text: string): number {
    return Array.from(normalizeCoreMemoryText(text)).length;
}

export function totalCoreMemoryChars(entries: Pick<CoreMemoryEntry, 'text'>[]): number {
    return entries.reduce((total, entry) => total + countCoreMemoryChars(entry.text), 0);
}

export type CoreMemoryDraftProblem = 'entryTooLong' | 'totalTooLong';

export function coreMemoryDraftProblems(entries: Pick<CoreMemoryEntry, 'text'>[]): CoreMemoryDraftProblem[] {
    const problems: CoreMemoryDraftProblem[] = [];
    if (entries.some((entry) => countCoreMemoryChars(entry.text) > CORE_MEMORY_ENTRY_MAX_CHARS)) {
        problems.push('entryTooLong');
    }
    if (totalCoreMemoryChars(entries) > CORE_MEMORY_MAX_CHARS) {
        problems.push('totalTooLong');
    }
    return problems;
}

export function emptyCoreMemory(characterId: string): CoreMemory {
    return { characterId, version: 0, entries: [] };
}
