import {
    DEFAULT_CONNECTION_ID,
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
import { setTtsPlaybackVolume } from '../ttsPlayer';
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
export const DEFAULT_TTS_CONNECTION_ID = DEFAULT_CONNECTION_ID;
export const DEFAULT_TTS_MODEL = 'deepgram/aura-2';
export const VOICEVOX_TTS_MODEL = 'voicevox';
export const DEFAULT_TTS_VOICE = 'aura-2-ama-ja';
export const DEFAULT_TTS_SPEED = 1.0;
export const DEFAULT_TTS_VOLUME = 1.0;
export const DEFAULT_TTS_AUTO_PLAY = false;
/** 直前の *...* 動作描写をIrodoriのcaption（演技指示）として送るか。 */
export const DEFAULT_TTS_ACTION_CAPTION = true;
/** Irodoriのcaptionガイダンス強度。SamplingRequestのデフォルトと同じ3.0。 */
export const DEFAULT_TTS_CAPTION_CFG_SCALE = 3.0;
/** *...* の地の文・動作描写をナレーションとして読み上げるか。 */
export const DEFAULT_TTS_NARRATION_ENABLED = false;
export const DEFAULT_TTS_NARRATOR_VOICE = '';
export const TTS_SPEED_MIN = 0.25;
export const TTS_SPEED_MAX = 4.0;
export const TTS_VOLUME_MIN = 0;
export const TTS_VOLUME_MAX = 1.0;
export const TTS_CAPTION_CFG_SCALE_MIN = 0;
export const TTS_CAPTION_CFG_SCALE_MAX = 10;

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

export function normalizeTtsSpeed(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TTS_SPEED;
    return Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, value));
}

export function normalizeTtsVolume(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TTS_VOLUME;
    return Math.min(TTS_VOLUME_MAX, Math.max(TTS_VOLUME_MIN, value));
}

export function normalizeTtsModel(connectionId: string, value: unknown): string {
    if (connectionId === 'voicevox') return VOICEVOX_TTS_MODEL;
    return typeof value === 'string' ? value.trim() : DEFAULT_TTS_MODEL;
}

export function normalizeTtsCaptionCfgScale(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TTS_CAPTION_CFG_SCALE;
    return Math.min(TTS_CAPTION_CFG_SCALE_MAX, Math.max(TTS_CAPTION_CFG_SCALE_MIN, value));
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

export function persistModelDefaults(state: ModelDefaults): Promise<void> {
    const modelDefaults = modelDefaultsFromState(state);
    modelDefaultsWriteQueue = modelDefaultsWriteQueue
        .catch(() => undefined)
        .then(() => db.setMeta('modelDefaults', modelDefaults));
    fire(modelDefaultsWriteQueue);
    return modelDefaultsWriteQueue;
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
    | 'chatWallpaper'
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
    | 'ttsConnectionId'
    | 'ttsModel'
    | 'ttsVoice'
    | 'ttsSpeed'
    | 'ttsVolume'
    | 'ttsAutoPlay'
    | 'ttsActionCaption'
    | 'ttsCaptionCfgScale'
    | 'ttsNarrationEnabled'
    | 'ttsNarratorVoice'
    | 'fullJsonDebugEnabled'
    | 'detailedErrorLoggingEnabled'
    | 'memoryInspectorEnabled'
    | 'summaryInspectorEnabled'
    | 'fullJsonDebugLogs'
    | 'setThemeMode'
    | 'setThemePalette'
    | 'setChatWallpaper'
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
    | 'setTtsConnectionId'
    | 'setTtsModel'
    | 'setTtsVoice'
    | 'setTtsSpeed'
    | 'setTtsVolume'
    | 'setTtsAutoPlay'
    | 'setTtsActionCaption'
    | 'setTtsCaptionCfgScale'
    | 'setTtsNarrationEnabled'
    | 'setTtsNarratorVoice'
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
        chatWallpaper: undefined,
        defaultViewMode: DEFAULT_VIEW_MODE,
        vnTypingSpeed: DEFAULT_VN_TYPING_SPEED,
        keyboardShortcuts: createDefaultKeyboardShortcuts(),
        ...getDefaultModelDefaults(),
        conversationCompressionEnabled: DEFAULT_CONVERSATION_COMPRESSION_ENABLED,
        generateTitleOnFirstReply: false,
        replySuggestionsEnabled: false,
        ttsConnectionId: DEFAULT_TTS_CONNECTION_ID,
        ttsModel: DEFAULT_TTS_MODEL,
        ttsVoice: DEFAULT_TTS_VOICE,
        ttsSpeed: DEFAULT_TTS_SPEED,
        ttsVolume: DEFAULT_TTS_VOLUME,
        ttsAutoPlay: DEFAULT_TTS_AUTO_PLAY,
        ttsActionCaption: DEFAULT_TTS_ACTION_CAPTION,
        ttsCaptionCfgScale: DEFAULT_TTS_CAPTION_CFG_SCALE,
        ttsNarrationEnabled: DEFAULT_TTS_NARRATION_ENABLED,
        ttsNarratorVoice: DEFAULT_TTS_NARRATOR_VOICE,
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
        setChatWallpaper: (image) => {
            const chatWallpaper = typeof image === 'string' && image.trim() ? image : undefined;
            set({ chatWallpaper });
            fire(chatWallpaper
                ? db.setMeta('chatWallpaper', chatWallpaper)
                : db.deleteMeta('chatWallpaper'));
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
        setTtsConnectionId: (id) => {
            const ttsConnectionId = id.trim();
            set(ttsConnectionId === 'voicevox'
                ? { ttsConnectionId, ttsModel: VOICEVOX_TTS_MODEL }
                : { ttsConnectionId });
            fire(db.setMeta('ttsConnectionId', ttsConnectionId));
            if (ttsConnectionId === 'voicevox') {
                fire(db.setMeta('ttsModel', VOICEVOX_TTS_MODEL));
            }
        },
        setTtsModel: (model) => {
            const ttsModel = model.trim();
            set({ ttsModel });
            fire(db.setMeta('ttsModel', ttsModel));
        },
        setTtsVoice: (voice) => {
            const ttsVoice = voice.trim();
            set({ ttsVoice });
            fire(db.setMeta('ttsVoice', ttsVoice));
        },
        setTtsSpeed: (speed) => {
            const ttsSpeed = normalizeTtsSpeed(speed);
            set({ ttsSpeed });
            fire(db.setMeta('ttsSpeed', ttsSpeed));
        },
        setTtsVolume: (volume) => {
            const ttsVolume = normalizeTtsVolume(volume);
            set({ ttsVolume });
            setTtsPlaybackVolume(ttsVolume);
            fire(db.setMeta('ttsVolume', ttsVolume));
        },
        setTtsAutoPlay: (ttsAutoPlay) => {
            set({ ttsAutoPlay });
            fire(db.setMeta('ttsAutoPlay', ttsAutoPlay));
        },
        setTtsActionCaption: (ttsActionCaption) => {
            set({ ttsActionCaption });
            fire(db.setMeta('ttsActionCaption', ttsActionCaption));
        },
        setTtsCaptionCfgScale: (scale) => {
            const ttsCaptionCfgScale = normalizeTtsCaptionCfgScale(scale);
            set({ ttsCaptionCfgScale });
            fire(db.setMeta('ttsCaptionCfgScale', ttsCaptionCfgScale));
        },
        setTtsNarrationEnabled: (ttsNarrationEnabled) => {
            set({ ttsNarrationEnabled });
            fire(db.setMeta('ttsNarrationEnabled', ttsNarrationEnabled));
        },
        setTtsNarratorVoice: (voice) => {
            const ttsNarratorVoice = voice.trim();
            set({ ttsNarratorVoice });
            fire(db.setMeta('ttsNarratorVoice', ttsNarratorVoice));
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
