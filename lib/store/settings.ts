import {
    normalizeModelRef,
    type AiApiConfig,
} from '../aiApi';
import * as db from '../db';
import { generateId } from '../id';
import {
    createDefaultKeyboardShortcuts,
    DEFAULT_KEYBOARD_SHORTCUTS,
    type KeyboardShortcutAction,
} from '../keyboardShortcuts';
import {
    getDefaultModelDefaults,
    normalizeModelDefaults,
    type ModelDefaults,
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

/** The effective model selection for every role. */
export function modelDefaultsFromState(state: ModelDefaults): ModelDefaults {
    return normalizeModelDefaults({
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
    });
}

export function persistModelDefaults(state: ModelDefaults): void {
    const modelDefaults = modelDefaultsFromState(state);
    modelDefaultsWriteQueue = modelDefaultsWriteQueue
        .catch(() => undefined)
        .then(() => db.setMeta('modelDefaults', modelDefaults));
    fire(modelDefaultsWriteQueue);
}

export async function waitForModelDefaultsWrites(): Promise<void> {
    await modelDefaultsWriteQueue.catch(() => undefined);
}

function updateModelDefault<K extends keyof ModelDefaults>(
    set: StoreSet,
    get: StoreGet,
    key: K,
    value: ModelDefaults[K],
): void {
    const ref = normalizeModelRef(value, get()[key]);
    set({ [key]: ref } as Partial<AppState>);
    persistModelDefaults(get());
}

export function getAiApiConfigFromState(state: ModelDefaults): AiApiConfig {
    const modelDefaults = modelDefaultsFromState(state);
    return {
        connectionId: modelDefaults.defaultChatModel.connectionId,
        modelDefaults,
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
    | 'conversationCompressionEnabled'
    | 'generateTitleOnFirstReply'
    | 'replySuggestionsEnabled'
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
    | 'setConversationCompressionEnabled'
    | 'setGenerateTitleOnFirstReply'
    | 'setReplySuggestionsEnabled'
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
        ...getDefaultModelDefaults(),
        conversationCompressionEnabled: DEFAULT_CONVERSATION_COMPRESSION_ENABLED,
        generateTitleOnFirstReply: false,
        replySuggestionsEnabled: false,
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
            set({ ...getDefaultModelDefaults() });
            persistModelDefaults(get());
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
