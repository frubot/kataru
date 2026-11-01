import type { WordReplacement } from './store/types';

/** サーバー（src/conversation/word_filter.rs）と同じ上限。 */
export const MAX_WORD_REPLACEMENTS = 200;
export const MAX_WORD_REPLACEMENT_FROM_CHARS = 100;
export const MAX_WORD_REPLACEMENT_TO_CHARS = 200;

/**
 * 保存値を検証する。編集中の空行を残すため、`from` が空でも `to` があれば残す。
 * 長すぎる値は上限で切る。
 */
export function normalizeWordReplacements(value: unknown): WordReplacement[] {
    if (!Array.isArray(value)) return [];
    const result: WordReplacement[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const from = typeof record.from === 'string' ? record.from.slice(0, MAX_WORD_REPLACEMENT_FROM_CHARS) : '';
        const to = typeof record.to === 'string' ? record.to.slice(0, MAX_WORD_REPLACEMENT_TO_CHARS) : '';
        result.push({ from, to });
        if (result.length >= MAX_WORD_REPLACEMENTS) break;
    }
    return result;
}

/** 会話リクエストへ送る規則。禁止ワードが空の行は除く。 */
export function activeWordReplacements(rules: WordReplacement[]): WordReplacement[] {
    return rules.filter((rule) => rule.from.trim().length > 0);
}
