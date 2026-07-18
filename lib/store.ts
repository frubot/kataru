import { create } from 'zustand';
import type { ParsedBackup } from './importExport';
import * as db from './db';
import { normalizeCharactersForCostumeDiffs } from './visualDiffMigration';
import { generateId } from './id';
import {
    DEFAULT_AUTO_GENERATION_MODEL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_DIRECTOR_MODEL,
    DEFAULT_IMAGE_MODEL,
    DEFAULT_MEMORY_EMBEDDING_MODEL,
    DEFAULT_MEMORY_EXTRACTION_MODEL,
    DEFAULT_SUMMARY_MODEL,
    DEFAULT_TITLE_GENERATION_MODEL,
} from './modelDefaults';
import {
    DEFAULT_AI_PROVIDER,
    DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED,
    DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED,
    isAiProvider,
    normalizeOpenAiCompatibleBaseUrl,
    type AiProvider,
    type AiProviderConfig,
} from './aiProvider';

export {
    DEFAULT_AUTO_GENERATION_MODEL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_DIRECTOR_MODEL,
    DEFAULT_IMAGE_MODEL,
    DEFAULT_MEMORY_EMBEDDING_MODEL,
    DEFAULT_MEMORY_EXTRACTION_MODEL,
    DEFAULT_SUMMARY_MODEL,
    DEFAULT_TITLE_GENERATION_MODEL,
} from './modelDefaults';
export {
    DEFAULT_AI_PROVIDER,
    DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED,
    DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED,
    type AiProvider,
    type AiProviderConfig,
} from './aiProvider';

export interface Expression {
    name: string;
    promptDetail?: string;
    image: string; // PNG dataURL, longest edge <= 1024px (2:3 portrait)
}

export interface Costume {
    name: string;
    promptDetail?: string;
    image: string; // PNG dataURL, longest edge <= 1024px (2:3 portrait)
    expressions?: Expression[];
}

export interface Character {
    id: string;
    name: string;
    systemPrompt: string;
    protagonistPrompt?: string;
    model: string;
    icon?: string;
    maxTokens?: number;
    maxHistory?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    enableMemory?: boolean;
    enableSummary?: boolean;
    thinkModeEnabled?: boolean;
    expressions?: Expression[];
    costumes?: Costume[];
    createdAt: number;
    updatedAt: number;
}

export interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    characterId?: string;
    toCharacterIds?: string[];
    expression?: string;
    memories?: string[];
    timestamp: number;
    archived?: boolean;
}

export type MemoryScope = 'character' | 'relationship' | 'world';
export type MemoryKind = 'fact' | 'preference' | 'event' | 'relationship' | 'instruction';

export interface MemoryRecord {
    id: string;
    scope: MemoryScope;
    characterId?: string;
    roomId?: string;
    sourceRoomId?: string;
    content: string;
    kind: MemoryKind;
    importance: number;
    confidence: number;
    embedding?: number[];
    embeddingModel?: string;
    sourceMessageIds: string[];
    createdAt: number;
    updatedAt: number;
    lastUsedAt?: number;
    usageCount: number;
    archived?: boolean;
}

export type AddMemoryOptions = {
    scope?: MemoryScope;
    kind?: MemoryKind;
    sourceRoomId?: string;
    sourceMessageIds?: string[];
    importance?: number;
    confidence?: number;
};

export type MemorySearchParams = {
    characterId: string;
    roomId?: string;
    recentMessageIds?: string[];
    query: string;
    limit?: number;
};

export type SituationMemoryMode = 'off' | 'readOnly';

export type SituationActor =
    | {
        id: string;
        type: 'character';
        characterId: string;
        rolePrompt?: string;
        directorDescription?: string;
    }
    | {
        id: string;
        type: 'temporary';
        name: string;
        systemPrompt: string;
        model?: string;
        icon?: string;
        rolePrompt?: string;
        directorDescription?: string;
        maxTokens?: number;
        maxHistory?: number;
        temperature?: number;
        topP?: number;
        topK?: number;
        thinkModeEnabled?: boolean;
        expressions?: Expression[];
        costumes?: Costume[];
    };

export interface SituationDirector {
    enabled: boolean;
    model: string;
    systemPrompt?: string;
    reasoningEffort?: 'none' | 'medium';
    maxAutoTurns: number;
    stopPolicy: 'after-one' | 'max-turns';
}

export type SituationPriorMessage =
    | {
        id: string;
        role: 'user';
        content: string;
    }
    | {
        id: string;
        role: 'assistant';
        content: string;
        actorId: string;
    };

export interface Situation {
    id: string;
    name: string;
    situationPrompt?: string;
    priorMessages?: SituationPriorMessage[];
    actors: SituationActor[];
    director: SituationDirector;
    memoryMode: SituationMemoryMode;
    maxHistory?: number;
    createdAt: number;
    updatedAt: number;
}

export type SituationParticipant = Character & {
    actorId: string;
    actorType: SituationActor['type'];
    sourceCharacterId?: string;
    rolePrompt?: string;
    directorDescription?: string;
};

export type CreateSituationInput = {
    name?: string;
    situationPrompt?: string;
    priorMessages?: SituationPriorMessage[];
    actors: SituationActor[];
    director?: Partial<SituationDirector>;
    memoryMode?: SituationMemoryMode;
    maxHistory?: number;
    roomName?: string;
};

export interface Room {
    id: string;
    characterId: string;
    groupId?: string;
    name: string;
    messages: Message[];
    summary?: string;
    summaryCheckpointUserMessageId?: string;
    maxMentionChain?: number;
    viewMode?: 'chat' | 'message' | 'vn';
    costumeSelections?: Record<string, string>; // characterId -> costume name; missing means default
    secretMode?: boolean; // memory-only; omitted from IndexedDB and backups
    isDraft?: boolean; // memory-only; omitted from IndexedDB and backups
    lastMessagePreview?: string;
    lastMessageAt?: number;
    createdAt: number;
    updatedAt: number;
}

function toStoredRoom(room: Room): db.StoredRoom {
    const stored: Partial<Room> = { ...room };
    delete stored.messages;
    delete stored.secretMode;
    delete stored.isDraft;
    if (room.secretMode) {
        delete stored.summary;
        delete stored.lastMessagePreview;
        delete stored.lastMessageAt;
    }
    return stored as db.StoredRoom;
}

function shouldPersistRoom(room: Room | undefined): room is Room {
    return !!room && room.secretMode !== true && room.isDraft !== true;
}

function shouldShowRoomInHistory(room: Room): boolean {
    return room.secretMode !== true && room.isDraft !== true;
}

const PREVIEW_MAX = 50;
const MEMORY_TAG_REGEX = /<memory>[\s\S]*?<\/memory>/gi;
const EMOTION_TAG_REGEX = /^\s*\[emotion:[^\]\n]+\]\s*/i;
function toPreview(content: string): string {
    const stripped = content.replace(MEMORY_TAG_REGEX, '').replace(EMOTION_TAG_REGEX, '').replace(/\s+/g, ' ').trim();
    return stripped.length > PREVIEW_MAX ? stripped.slice(0, PREVIEW_MAX) : stripped;
}

export interface UsageRecord {
    id: string;
    characterId: string;
    timestamp: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
}

export interface ThinkDebugLog {
    id: string;
    roomId: string;
    roomName: string;
    characterId: string;
    characterName: string;
    thinking: string;
    createdAt: number;
}

export interface FullJsonDebugLog {
    id: string;
    roomId: string;
    roomName: string;
    characterId: string;
    characterName: string;
    model?: string;
    status: 'success' | 'error';
    source: string;
    prompt?: string;
    json: string;
    httpStatus?: number;
    elapsedMs?: number;
    errorName?: string;
    createdAt: number;
}

export type ThemeMode = 'light' | 'dark';
export type ThemePalette = 'classic' | 'sakura' | 'sage' | 'sky' | 'amber' | 'mono';
export type VnTypingSpeed = 'slow' | 'default' | 'fast' | 'streaming';

type ThemeSelection = {
    mode: ThemeMode;
    palette: ThemePalette;
};

type CharacterExtras = Partial<Omit<Character, 'id' | 'name' | 'systemPrompt' | 'model' | 'createdAt' | 'updatedAt'>>;

interface AppState {
    hydrated: boolean;
    themeMode: ThemeMode;
    themePalette: ThemePalette;
    vnTypingSpeed: VnTypingSpeed;
    summaryModel: string;
    defaultChatModel: string;
    defaultDirectorModel: string;
    defaultAutoGenerationModel: string;
    titleGenerationModel: string;
    defaultImageModel: string;
    memoryExtractionModel: string;
    memoryEmbeddingModel: string;
    generateTitleOnFirstReply: boolean;
    aiProvider: AiProvider;
    openAiCompatibleBaseUrl: string;
    openAiCompatibleEmbeddingsEnabled: boolean;
    openAiCompatibleImageGenerationEnabled: boolean;
    thinkDebugEnabled: boolean;
    thinkDebugLogs: ThinkDebugLog[];
    fullJsonDebugEnabled: boolean;
    fullJsonDebugLogs: FullJsonDebugLog[];
    characters: Character[];
    groups: Situation[];
    rooms: Room[];
    currentRoomId: string | null;
    usageRecords: UsageRecord[];

    // Hydration
    hydrate: () => Promise<void>;

    // Theme
    setThemeMode: (mode: ThemeMode) => void;
    setThemePalette: (palette: ThemePalette) => void;
    toggleThemeMode: () => void;
    toggleTheme: () => void;
    setVnTypingSpeed: (speed: VnTypingSpeed) => void;
    setSummaryModel: (model: string) => void;
    setDefaultChatModel: (model: string) => void;
    setDefaultDirectorModel: (model: string) => void;
    setDefaultAutoGenerationModel: (model: string) => void;
    setTitleGenerationModel: (model: string) => void;
    setDefaultImageModel: (model: string) => void;
    setMemoryExtractionModel: (model: string) => void;
    setMemoryEmbeddingModel: (model: string) => void;
    setGenerateTitleOnFirstReply: (enabled: boolean) => void;
    setAiProvider: (provider: AiProvider) => void;
    setOpenAiCompatibleBaseUrl: (baseUrl: string) => void;
    setOpenAiCompatibleEmbeddingsEnabled: (enabled: boolean) => void;
    setOpenAiCompatibleImageGenerationEnabled: (enabled: boolean) => void;
    getAiProviderConfig: () => AiProviderConfig;
    setThinkDebugEnabled: (enabled: boolean) => void;
    setFullJsonDebugEnabled: (enabled: boolean) => void;

    // Characters
    createCharacter: (name: string, systemPrompt?: string, model?: string, extras?: CharacterExtras) => string;
    updateCharacter: (id: string, updates: Partial<Pick<Character, 'name' | 'systemPrompt' | 'protagonistPrompt' | 'model' | 'icon' | 'maxTokens' | 'maxHistory' | 'temperature' | 'topP' | 'topK' | 'enableMemory' | 'enableSummary' | 'thinkModeEnabled' | 'expressions' | 'costumes'>>) => void;
    deleteCharacter: (id: string) => void;
    duplicateCharacter: (id: string) => string;
    getCharacter: (id: string) => Character | undefined;

    // Debug logs (memory-only)
    addThinkDebugLog: (log: Omit<ThinkDebugLog, 'id' | 'createdAt'>) => void;
    clearThinkDebugLogs: () => void;
    addFullJsonDebugLog: (log: Omit<FullJsonDebugLog, 'id' | 'createdAt'>) => void;
    clearFullJsonDebugLogs: () => void;

    // Memories
    addMemory: (characterId: string, memory: string, options?: AddMemoryOptions) => Promise<void>;
    removeMemoryRecord: (characterId: string, memoryId: string) => Promise<void>;
    clearMemories: (characterId: string) => Promise<void>;
    listMemoriesForCharacter: (characterId: string) => Promise<MemoryRecord[]>;
    searchRelevantMemories: (params: MemorySearchParams) => Promise<MemoryRecord[]>;
    markMemoriesUsed: (memoryIds: string[]) => void;

    // Rooms
    createRoom: (characterId: string, name?: string, options?: { viewMode?: Room['viewMode'] }) => string;
    createSituationRoom: (input: CreateSituationInput) => string;
    createRoomForSituation: (situationId: string, name?: string, options?: { viewMode?: Room['viewMode'] }) => string;
    deleteRoom: (id: string) => void;
    deleteSituation: (id: string) => void;
    setCurrentRoom: (id: string | null) => Promise<void>;
    updateSituation: (id: string, updates: Partial<Pick<Situation, 'name' | 'situationPrompt' | 'priorMessages' | 'actors' | 'director' | 'memoryMode' | 'maxHistory'>>) => void;
    updateRoomName: (id: string, name: string) => void;
    updateRoomSettings: (id: string, updates: Partial<Pick<Room, 'maxMentionChain' | 'viewMode' | 'costumeSelections'>>) => void;
    setRoomSecretMode: (id: string, enabled: boolean) => void;

    // Messages
    addMessage: (roomId: string, role: 'user' | 'assistant', content: string, characterId?: string, meta?: Pick<Message, 'expression' | 'memories' | 'toCharacterIds'>) => string;
    deleteLastMessage: (roomId: string) => void;
    deleteMessagesFrom: (roomId: string, fromIndex: number) => Promise<MemoryRecord[]>;
    restoreMessagesAt: (roomId: string, fromIndex: number, messages: Message[], memories?: MemoryRecord[]) => Promise<void>;
    attachMemoriesToMessage: (roomId: string, messageId: string, memories: string[]) => void;
    updateLastAssistantMessage: (roomId: string, content: string, meta?: Pick<Message, 'expression' | 'memories' | 'toCharacterIds'>) => void;
    flushLastAssistantMessage: (roomId: string) => void;
    clearRoomMessages: (roomId: string) => void;
    clearAllHistory: () => Promise<void>;
    updateRoomSummary: (roomId: string, summary: string, summaryCheckpointUserMessageId?: string) => void;
    compressRoomHistory: (roomId: string, keepCount: number) => void;

    // Usage Statistics
    addUsageRecord: (characterId: string, promptTokens: number, completionTokens: number, totalTokens: number, cost: number) => void;
    cleanOldUsageRecords: () => void;
    getUsageRecords: (characterId?: string, startDate?: number, endDate?: number) => UsageRecord[];

    // Backup
    mergeBackup: (data: ParsedBackup) => Promise<void>;
    restoreBackup: (data: ParsedBackup) => Promise<void>;

    // Helpers
    getCurrentRoom: () => Room | null;
    getRoomsForCharacter: (characterId: string) => Room[];
    getRoomsForSituation: (situationId: string) => Room[];
    getSituationParticipants: (room: Room) => SituationParticipant[];
    removeMemories: (characterId: string, memoriesToRemove: string[]) => void;
}

let currentRoomLoadSeq = 0;

// fire-and-forget helper for swallowing async errors
const fire = (p: Promise<unknown>) => { p.catch((e) => console.error('[db]', e)); };

function resolveCharacterModel(model: string | undefined, fallbackModel: string): string {
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    if (normalizedModel) return normalizedModel;
    return fallbackModel.trim() || DEFAULT_CHAT_MODEL;
}

function normalizeCharacterModel(character: Character, fallbackModel: string): Character {
    const model = resolveCharacterModel(character.model, fallbackModel);
    return model === character.model ? character : { ...character, model };
}

function normalizeCharacters(characters: Character[], fallbackModel: string): Character[] {
    return normalizeCharactersForCostumeDiffs(characters)
        .map((character) => normalizeCharacterModel(character, fallbackModel));
}

const DEFAULT_MEMORY_IMPORTANCE = 0.6;
const DEFAULT_MEMORY_CONFIDENCE = 0.85;
const MEMORY_SEARCH_LIMIT = 8;
const EMBEDDING_TIMEOUT_MS = 12_000;
const MEMORY_DUPLICATE_SIMILARITY_THRESHOLD = 0.7;

function normalizeMemoryContent(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function normalizeMemoryCompareKey(value: string): string {
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
    for (let i = 0; i < compact.length - 1; i++) {
        signals.add(compact.slice(i, i + 2));
    }
    return signals;
}

function memoryTextSimilarity(a: string, b: string): number {
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
        if (signalsB.has(signal)) overlap++;
    }
    return overlap / Math.min(signalsA.size, signalsB.size);
}

function inferMemoryKind(content: string): MemoryKind {
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

function createMemoryRecord(characterId: string, memory: string, options?: AddMemoryOptions): MemoryRecord | null {
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
    aiProviderConfig: AiProviderConfig,
): Promise<{ embedding: number[]; model: string } | null> {
    const trimmed = input.trim();
    if (!trimmed || typeof window === 'undefined') return null;
    if (aiProviderConfig.aiProvider === 'openai-compatible' && !aiProviderConfig.openAiCompatibleEmbeddingsEnabled) {
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
                aiProviderConfig,
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
    aiProviderConfig: AiProviderConfig,
): Promise<void> {
    const existing = await db.getMemoriesByCharacter(memory.characterId ?? '');
    const matched = existing.find((record) =>
        memoryTextSimilarity(record.content, memory.content) >= MEMORY_DUPLICATE_SIMILARITY_THRESHOLD
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
            const embedded = await requestMemoryEmbedding(nextMemory.content, embeddingModel, 'search_document', aiProviderConfig);
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
    const embedded = await requestMemoryEmbedding(memory.content, embeddingModel, 'search_document', aiProviderConfig);
    if (!embedded) return;
    await db.putMemory({
        ...memory,
        embedding: embedded.embedding,
        embeddingModel: embedded.model,
        updatedAt: Date.now(),
    });
}

async function duplicateDedicatedMemories(sourceCharacterId: string, nextCharacterId: string): Promise<void> {
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
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
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
        if (contentSignals.has(signal)) hits++;
    }
    return Math.min(1, hits / Math.min(querySignals.size, 12));
}

function memoryRecencyBoost(memory: MemoryRecord): number {
    const ageDays = Math.max(0, (Date.now() - memory.updatedAt) / 86_400_000);
    if (ageDays <= 1) return 1;
    if (ageDays >= 60) return 0;
    return 1 - ageDays / 60;
}

function scoreMemory(memory: MemoryRecord, query: string, queryEmbedding: number[] | null, embeddingModel: string): number {
    const lexical = lexicalMemorySimilarity(query, memory.content);
    const vector = queryEmbedding && memory.embedding && memory.embeddingModel === embeddingModel
        ? Math.max(0, cosineSimilarity(queryEmbedding, memory.embedding))
        : 0;
    const importance = Math.min(1, Math.max(0, memory.importance));
    const confidence = Math.min(1, Math.max(0, memory.confidence));
    const usage = Math.min(1, Math.log1p(memory.usageCount ?? 0) / Math.log(10));
    const recency = memoryRecencyBoost(memory);

    if (queryEmbedding && vector > 0) {
        return vector * 0.62 + lexical * 0.14 + importance * 0.12 + confidence * 0.06 + usage * 0.03 + recency * 0.03;
    }
    return lexical * 0.52 + importance * 0.22 + confidence * 0.12 + usage * 0.06 + recency * 0.08;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object';
}

function defaultGroupRoomName(_groupName: string, index: number): string {
    return `チャット ${index}`;
}

function createDefaultSituationDirector(model: string): SituationDirector {
    return {
        enabled: true,
        model,
        maxAutoTurns: 3,
        stopPolicy: 'max-turns',
    };
}

function normalizeSituationMaxHistory(maxHistory: unknown): number | undefined {
    if (typeof maxHistory !== 'number' || !Number.isFinite(maxHistory)) return undefined;
    return Math.max(1, Math.min(100, Math.round(maxHistory)));
}

function normalizeSituationDirector(director: Situation['director'] | undefined, fallbackModel: string): SituationDirector {
    const maxAutoTurns = Number.isFinite(director?.maxAutoTurns)
        ? Math.max(1, Math.min(10, Math.round(director!.maxAutoTurns)))
        : 3;
    const stopPolicy = director?.stopPolicy === 'after-one' ? 'after-one' : 'max-turns';
    const reasoningEffort = director?.reasoningEffort === 'medium' ? 'medium' : 'none';
    const model = director?.model?.trim() || fallbackModel;
    return {
        enabled: director?.enabled !== false,
        model,
        ...(director?.systemPrompt?.trim() ? { systemPrompt: director.systemPrompt.trim() } : {}),
        reasoningEffort,
        maxAutoTurns,
        stopPolicy,
    };
}

function normalizeSituationActor(rawActor: unknown, validCharacterIds: Set<string>, fallbackModel: string): SituationActor | null {
    if (!isRecord(rawActor)) return null;
    const type = rawActor.type;
    if (type === 'character') {
        const characterId = typeof rawActor.characterId === 'string' ? rawActor.characterId.trim() : '';
        if (!characterId || !validCharacterIds.has(characterId)) return null;
        const id = typeof rawActor.id === 'string' && rawActor.id.trim() ? rawActor.id.trim() : characterId;
        return {
            id,
            type: 'character',
            characterId,
            ...(typeof rawActor.rolePrompt === 'string' && rawActor.rolePrompt.trim() ? { rolePrompt: rawActor.rolePrompt.trim() } : {}),
            ...(typeof rawActor.directorDescription === 'string' && rawActor.directorDescription.trim() ? { directorDescription: rawActor.directorDescription.trim() } : {}),
        };
    }
    if (type === 'temporary') {
        const name = typeof rawActor.name === 'string' ? rawActor.name.trim() : '';
        if (!name) return null;
        const systemPrompt = typeof rawActor.systemPrompt === 'string' ? rawActor.systemPrompt.trim() : '';
        const id = typeof rawActor.id === 'string' && rawActor.id.trim() ? rawActor.id.trim() : generateId();
        return {
            id,
            type: 'temporary',
            name,
            systemPrompt,
            model: typeof rawActor.model === 'string' && rawActor.model.trim() ? rawActor.model.trim() : fallbackModel,
            ...(typeof rawActor.icon === 'string' && rawActor.icon ? { icon: rawActor.icon } : {}),
            ...(typeof rawActor.rolePrompt === 'string' && rawActor.rolePrompt.trim() ? { rolePrompt: rawActor.rolePrompt.trim() } : {}),
            ...(typeof rawActor.directorDescription === 'string' && rawActor.directorDescription.trim() ? { directorDescription: rawActor.directorDescription.trim() } : {}),
            ...(typeof rawActor.maxTokens === 'number' ? { maxTokens: rawActor.maxTokens } : {}),
            ...(typeof rawActor.maxHistory === 'number' ? { maxHistory: rawActor.maxHistory } : {}),
            ...(typeof rawActor.temperature === 'number' ? { temperature: rawActor.temperature } : {}),
            ...(typeof rawActor.topP === 'number' ? { topP: rawActor.topP } : {}),
            ...(typeof rawActor.topK === 'number' ? { topK: rawActor.topK } : {}),
            ...(rawActor.thinkModeEnabled === true ? { thinkModeEnabled: true } : {}),
            ...(Array.isArray(rawActor.expressions) ? { expressions: rawActor.expressions as Expression[] } : {}),
            ...(Array.isArray(rawActor.costumes) ? { costumes: rawActor.costumes as Costume[] } : {}),
        };
    }
    return null;
}

function uniqueSituationActors(actors: SituationActor[]): SituationActor[] {
    const seen = new Set<string>();
    return actors.filter((actor) => {
        const key = actor.id.trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function getSituationActorIds(situation: Pick<Situation, 'actors'>): string[] {
    return situation.actors.map((actor) => actor.id);
}

function normalizeSituationPriorMessages(messages: unknown, validActorIds: Set<string>): SituationPriorMessage[] {
    if (!Array.isArray(messages)) return [];

    const usedIds = new Set<string>();
    const normalized: SituationPriorMessage[] = [];
    for (const rawMessage of messages) {
        if (!rawMessage || typeof rawMessage !== 'object') continue;
        const message = rawMessage as Partial<SituationPriorMessage>;
        const content = typeof message.content === 'string' ? message.content.trim() : '';
        if (!content || (message.role !== 'user' && message.role !== 'assistant')) continue;

        const rawId = typeof message.id === 'string' ? message.id.trim() : '';
        const id = rawId && !usedIds.has(rawId) ? rawId : generateId();
        usedIds.add(id);
        if (message.role === 'user') {
            normalized.push({ id, role: 'user', content });
            continue;
        }

        const actorId = 'actorId' in message && typeof message.actorId === 'string'
            ? message.actorId
            : '';
        if (validActorIds.has(actorId)) {
            normalized.push({ id, role: 'assistant', content, actorId });
        }
    }
    return normalized;
}

function normalizeSituation(
    situation: Situation,
    validCharacterIds: Set<string>,
    fallbackModel: string,
    now = Date.now(),
    directorFallbackModel = fallbackModel,
): Situation | null {
    const actors = uniqueSituationActors(
        situation.actors
            .map((actor) => normalizeSituationActor(actor, validCharacterIds, fallbackModel))
            .filter((actor): actor is SituationActor => actor != null)
    );
    if (actors.length === 0) return null;

    const actorIds = actors.map((actor) => actor.id);
    const memoryMode: SituationMemoryMode = situation.memoryMode === 'readOnly' ? 'readOnly' : 'off';
    return {
        id: situation.id,
        name: situation.name?.trim() || 'シチュエーション',
        situationPrompt: situation.situationPrompt ?? '',
        priorMessages: normalizeSituationPriorMessages(situation.priorMessages, new Set(actorIds)),
        actors,
        director: normalizeSituationDirector(situation.director, directorFallbackModel),
        memoryMode,
        maxHistory: normalizeSituationMaxHistory(situation.maxHistory),
        createdAt: situation.createdAt ?? now,
        updatedAt: situation.updatedAt ?? now,
    };
}

export function resolveSituationParticipants(
    situation: Situation | null | undefined,
    characters: Character[],
    fallbackModel = DEFAULT_CHAT_MODEL,
): SituationParticipant[] {
    if (!situation) return [];
    const byId = new Map(characters.map((character) => [character.id, character]));
    return situation.actors
        .map((actor): SituationParticipant | null => {
            if (actor.type === 'character') {
                const character = byId.get(actor.characterId);
                if (!character) return null;
                return {
                    ...character,
                    id: actor.id,
                    actorId: actor.id,
                    actorType: 'character',
                    sourceCharacterId: character.id,
                    rolePrompt: actor.rolePrompt,
                    directorDescription: actor.directorDescription,
                };
            }
            const now = Date.now();
            return {
                id: actor.id,
                actorId: actor.id,
                actorType: 'temporary',
                name: actor.name,
                systemPrompt: actor.systemPrompt,
                model: actor.model?.trim() || fallbackModel,
                icon: actor.icon,
                maxTokens: actor.maxTokens,
                maxHistory: actor.maxHistory,
                temperature: actor.temperature,
                topP: actor.topP,
                topK: actor.topK,
                enableMemory: false,
                enableSummary: false,
                thinkModeEnabled: actor.thinkModeEnabled,
                expressions: actor.expressions,
                costumes: actor.costumes,
                createdAt: situation.createdAt ?? now,
                updatedAt: actor.id ? situation.updatedAt ?? now : now,
                rolePrompt: actor.rolePrompt,
                directorDescription: actor.directorDescription,
            };
        })
        .filter((participant): participant is SituationParticipant => participant != null);
}

function normalizeGroupData(params: {
    characters: Character[];
    groups: Situation[];
    rooms: Room[];
    fallbackModel?: string;
    directorFallbackModel?: string;
}): { groups: Situation[]; rooms: Room[]; changedGroups: Situation[]; changedRooms: Room[] } {
    const now = Date.now();
    const fallbackModel = params.fallbackModel?.trim() || DEFAULT_CHAT_MODEL;
    const directorFallbackModel = params.directorFallbackModel?.trim() || fallbackModel;
    const validCharacterIds = new Set(params.characters.map((c) => c.id));
    const groupsById = new Map<string, Situation>();
    const changedGroups: Situation[] = [];
    const changedRooms: Room[] = [];

    for (const group of params.groups) {
        const normalizedGroup = normalizeSituation(group, validCharacterIds, fallbackModel, now, directorFallbackModel);
        if (!normalizedGroup) continue;
        groupsById.set(normalizedGroup.id, normalizedGroup);
        if (JSON.stringify(normalizedGroup) !== JSON.stringify(group)) changedGroups.push(normalizedGroup);
    }

    const rooms = params.rooms.map((room) => {
        if (room.groupId && groupsById.has(room.groupId)) {
            const group = groupsById.get(room.groupId)!;
            const actorIds = getSituationActorIds(group);
            const next: Room = {
                ...room,
                characterId: actorIds[0],
            };
            if (next.characterId !== room.characterId) {
                changedRooms.push(next);
                return next;
            }
        }
        return room;
    });

    return {
        groups: [...groupsById.values()],
        rooms,
        changedGroups,
        changedRooms,
    };
}

// Cache theme to localStorage for no-flash first paint (synchronous access before IDB loads)
export const THEME_LS_KEY = 'kataru-theme';
const DEFAULT_THEME_SELECTION: ThemeSelection = { mode: 'dark', palette: 'classic' };
const DEFAULT_VN_TYPING_SPEED: VnTypingSpeed = 'default';
// Set these to numbers to apply defaults when a character or situation does not override them.
export const DEFAULT_CHARACTER_MAX_TOKENS: number | undefined = 1024;
export const DEFAULT_CHARACTER_MAX_HISTORY: number | undefined = 7;
export const DEFAULT_CHARACTER_TEMPERATURE = 1.0;
export const DEFAULT_CHARACTER_TOP_P: number | undefined = 0.95;
export const DEFAULT_CHARACTER_TOP_K = 15;

export function getThemeClassName(mode: ThemeMode, palette: ThemePalette) {
    return `mode-${mode} palette-${palette}`;
}

const isThemeMode = (value: unknown): value is ThemeMode => value === 'light' || value === 'dark';
const isThemePalette = (value: unknown): value is ThemePalette =>
    value === 'classic' ||
    value === 'sakura' ||
    value === 'sage' ||
    value === 'sky' ||
    value === 'amber' ||
    value === 'mono';
const isVnTypingSpeed = (value: unknown): value is VnTypingSpeed =>
    value === 'slow' || value === 'default' || value === 'fast' || value === 'streaming';

function resolveThemeSelection(params: {
    mode?: unknown;
    palette?: unknown;
}): ThemeSelection {
    return {
        mode: isThemeMode(params.mode) ? params.mode : DEFAULT_THEME_SELECTION.mode,
        palette: isThemePalette(params.palette) ? params.palette : DEFAULT_THEME_SELECTION.palette,
    };
}

const writeThemeCache = (mode: ThemeMode, palette: ThemePalette) => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(THEME_LS_KEY, `${mode}:${palette}`); } catch { /* ignore */ }
};

const DEBUG_LOG_LIMIT = 50;

function getAiProviderConfigFromState(state: Pick<AppState,
    'aiProvider' |
    'openAiCompatibleBaseUrl' |
    'openAiCompatibleEmbeddingsEnabled' |
    'openAiCompatibleImageGenerationEnabled'
>): AiProviderConfig {
    return {
        aiProvider: state.aiProvider,
        openAiCompatibleBaseUrl: normalizeOpenAiCompatibleBaseUrl(state.openAiCompatibleBaseUrl),
        openAiCompatibleEmbeddingsEnabled: state.openAiCompatibleEmbeddingsEnabled,
        openAiCompatibleImageGenerationEnabled: state.openAiCompatibleImageGenerationEnabled,
    };
}

export const useStore = create<AppState>()((set, get) => ({
    hydrated: false,
    themeMode: DEFAULT_THEME_SELECTION.mode,
    themePalette: DEFAULT_THEME_SELECTION.palette,
    vnTypingSpeed: DEFAULT_VN_TYPING_SPEED,
    summaryModel: DEFAULT_SUMMARY_MODEL,
    defaultChatModel: DEFAULT_CHAT_MODEL,
    defaultDirectorModel: DEFAULT_DIRECTOR_MODEL,
    defaultAutoGenerationModel: DEFAULT_AUTO_GENERATION_MODEL,
    titleGenerationModel: DEFAULT_TITLE_GENERATION_MODEL,
    defaultImageModel: DEFAULT_IMAGE_MODEL,
    memoryExtractionModel: DEFAULT_MEMORY_EXTRACTION_MODEL,
    memoryEmbeddingModel: DEFAULT_MEMORY_EMBEDDING_MODEL,
    generateTitleOnFirstReply: false,
    aiProvider: DEFAULT_AI_PROVIDER,
    openAiCompatibleBaseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    openAiCompatibleEmbeddingsEnabled: DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED,
    openAiCompatibleImageGenerationEnabled: DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED,
    thinkDebugEnabled: false,
    thinkDebugLogs: [],
    fullJsonDebugEnabled: false,
    fullJsonDebugLogs: [],
    characters: [],
    groups: [],
    rooms: [],
    currentRoomId: null,
    usageRecords: [],

    hydrate: async () => {
        if (get().hydrated) return;
        await db.migrateLegacyDatabase();
        const [loadedCharacters, storedGroups, storedRooms, usageRecords, themeMode, themePalette, currentRoomId, vnTypingSpeed, thinkDebugEnabled, fullJsonDebugEnabled, storedSummaryModel, storedDefaultChatModel, storedDefaultDirectorModel, storedDefaultAutoGenerationModel, storedTitleGenerationModel, storedDefaultImageModel, storedMemoryExtractionModel, storedMemoryEmbeddingModel, storedGenerateTitleOnFirstReply, storedAiProvider, storedOpenAiCompatibleBaseUrl, storedOpenAiCompatibleEmbeddingsEnabled, storedOpenAiCompatibleImageGenerationEnabled, legacyOpenAiCompatibleApiKey] = await Promise.all([
            db.getAllCharacters(),
            db.getAllGroups(),
            db.getAllRooms(),
            db.getAllUsageRecords(),
            db.getMeta<ThemeMode>('themeMode'),
            db.getMeta<ThemePalette>('themePalette'),
            db.getMeta<string | null>('currentRoomId'),
            db.getMeta<VnTypingSpeed>('vnTypingSpeed'),
            db.getMeta<boolean>('thinkDebugEnabled'),
            db.getMeta<boolean>('fullJsonDebugEnabled'),
            db.getMeta<string>('summaryModel'),
            db.getMeta<string>('defaultChatModel'),
            db.getMeta<string>('defaultDirectorModel'),
            db.getMeta<string>('defaultAutoGenerationModel'),
            db.getMeta<string>('titleGenerationModel'),
            db.getMeta<string>('defaultImageModel'),
            db.getMeta<string>('memoryExtractionModel'),
            db.getMeta<string>('memoryEmbeddingModel'),
            db.getMeta<boolean>('generateTitleOnFirstReply'),
            db.getMeta<AiProvider>('aiProvider'),
            db.getMeta<string>('openAiCompatibleBaseUrl'),
            db.getMeta<boolean>('openAiCompatibleEmbeddingsEnabled'),
            db.getMeta<boolean>('openAiCompatibleImageGenerationEnabled'),
            // Legacy client-side key; removed for security. Detect presence so we can delete it.
            db.getMeta<string>('openAiCompatibleApiKey'),
        ]);
        // Drop any previously stored client-side API key from IndexedDB.
        if (legacyOpenAiCompatibleApiKey !== undefined) {
            fire(db.deleteMeta('openAiCompatibleApiKey'));
        }
        const resolvedDefaultChatModel = typeof storedDefaultChatModel === 'string' && storedDefaultChatModel.trim()
            ? storedDefaultChatModel.trim()
            : DEFAULT_CHAT_MODEL;
        const characters = normalizeCharacters(loadedCharacters, resolvedDefaultChatModel);
        const changedCharacters = characters.filter((character, index) => character !== loadedCharacters[index]);
        if (changedCharacters.length > 0) {
            await Promise.all(changedCharacters.map((character) => db.putCharacter(character)));
        }
        const resolvedDefaultDirectorModel = typeof storedDefaultDirectorModel === 'string' && storedDefaultDirectorModel.trim()
            ? storedDefaultDirectorModel.trim()
            : resolvedDefaultChatModel || DEFAULT_DIRECTOR_MODEL;
        const normalized = normalizeGroupData({
            characters,
            groups: storedGroups,
            rooms: storedRooms.map((r) => ({ ...r, messages: [] })),
            fallbackModel: resolvedDefaultChatModel,
            directorFallbackModel: resolvedDefaultDirectorModel,
        });
        const groups = normalized.groups;
        const rooms: Room[] = normalized.rooms;
        for (const group of normalized.changedGroups) fire(db.putGroup(group));
        for (const room of normalized.changedRooms) fire(db.putRoom(toStoredRoom(room)));

        // Load messages for the current room only
        let resolvedCurrentRoomId: string | null = currentRoomId ?? null;
        if (resolvedCurrentRoomId && !rooms.find((r) => r.id === resolvedCurrentRoomId)) {
            resolvedCurrentRoomId = null;
        }
        if (resolvedCurrentRoomId) {
            const msgs = await db.getMessagesByRoom(resolvedCurrentRoomId);
            const idx = rooms.findIndex((r) => r.id === resolvedCurrentRoomId);
            if (idx >= 0) rooms[idx] = { ...rooms[idx], messages: msgs };
        }

        const resolvedTheme = resolveThemeSelection({
            mode: themeMode,
            palette: themePalette,
        });
        writeThemeCache(resolvedTheme.mode, resolvedTheme.palette);
        const resolvedVnTypingSpeed = isVnTypingSpeed(vnTypingSpeed) ? vnTypingSpeed : DEFAULT_VN_TYPING_SPEED;
        const resolvedSummaryModel = typeof storedSummaryModel === 'string' && storedSummaryModel.trim()
            ? storedSummaryModel.trim()
            : DEFAULT_SUMMARY_MODEL;
        if (themeMode !== resolvedTheme.mode) fire(db.setMeta('themeMode', resolvedTheme.mode));
        if (themePalette !== resolvedTheme.palette) fire(db.setMeta('themePalette', resolvedTheme.palette));
        if (vnTypingSpeed !== resolvedVnTypingSpeed) fire(db.setMeta('vnTypingSpeed', resolvedVnTypingSpeed));
        if (storedSummaryModel !== resolvedSummaryModel) fire(db.setMeta('summaryModel', resolvedSummaryModel));
        const resolvedDefaultImageModel = typeof storedDefaultImageModel === 'string' && storedDefaultImageModel.trim()
            ? storedDefaultImageModel.trim()
            : DEFAULT_IMAGE_MODEL;
        const resolvedDefaultAutoGenerationModel = typeof storedDefaultAutoGenerationModel === 'string' && storedDefaultAutoGenerationModel.trim()
            ? storedDefaultAutoGenerationModel.trim()
            : DEFAULT_AUTO_GENERATION_MODEL;
        const resolvedTitleGenerationModel = typeof storedTitleGenerationModel === 'string' && storedTitleGenerationModel.trim()
            ? storedTitleGenerationModel.trim()
            : DEFAULT_TITLE_GENERATION_MODEL;
        const resolvedMemoryExtractionModel = typeof storedMemoryExtractionModel === 'string' && storedMemoryExtractionModel.trim()
            ? storedMemoryExtractionModel.trim()
            : DEFAULT_MEMORY_EXTRACTION_MODEL;
        const resolvedMemoryEmbeddingModel = typeof storedMemoryEmbeddingModel === 'string' && storedMemoryEmbeddingModel.trim()
            ? storedMemoryEmbeddingModel.trim()
            : DEFAULT_MEMORY_EMBEDDING_MODEL;
        const resolvedGenerateTitleOnFirstReply = storedGenerateTitleOnFirstReply === true;
        const resolvedAiProvider = isAiProvider(storedAiProvider) ? storedAiProvider : DEFAULT_AI_PROVIDER;
        const resolvedOpenAiCompatibleBaseUrl = normalizeOpenAiCompatibleBaseUrl(storedOpenAiCompatibleBaseUrl);
        const resolvedOpenAiCompatibleEmbeddingsEnabled = typeof storedOpenAiCompatibleEmbeddingsEnabled === 'boolean'
            ? storedOpenAiCompatibleEmbeddingsEnabled
            : DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED;
        const resolvedOpenAiCompatibleImageGenerationEnabled = typeof storedOpenAiCompatibleImageGenerationEnabled === 'boolean'
            ? storedOpenAiCompatibleImageGenerationEnabled
            : DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED;
        if (storedDefaultChatModel !== resolvedDefaultChatModel) fire(db.setMeta('defaultChatModel', resolvedDefaultChatModel));
        if (storedDefaultDirectorModel !== resolvedDefaultDirectorModel) fire(db.setMeta('defaultDirectorModel', resolvedDefaultDirectorModel));
        if (storedDefaultAutoGenerationModel !== resolvedDefaultAutoGenerationModel) fire(db.setMeta('defaultAutoGenerationModel', resolvedDefaultAutoGenerationModel));
        if (storedTitleGenerationModel !== resolvedTitleGenerationModel) fire(db.setMeta('titleGenerationModel', resolvedTitleGenerationModel));
        if (storedDefaultImageModel !== resolvedDefaultImageModel) fire(db.setMeta('defaultImageModel', resolvedDefaultImageModel));
        if (storedMemoryExtractionModel !== resolvedMemoryExtractionModel) fire(db.setMeta('memoryExtractionModel', resolvedMemoryExtractionModel));
        if (storedMemoryEmbeddingModel !== resolvedMemoryEmbeddingModel) fire(db.setMeta('memoryEmbeddingModel', resolvedMemoryEmbeddingModel));
        if (storedGenerateTitleOnFirstReply !== resolvedGenerateTitleOnFirstReply) fire(db.setMeta('generateTitleOnFirstReply', resolvedGenerateTitleOnFirstReply));
        if (storedAiProvider !== resolvedAiProvider) fire(db.setMeta('aiProvider', resolvedAiProvider));
        if (storedOpenAiCompatibleBaseUrl !== resolvedOpenAiCompatibleBaseUrl) fire(db.setMeta('openAiCompatibleBaseUrl', resolvedOpenAiCompatibleBaseUrl));
        if (storedOpenAiCompatibleEmbeddingsEnabled !== resolvedOpenAiCompatibleEmbeddingsEnabled) fire(db.setMeta('openAiCompatibleEmbeddingsEnabled', resolvedOpenAiCompatibleEmbeddingsEnabled));
        if (storedOpenAiCompatibleImageGenerationEnabled !== resolvedOpenAiCompatibleImageGenerationEnabled) fire(db.setMeta('openAiCompatibleImageGenerationEnabled', resolvedOpenAiCompatibleImageGenerationEnabled));
        set({
            hydrated: true,
            characters,
            groups,
            rooms,
            usageRecords,
            themeMode: resolvedTheme.mode,
            themePalette: resolvedTheme.palette,
            vnTypingSpeed: resolvedVnTypingSpeed,
            summaryModel: resolvedSummaryModel,
            defaultChatModel: resolvedDefaultChatModel,
            defaultDirectorModel: resolvedDefaultDirectorModel,
            defaultAutoGenerationModel: resolvedDefaultAutoGenerationModel,
            titleGenerationModel: resolvedTitleGenerationModel,
            defaultImageModel: resolvedDefaultImageModel,
            memoryExtractionModel: resolvedMemoryExtractionModel,
            memoryEmbeddingModel: resolvedMemoryEmbeddingModel,
            generateTitleOnFirstReply: resolvedGenerateTitleOnFirstReply,
            aiProvider: resolvedAiProvider,
            openAiCompatibleBaseUrl: resolvedOpenAiCompatibleBaseUrl,
            openAiCompatibleEmbeddingsEnabled: resolvedOpenAiCompatibleEmbeddingsEnabled,
            openAiCompatibleImageGenerationEnabled: resolvedOpenAiCompatibleImageGenerationEnabled,
            thinkDebugEnabled: thinkDebugEnabled === true,
            thinkDebugLogs: [],
            fullJsonDebugEnabled: fullJsonDebugEnabled === true,
            fullJsonDebugLogs: [],
            currentRoomId: resolvedCurrentRoomId,
        });
    },

    setThemeMode: (themeMode) => {
        set({ themeMode });
        writeThemeCache(themeMode, get().themePalette);
        fire(db.setMeta('themeMode', themeMode));
    },
    setThemePalette: (themePalette) => {
        set({ themePalette });
        writeThemeCache(get().themeMode, themePalette);
        fire(db.setMeta('themePalette', themePalette));
    },
    toggleThemeMode: () => {
        const next: ThemeMode = get().themeMode === 'light' ? 'dark' : 'light';
        get().setThemeMode(next);
    },
    toggleTheme: () => {
        get().toggleThemeMode();
    },
    setVnTypingSpeed: (vnTypingSpeed) => {
        set({ vnTypingSpeed });
        fire(db.setMeta('vnTypingSpeed', vnTypingSpeed));
    },
    setSummaryModel: (summaryModel) => {
        set({ summaryModel });
        fire(db.setMeta('summaryModel', summaryModel));
    },
    setThinkDebugEnabled: (thinkDebugEnabled) => {
        set({ thinkDebugEnabled });
        fire(db.setMeta('thinkDebugEnabled', thinkDebugEnabled));
    },
    setFullJsonDebugEnabled: (fullJsonDebugEnabled) => {
        set({ fullJsonDebugEnabled });
        fire(db.setMeta('fullJsonDebugEnabled', fullJsonDebugEnabled));
    },

    setDefaultChatModel: (defaultChatModel) => {
        set({ defaultChatModel });
        fire(db.setMeta('defaultChatModel', defaultChatModel));
    },
    setDefaultDirectorModel: (defaultDirectorModel) => {
        set({ defaultDirectorModel });
        fire(db.setMeta('defaultDirectorModel', defaultDirectorModel));
    },
    setDefaultAutoGenerationModel: (defaultAutoGenerationModel) => {
        set({ defaultAutoGenerationModel });
        fire(db.setMeta('defaultAutoGenerationModel', defaultAutoGenerationModel));
    },
    setTitleGenerationModel: (titleGenerationModel) => {
        set({ titleGenerationModel });
        fire(db.setMeta('titleGenerationModel', titleGenerationModel));
    },
    setDefaultImageModel: (defaultImageModel) => {
        set({ defaultImageModel });
        fire(db.setMeta('defaultImageModel', defaultImageModel));
    },
    setMemoryExtractionModel: (memoryExtractionModel) => {
        set({ memoryExtractionModel });
        fire(db.setMeta('memoryExtractionModel', memoryExtractionModel));
    },
    setMemoryEmbeddingModel: (memoryEmbeddingModel) => {
        set({ memoryEmbeddingModel });
        fire(db.setMeta('memoryEmbeddingModel', memoryEmbeddingModel));
    },
    setGenerateTitleOnFirstReply: (generateTitleOnFirstReply) => {
        set({ generateTitleOnFirstReply });
        fire(db.setMeta('generateTitleOnFirstReply', generateTitleOnFirstReply));
    },
    setAiProvider: (aiProvider) => {
        set({ aiProvider });
        fire(db.setMeta('aiProvider', aiProvider));
    },
    setOpenAiCompatibleBaseUrl: (openAiCompatibleBaseUrl) => {
        const normalized = normalizeOpenAiCompatibleBaseUrl(openAiCompatibleBaseUrl);
        set({ openAiCompatibleBaseUrl: normalized });
        fire(db.setMeta('openAiCompatibleBaseUrl', normalized));
    },
    setOpenAiCompatibleEmbeddingsEnabled: (openAiCompatibleEmbeddingsEnabled) => {
        set({ openAiCompatibleEmbeddingsEnabled });
        fire(db.setMeta('openAiCompatibleEmbeddingsEnabled', openAiCompatibleEmbeddingsEnabled));
    },
    setOpenAiCompatibleImageGenerationEnabled: (openAiCompatibleImageGenerationEnabled) => {
        set({ openAiCompatibleImageGenerationEnabled });
        fire(db.setMeta('openAiCompatibleImageGenerationEnabled', openAiCompatibleImageGenerationEnabled));
    },
    getAiProviderConfig: () => getAiProviderConfigFromState(get()),
    createCharacter: (name, systemPrompt = '', model = get().defaultChatModel, extras) => {
        const id = generateId();
        const now = Date.now();
        const character: Character = {
            id,
            name,
            systemPrompt,
            ...(extras ?? {}),
            model: resolveCharacterModel(model, get().defaultChatModel),
            createdAt: now,
            updatedAt: now,
        };
        set((state) => ({ characters: [...state.characters, character] }));
        fire(db.putCharacter(character));
        return id;
    },

    updateCharacter: (id, updates) => {
        let updated: Character | undefined;
        const normalizedUpdates = 'model' in updates
            ? { ...updates, model: resolveCharacterModel(updates.model, get().defaultChatModel) }
            : updates;
        set((state) => ({
            characters: state.characters.map((c) => {
                if (c.id !== id) return c;
                updated = { ...c, ...normalizedUpdates, updatedAt: Date.now() };
                return updated;
            }),
        }));
        if (updated) fire(db.putCharacter(updated));
    },

    deleteCharacter: (id) => {
        const state = get();
        const now = Date.now();
        const validCharacterIds = new Set(state.characters.map((c) => c.id).filter((cid) => cid !== id));
        const groupResolution = new Map<string, { type: 'keep'; group: Situation; removedActorIds: string[] } | { type: 'delete'; removedActorIds: string[] }>();
        const updatedGroups: Situation[] = [];
        const groupsToDelete: string[] = [];
        const nextGroups: Situation[] = [];

        for (const group of state.groups) {
            const removedActorIds = group.actors
                .filter((actor) => actor.type === 'character' && actor.characterId === id)
                .map((actor) => actor.id);
            if (removedActorIds.length === 0) {
                nextGroups.push(group);
                continue;
            }

            const remainingActors = group.actors
                .filter((actor) => !(actor.type === 'character' && actor.characterId === id))
                .map((actor) => normalizeSituationActor(actor, validCharacterIds, get().defaultChatModel))
                .filter((actor): actor is SituationActor => actor != null);
            if (remainingActors.length > 0) {
                const nextGroup = {
                    ...group,
                    actors: remainingActors,
                    updatedAt: now,
                };
                nextGroups.push(nextGroup);
                updatedGroups.push(nextGroup);
                groupResolution.set(group.id, { type: 'keep', group: nextGroup, removedActorIds });
            } else {
                groupsToDelete.push(group.id);
                groupResolution.set(group.id, { type: 'delete', removedActorIds });
            }
        }

        const updatedRooms: Room[] = [];
        const roomsToDelete: string[] = [];
        const roomsToUpdate: Room[] = [];
        for (const r of state.rooms) {
            const nextSelections = { ...(r.costumeSelections ?? {}) };
            delete nextSelections[id];
            const resolution = r.groupId ? groupResolution.get(r.groupId) : undefined;
            for (const removedActorId of resolution?.removedActorIds ?? []) {
                delete nextSelections[removedActorId];
            }
            const costumeSelections = Object.keys(nextSelections).length > 0 ? nextSelections : undefined;

            if (r.groupId && resolution) {
                if (resolution.type === 'keep') {
                    const actorIds = getSituationActorIds(resolution.group);
                    const next = {
                        ...r,
                        characterId: actorIds[0],
                        costumeSelections,
                    };
                    updatedRooms.push(next);
                    roomsToUpdate.push(next);
                } else {
                    roomsToDelete.push(r.id);
                }
            } else if (r.characterId === id) {
                roomsToDelete.push(r.id);
            } else {
                updatedRooms.push(r);
            }
        }
        const nextCurrent = roomsToDelete.includes(state.currentRoomId || '')
            ? null
            : state.currentRoomId;
        set({
            characters: state.characters.filter((c) => c.id !== id),
            groups: nextGroups,
            rooms: updatedRooms,
            currentRoomId: nextCurrent,
        });
        fire(db.deleteCharacter(id));
        for (const gid of groupsToDelete) fire(db.deleteGroup(gid));
        for (const g of updatedGroups) fire(db.putGroup(g));
        for (const rid of roomsToDelete) fire(db.deleteRoom(rid));
        for (const r of roomsToUpdate) {
            if (shouldPersistRoom(r)) fire(db.putRoom(toStoredRoom(r)));
        }
        if (nextCurrent !== state.currentRoomId) {
            fire(db.setMeta('currentRoomId', nextCurrent));
        }
    },

    duplicateCharacter: (id) => {
        const source = get().characters.find((c) => c.id === id);
        if (!source) return '';
        const newId = generateId();
        const now = Date.now();
        const baseName = source.name.replace(/\s*\(\d+\)$/, '');
        const existingNames = new Set(get().characters.map((c) => c.name));
        let n = 1;
        while (existingNames.has(`${baseName} (${n})`)) n++;
        const newName = `${baseName} (${n})`;
        const next: Character = {
            ...source,
            id: newId,
            name: newName,
            model: resolveCharacterModel(source.model, get().defaultChatModel),
            createdAt: now,
            updatedAt: now,
        };
        set((state) => ({ characters: [...state.characters, next] }));
        fire(db.putCharacter(next));
        fire(duplicateDedicatedMemories(source.id, newId));
        return newId;
    },

    getCharacter: (id) => get().characters.find((c) => c.id === id),

    addThinkDebugLog: (log) => {
        const thinking = log.thinking.trim();
        if (!thinking) return;
        const entry: ThinkDebugLog = {
            ...log,
            thinking,
            id: generateId(),
            createdAt: Date.now(),
        };
        set((state) => ({
            thinkDebugLogs: [entry, ...state.thinkDebugLogs].slice(0, DEBUG_LOG_LIMIT),
        }));
    },

    clearThinkDebugLogs: () => {
        set({ thinkDebugLogs: [] });
    },

    addFullJsonDebugLog: (log) => {
        const json = log.json.trim();
        if (!json) return;
        const entry: FullJsonDebugLog = {
            ...log,
            json,
            id: generateId(),
            createdAt: Date.now(),
        };
        set((state) => ({
            fullJsonDebugLogs: [entry, ...state.fullJsonDebugLogs].slice(0, DEBUG_LOG_LIMIT),
        }));
    },

    clearFullJsonDebugLogs: () => {
        set({ fullJsonDebugLogs: [] });
    },

    addMemory: async (characterId, memory, options) => {
        const content = normalizeMemoryContent(memory);
        if (!content) return;
        const record = createMemoryRecord(characterId, content, options);
        if (!record) return;
        const state = get();
        await persistMemoryWithEmbedding(record, state.memoryEmbeddingModel, getAiProviderConfigFromState(state));
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
                    const memories = message.memories.filter((content) => normalizeMemoryContent(content) !== removedContent);
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
                    const memories = message.memories.filter((content) => !normalizedContents.has(normalizeMemoryContent(content)));
                    if (memories.length === message.memories.length) return message;
                    return { ...message, memories: memories.length > 0 ? memories : undefined };
                }),
            })),
        }));
    },

    listMemoriesForCharacter: async (characterId) => {
        return db.getMemoriesByCharacter(characterId);
    },

    searchRelevantMemories: async ({ characterId, roomId, recentMessageIds, query, limit = MEMORY_SEARCH_LIMIT }) => {
        const candidates = await db.getSearchableMemories({ characterId, roomId, recentMessageIds });
        if (candidates.length === 0) return [];

        const embeddingModel = get().memoryEmbeddingModel;
        const queryEmbeddingResult = await requestMemoryEmbedding(
            query,
            embeddingModel,
            'search_query',
            getAiProviderConfigFromState(get()),
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

    createRoom: (characterId, name, options) => {
        const id = generateId();
        const now = Date.now();
        const character = get().characters.find((c) => c.id === characterId);
        const explicitName = name?.trim();
        const roomCountForChar = get().rooms.filter((r) =>
            shouldShowRoomInHistory(r) &&
            r.characterId === characterId &&
            !r.groupId
        ).length;
        const room: Room = {
            id,
            characterId,
            name: explicitName || (get().generateTitleOnFirstReply ? '' : `${character?.name || 'Chat'} ${roomCountForChar + 1}`),
            messages: [],
            viewMode: options?.viewMode,
            isDraft: true,
            createdAt: now,
            updatedAt: now,
        };
        set((state) => ({
            rooms: [...state.rooms.filter((r) => !r.isDraft), room],
            currentRoomId: id,
        }));
        return id;
    },

    createSituationRoom: (input) => {
        const validCharacterIds = new Set(get().characters.map((c) => c.id));
        const actors = uniqueSituationActors(
            input.actors
                .map((actor) => normalizeSituationActor(actor, validCharacterIds, get().defaultChatModel))
                .filter((actor): actor is SituationActor => actor != null)
        );
        if (actors.length === 0) return '';

        const groupId = generateId();
        const roomId = generateId();
        const now = Date.now();
        const actorIds = actors.map((actor) => actor.id);
        const explicitRoomName = input.roomName?.trim();
        const characterActorIds = actors
            .filter((actor) => actor.type === 'character')
            .map((actor) => actor.characterId);
        const characterNames = new Map(get().characters.map((character) => [character.id, character.name]));
        const resolvedGroupName = input.name?.trim()
            || characterActorIds.map((id) => characterNames.get(id)).filter(Boolean).join(' & ')
            || 'シチュエーション';
        const group: Situation = {
            id: groupId,
            name: resolvedGroupName,
            situationPrompt: input.situationPrompt?.trim() ?? '',
            priorMessages: normalizeSituationPriorMessages(input.priorMessages, new Set(actorIds)),
            actors,
            director: normalizeSituationDirector({
                ...createDefaultSituationDirector(get().defaultDirectorModel),
                ...(input.director ?? {}),
            }, get().defaultDirectorModel),
            memoryMode: input.memoryMode === 'readOnly' ? 'readOnly' : 'off',
            maxHistory: normalizeSituationMaxHistory(input.maxHistory),
            createdAt: now,
            updatedAt: now,
        };
        const room: Room = {
            id: roomId,
            characterId: actorIds[0],
            groupId,
            name: explicitRoomName || (get().generateTitleOnFirstReply ? '' : defaultGroupRoomName(resolvedGroupName, 1)),
            messages: [],
            isDraft: true,
            createdAt: now,
            updatedAt: now,
        };
        set((state) => ({
            groups: [...state.groups, group],
            rooms: [...state.rooms.filter((r) => !r.isDraft), room],
            currentRoomId: roomId,
        }));
        fire(db.putGroup(group));
        return roomId;
    },

    createRoomForSituation: (groupId, name, options) => {
        const group = get().groups.find((g) => g.id === groupId);
        const actorIds = group ? getSituationActorIds(group) : [];
        if (!group || actorIds.length === 0) return '';

        const id = generateId();
        const now = Date.now();
        const explicitName = name?.trim();
        const roomCountForGroup = get().rooms.filter((r) => shouldShowRoomInHistory(r) && r.groupId === groupId).length;
        const room: Room = {
            id,
            characterId: actorIds[0],
            groupId,
            name: explicitName || (get().generateTitleOnFirstReply ? '' : defaultGroupRoomName(group.name, roomCountForGroup + 1)),
            messages: [],
            viewMode: options?.viewMode,
            isDraft: true,
            createdAt: now,
            updatedAt: now,
        };
        const updatedGroup = { ...group, updatedAt: now };
        set((state) => ({
            groups: state.groups.map((g) => (g.id === groupId ? updatedGroup : g)),
            rooms: [...state.rooms.filter((r) => !r.isDraft), room],
            currentRoomId: id,
        }));
        fire(db.putGroup(updatedGroup));
        return id;
    },

    deleteRoom: (id) => {
        const state = get();
        const roomToDelete = state.rooms.find((r) => r.id === id);
        const shouldDeleteGroup = !!roomToDelete?.groupId &&
            state.rooms.filter((r) => r.groupId === roomToDelete.groupId && r.id !== id).length === 0;
        const nextCurrent = state.currentRoomId === id ? null : state.currentRoomId;
        set({
            groups: shouldDeleteGroup
                ? state.groups.filter((g) => g.id !== roomToDelete!.groupId)
                : state.groups,
            rooms: state.rooms.filter((r) => r.id !== id),
            currentRoomId: nextCurrent,
        });
        fire(db.deleteRoom(id));
        if (shouldDeleteGroup) fire(db.deleteGroup(roomToDelete!.groupId!));
        if (nextCurrent !== state.currentRoomId) {
            fire(db.setMeta('currentRoomId', nextCurrent));
        }
    },

    deleteSituation: (id) => {
        const state = get();
        const roomIds = state.rooms.filter((r) => r.groupId === id).map((r) => r.id);
        const nextCurrent = roomIds.includes(state.currentRoomId || '') ? null : state.currentRoomId;
        set({
            groups: state.groups.filter((g) => g.id !== id),
            rooms: state.rooms.filter((r) => r.groupId !== id),
            currentRoomId: nextCurrent,
        });
        fire(db.deleteGroup(id));
        for (const roomId of roomIds) fire(db.deleteRoom(roomId));
        if (nextCurrent !== state.currentRoomId) {
            fire(db.setMeta('currentRoomId', nextCurrent));
        }
    },

    setCurrentRoom: async (id) => {
        const loadSeq = ++currentRoomLoadSeq;
        const prevId = get().currentRoomId;

        set((state) => ({
            currentRoomId: id,
            rooms: prevId && prevId !== id
                ? state.rooms.map((r) => {
                    if (r.id !== prevId) return r;
                    return r.secretMode === true
                        ? { ...r, messages: [], summary: undefined, summaryCheckpointUserMessageId: undefined, lastMessagePreview: undefined, lastMessageAt: undefined }
                        : { ...r, messages: [] };
                })
                : state.rooms,
        }));
        const selectedRoom = get().rooms.find((r) => r.id === id);
        if (!id) {
            fire(db.setMeta('currentRoomId', null));
        } else if (shouldPersistRoom(selectedRoom)) {
            fire(db.setMeta('currentRoomId', id));
        }

        if (!id || !get().rooms.some((r) => r.id === id)) return;

        const msgs = await db.getMessagesByRoom(id);
        if (loadSeq !== currentRoomLoadSeq || get().currentRoomId !== id) return;

        set((state) => ({
            rooms: state.rooms.map((r) => (r.id === id ? { ...r, messages: msgs } : r)),
        }));
    },

    updateSituation: (id, updates) => {
        let updated: Situation | undefined;
        const updatedRooms: Room[] = [];
        set((state) => ({
            ...(() => {
                const now = Date.now();
                const validCharacterIds = new Set(state.characters.map((c) => c.id));
                const groups = state.groups.map((g) => {
                    if (g.id !== id) return g;
                    const normalizedActors = updates.actors
                        ? uniqueSituationActors(
                            updates.actors
                                .map((actor) => normalizeSituationActor(actor, validCharacterIds, state.defaultChatModel))
                                .filter((actor): actor is SituationActor => actor != null)
                        )
                        : g.actors;
                    const nextActors = normalizedActors.length > 0 ? normalizedActors : g.actors;
                    const nextActorIds = new Set(nextActors.map((actor) => actor.id));
                    updated = {
                        ...g,
                        ...updates,
                        actors: nextActors,
                        ...(updates.director ? { director: normalizeSituationDirector(updates.director, state.defaultDirectorModel) } : {}),
                        priorMessages: normalizeSituationPriorMessages(
                            'priorMessages' in updates ? updates.priorMessages : g.priorMessages,
                            nextActorIds,
                        ),
                        memoryMode: updates.memoryMode === 'readOnly' ? 'readOnly' : updates.memoryMode === 'off' ? 'off' : g.memoryMode ?? 'off',
                        maxHistory: 'maxHistory' in updates ? normalizeSituationMaxHistory(updates.maxHistory) : g.maxHistory,
                        updatedAt: now,
                    };
                    return updated;
                });

                if (!updated) return { groups };

                const actorIds = getSituationActorIds(updated);
                const actorIdSet = new Set(actorIds);
                if (actorIds.length === 0) return { groups };

                const rooms = state.rooms.map((r) => {
                    if (r.groupId !== id) return r;
                    const costumeSelections = r.costumeSelections
                        ? Object.fromEntries(
                            Object.entries(r.costumeSelections)
                                .filter(([actorId]) => actorIdSet.has(actorId))
                        )
                        : undefined;
                    const nextRoom: Room = {
                        ...r,
                        characterId: actorIdSet.has(r.characterId) ? r.characterId : actorIds[0],
                        costumeSelections: costumeSelections && Object.keys(costumeSelections).length > 0 ? costumeSelections : undefined,
                        updatedAt: now,
                    };
                    updatedRooms.push(nextRoom);
                    return nextRoom;
                });

                return { groups, rooms };
            })(),
        }));
        if (updated) {
            fire(db.putGroup(updated));
        }
        for (const r of updatedRooms) {
            if (shouldPersistRoom(r)) fire(db.putRoom(toStoredRoom(r)));
        }
    },

    updateRoomName: (id, name) => {
        let updated: Room | undefined;
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== id) return r;
                updated = { ...r, name, updatedAt: Date.now() };
                return updated;
            }),
        }));
        if (shouldPersistRoom(updated)) {
            fire(db.putRoom(toStoredRoom(updated)));
        }
    },

    updateRoomSettings: (id, updates) => {
        let updated: Room | undefined;
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== id) return r;
                updated = { ...r, ...updates, updatedAt: Date.now() };
                return updated;
            }),
        }));
        if (shouldPersistRoom(updated)) {
            fire(db.putRoom(toStoredRoom(updated)));
        }
    },

    setRoomSecretMode: (id, enabled) => {
        let updatedRoom: Room | undefined;
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== id || r.messages.length > 0) return r;
                updatedRoom = {
                    ...r,
                    secretMode: enabled || undefined,
                    summary: enabled ? undefined : r.summary,
                    summaryCheckpointUserMessageId: enabled ? undefined : r.summaryCheckpointUserMessageId,
                    lastMessagePreview: enabled ? undefined : r.lastMessagePreview,
                    lastMessageAt: enabled ? undefined : r.lastMessageAt,
                };
                return updatedRoom;
            }),
        }));
        if (!updatedRoom) return;
        if (enabled) {
            fire(db.deleteRoomHistory(id));
            fire(db.setMeta('currentRoomId', null));
        } else if (shouldPersistRoom(updatedRoom)) {
            fire(db.putRoom(toStoredRoom(updatedRoom)));
            fire(db.setMeta('currentRoomId', id));
        }
    },

    addMessage: (roomId, role, content, characterId, meta) => {
        const now = Date.now();
        const memories = meta?.memories
            ?.map((memory) => memory.trim())
            .filter(Boolean);
        const toCharacterIds = meta?.toCharacterIds
            ?.map((id) => id.trim())
            .filter(Boolean);
        const message: Message = {
            id: generateId(),
            role,
            content,
            ...(characterId ? { characterId } : {}),
            ...(toCharacterIds && toCharacterIds.length > 0 ? { toCharacterIds } : {}),
            ...(meta?.expression ? { expression: meta.expression } : {}),
            ...(memories && memories.length > 0 ? { memories } : {}),
            timestamp: now,
        };
        let updatedRoom: Room | undefined;
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== roomId) return r;
                const isSecret = r.secretMode === true;
                updatedRoom = {
                    ...r,
                    isDraft: isSecret ? r.isDraft : undefined,
                    messages: [...r.messages, message],
                    ...(isSecret ? {} : {
                        lastMessagePreview: toPreview(content),
                        lastMessageAt: now,
                        updatedAt: now,
                    }),
                };
                return updatedRoom;
            }),
        }));
        if (shouldPersistRoom(updatedRoom)) {
            fire(db.putMessage(roomId, message));
            fire(db.putRoom(toStoredRoom(updatedRoom)));
            fire(db.setMeta('currentRoomId', roomId));
        }
        return message.id;
    },

    deleteLastMessage: (roomId) => {
        let removedId: string | undefined;
        let updatedRoom: Room | undefined;
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== roomId) return r;
                const messages = [...r.messages];
                const removed = messages.pop();
                removedId = removed?.id;
                const newLast = messages[messages.length - 1];
                updatedRoom = r.secretMode === true
                    ? { ...r, messages }
                    : {
                        ...r,
                        messages,
                        lastMessagePreview: newLast ? toPreview(newLast.content) : undefined,
                        lastMessageAt: newLast?.timestamp,
                        updatedAt: Date.now(),
                    };
                return updatedRoom;
            }),
        }));
        if (shouldPersistRoom(updatedRoom) && removedId) {
            fire(db.deleteMessage(removedId));
            fire(db.deleteMemoriesBySourceMessageIds([removedId]));
            fire(db.putRoom(toStoredRoom(updatedRoom)));
        }
    },

    deleteMessagesFrom: async (roomId, fromIndex) => {
        let removedIds: string[] = [];
        let removedMessages: Message[] = [];
        let updatedRoom: Room | undefined;
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== roomId) return r;
                removedMessages = r.messages.slice(fromIndex);
                removedIds = removedMessages.map((message) => message.id);
                const messages = r.messages.slice(0, fromIndex);
                const newLast = messages[messages.length - 1];
                updatedRoom = r.secretMode === true
                    ? { ...r, messages }
                    : {
                        ...r,
                        messages,
                        lastMessagePreview: newLast ? toPreview(newLast.content) : undefined,
                        lastMessageAt: newLast?.timestamp,
                        updatedAt: Date.now(),
                    };
                return updatedRoom;
            }),
        }));
        if (shouldPersistRoom(updatedRoom)) {
            const sourceMemories = removedIds.length > 0
                ? await db.getMemoriesBySourceMessageIds(removedIds)
                : [];
            const legacyMemoryContentsByCharacter = new Map<string, Set<string>>();
            for (const message of removedMessages) {
                if (message.role !== 'assistant' || !message.characterId) continue;
                const contents = message.memories?.map(normalizeMemoryContent).filter(Boolean) ?? [];
                if (contents.length === 0) continue;
                const existingContents = legacyMemoryContentsByCharacter.get(message.characterId) ?? new Set<string>();
                for (const content of contents) existingContents.add(content);
                legacyMemoryContentsByCharacter.set(message.characterId, existingContents);
            }
            const legacyMemories = (await Promise.all(
                [...legacyMemoryContentsByCharacter].map(async ([characterId, contents]) => {
                    const characterMemories = await db.getMemoriesByCharacter(characterId);
                    return characterMemories.filter((memory) =>
                        (memory.sourceMessageIds ?? []).length === 0 &&
                        contents.has(normalizeMemoryContent(memory.content))
                    );
                })
            )).flat();
            const removedMemories = [...new Map(
                [...sourceMemories, ...legacyMemories].map((memory) => [memory.id, memory])
            ).values()];
            await Promise.all([
                ...(removedIds.length > 0 ? [
                    db.deleteMessagesByIds(removedIds),
                    db.deleteMemoriesBySourceMessageIds(removedIds),
                ] : []),
                db.deleteMemories(legacyMemories.map((memory) => memory.id)),
                db.putRoom(toStoredRoom(updatedRoom)),
            ]);
            return removedMemories;
        }
        return [];
    },

    restoreMessagesAt: async (roomId, fromIndex, messages, memories = []) => {
        let updatedRoom: Room | undefined;
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== roomId) return r;
                const restored = [...r.messages.slice(0, fromIndex), ...messages];
                const newLast = restored[restored.length - 1];
                updatedRoom = r.secretMode === true
                    ? { ...r, messages: restored }
                    : {
                        ...r,
                        messages: restored,
                        lastMessagePreview: newLast ? toPreview(newLast.content) : undefined,
                        lastMessageAt: newLast?.timestamp,
                        updatedAt: Date.now(),
                    };
                return updatedRoom;
            }),
        }));
        if (shouldPersistRoom(updatedRoom)) {
            await Promise.all([
                db.putRoom(toStoredRoom(updatedRoom)),
                db.putMessages(roomId, messages),
                db.putMemories(memories),
            ]);
        }
    },

    attachMemoriesToMessage: (roomId, messageId, memoriesToAttach) => {
        const normalizedMemories = [...new Set(
            memoriesToAttach.map((memory) => normalizeMemoryContent(memory)).filter(Boolean)
        )];
        if (normalizedMemories.length === 0) return;

        let updatedRoom: Room | undefined;
        let updatedMessage: Message | undefined;
        set((state) => ({
            rooms: state.rooms.map((room) => {
                if (room.id !== roomId) return room;
                const messages = room.messages.map((message) => {
                    if (message.id !== messageId || message.role !== 'assistant') return message;
                    const nextMemories = [...new Set([...(message.memories ?? []), ...normalizedMemories])];
                    updatedMessage = { ...message, memories: nextMemories };
                    return updatedMessage;
                });
                updatedRoom = { ...room, messages };
                return updatedRoom;
            }),
        }));
        if (shouldPersistRoom(updatedRoom) && updatedMessage) {
            fire(db.putMessage(roomId, updatedMessage));
        }
    },

    updateLastAssistantMessage: (roomId, content, meta) => {
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== roomId) return r;
                const messages = [...r.messages];
                const lastIndex = messages.length - 1;
                if (lastIndex >= 0 && messages[lastIndex].role === 'assistant') {
                    const memories = meta?.memories
                        ?.map((memory) => memory.trim())
                        .filter(Boolean);
                    const toCharacterIds = meta?.toCharacterIds
                        ?.map((id) => id.trim())
                        .filter(Boolean);
                    messages[lastIndex] = {
                        ...messages[lastIndex],
                        content,
                        ...(meta ? {
                            expression: meta.expression,
                            memories: memories && memories.length > 0 ? memories : undefined,
                            toCharacterIds: toCharacterIds && toCharacterIds.length > 0 ? toCharacterIds : undefined,
                        } : {}),
                    };
                }
                return { ...r, messages };
            }),
        }));
        // No DB write: streaming updates are memory-only; call flushLastAssistantMessage at stream end.
    },

    flushLastAssistantMessage: (roomId) => {
        let updatedRoom: Room | undefined;
        let lastMessage: Message | undefined;
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== roomId) return r;
                const last = r.messages[r.messages.length - 1];
                if (!last || last.role !== 'assistant') return r;
                lastMessage = last;
                if (r.secretMode === true) {
                    updatedRoom = r;
                    return r;
                }
                updatedRoom = {
                    ...r,
                    lastMessagePreview: toPreview(last.content),
                    lastMessageAt: last.timestamp,
                };
                return updatedRoom;
            }),
        }));
        if (shouldPersistRoom(updatedRoom) && lastMessage) {
            fire(db.putMessage(roomId, lastMessage));
            fire(db.putRoom(toStoredRoom(updatedRoom)));
        }
    },

    removeMemories: (characterId, memoriesToRemove) => {
        fire(db.deleteMemoriesByCharacterAndContent(characterId, memoriesToRemove));
    },

    clearRoomMessages: (roomId) => {
        let updatedRoom: Room | undefined;
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== roomId) return r;
                updatedRoom = {
                    ...r,
                    messages: [],
                    summary: undefined,
                    summaryCheckpointUserMessageId: undefined,
                    lastMessagePreview: undefined,
                    lastMessageAt: undefined,
                    updatedAt: Date.now(),
                };
                return updatedRoom;
            }),
        }));
        if (shouldPersistRoom(updatedRoom)) {
            fire(db.clearMessagesByRoom(roomId));
            fire(db.putRoom(toStoredRoom(updatedRoom)));
        }
    },

    clearAllHistory: async () => {
        const now = Date.now();
        const state = get();
        currentRoomLoadSeq++;
        const rooms = state.rooms.map((r) => ({
            ...r,
            messages: [],
            summary: undefined,
            summaryCheckpointUserMessageId: undefined,
            lastMessagePreview: undefined,
            lastMessageAt: undefined,
            updatedAt: now,
        }));
        set({
            rooms,
        });
        await db.clearAllMessagesAndPutRooms(rooms.filter(shouldPersistRoom).map(toStoredRoom));
    },

    updateRoomSummary: (roomId, summary, summaryCheckpointUserMessageId) => {
        let updated: Room | undefined;
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== roomId) return r;
                const summaryUpdates = summaryCheckpointUserMessageId === undefined
                    ? { summary }
                    : { summary, summaryCheckpointUserMessageId };
                updated = r.secretMode === true
                    ? { ...r, ...summaryUpdates }
                    : { ...r, ...summaryUpdates, updatedAt: Date.now() };
                return updated;
            }),
        }));
        if (shouldPersistRoom(updated)) {
            fire(db.putRoom(toStoredRoom(updated)));
        }
    },

    compressRoomHistory: (roomId, keepCount) => {
        const changedMessages: Message[] = [];
        let updatedRoom: Room | undefined;
        set((state) => ({
            rooms: state.rooms.map((r) => {
                if (r.id !== roomId) return r;
                const cutIndex = r.messages.length - keepCount;
                const messages = r.messages.map((m, i) => {
                    if (i < cutIndex && !m.archived) {
                        const next = { ...m, archived: true };
                        changedMessages.push(next);
                        return next;
                    }
                    return m;
                });
                updatedRoom = r.secretMode === true
                    ? { ...r, messages }
                    : { ...r, messages, updatedAt: Date.now() };
                return updatedRoom;
            }),
        }));
        if (shouldPersistRoom(updatedRoom)) {
            if (changedMessages.length > 0) fire(db.putMessages(roomId, changedMessages));
            fire(db.putRoom(toStoredRoom(updatedRoom)));
        }
    },

    mergeBackup: async (data) => {
        const characters = normalizeCharacters(data.characters, get().defaultChatModel);
        const normalizedGroups = normalizeGroupData({
            characters,
            groups: data.groups,
            rooms: data.rooms,
            fallbackModel: get().defaultChatModel,
            directorFallbackModel: get().defaultDirectorModel,
        });
        const normalizedData: ParsedBackup = {
            ...data,
            characters,
            groups: normalizedGroups.groups,
            rooms: normalizedGroups.rooms,
        };
        const storedGroups = normalizedData.groups;
        const storedRooms = normalizedData.rooms.map(toStoredRoom);
        const storedMessages = normalizedData.rooms.flatMap((r) =>
            (r.messages ?? []).map((m) => ({ ...m, roomId: r.id }))
        );
        await db.bulkWrite({
            characters: normalizedData.characters,
            groups: storedGroups,
            rooms: storedRooms,
            messages: storedMessages,
            memories: normalizedData.memories,
            usageRecords: normalizedData.usageRecords,
        });
        set((state) => ({
            characters: [...state.characters, ...normalizedData.characters],
            groups: [...state.groups, ...normalizedData.groups],
            rooms: [...state.rooms, ...normalizedData.rooms],
            usageRecords: [...state.usageRecords, ...normalizedData.usageRecords],
        }));
    },

    restoreBackup: async (data) => {
        const characters = normalizeCharacters(data.characters, get().defaultChatModel);
        const normalizedGroups = normalizeGroupData({
            characters,
            groups: data.groups,
            rooms: data.rooms,
            fallbackModel: get().defaultChatModel,
            directorFallbackModel: get().defaultDirectorModel,
        });
        const normalizedData: ParsedBackup = {
            ...data,
            characters,
            groups: normalizedGroups.groups,
            rooms: normalizedGroups.rooms,
        };
        const nextCurrentRoomId = normalizedData.rooms
            .reduce<Room | null>((latest, room) => (!latest || room.updatedAt > latest.updatedAt ? room : latest), null)
            ?.id ?? null;
        const storedGroups = normalizedData.groups;
        const storedRooms = normalizedData.rooms.map(toStoredRoom);
        const storedMessages = normalizedData.rooms.flatMap((r) =>
            (r.messages ?? []).map((m) => ({ ...m, roomId: r.id }))
        );
        await db.replaceAll({
            characters: normalizedData.characters,
            groups: storedGroups,
            rooms: storedRooms,
            messages: storedMessages,
            memories: normalizedData.memories,
            usageRecords: normalizedData.usageRecords,
            currentRoomId: nextCurrentRoomId,
        });
        currentRoomLoadSeq++;
        set({
            characters: normalizedData.characters,
            groups: normalizedData.groups,
            rooms: normalizedData.rooms.map((r) => ({
                ...r,
                messages: r.id === nextCurrentRoomId ? r.messages ?? [] : [],
            })),
            usageRecords: normalizedData.usageRecords,
            currentRoomId: nextCurrentRoomId,
        });
    },

    getCurrentRoom: () => {
        const state = get();
        return state.rooms.find((r) => r.id === state.currentRoomId) || null;
    },

    getRoomsForCharacter: (characterId) => {
        const state = get();
        const groupIds = new Set(state.groups
            .filter((g) => g.actors
                .some((actor) => actor.type === 'character' && actor.characterId === characterId))
            .map((g) => g.id));
        return state.rooms.filter((r) =>
            r.characterId === characterId ||
            (r.groupId && groupIds.has(r.groupId))
        );
    },

    getRoomsForSituation: (groupId) => {
        return get().rooms.filter((r) => r.groupId === groupId);
    },

    getSituationParticipants: (room) => {
        const state = get();
        const group = room.groupId
            ? state.groups.find((g) => g.id === room.groupId)
            : undefined;
        if (group) return resolveSituationParticipants(group, state.characters, state.defaultChatModel);
        return [];
    },

    addUsageRecord: (characterId, promptTokens, completionTokens, totalTokens, cost) => {
        const record: UsageRecord = {
            id: generateId(),
            characterId,
            timestamp: Date.now(),
            promptTokens,
            completionTokens,
            totalTokens,
            cost,
        };
        set((state) => ({ usageRecords: [...state.usageRecords, record] }));
        fire(db.putUsageRecord(record));
    },

    cleanOldUsageRecords: () => {
        const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
        set((state) => ({
            usageRecords: state.usageRecords.filter((r) => r.timestamp >= oneYearAgo),
        }));
        fire(db.deleteUsageRecordsOlderThan(oneYearAgo));
    },

    getUsageRecords: (characterId, startDate, endDate) => {
        let records = get().usageRecords;
        if (characterId) records = records.filter((r) => r.characterId === characterId);
        if (startDate) records = records.filter((r) => r.timestamp >= startDate);
        if (endDate) records = records.filter((r) => r.timestamp <= endDate);
        return records;
    },
}));
