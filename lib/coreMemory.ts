import type { CoreMemory, CoreMemoryEntry, CoreMemorySection } from './store/types';

/** サーバー（src/core_memory.rs）と同じ上限。 */
export const CORE_MEMORY_MAX_CHARS = 1000;
export const CORE_MEMORY_ENTRY_MAX_CHARS = 200;

export const CORE_MEMORY_SECTIONS: { value: CoreMemorySection; label: string; hint: string }[] = [
    { value: 'user', label: 'ユーザーについて', hint: '名前、呼び方、苦手なこと、大事な属性など' },
    { value: 'relationship', label: '関係', hint: '今の関係、距離感、ユーザーへの気持ち、まだ果たしていない約束など' },
    { value: 'self', label: '自分の今', hint: '設定から変わって続いている状態（見た目、立場、怪我など）。今いる場所や今していることは書かない' },
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

/** 行の頭にこの記号を付けると固定した行になる。全角の「！」も受け付ける。 */
export const CORE_MEMORY_LOCK_MARK = '!';
const LOCK_MARK_PATTERN = /^[!！]/;

/** テキストエリアの1行が、中身のある固定した行かどうか。 */
export function isLockedCoreMemoryLine(line: string): boolean {
    return parseLine(line)?.locked === true;
}

/** 見出し1つ分の行を、テキストエリアに入れる文章にする。固定した行には `!` を付ける。 */
export function coreMemorySectionToText(entries: CoreMemoryEntry[], section: CoreMemorySection): string {
    return entries
        .filter((entry) => entry.section === section)
        .map((entry) => `${entry.locked ? CORE_MEMORY_LOCK_MARK : ''}${entry.text}`)
        .join('\n');
}

interface ParsedLine {
    text: string;
    locked: boolean;
}

/** 1行を読む。`!` を外し、空白をまとめる。空の行は `null`。 */
function parseLine(line: string): ParsedLine | null {
    const trimmed = line.trim();
    const locked = LOCK_MARK_PATTERN.test(trimmed);
    const text = normalizeCoreMemoryText(locked ? trimmed.slice(1) : trimmed);
    return text ? { text, locked } : null;
}

/**
 * テキストエリアの文章を行に戻す。前と同じ文の行は前の ID・書いた人を引き継ぎ、
 * 変わった行や新しい行は ID を空にしてサーバーに振ってもらう。
 */
export function parseCoreMemorySectionText(
    text: string,
    section: CoreMemorySection,
    previous: CoreMemoryEntry[],
): CoreMemoryEntry[] {
    const unused = previous.filter((entry) => entry.section === section);
    const entries: CoreMemoryEntry[] = [];
    for (const line of text.split('\n')) {
        const parsed = parseLine(line);
        if (!parsed) continue;
        const matchIndex = unused.findIndex((entry) => normalizeCoreMemoryText(entry.text) === parsed.text);
        if (matchIndex >= 0) {
            const [old] = unused.splice(matchIndex, 1);
            entries.push({ ...old, text: parsed.text, locked: parsed.locked });
        } else {
            entries.push({ id: '', section, text: parsed.text, locked: parsed.locked });
        }
    }
    return entries;
}

/** 1行の上限を超えている行の番号（1始まり、空の行も数える）。 */
export function tooLongCoreMemoryLines(text: string): number[] {
    return text.split('\n').flatMap((line, index) => {
        const parsed = parseLine(line);
        return parsed && Array.from(parsed.text).length > CORE_MEMORY_ENTRY_MAX_CHARS ? [index + 1] : [];
    });
}
