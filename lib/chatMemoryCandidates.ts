import type { Character, MemoryKind, MemoryRecord, MemoryScope } from './store/types';

const MEMORY_SAVE_MIN_IMPORTANCE = 0.4;
const MEMORY_SAVE_MIN_CONFIDENCE = 0.75;
const MEMORY_SAVE_MAX_UPDATES = 5;
const MEMORY_TURN_DEDUP_SIMILARITY_THRESHOLD = 0.68;
const MEMORY_EXISTING_DEDUP_SIMILARITY_THRESHOLD = 0.78;

export type ExtractedMemoryUpdate = {
    content: string;
    kind: MemoryKind;
    scope: MemoryScope;
    importance: number;
    confidence: number;
};

type CharacterSetting = Pick<
    Character,
    'systemPrompt' | 'speechStyle' | 'protagonistPrompt' | 'userConstraints'
>;

function buildCharacterSettingPrompt(character: CharacterSetting): string {
    const speechStyle = character.speechStyle?.trim();
    const protagonistPrompt = character.protagonistPrompt?.trim();
    const userConstraints = character.userConstraints?.trim();
    return [
        character.systemPrompt,
        speechStyle ? `# 口調\n${speechStyle}` : '',
        protagonistPrompt ? `# 主人公について\n${protagonistPrompt}` : '',
        userConstraints ? `# 追加の制約\n${userConstraints}` : '',
    ].filter((part) => part.trim()).join('\n\n');
}

function normalizeMemoryTextForDedup(value: string): string {
    return value
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase()
        .replace(/[「」『』（）()[\]{}.,，。!！?？:：;；、・\s]/g, '');
}

function getMemoryDedupSignals(value: string): Set<string> {
    const signals = new Set<string>();
    const normalized = value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    for (const token of normalized.split(/[\s、。,.!?！？「」『』（）()[\]{}:;・/\\|]+/)) {
        if (token.length >= 2) signals.add(token);
    }
    const compact = normalizeMemoryTextForDedup(value);
    for (let index = 0; index < compact.length - 1; index++) {
        signals.add(compact.slice(index, index + 2));
    }
    return signals;
}

export function memoryDedupSimilarity(left: string, right: string): number {
    const leftKey = normalizeMemoryTextForDedup(left);
    const rightKey = normalizeMemoryTextForDedup(right);
    if (!leftKey || !rightKey) return 0;
    if (leftKey === rightKey) return 1;
    if (leftKey.includes(rightKey) || rightKey.includes(leftKey)) {
        const shorter = Math.min(leftKey.length, rightKey.length);
        const longer = Math.max(leftKey.length, rightKey.length);
        if (shorter >= 8 && shorter / longer >= 0.72) return 0.9;
    }
    const leftSignals = getMemoryDedupSignals(left);
    const rightSignals = getMemoryDedupSignals(right);
    if (leftSignals.size === 0 || rightSignals.size === 0) return 0;
    let overlap = 0;
    for (const signal of leftSignals) {
        if (rightSignals.has(signal)) overlap++;
    }
    return overlap / Math.min(leftSignals.size, rightSignals.size);
}

function isSimilarMemoryContent(content: string, others: { content: string }[], threshold: number): boolean {
    return others.some((other) => memoryDedupSimilarity(content, other.content) >= threshold);
}

function isCoveredByCharacterSetting(content: string, settingPrompt: string): boolean {
    const normalizedContent = normalizeMemoryTextForDedup(content);
    const normalizedPrompt = normalizeMemoryTextForDedup(settingPrompt);
    if (!normalizedContent || !normalizedPrompt) return false;
    if (normalizedPrompt.includes(normalizedContent)) return true;
    return memoryDedupSimilarity(content, normalizedPrompt) >= 0.28;
}

export function selectMemoryCandidates(
    candidates: ExtractedMemoryUpdate[] | undefined,
    character: CharacterSetting,
    existingMemories: Pick<MemoryRecord, 'content'>[],
): ExtractedMemoryUpdate[] {
    const savedThisTurn: ExtractedMemoryUpdate[] = [];
    const settingPrompt = buildCharacterSettingPrompt(character);
    return (candidates ?? [])
        .filter((update) =>
            update
            && typeof update.content === 'string'
            && ['fact', 'preference', 'event', 'relationship', 'instruction'].includes(update.kind)
            && ['character', 'relationship', 'world'].includes(update.scope)
            && update.importance >= MEMORY_SAVE_MIN_IMPORTANCE
            && update.confidence >= MEMORY_SAVE_MIN_CONFIDENCE
        )
        .sort((left, right) =>
            (right.importance * right.confidence) - (left.importance * left.confidence)
        )
        .filter((update) => {
            if (isCoveredByCharacterSetting(update.content, settingPrompt)) return false;
            if (isSimilarMemoryContent(update.content, existingMemories, MEMORY_EXISTING_DEDUP_SIMILARITY_THRESHOLD)) return false;
            if (isSimilarMemoryContent(update.content, savedThisTurn, MEMORY_TURN_DEDUP_SIMILARITY_THRESHOLD)) return false;
            savedThisTurn.push(update);
            return true;
        })
        .slice(0, MEMORY_SAVE_MAX_UPDATES);
}
