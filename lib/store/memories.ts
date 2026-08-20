import type { AiApiConfig } from '../aiApi';
import * as db from '../db';
import { generateId } from '../id';
import { fire } from './persistence';
import { getAiApiConfigFromState } from './settings';
import type {
    AddMemoryOptions,
    AppState,
    MemoryKind,
    MemoryRecord,
    StoreGet,
    StoreSet,
} from './types';

const DEFAULT_MEMORY_IMPORTANCE = 0.6;
const DEFAULT_MEMORY_CONFIDENCE = 0.85;
const MEMORY_SEARCH_LIMIT = 8;
const EMBEDDING_TIMEOUT_MS = 12_000;
const MEMORY_DUPLICATE_SIMILARITY_THRESHOLD = 0.7;

export function normalizeMemoryContent(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

export function normalizeMemoryCompareKey(value: string): string {
    return normalizeMemoryContent(value)
        .toLocaleLowerCase()
        .replace(/[「」『』（）()[\]{}.,，。!！?？:：;；、・\s]/g, '');
}

function getMemoryTextSignals(value: string): Set<string> {
    const normalized = normalizeMemoryContent(value).toLocaleLowerCase();
    const signals = new Set<string>();
    for (const token of normalized.split(/[\s、。,.!?！？「」『』（）()[\]{}:;・/\\|]+/)) {
        if (token.length >= 2) signals.add(token);
    }

    const compact = normalizeMemoryCompareKey(normalized);
    for (let index = 0; index < compact.length - 1; index++) {
        signals.add(compact.slice(index, index + 2));
    }
    return signals;
}

export function memoryTextSimilarity(a: string, b: string): number {
    const keyA = normalizeMemoryCompareKey(a);
    const keyB = normalizeMemoryCompareKey(b);
    if (!keyA || !keyB) return 0;
    if (keyA === keyB) return 1;
    if (keyA.includes(keyB) || keyB.includes(keyA)) {
        return Math.min(keyA.length, keyB.length) / Math.max(keyA.length, keyB.length);
    }

    const signalsA = getMemoryTextSignals(a);
    const signalsB = getMemoryTextSignals(b);
    if (signalsA.size === 0 || signalsB.size === 0) return 0;
    let overlap = 0;
    for (const signal of signalsA) {
        if (signalsB.has(signal)) overlap += 1;
    }
    return overlap / Math.min(signalsA.size, signalsB.size);
}

export function inferMemoryKind(content: string): MemoryKind {
    if (/好き|嫌い|好み|苦手|呼んで|呼び方|prefer|preference|likes?|dislikes?/i.test(content)) {
        return 'preference';
    }
    if (/約束|関係|信頼|友人|恋人|家族|relationship|promise/i.test(content)) {
        return 'relationship';
    }
    if (/指示|必ず|しないで|覚えておくこと|instruction|rule/i.test(content)) {
        return 'instruction';
    }
    if (/前回|以前|出来事|事件|会った|event/i.test(content)) {
        return 'event';
    }
    return 'fact';
}

export function createMemoryRecord(
    characterId: string,
    memory: string,
    options?: AddMemoryOptions,
): MemoryRecord | null {
    const content = normalizeMemoryContent(memory);
    if (!content) return null;
    const now = Date.now();
    const scope = options?.scope ?? 'character';
    return {
        id: generateId(),
        scope,
        ...(characterId ? { characterId } : {}),
        ...(options?.sourceRoomId ? { sourceRoomId: options.sourceRoomId } : {}),
        content,
        kind: options?.kind ?? inferMemoryKind(content),
        importance: options?.importance ?? DEFAULT_MEMORY_IMPORTANCE,
        confidence: options?.confidence ?? DEFAULT_MEMORY_CONFIDENCE,
        sourceMessageIds: options?.sourceMessageIds ?? [],
        createdAt: now,
        updatedAt: now,
        usageCount: 0,
    };
}

type EmbeddingInputType = 'search_document' | 'search_query';

async function requestMemoryEmbedding(
    input: string,
    model: string,
    inputType: EmbeddingInputType,
    aiApiConfig: AiApiConfig,
): Promise<{ embedding: number[]; model: string } | null> {
    const trimmed = input.trim();
    if (!trimmed || typeof window === 'undefined') return null;
    if (
        aiApiConfig.aiApiType === 'anthropic'
        || (
            aiApiConfig.aiApiType === 'openai-compatible'
            && !aiApiConfig.openAiCompatibleEmbeddingsEnabled
        )
    ) {
        return null;
    }

    try {
        const response = await fetch('/api/embeddings', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input: trimmed,
                model,
                inputType,
                aiApiConfig,
            }),
            signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const data = await response.json() as {
            model?: unknown;
            data?: { embedding?: unknown }[];
        };
        const embedding = data.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number')) return null;
        return {
            embedding,
            model: typeof data.model === 'string' ? data.model : model,
        };
    } catch {
        return null;
    }
}

async function persistMemoryWithEmbedding(
    memory: MemoryRecord,
    embeddingModel: string,
    aiApiConfig: AiApiConfig,
): Promise<void> {
    const existing = await db.getMemoriesByCharacter(memory.characterId ?? '');
    const matched = existing.find((record) =>
        memoryTextSimilarity(record.content, memory.content) >= MEMORY_DUPLICATE_SIMILARITY_THRESHOLD,
    );
    if (matched) {
        const nextMemory = {
            ...matched,
            scope: memory.scope,
            kind: memory.kind,
            importance: Math.max(matched.importance ?? 0, memory.importance),
            confidence: Math.max(matched.confidence ?? 0, memory.confidence),
            sourceMessageIds: [...new Set([...(matched.sourceMessageIds ?? []), ...memory.sourceMessageIds])],
            sourceRoomId: memory.sourceRoomId ?? matched.sourceRoomId,
            updatedAt: Date.now(),
            archived: false,
        };
        await db.putMemory(nextMemory);
        if (!nextMemory.embedding || nextMemory.embeddingModel !== embeddingModel) {
            const embedded = await requestMemoryEmbedding(
                nextMemory.content,
                embeddingModel,
                'search_document',
                aiApiConfig,
            );
            if (embedded) {
                await db.putMemory({
                    ...nextMemory,
                    embedding: embedded.embedding,
                    embeddingModel: embedded.model,
                    updatedAt: Date.now(),
                });
            }
        }
        return;
    }

    await db.putMemory(memory);
    const embedded = await requestMemoryEmbedding(memory.content, embeddingModel, 'search_document', aiApiConfig);
    if (!embedded) return;
    await db.putMemory({
        ...memory,
        embedding: embedded.embedding,
        embeddingModel: embedded.model,
        updatedAt: Date.now(),
    });
}

export async function duplicateDedicatedMemories(
    sourceCharacterId: string,
    nextCharacterId: string,
): Promise<void> {
    const sourceMemories = await db.getMemoriesByCharacter(sourceCharacterId);
    if (sourceMemories.length === 0) return;
    const now = Date.now();
    await db.putMemories(sourceMemories.map((memory) => ({
        ...memory,
        id: generateId(),
        characterId: nextCharacterId,
        sourceMessageIds: [],
        createdAt: now,
        updatedAt: now,
        lastUsedAt: undefined,
        usageCount: 0,
    })));
}

function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index++) {
        dot += a[index] * b[index];
        normA += a[index] * a[index];
        normB += b[index] * b[index];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function lexicalMemorySimilarity(query: string, content: string): number {
    const querySignals = getMemoryTextSignals(query);
    if (querySignals.size === 0) return 0;
    const contentSignals = getMemoryTextSignals(content);
    let hits = 0;
    for (const signal of querySignals) {
        if (contentSignals.has(signal)) hits += 1;
    }
    return Math.min(1, hits / Math.min(querySignals.size, 12));
}

function memoryRecencyBoost(memory: MemoryRecord): number {
    const ageDays = Math.max(0, (Date.now() - memory.updatedAt) / 86_400_000);
    if (ageDays <= 1) return 1;
    if (ageDays >= 60) return 0;
    return 1 - ageDays / 60;
}

function scoreMemory(
    memory: MemoryRecord,
    query: string,
    queryEmbedding: number[] | null,
    embeddingModel: string,
): number {
    const lexical = lexicalMemorySimilarity(query, memory.content);
    const vector = queryEmbedding && memory.embedding && memory.embeddingModel === embeddingModel
        ? Math.max(0, cosineSimilarity(queryEmbedding, memory.embedding))
        : 0;
    const importance = Math.min(1, Math.max(0, memory.importance));
    const confidence = Math.min(1, Math.max(0, memory.confidence));
    const usage = Math.min(1, Math.log1p(memory.usageCount ?? 0) / Math.log(10));
    const recency = memoryRecencyBoost(memory);

    if (queryEmbedding && vector > 0) {
        return vector * 0.62
            + lexical * 0.14
            + importance * 0.12
            + confidence * 0.06
            + usage * 0.03
            + recency * 0.03;
    }
    return lexical * 0.52
        + importance * 0.22
        + confidence * 0.12
        + usage * 0.06
        + recency * 0.08;
}

type MemorySlice = Pick<
    AppState,
    | 'addMemory'
    | 'removeMemoryRecord'
    | 'clearMemories'
    | 'listMemoriesForCharacter'
    | 'searchRelevantMemories'
    | 'markMemoriesUsed'
    | 'removeMemories'
>;

export function createMemorySlice(set: StoreSet, get: StoreGet): MemorySlice {
    return {
        addMemory: async (characterId, memory, options) => {
            const content = normalizeMemoryContent(memory);
            if (!content) return;
            const record = createMemoryRecord(characterId, content, options);
            if (!record) return;
            const state = get();
            await persistMemoryWithEmbedding(record, state.memoryEmbeddingModel, getAiApiConfigFromState(state));
            if (record.sourceMessageIds.length > 0 && !await db.doMessagesExist(record.sourceMessageIds)) {
                await db.deleteMemoriesBySourceMessageIds(record.sourceMessageIds);
            }
        },

        removeMemoryRecord: async (characterId, memoryId) => {
            const memory = await db.getMemory(memoryId);
            if (memory?.characterId !== characterId) return;
            await db.deleteMemory(memoryId);
            await db.removeMemoryContentsFromMessages(characterId, [memory.content]);
            const removedContent = normalizeMemoryContent(memory.content);
            set((state) => ({
                rooms: state.rooms.map((room) => ({
                    ...room,
                    messages: room.messages.map((message) => {
                        if (message.characterId !== characterId || !message.memories?.length) return message;
                        const memories = message.memories.filter(
                            (content) => normalizeMemoryContent(content) !== removedContent,
                        );
                        if (memories.length === message.memories.length) return message;
                        return { ...message, memories: memories.length > 0 ? memories : undefined };
                    }),
                })),
            }));
        },

        clearMemories: async (characterId) => {
            const memoriesToRemove = await db.getMemoriesByCharacter(characterId);
            const contentsToRemove = memoriesToRemove.map((memory) => memory.content);
            await db.deleteMemoriesByCharacter(characterId);
            await db.removeMemoryContentsFromMessages(characterId, contentsToRemove);
            const normalizedContents = new Set(contentsToRemove.map(normalizeMemoryContent));
            set((state) => ({
                rooms: state.rooms.map((room) => ({
                    ...room,
                    messages: room.messages.map((message) => {
                        if (message.characterId !== characterId || !message.memories?.length) return message;
                        const memories = message.memories.filter(
                            (content) => !normalizedContents.has(normalizeMemoryContent(content)),
                        );
                        if (memories.length === message.memories.length) return message;
                        return { ...message, memories: memories.length > 0 ? memories : undefined };
                    }),
                })),
            }));
        },

        listMemoriesForCharacter: async (characterId) => db.getMemoriesByCharacter(characterId),

        searchRelevantMemories: async ({
            characterId,
            roomId,
            recentMessageIds,
            query,
            limit = MEMORY_SEARCH_LIMIT,
        }) => {
            const candidates = await db.getSearchableMemories({ characterId, roomId, recentMessageIds });
            if (candidates.length === 0) return [];

            const embeddingModel = get().memoryEmbeddingModel;
            const queryEmbeddingResult = await requestMemoryEmbedding(
                query,
                embeddingModel,
                'search_query',
                getAiApiConfigFromState(get()),
            );
            const queryEmbedding = queryEmbeddingResult?.model === embeddingModel
                ? queryEmbeddingResult.embedding
                : null;

            return candidates
                .map((memory) => ({
                    memory,
                    score: scoreMemory(memory, query, queryEmbedding, embeddingModel),
                }))
                .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)
                .slice(0, Math.max(1, limit))
                .map(({ memory }) => memory);
        },

        markMemoriesUsed: (memoryIds) => {
            fire(db.touchMemories(memoryIds));
        },

        removeMemories: (characterId, memoriesToRemove) => {
            fire(db.deleteMemoriesByCharacterAndContent(characterId, memoriesToRemove));
        },
    };
}
