import type { StoreApi } from 'zustand';

import type { AiApiConfig, AiApiType } from '../aiApi';
import type {
    KeyboardShortcut,
    KeyboardShortcutAction,
    KeyboardShortcutSettings,
} from '../keyboardShortcuts';
import type { ModelDefaultsByApiType } from '../modelDefaults';

export interface Expression {
    name: string;
    promptDetail?: string;
    image: string;
}

export interface Costume {
    name: string;
    promptDetail?: string;
    image: string;
    expressions?: Expression[];
}

export interface Character {
    id: string;
    name: string;
    systemPrompt: string;
    favorite?: boolean;
    speechStyle?: string;
    protagonistPrompt?: string;
    userConstraints?: string;
    model: string;
    icon?: string;
    maxTokens?: number;
    maxHistory?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    enableThinking?: boolean;
    enableMemory?: boolean;
    enableSummary?: boolean;
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
    /** Long-term memory records that were inserted into this assistant response's prompt. */
    usedMemoryIds?: string[];
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
    pinned?: boolean;
    archived?: boolean;
}

export interface SummaryRevision {
    text: string;
    checkpointUserMessageId?: string;
    createdAt: number;
    source: 'automatic' | 'manual';
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
        speechStyle?: string;
        userConstraints?: string;
        model?: string;
        icon?: string;
        rolePrompt?: string;
        directorDescription?: string;
        maxTokens?: number;
        maxHistory?: number;
        temperature?: number;
        topP?: number;
        topK?: number;
        expressions?: Expression[];
        costumes?: Costume[];
    };

export interface SituationDirector {
    enabled: boolean;
    model: string;
    systemPrompt?: string;
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
    favorite?: boolean;
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

export interface RoomReplySuggestions {
    sourceMessageId: string;
    suggestions: string[];
}

export interface Room {
    id: string;
    characterId: string;
    groupId?: string;
    name: string;
    messages: Message[];
    summary?: string;
    summaryCheckpointUserMessageId?: string;
    summaryHistory?: SummaryRevision[];
    maxMentionChain?: number;
    viewMode?: 'chat' | 'message' | 'vn';
    costumeSelections?: Record<string, string>;
    replySuggestions?: RoomReplySuggestions;
    secretMode?: boolean;
    isDraft?: boolean;
    lastMessagePreview?: string;
    lastMessageAt?: number;
    createdAt: number;
    updatedAt: number;
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

export interface ParsedBackup {
    characters: Character[];
    groups: Situation[];
    rooms: Room[];
    memories: MemoryRecord[];
    usageRecords: UsageRecord[];
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
export type ThemePalette = 'indigo' | 'sakura' | 'sage' | 'sky' | 'amber' | 'mono';
export type VnTypingSpeed = 'slow' | 'default' | 'fast' | 'streaming';

export type ThemeSelection = {
    mode: ThemeMode;
    palette: ThemePalette;
};

export type CharacterExtras = Partial<Omit<Character, 'id' | 'name' | 'systemPrompt' | 'model' | 'createdAt' | 'updatedAt'>>;

export interface AppState {
    hydrated: boolean;
    onboardingVersion: number;
    themeMode: ThemeMode;
    themePalette: ThemePalette;
    vnTypingSpeed: VnTypingSpeed;
    keyboardShortcuts: KeyboardShortcutSettings;
    summaryModel: string;
    defaultChatModel: string;
    defaultDirectorModel: string;
    defaultAutoGenerationModel: string;
    titleGenerationModel: string;
    replySuggestionModel: string;
    defaultImageModel: string;
    memoryExtractionModel: string;
    memoryEmbeddingModel: string;
    modelDefaultsByApiType: ModelDefaultsByApiType;
    generateTitleOnFirstReply: boolean;
    replySuggestionsEnabled: boolean;
    aiApiType: AiApiType;
    openRouterIgnoredProviders: string[];
    openAiCompatibleBaseUrl: string;
    openAiCompatibleEmbeddingsEnabled: boolean;
    openAiCompatibleImageGenerationEnabled: boolean;
    fullJsonDebugEnabled: boolean;
    detailedErrorLoggingEnabled: boolean;
    memoryInspectorEnabled: boolean;
    summaryInspectorEnabled: boolean;
    fullJsonDebugLogs: FullJsonDebugLog[];
    characters: Character[];
    groups: Situation[];
    rooms: Room[];
    currentRoomId: string | null;
    usageRecords: UsageRecord[];

    hydrate: () => Promise<void>;
    completeOnboarding: () => void;

    setThemeMode: (mode: ThemeMode) => void;
    setThemePalette: (palette: ThemePalette) => void;
    toggleThemeMode: () => void;
    toggleTheme: () => void;
    setVnTypingSpeed: (speed: VnTypingSpeed) => void;
    setKeyboardShortcut: (action: KeyboardShortcutAction, shortcut: KeyboardShortcut) => void;
    resetKeyboardShortcut: (action: KeyboardShortcutAction) => void;
    resetKeyboardShortcuts: () => void;
    setSummaryModel: (model: string) => void;
    setDefaultChatModel: (model: string) => void;
    setDefaultDirectorModel: (model: string) => void;
    setDefaultAutoGenerationModel: (model: string) => void;
    setTitleGenerationModel: (model: string) => void;
    setReplySuggestionModel: (model: string) => void;
    setDefaultImageModel: (model: string) => void;
    setMemoryExtractionModel: (model: string) => void;
    setMemoryEmbeddingModel: (model: string) => void;
    setGenerateTitleOnFirstReply: (enabled: boolean) => void;
    setReplySuggestionsEnabled: (enabled: boolean) => void;
    setAiApiType: (apiType: AiApiType) => void;
    setOpenRouterIgnoredProviders: (providers: string[]) => void;
    setOpenAiCompatibleBaseUrl: (baseUrl: string) => void;
    setOpenAiCompatibleEmbeddingsEnabled: (enabled: boolean) => void;
    setOpenAiCompatibleImageGenerationEnabled: (enabled: boolean) => void;
    getAiApiConfig: () => AiApiConfig;
    setFullJsonDebugEnabled: (enabled: boolean) => void;
    setDetailedErrorLoggingEnabled: (enabled: boolean) => void;
    setMemoryInspectorEnabled: (enabled: boolean) => void;
    setSummaryInspectorEnabled: (enabled: boolean) => void;

    createCharacter: (name: string, systemPrompt?: string, model?: string, extras?: CharacterExtras) => string;
    updateCharacter: (id: string, updates: Partial<Pick<Character, 'name' | 'systemPrompt' | 'favorite' | 'speechStyle' | 'protagonistPrompt' | 'userConstraints' | 'model' | 'icon' | 'maxTokens' | 'maxHistory' | 'temperature' | 'topP' | 'topK' | 'enableThinking' | 'enableMemory' | 'enableSummary' | 'expressions' | 'costumes'>>) => void;
    deleteCharacter: (id: string) => void;
    duplicateCharacter: (id: string) => string;
    getCharacter: (id: string) => Character | undefined;

    addFullJsonDebugLog: (log: Omit<FullJsonDebugLog, 'id' | 'createdAt'>) => void;
    clearFullJsonDebugLogs: () => void;

    addMemory: (characterId: string, memory: string, options?: AddMemoryOptions) => Promise<void>;
    removeMemoryRecord: (characterId: string, memoryId: string) => Promise<void>;
    updateMemoryRecord: (
        characterId: string,
        memoryId: string,
        updates: { content?: string; pinned?: boolean },
    ) => Promise<MemoryRecord | null>;
    listMemoriesByIds: (memoryIds: string[]) => Promise<MemoryRecord[]>;
    clearMemories: (characterId: string) => Promise<void>;
    listMemoriesForCharacter: (characterId: string) => Promise<MemoryRecord[]>;
    searchRelevantMemories: (params: MemorySearchParams) => Promise<MemoryRecord[]>;
    markMemoriesUsed: (memoryIds: string[]) => void;

    createRoom: (characterId: string, name?: string, options?: { viewMode?: Room['viewMode'] }) => string;
    createSituationRoom: (input: CreateSituationInput) => string;
    createRoomForSituation: (situationId: string, name?: string, options?: { viewMode?: Room['viewMode'] }) => string;
    branchRoomFromMessage: (roomId: string, messageId: string) => Promise<string>;
    deleteRoom: (id: string) => void;
    deleteSituation: (id: string) => void;
    duplicateSituation: (id: string) => string;
    setCurrentRoom: (id: string | null) => Promise<void>;
    updateSituation: (id: string, updates: Partial<Pick<Situation, 'name' | 'favorite' | 'situationPrompt' | 'priorMessages' | 'actors' | 'director' | 'memoryMode' | 'maxHistory'>>) => void;
    updateRoomName: (id: string, name: string) => void;
    updateRoomSettings: (id: string, updates: Partial<Pick<Room, 'maxMentionChain' | 'viewMode' | 'costumeSelections'>>) => void;
    setRoomReplySuggestions: (id: string, replySuggestions?: RoomReplySuggestions) => void;
    setRoomSecretMode: (id: string, enabled: boolean) => void;

    addMessage: (roomId: string, role: 'user' | 'assistant', content: string, characterId?: string, meta?: Pick<Message, 'expression' | 'memories' | 'toCharacterIds'>) => string;
    deleteLastMessage: (roomId: string) => void;
    deleteMessagesFrom: (roomId: string, fromIndex: number) => Promise<MemoryRecord[]>;
    restoreMessagesAt: (roomId: string, fromIndex: number, messages: Message[], memories?: MemoryRecord[]) => Promise<void>;
    attachMemoriesToMessage: (roomId: string, messageId: string, memories: string[]) => void;
    updateLastAssistantMessage: (roomId: string, content: string, meta?: Pick<Message, 'expression' | 'memories' | 'toCharacterIds'>) => void;
    flushLastAssistantMessage: (roomId: string) => void;
    refreshConversationRoom: (roomId: string) => Promise<void>;
    clearRoomMessages: (roomId: string) => void;
    clearAllHistory: () => Promise<void>;
    resetApplication: () => Promise<void>;
    updateRoomSummary: (
        roomId: string,
        summary: string,
        summaryCheckpointUserMessageId?: string,
        source?: SummaryRevision['source'],
    ) => void;
    compressRoomHistory: (roomId: string, keepCount: number) => void;

    addUsageRecord: (characterId: string, promptTokens: number, completionTokens: number, totalTokens: number, cost: number) => void;
    cleanOldUsageRecords: () => void;
    getUsageRecords: (characterId?: string, startDate?: number, endDate?: number) => UsageRecord[];

    mergeBackup: (data: ParsedBackup) => Promise<void>;
    restoreBackup: (data: ParsedBackup) => Promise<void>;

    getCurrentRoom: () => Room | null;
    getRoomsForCharacter: (characterId: string) => Room[];
    getRoomsForSituation: (situationId: string) => Room[];
    getSituationParticipants: (room: Room) => SituationParticipant[];
    removeMemories: (characterId: string, memoriesToRemove: string[]) => void;
}

export type StoreSet = StoreApi<AppState>['setState'];
export type StoreGet = StoreApi<AppState>['getState'];
