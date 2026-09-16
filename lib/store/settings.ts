import {
    DEFAULT_AI_API_TYPE,
    DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED,
    DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED,
    DEFAULT_OPENROUTER_IGNORED_PROVIDERS,
    normalizeOpenAiCompatibleBaseUrl,
    normalizeOpenRouterIgnoredProviders,
    normalizeRoleApiTypes,
    type AiApiConfig,
    type AiApiType,
    type RoleApiTypes,
} from '../aiApi';
import * as db from '../db';
import { generateId } from '../id';
import {
    createDefaultKeyboardShortcuts,
    DEFAULT_KEYBOARD_SHORTCUTS,
    type KeyboardShortcutAction,
} from '../keyboardShortcuts';
import {
    DEFAULT_AUTO_GENERATION_MODEL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_DIRECTOR_MODEL,
    DEFAULT_EXPRESSION_DETECTION_MODEL,
    DEFAULT_IMAGE_MODEL,
    DEFAULT_MEMORY_EMBEDDING_MODEL,
    DEFAULT_MEMORY_EXTRACTION_MODEL,
    DEFAULT_REPLY_SUGGESTION_MODEL,
    DEFAULT_SUMMARY_MODEL,
    DEFAULT_TITLE_GENERATION_MODEL,
    getDefaultModelDefaults,
    MODEL_DEFAULT_FIELDS,
    normalizeModelDefaults,
    normalizeModelDefaultsByApiType,
    type ModelDefaults,
    type ModelDefaultsByApiType,
    type ModelRoleKey,
} from '../modelDefaults';
import { fire } from './persistence';
import type {
    AppState,
    StoreGet,
    StoreSet,
    ThemeMode,
    ThemePalette,
    ThemeSelection,
    RoomViewMode,
    VnTypingSpeed,
} from './types';

export const THEME_LS_KEY = 'kataru-theme';
export const DEFAULT_THEME_SELECTION: ThemeSelection = { mode: 'dark', palette: 'mono' };
export const DEFAULT_VIEW_MODE: RoomViewMode = 'chat';
export const DEFAULT_VN_TYPING_SPEED: VnTypingSpeed = 'default';
export const DEFAULT_CHARACTER_MAX_CHARACTERS = 512;
export const DEFAULT_CHARACTER_MAX_HISTORY: number | undefined = 7;
export const DEFAULT_CHARACTER_TEMPERATURE = 1.0;
export const DEFAULT_CHARACTER_TOP_P: number | undefined = 0.95;
export const DEFAULT_CHARACTER_TOP_K = 0;
export const DEFAULT_CHARACTER_FREQUENCY_PENALTY = 0;
export const DEFAULT_CHARACTER_PRESENCE_PENALTY = 0;
export const DEFAULT_CHARACTER_REPETITION_PENALTY = 1;
export const DEFAULT_CONVERSATION_COMPRESSION_ENABLED = true;

export function getThemeClassName(mode: ThemeMode, palette: ThemePalette): string {
    return `mode-${mode} palette-${palette}`;
}

function isThemeMode(value: unknown): value is ThemeMode {
    return value === 'light' || value === 'dark';
}

function isThemePalette(value: unknown): value is ThemePalette {
    return value === 'indigo'
        || value === 'sakura'
        || value === 'sage'
        || value === 'sky'
        || value === 'amber'
        || value === 'mono';
}

export function isVnTypingSpeed(value: unknown): value is VnTypingSpeed {
    return value === 'slow' || value === 'default' || value === 'fast' || value === 'streaming';
}

export function isRoomViewMode(value: unknown): value is RoomViewMode {
    return value === 'chat' || value === 'message' || value === 'vn';
}

export function resolveThemeSelection(params: { mode?: unknown; palette?: unknown }): ThemeSelection {
    return {
        mode: isThemeMode(params.mode) ? params.mode : DEFAULT_THEME_SELECTION.mode,
        palette: isThemePalette(params.palette) ? params.palette : DEFAULT_THEME_SELECTION.palette,
    };
}

export function writeThemeCache(mode: ThemeMode, palette: ThemePalette): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(THEME_LS_KEY, `${mode}:${palette}`);
    } catch {
        // localStorage can be unavailable in restricted browser contexts.
    }
}

export function clearThemeCache(): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.removeItem(THEME_LS_KEY);
        window.localStorage.removeItem('roleplay-gui-theme');
    } catch {
        // localStorage can be unavailable in restricted browser contexts.
    }
}

const DEBUG_LOG_LIMIT = 50;
let modelDefaultsWriteQueue: Promise<void> = Promise.resolve();

export function persistModelDefaultsByApiType(modelDefaultsByApiType: ModelDefaultsByApiType): void {
    modelDefaultsWriteQueue = modelDefaultsWriteQueue
        .catch(() => undefined)
        .then(() => db.setMeta('modelDefaultsByApiType', modelDefaultsByApiType));
    fire(modelDefaultsWriteQueue);
}

export async function waitForModelDefaultsWrites(): Promise<void> {
    await modelDefaultsWriteQueue.catch(() => undefined);
}

/** The service a role currently resolves to (its override or the global type). */
export function roleApiTypeFor(
    state: Pick<AppState, 'aiApiType' | 'roleApiTypes'>,
    role: ModelRoleKey,
): AiApiType {
    return state.roleApiTypes[role] ?? state.aiApiType;
}

/** The effective model for every role, honoring per-role service overrides. */
export function activeModelDefaults(
    state: Pick<AppState, 'aiApiType' | 'roleApiTypes' | 'modelDefaultsByApiType'>,
): ModelDefaults {
    return Object.fromEntries(MODEL_DEFAULT_FIELDS.map((key) => [
        key,
        state.modelDefaultsByApiType[roleApiTypeFor(state, key)][key],
    ])) as unknown as ModelDefaults;
}

function updateModelDefault<K extends keyof ModelDefaults>(
    set: StoreSet,
    get: StoreGet,
    key: K,
    value: ModelDefaults[K],
): void {
    const state = get();
    const roleApiType = roleApiTypeFor(state, key);
    const apiTypeDefaults = {
        ...state.modelDefaultsByApiType[roleApiType],
        [key]: value,
    };
    const modelDefaultsByApiType = {
        ...state.modelDefaultsByApiType,
        [roleApiType]: apiTypeDefaults,
    };
    set({ [key]: value, modelDefaultsByApiType } as Partial<AppState>);
    persistModelDefaultsByApiType(modelDefaultsByApiType);
}

type AiConfigState = Pick<
    AppState,
    | 'aiApiType'
    | 'roleApiTypes'
    | 'openRouterIgnoredProviders'
    | 'openAiCompatibleBaseUrl'
    | 'openAiCompatibleEmbeddingsEnabled'
    | 'openAiCompatibleImageGenerationEnabled'
    | 'summaryModel'
    | 'defaultChatModel'
    | 'defaultDirectorModel'
    | 'defaultAutoGenerationModel'
    | 'titleGenerationModel'
    | 'replySuggestionModel'
    | 'defaultImageModel'
    | 'expressionDetectionModel'
    | 'memoryExtractionModel'
    | 'memoryEmbeddingModel'
>;

export function getAiApiConfigFromState(state: AiConfigState): AiApiConfig {
    const modelDefaults = normalizeModelDefaults({
        summaryModel: state.summaryModel,
        defaultChatModel: state.defaultChatModel,
        defaultDirectorModel: state.defaultDirectorModel,
        defaultAutoGenerationModel: state.defaultAutoGenerationModel,
        titleGenerationModel: state.titleGenerationModel,
        replySuggestionModel: state.replySuggestionModel,
        defaultImageModel: state.defaultImageModel,
        expressionDetectionModel: state.expressionDetectionModel,
        memoryExtractionModel: state.memoryExtractionModel,
        memoryEmbeddingModel: state.memoryEmbeddingModel,
    }, getDefaultModelDefaults(state.aiApiType));
    return {
        aiApiType: state.aiApiType,
        openRouterIgnoredProviders: normalizeOpenRouterIgnoredProviders(state.openRouterIgnoredProviders),
        openAiCompatibleBaseUrl: normalizeOpenAiCompatibleBaseUrl(state.openAiCompatibleBaseUrl),
        openAiCompatibleEmbeddingsEnabled: state.openAiCompatibleEmbeddingsEnabled,
        openAiCompatibleImageGenerationEnabled: state.openAiCompatibleImageGenerationEnabled,
        modelDefaults,
        roleApiTypes: normalizeRoleApiTypes(state.roleApiTypes),
    };
}

type SettingsSlice = Pick<
    AppState,
    | 'themeMode'
    | 'themePalette'
    | 'defaultViewMode'
    | 'vnTypingSpeed'
    | 'keyboardShortcuts'
    | 'summaryModel'
    | 'defaultChatModel'
    | 'defaultDirectorModel'
    | 'defaultAutoGenerationModel'
    | 'titleGenerationModel'
    | 'replySuggestionModel'
    | 'defaultImageModel'
    | 'expressionDetectionModel'
    | 'memoryExtractionModel'
    | 'memoryEmbeddingModel'
    | 'modelDefaultsByApiType'
    | 'roleApiTypes'
    | 'conversationCompressionEnabled'
    | 'generateTitleOnFirstReply'
    | 'replySuggestionsEnabled'
    | 'aiApiType'
    | 'openRouterIgnoredProviders'
    | 'openAiCompatibleBaseUrl'
    | 'openAiCompatibleEmbeddingsEnabled'
    | 'openAiCompatibleImageGenerationEnabled'
    | 'fullJsonDebugEnabled'
    | 'detailedErrorLoggingEnabled'
    | 'memoryInspectorEnabled'
    | 'summaryInspectorEnabled'
    | 'fullJsonDebugLogs'
    | 'setThemeMode'
    | 'setThemePalette'
    | 'setDefaultViewMode'
    | 'toggleThemeMode'
    | 'toggleTheme'
    | 'setVnTypingSpeed'
    | 'setKeyboardShortcut'
    | 'resetKeyboardShortcut'
    | 'resetKeyboardShortcuts'
    | 'resetModelDefaults'
    | 'setSummaryModel'
    | 'setDefaultChatModel'
    | 'setDefaultDirectorModel'
    | 'setDefaultAutoGenerationModel'
    | 'setTitleGenerationModel'
    | 'setReplySuggestionModel'
    | 'setDefaultImageModel'
    | 'setExpressionDetectionModel'
    | 'setMemoryExtractionModel'
    | 'setMemoryEmbeddingModel'
    | 'setRoleApiType'
    | 'setConversationCompressionEnabled'
    | 'setGenerateTitleOnFirstReply'
    | 'setReplySuggestionsEnabled'
    | 'setAiApiType'
    | 'setOpenRouterIgnoredProviders'
    | 'setOpenAiCompatibleBaseUrl'
    | 'setOpenAiCompatibleEmbeddingsEnabled'
    | 'setOpenAiCompatibleImageGenerationEnabled'
    | 'getAiApiConfig'
    | 'setFullJsonDebugEnabled'
    | 'setDetailedErrorLoggingEnabled'
    | 'setMemoryInspectorEnabled'
    | 'setSummaryInspectorEnabled'
    | 'addFullJsonDebugLog'
    | 'clearFullJsonDebugLogs'
>;

export function createSettingsSlice(set: StoreSet, get: StoreGet): SettingsSlice {
    return {
        themeMode: DEFAULT_THEME_SELECTION.mode,
        themePalette: DEFAULT_THEME_SELECTION.palette,
        defaultViewMode: DEFAULT_VIEW_MODE,
        vnTypingSpeed: DEFAULT_VN_TYPING_SPEED,
        keyboardShortcuts: createDefaultKeyboardShortcuts(),
        summaryModel: DEFAULT_SUMMARY_MODEL,
        defaultChatModel: DEFAULT_CHAT_MODEL,
        defaultDirectorModel: DEFAULT_DIRECTOR_MODEL,
        defaultAutoGenerationModel: DEFAULT_AUTO_GENERATION_MODEL,
        titleGenerationModel: DEFAULT_TITLE_GENERATION_MODEL,
        replySuggestionModel: DEFAULT_REPLY_SUGGESTION_MODEL,
        defaultImageModel: DEFAULT_IMAGE_MODEL,
        expressionDetectionModel: DEFAULT_EXPRESSION_DETECTION_MODEL,
        memoryExtractionModel: DEFAULT_MEMORY_EXTRACTION_MODEL,
        memoryEmbeddingModel: DEFAULT_MEMORY_EMBEDDING_MODEL,
        modelDefaultsByApiType: normalizeModelDefaultsByApiType(undefined),
        roleApiTypes: {},
        conversationCompressionEnabled: DEFAULT_CONVERSATION_COMPRESSION_ENABLED,
        generateTitleOnFirstReply: false,
        replySuggestionsEnabled: false,
        aiApiType: DEFAULT_AI_API_TYPE,
        openRouterIgnoredProviders: DEFAULT_OPENROUTER_IGNORED_PROVIDERS,
        openAiCompatibleBaseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
        openAiCompatibleEmbeddingsEnabled: DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED,
        openAiCompatibleImageGenerationEnabled: DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED,
        fullJsonDebugEnabled: false,
        detailedErrorLoggingEnabled: false,
        memoryInspectorEnabled: false,
        summaryInspectorEnabled: false,
        fullJsonDebugLogs: [],

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
        setDefaultViewMode: (defaultViewMode) => {
            set({ defaultViewMode });
            fire(db.setMeta('defaultViewMode', defaultViewMode));
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
        setKeyboardShortcut: (action, shortcut) => {
            const keyboardShortcuts = {
                ...get().keyboardShortcuts,
                [action]: [{ ...shortcut }],
            };
            set({ keyboardShortcuts });
            fire(db.setMeta('keyboardShortcuts', keyboardShortcuts));
        },
        resetKeyboardShortcut: (action: KeyboardShortcutAction) => {
            const keyboardShortcuts = {
                ...get().keyboardShortcuts,
                [action]: DEFAULT_KEYBOARD_SHORTCUTS[action].map((shortcut) => ({ ...shortcut })),
            };
            set({ keyboardShortcuts });
            fire(db.setMeta('keyboardShortcuts', keyboardShortcuts));
        },
        resetKeyboardShortcuts: () => {
            const keyboardShortcuts = createDefaultKeyboardShortcuts();
            set({ keyboardShortcuts });
            fire(db.setMeta('keyboardShortcuts', keyboardShortcuts));
        },
        resetModelDefaults: () => {
            const state = get();
            const modelDefaultsByApiType = { ...state.modelDefaultsByApiType };
            const flat = {} as Record<ModelRoleKey, string>;
            for (const key of MODEL_DEFAULT_FIELDS) {
                const roleApiType = roleApiTypeFor(state, key);
                const defaults = getDefaultModelDefaults(roleApiType);
                modelDefaultsByApiType[roleApiType] = {
                    ...modelDefaultsByApiType[roleApiType],
                    [key]: defaults[key],
                };
                flat[key] = defaults[key];
            }
            set({ ...flat, modelDefaultsByApiType });
            persistModelDefaultsByApiType(modelDefaultsByApiType);
        },
        setSummaryModel: (summaryModel) => {
            updateModelDefault(set, get, 'summaryModel', summaryModel);
        },
        setDefaultChatModel: (defaultChatModel) => {
            updateModelDefault(set, get, 'defaultChatModel', defaultChatModel);
        },
        setDefaultDirectorModel: (defaultDirectorModel) => {
            updateModelDefault(set, get, 'defaultDirectorModel', defaultDirectorModel);
        },
        setDefaultAutoGenerationModel: (defaultAutoGenerationModel) => {
            updateModelDefault(set, get, 'defaultAutoGenerationModel', defaultAutoGenerationModel);
        },
        setTitleGenerationModel: (titleGenerationModel) => {
            updateModelDefault(set, get, 'titleGenerationModel', titleGenerationModel);
        },
        setReplySuggestionModel: (replySuggestionModel) => {
            updateModelDefault(set, get, 'replySuggestionModel', replySuggestionModel);
        },
        setDefaultImageModel: (defaultImageModel) => {
            updateModelDefault(set, get, 'defaultImageModel', defaultImageModel);
        },
        setExpressionDetectionModel: (expressionDetectionModel) => {
            updateModelDefault(set, get, 'expressionDetectionModel', expressionDetectionModel);
        },
        setMemoryExtractionModel: (memoryExtractionModel) => {
            updateModelDefault(set, get, 'memoryExtractionModel', memoryExtractionModel);
        },
        setMemoryEmbeddingModel: (memoryEmbeddingModel) => {
            updateModelDefault(set, get, 'memoryEmbeddingModel', memoryEmbeddingModel);
        },
        setRoleApiType: (role, apiType) => {
            const state = get();
            const roleApiTypes: RoleApiTypes = { ...state.roleApiTypes };
            if (apiType) {
                roleApiTypes[role] = apiType;
            } else {
                delete roleApiTypes[role];
            }
            const effectiveApiType = apiType ?? state.aiApiType;
            const model = state.modelDefaultsByApiType[effectiveApiType][role];
            set({ roleApiTypes, [role]: model } as Partial<AppState>);
            fire(db.setMeta('roleApiTypes', roleApiTypes));
        },
        setConversationCompressionEnabled: (conversationCompressionEnabled) => {
            set({ conversationCompressionEnabled });
            fire(db.setMeta('conversationCompressionEnabled', conversationCompressionEnabled));
        },
        setGenerateTitleOnFirstReply: (generateTitleOnFirstReply) => {
            set({ generateTitleOnFirstReply });
            fire(db.setMeta('generateTitleOnFirstReply', generateTitleOnFirstReply));
        },
        setReplySuggestionsEnabled: (replySuggestionsEnabled) => {
            set({ replySuggestionsEnabled });
            fire(db.setMeta('replySuggestionsEnabled', replySuggestionsEnabled));
        },
        setAiApiType: (aiApiType) => {
            const state = get();
            const modelDefaults = activeModelDefaults({ ...state, aiApiType });
            set({ aiApiType, ...modelDefaults });
            fire(db.setMeta('aiApiType', aiApiType));
        },
        setOpenRouterIgnoredProviders: (providers) => {
            const openRouterIgnoredProviders = normalizeOpenRouterIgnoredProviders(providers);
            set({ openRouterIgnoredProviders });
            fire(db.setMeta('openRouterIgnoredProviders', openRouterIgnoredProviders));
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
        getAiApiConfig: () => getAiApiConfigFromState(get()),
        setFullJsonDebugEnabled: (fullJsonDebugEnabled) => {
            set({ fullJsonDebugEnabled });
            fire(db.setMeta('fullJsonDebugEnabled', fullJsonDebugEnabled));
        },
        setDetailedErrorLoggingEnabled: (detailedErrorLoggingEnabled) => {
            set({ detailedErrorLoggingEnabled });
            fire(db.setMeta('detailedErrorLoggingEnabled', detailedErrorLoggingEnabled));
        },
        setMemoryInspectorEnabled: (memoryInspectorEnabled) => {
            set({ memoryInspectorEnabled });
            fire(db.setMeta('memoryInspectorEnabled', memoryInspectorEnabled));
        },
        setSummaryInspectorEnabled: (summaryInspectorEnabled) => {
            set({ summaryInspectorEnabled });
            fire(db.setMeta('summaryInspectorEnabled', summaryInspectorEnabled));
        },
        addFullJsonDebugLog: (log) => {
            const json = log.json.trim();
            if (!json) return;
            const entry = {
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
    };
}
