import type { StoreApi } from 'zustand';

import type { AiApiConfig, AiConnectionKind, ModelRef } from '../aiApi';
import type {
    KeyboardShortcut,
    KeyboardShortcutAction,
    KeyboardShortcutSettings,
} from '../keyboardShortcuts';

export interface Expression {
    name: string;
    promptDetail?: string;
    image: string;
}

export interface Costume {
    name: string;
    kind?: 'image' | 'vrm';
    promptDetail?: string;
    image: string;
    expressions?: Expression[];
    vrm?: VrmAvatar;
}

export interface VrmAvatar {
    source: string;
    framing: { scale: number; offsetY: number; rotation: number };
    expressionMap: Record<string, string>;
}

export interface Character {
    id: string;
    name: string;
    systemPrompt: string;
    favorite?: boolean;
    speechStyle?: string;
    protagonistPrompt?: string;
    userConstraints?: string;
    model: ModelRef;
    icon?: string;
    maxCharacters?: number;
    maxHistory?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    repetitionPenalty?: number;
    enableThinking?: boolean;
    enableMemory?: boolean;
    tts?: {
        connectionId?: string;
        model?: string;
        voice?: string;
        speed?: number;
        volume?: number;
    };
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
    embeddingConnectionId?: string;
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

export interface RoomCompressionSnapshot {
    archivedMessages: Message[];
    summary?: string;
    summaryCheckpointUserMessageId?: string;
    summaryHistory?: SummaryRevision[];
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
        costumeName?: string;
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
        model?: ModelRef;
        icon?: string;
        rolePrompt?: string;
        directorDescription?: string;
        maxCharacters?: number;
        maxHistory?: number;
        temperature?: number;
        topP?: number;
        topK?: number;
        frequencyPenalty?: number;
        presencePenalty?: number;
        repetitionPenalty?: number;
        enableThinking?: boolean;
        expressions?: Expression[];
        costumes?: Costume[];
    };

export interface SituationDirector {
    enabled: boolean;
    model: ModelRef;
    systemPrompt?: string;
    maxAutoTurns: number;
    stopPolicy: 'after-one' | 'max-turns';
    engine?: 'llm' | 'typesafe';
    continueThreshold?: number;
    protagonistThreshold?: number;
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
        expression?: string;
    };

export interface Situation {
    id: string;
    name: string;
    favorite?: boolean;
    backgroundImage?: string;
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
    backgroundImage?: string;
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
    viewMode?: RoomViewMode;
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

/** フルバックアップに含めるAI接続のメタデータ。apiKey等の秘密情報は含めない。 */
export interface ExportedConnection {
    id: string;
    name: string;
    kind: AiConnectionKind;
    baseUrl?: string;
    embeddingsEnabled?: boolean;
    imageGenerationEnabled?: boolean;
    ttsEnabled?: boolean;
    ignoredProviders?: string[];
}

export interface ParsedBackup {
    characters: Character[];
    groups: Situation[];
    rooms: Room[];
    memories: MemoryRecord[];
    usageRecords: UsageRecord[];
    connections?: ExportedConnection[];
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
    secondJson?: string;
    httpStatus?: number;
    elapsedMs?: number;
    errorName?: string;
    createdAt: number;
}

export type ThemeMode = 'light' | 'dark';
export type ThemePalette = 'indigo' | 'sakura' | 'sage' | 'sky' | 'amber' | 'mono';
export type VnTypingSpeed = 'slow' | 'default' | 'fast' | 'streaming';
export type RoomViewMode = 'chat' | 'message' | 'vn';

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
    chatWallpaper?: string;
    defaultViewMode: RoomViewMode;
    vnTypingSpeed: VnTypingSpeed;
    keyboardShortcuts: KeyboardShortcutSettings;
    summaryModel: ModelRef;
    defaultChatModel: ModelRef;
    defaultDirectorModel: ModelRef;
    defaultAutoGenerationModel: ModelRef;
    titleGenerationModel: ModelRef;
    replySuggestionModel: ModelRef;
    defaultImageModel: ModelRef;
    expressionDetectionModel: ModelRef;
    memoryExtractionModel: ModelRef;
    memoryEmbeddingModel: ModelRef;
    conversationCompressionEnabled: boolean;
    generateTitleOnFirstReply: boolean;
    replySuggestionsEnabled: boolean;
    ttsConnectionId: string;
    ttsModel: string;
    ttsVoice: string;
    ttsSpeed: number;
    ttsVolume: number;
    ttsAutoPlay: boolean;
    fullJsonDebugEnabled: boolean;
    detailedErrorLoggingEnabled: boolean;
    memoryInspectorEnabled: boolean;
    summaryInspectorEnabled: boolean;
    fullJsonDebugLogs: FullJsonDebugLog[];
    characters: Character[];
    groups: Situation[];
    rooms: Room[];
    currentRoomId: string | null;
    loadingRoomHistoryId: string | null;
    usageRecords: UsageRecord[];

    hydrate: () => Promise<void>;
    completeOnboarding: () => void;

    setThemeMode: (mode: ThemeMode) => void;
    setThemePalette: (palette: ThemePalette) => void;
    setChatWallpaper: (image?: string) => void;
    setDefaultViewMode: (viewMode: RoomViewMode) => void;
    toggleThemeMode: () => void;
    toggleTheme: () => void;
    setVnTypingSpeed: (speed: VnTypingSpeed) => void;
    setKeyboardShortcut: (action: KeyboardShortcutAction, shortcut: KeyboardShortcut) => void;
    resetKeyboardShortcut: (action: KeyboardShortcutAction) => void;
    resetKeyboardShortcuts: () => void;
    resetModelDefaults: () => void;
    setSummaryModel: (model: ModelRef) => void;
    setDefaultChatModel: (model: ModelRef) => void;
    setDefaultDirectorModel: (model: ModelRef) => void;
    setDefaultAutoGenerationModel: (model: ModelRef) => void;
    setTitleGenerationModel: (model: ModelRef) => void;
    setReplySuggestionModel: (model: ModelRef) => void;
    setDefaultImageModel: (model: ModelRef) => void;
    setExpressionDetectionModel: (model: ModelRef) => void;
    setMemoryExtractionModel: (model: ModelRef) => void;
    setMemoryEmbeddingModel: (model: ModelRef) => void;
    setConversationCompressionEnabled: (enabled: boolean) => void;
    setGenerateTitleOnFirstReply: (enabled: boolean) => void;
    setReplySuggestionsEnabled: (enabled: boolean) => void;
    setTtsConnectionId: (id: string) => void;
    setTtsModel: (model: string) => void;
    setTtsVoice: (voice: string) => void;
    setTtsSpeed: (speed: number) => void;
    setTtsVolume: (volume: number) => void;
    setTtsAutoPlay: (enabled: boolean) => void;
    getAiApiConfig: () => AiApiConfig;
    setFullJsonDebugEnabled: (enabled: boolean) => void;
    setDetailedErrorLoggingEnabled: (enabled: boolean) => void;
    setMemoryInspectorEnabled: (enabled: boolean) => void;
    setSummaryInspectorEnabled: (enabled: boolean) => void;

    createCharacter: (name: string, systemPrompt?: string, model?: ModelRef, extras?: CharacterExtras) => string;
    updateCharacter: (id: string, updates: Partial<Pick<Character, 'name' | 'systemPrompt' | 'favorite' | 'speechStyle' | 'protagonistPrompt' | 'userConstraints' | 'model' | 'icon' | 'maxCharacters' | 'maxHistory' | 'temperature' | 'topP' | 'topK' | 'frequencyPenalty' | 'presencePenalty' | 'repetitionPenalty' | 'enableThinking' | 'enableMemory' | 'tts' | 'expressions' | 'costumes'>>) => void;
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
    updateSituation: (id: string, updates: Partial<Pick<Situation, 'name' | 'favorite' | 'backgroundImage' | 'situationPrompt' | 'priorMessages' | 'actors' | 'director' | 'memoryMode' | 'maxHistory'>>) => void;
    updateRoomName: (id: string, name: string) => void;
    updateRoomSettings: (id: string, updates: Partial<Pick<Room, 'maxMentionChain' | 'viewMode' | 'costumeSelections'>>) => void;
    setRoomReplySuggestions: (id: string, replySuggestions?: RoomReplySuggestions) => void;
    setRoomSecretMode: (id: string, enabled: boolean) => void;

    addMessage: (roomId: string, role: 'user' | 'assistant', content: string, characterId?: string, meta?: Pick<Message, 'expression' | 'memories' | 'toCharacterIds'>) => string;
    deleteLastMessage: (roomId: string) => void;
    deleteMessagesFrom: (roomId: string, fromIndex: number) => Promise<MemoryRecord[]>;
    restoreMessagesAt: (roomId: string, fromIndex: number, messages: Message[], memories?: MemoryRecord[]) => Promise<void>;
    rewindRoomCompression: (roomId: string) => Promise<RoomCompressionSnapshot | null>;
    restoreRoomCompression: (roomId: string, snapshot: RoomCompressionSnapshot) => Promise<void>;
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
