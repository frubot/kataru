import {
    DEFAULT_CONNECTION_ID,
    normalizeOpenRouterIgnoredProviders,
} from '../aiApi';
import { updateAiConnection, type UpdateAiConnectionInput } from '../aiConnections';
import {
    foldMigratedModelDefaults,
    normalizeMigratableRoleApiTypes,
    resolveAiSettingsMigration,
    type MigratableModelDefaults,
    type MigratableModelDefaultsByApiType,
} from '../aiSettingsMigration';
import * as db from '../db';
import {
    createDefaultKeyboardShortcuts,
    normalizeKeyboardShortcuts,
    type KeyboardShortcutSettings,
} from '../keyboardShortcuts';
import {
    DEFAULT_ANTHROPIC_TEXT_MODEL,
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
} from '../modelDefaults';
import { normalizeCharacters } from './characters';
import { fire, nextRoomLoadSequence, persistGroup, toStoredRoom } from './persistence';
import {
    clearThemeCache,
    DEFAULT_CONVERSATION_COMPRESSION_ENABLED,
    DEFAULT_THEME_SELECTION,
    DEFAULT_VIEW_MODE,
    DEFAULT_VN_TYPING_SPEED,
    isVnTypingSpeed,
    isRoomViewMode,
    persistModelDefaults,
    resolveThemeSelection,
    waitForModelDefaultsWrites,
    writeThemeCache,
} from './settings';
import { normalizeGroupData } from './situations';
import type {
    AppState,
    Room,
    StoreGet,
    StoreSet,
    ThemeMode,
    ThemePalette,
    RoomViewMode,
    VnTypingSpeed,
} from './types';

export const CURRENT_ONBOARDING_VERSION = 1;
export const CURRENT_AI_SETTINGS_SCHEMA_VERSION = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const LEGACY_FLAT_MODEL_DEFAULTS: MigratableModelDefaults = {
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
};

const LEGACY_MODEL_DEFAULTS_BY_API_TYPE: MigratableModelDefaultsByApiType = {
    openrouter: LEGACY_FLAT_MODEL_DEFAULTS,
    'openai-compatible': LEGACY_FLAT_MODEL_DEFAULTS,
    anthropic: {
        ...LEGACY_FLAT_MODEL_DEFAULTS,
        summaryModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        defaultChatModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        defaultDirectorModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        defaultAutoGenerationModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        titleGenerationModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        replySuggestionModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        expressionDetectionModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        memoryExtractionModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
    },
};

const LEGACY_DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1';

type LifecycleSlice = Pick<
    AppState,
    'hydrated' | 'onboardingVersion' | 'hydrate' | 'completeOnboarding' | 'resetApplication'
>;

export function createLifecycleSlice(set: StoreSet, get: StoreGet): LifecycleSlice {
    return {
        hydrated: false,
        onboardingVersion: 0,

        hydrate: async () => {
            if (get().hydrated) return;
            await db.migrateLegacyDatabase();
            const [loadedCharacters, storedGroups, storedRooms, usageRecords, themeMode, themePalette, storedDefaultViewMode, currentRoomId, vnTypingSpeed, storedKeyboardShortcuts, fullJsonDebugEnabled, detailedErrorLoggingEnabled, memoryInspectorEnabled, summaryInspectorEnabled, storedModelDefaults, storedSummaryModel, storedDefaultChatModel, storedDefaultDirectorModel, storedDefaultAutoGenerationModel, storedTitleGenerationModel, storedDefaultImageModel, storedMemoryExtractionModel, storedMemoryEmbeddingModel, storedModelDefaultsByApiType, storedLegacyModelDefaultsByProvider, storedRoleApiTypes, storedConversationCompressionEnabled, storedGenerateTitleOnFirstReply, storedReplySuggestionsEnabled, storedAiApiType, storedLegacyAiProvider, storedOpenRouterIgnoredProviders, storedOpenAiCompatibleBaseUrl, storedOpenAiCompatibleEmbeddingsEnabled, storedOpenAiCompatibleImageGenerationEnabled, legacyOpenAiCompatibleApiKey, storedOnboardingVersion, storedAiSettingsSchemaVersion] = await Promise.all([
                db.getAllCharacters(),
                db.getAllGroups(),
                db.getAllRooms(),
                db.getAllUsageRecords(),
                db.getMeta<ThemeMode>('themeMode'),
                db.getMeta<ThemePalette>('themePalette'),
                db.getMeta<RoomViewMode>('defaultViewMode'),
                db.getMeta<string | null>('currentRoomId'),
                db.getMeta<VnTypingSpeed>('vnTypingSpeed'),
                db.getMeta<KeyboardShortcutSettings>('keyboardShortcuts'),
                db.getMeta<boolean>('fullJsonDebugEnabled'),
                db.getMeta<boolean>('detailedErrorLoggingEnabled'),
                db.getMeta<boolean>('memoryInspectorEnabled'),
                db.getMeta<boolean>('summaryInspectorEnabled'),
                db.getMeta<unknown>('modelDefaults'),
                db.getMeta<string>('summaryModel'),
                db.getMeta<string>('defaultChatModel'),
                db.getMeta<string>('defaultDirectorModel'),
                db.getMeta<string>('defaultAutoGenerationModel'),
                db.getMeta<string>('titleGenerationModel'),
                db.getMeta<string>('defaultImageModel'),
                db.getMeta<string>('memoryExtractionModel'),
                db.getMeta<string>('memoryEmbeddingModel'),
                db.getMeta<unknown>('modelDefaultsByApiType'),
                db.getMeta<unknown>('modelDefaultsByProvider'),
                db.getMeta<unknown>('roleApiTypes'),
                db.getMeta<boolean>('conversationCompressionEnabled'),
                db.getMeta<boolean>('generateTitleOnFirstReply'),
                db.getMeta<boolean>('replySuggestionsEnabled'),
                db.getMeta<unknown>('aiApiType'),
                db.getMeta<unknown>('aiProvider'),
                db.getMeta<unknown>('openRouterIgnoredProviders'),
                db.getMeta<string>('openAiCompatibleBaseUrl'),
                db.getMeta<boolean>('openAiCompatibleEmbeddingsEnabled'),
                db.getMeta<boolean>('openAiCompatibleImageGenerationEnabled'),
                // Legacy client-side key; removed for security. Detect presence so we can delete it.
                db.getMeta<string>('openAiCompatibleApiKey'),
                db.getMeta<number>('onboardingVersion'),
                db.getMeta<number>('aiSettingsSchemaVersion'),
            ]);
            // Drop any previously stored client-side API key from IndexedDB.
            if (legacyOpenAiCompatibleApiKey !== undefined) {
                fire(db.deleteMeta('openAiCompatibleApiKey'));
            }
            fire(db.deleteMeta('thinkDebugEnabled'));
            fire(db.deleteMeta('promptInspectorEnabled'));
            const hasLegacyModelDefaults = [
                storedSummaryModel,
                storedDefaultChatModel,
                storedDefaultDirectorModel,
                storedDefaultAutoGenerationModel,
                storedTitleGenerationModel,
                storedDefaultImageModel,
                storedMemoryExtractionModel,
                storedMemoryEmbeddingModel,
            ].some((value) => typeof value === 'string' && value.trim().length > 0);
            const legacyDefaultChatModel = typeof storedDefaultChatModel === 'string' && storedDefaultChatModel.trim()
                ? storedDefaultChatModel.trim()
                : DEFAULT_CHAT_MODEL;
            const legacyDefaultDirectorModel = typeof storedDefaultDirectorModel === 'string' && storedDefaultDirectorModel.trim()
                ? storedDefaultDirectorModel.trim()
                : legacyDefaultChatModel || DEFAULT_DIRECTOR_MODEL;
            const legacyModelDefaults: MigratableModelDefaults = {
                summaryModel: typeof storedSummaryModel === 'string' && storedSummaryModel.trim()
                    ? storedSummaryModel.trim()
                    : DEFAULT_SUMMARY_MODEL,
                defaultChatModel: legacyDefaultChatModel,
                defaultDirectorModel: legacyDefaultDirectorModel,
                defaultAutoGenerationModel: typeof storedDefaultAutoGenerationModel === 'string' && storedDefaultAutoGenerationModel.trim()
                    ? storedDefaultAutoGenerationModel.trim()
                    : DEFAULT_AUTO_GENERATION_MODEL,
                titleGenerationModel: typeof storedTitleGenerationModel === 'string' && storedTitleGenerationModel.trim()
                    ? storedTitleGenerationModel.trim()
                    : DEFAULT_TITLE_GENERATION_MODEL,
                replySuggestionModel: DEFAULT_REPLY_SUGGESTION_MODEL,
                defaultImageModel: typeof storedDefaultImageModel === 'string' && storedDefaultImageModel.trim()
                    ? storedDefaultImageModel.trim()
                    : DEFAULT_IMAGE_MODEL,
                expressionDetectionModel: DEFAULT_EXPRESSION_DETECTION_MODEL,
                memoryExtractionModel: typeof storedMemoryExtractionModel === 'string' && storedMemoryExtractionModel.trim()
                    ? storedMemoryExtractionModel.trim()
                    : DEFAULT_MEMORY_EXTRACTION_MODEL,
                memoryEmbeddingModel: typeof storedMemoryEmbeddingModel === 'string' && storedMemoryEmbeddingModel.trim()
                    ? storedMemoryEmbeddingModel.trim()
                    : DEFAULT_MEMORY_EMBEDDING_MODEL,
            };
            const aiSettingsMigration = resolveAiSettingsMigration({
                canonicalAiApiType: storedAiApiType,
                legacyAiProvider: storedLegacyAiProvider,
                canonicalModelDefaultsByApiType: storedModelDefaultsByApiType,
                legacyModelDefaultsByProvider: storedLegacyModelDefaultsByProvider,
                legacyModelDefaults: hasLegacyModelDefaults ? legacyModelDefaults : undefined,
                defaultAiApiType: DEFAULT_CONNECTION_ID,
                defaultModelDefaultsByApiType: LEGACY_MODEL_DEFAULTS_BY_API_TYPE,
                storedSchemaVersion: storedAiSettingsSchemaVersion,
                currentSchemaVersion: CURRENT_AI_SETTINGS_SCHEMA_VERSION,
            });
            // 旧形式（グローバル aiApiType + 役割別 roleApiTypes + 種別ごとの
            // modelDefaultsByApiType）を役割ごとの ModelRef に畳み込む。
            const roleApiTypes = normalizeMigratableRoleApiTypes(storedRoleApiTypes);
            const foldedModelDefaults = normalizeModelDefaults(foldMigratedModelDefaults(
                aiSettingsMigration.modelDefaultsByApiType,
                aiSettingsMigration.aiApiType,
                roleApiTypes,
            ));
            // meta 'modelDefaults' が既に新形式（値がオブジェクト）ならそれを優先する。
            const storedModelDefaultsIsCurrent = isRecord(storedModelDefaults)
                && MODEL_DEFAULT_FIELDS.some((field) => isRecord(storedModelDefaults[field]));
            const resolvedModelDefaults = storedModelDefaultsIsCurrent
                ? normalizeModelDefaults(storedModelDefaults, foldedModelDefaults)
                : foldedModelDefaults;
            const characters = normalizeCharacters(loadedCharacters, resolvedModelDefaults.defaultChatModel);
            const changedCharacters = characters.filter((character, index) => character !== loadedCharacters[index]);
            if (changedCharacters.length > 0) {
                await Promise.all(changedCharacters.map((character) => db.putCharacter(character)));
            }
            const normalized = normalizeGroupData({
                characters,
                groups: storedGroups,
                rooms: storedRooms.map((r) => ({ ...r, messages: [] })),
                fallbackModel: resolvedModelDefaults.defaultChatModel,
                directorFallbackModel: resolvedModelDefaults.defaultDirectorModel,
            });
            const groups = normalized.groups;
            const rooms: Room[] = normalized.rooms;
            for (const group of normalized.changedGroups) fire(persistGroup(set, get, group));
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
            const resolvedDefaultViewMode = isRoomViewMode(storedDefaultViewMode)
                ? storedDefaultViewMode
                : DEFAULT_VIEW_MODE;
            writeThemeCache(resolvedTheme.mode, resolvedTheme.palette);
            const resolvedVnTypingSpeed = isVnTypingSpeed(vnTypingSpeed) ? vnTypingSpeed : DEFAULT_VN_TYPING_SPEED;
            const resolvedKeyboardShortcuts = normalizeKeyboardShortcuts(storedKeyboardShortcuts);
            if (themeMode !== resolvedTheme.mode) fire(db.setMeta('themeMode', resolvedTheme.mode));
            if (themePalette !== resolvedTheme.palette) fire(db.setMeta('themePalette', resolvedTheme.palette));
            if (storedDefaultViewMode !== resolvedDefaultViewMode) fire(db.setMeta('defaultViewMode', resolvedDefaultViewMode));
            if (vnTypingSpeed !== resolvedVnTypingSpeed) fire(db.setMeta('vnTypingSpeed', resolvedVnTypingSpeed));
            if (JSON.stringify(storedKeyboardShortcuts) !== JSON.stringify(resolvedKeyboardShortcuts)) {
                fire(db.setMeta('keyboardShortcuts', resolvedKeyboardShortcuts));
            }
            const resolvedConversationCompressionEnabled = typeof storedConversationCompressionEnabled === 'boolean'
                ? storedConversationCompressionEnabled
                : DEFAULT_CONVERSATION_COMPRESSION_ENABLED;
            const resolvedGenerateTitleOnFirstReply = storedGenerateTitleOnFirstReply === true;
            const resolvedReplySuggestionsEnabled = storedReplySuggestionsEnabled === true;
            // 旧接続設定を組み込み接続へベストエフォートで引き継ぐ（失敗しても続行）。
            const resolvedOpenRouterIgnoredProviders = normalizeOpenRouterIgnoredProviders(storedOpenRouterIgnoredProviders);
            let openRouterUpdateSucceeded = true;
            if (resolvedOpenRouterIgnoredProviders.length > 0) {
                try {
                    await updateAiConnection('openrouter', {
                        ignoredProviders: resolvedOpenRouterIgnoredProviders,
                    });
                } catch (error) {
                    openRouterUpdateSucceeded = false;
                    console.error('[db]', error);
                }
            }
            const openAiConnectionUpdate: UpdateAiConnectionInput = {};
            const storedOpenAiBaseUrl = typeof storedOpenAiCompatibleBaseUrl === 'string'
                ? storedOpenAiCompatibleBaseUrl.trim().replace(/\/+$/, '')
                : '';
            if (storedOpenAiBaseUrl && storedOpenAiBaseUrl !== LEGACY_DEFAULT_OPENAI_COMPATIBLE_BASE_URL) {
                openAiConnectionUpdate.baseUrl = storedOpenAiBaseUrl;
            }
            if (typeof storedOpenAiCompatibleEmbeddingsEnabled === 'boolean') {
                openAiConnectionUpdate.embeddingsEnabled = storedOpenAiCompatibleEmbeddingsEnabled;
            }
            if (typeof storedOpenAiCompatibleImageGenerationEnabled === 'boolean') {
                openAiConnectionUpdate.imageGenerationEnabled = storedOpenAiCompatibleImageGenerationEnabled;
            }
            let openAiCompatibleUpdateSucceeded = true;
            if (Object.keys(openAiConnectionUpdate).length > 0) {
                try {
                    await updateAiConnection('openai-compatible', openAiConnectionUpdate);
                } catch (error) {
                    openAiCompatibleUpdateSucceeded = false;
                    console.error('[db]', error);
                }
            }

            let modelDefaultsPersisted = true;
            if (JSON.stringify(storedModelDefaults) !== JSON.stringify(resolvedModelDefaults)) {
                try {
                    await persistModelDefaults(resolvedModelDefaults);
                } catch {
                    modelDefaultsPersisted = false;
                }
            }
            // 移行に成功した旧メタキーのみ削除する（失敗したものは次回起動時に再試行）。
            const legacyMetaEntries: [string, unknown, boolean][] = [
                ['aiApiType', storedAiApiType, modelDefaultsPersisted],
                ['aiProvider', storedLegacyAiProvider, modelDefaultsPersisted],
                ['roleApiTypes', storedRoleApiTypes, modelDefaultsPersisted],
                ['modelDefaultsByApiType', storedModelDefaultsByApiType, modelDefaultsPersisted],
                ['modelDefaultsByProvider', storedLegacyModelDefaultsByProvider, modelDefaultsPersisted],
                ['openRouterIgnoredProviders', storedOpenRouterIgnoredProviders, openRouterUpdateSucceeded],
                ['openAiCompatibleBaseUrl', storedOpenAiCompatibleBaseUrl, openAiCompatibleUpdateSucceeded],
                ['openAiCompatibleEmbeddingsEnabled', storedOpenAiCompatibleEmbeddingsEnabled, openAiCompatibleUpdateSucceeded],
                ['openAiCompatibleImageGenerationEnabled', storedOpenAiCompatibleImageGenerationEnabled, openAiCompatibleUpdateSucceeded],
                ['summaryModel', storedSummaryModel, modelDefaultsPersisted],
                ['defaultChatModel', storedDefaultChatModel, modelDefaultsPersisted],
                ['defaultDirectorModel', storedDefaultDirectorModel, modelDefaultsPersisted],
                ['defaultAutoGenerationModel', storedDefaultAutoGenerationModel, modelDefaultsPersisted],
                ['titleGenerationModel', storedTitleGenerationModel, modelDefaultsPersisted],
                ['defaultImageModel', storedDefaultImageModel, modelDefaultsPersisted],
                ['memoryExtractionModel', storedMemoryExtractionModel, modelDefaultsPersisted],
                ['memoryEmbeddingModel', storedMemoryEmbeddingModel, modelDefaultsPersisted],
            ];
            for (const [key, value, migrated] of legacyMetaEntries) {
                if (value !== undefined && migrated) fire(db.deleteMeta(key));
            }

            const hasExistingContent = loadedCharacters.length > 0 || storedGroups.length > 0 || storedRooms.length > 0;
            const normalizedOnboardingVersion = typeof storedOnboardingVersion === 'number' && Number.isFinite(storedOnboardingVersion)
                ? Math.max(0, Math.floor(storedOnboardingVersion))
                : 0;
            const resolvedOnboardingVersion = hasExistingContent
                ? Math.max(normalizedOnboardingVersion, CURRENT_ONBOARDING_VERSION)
                : normalizedOnboardingVersion;
            if (storedConversationCompressionEnabled !== resolvedConversationCompressionEnabled) fire(db.setMeta('conversationCompressionEnabled', resolvedConversationCompressionEnabled));
            if (storedGenerateTitleOnFirstReply !== resolvedGenerateTitleOnFirstReply) fire(db.setMeta('generateTitleOnFirstReply', resolvedGenerateTitleOnFirstReply));
            if (storedReplySuggestionsEnabled !== resolvedReplySuggestionsEnabled) fire(db.setMeta('replySuggestionsEnabled', resolvedReplySuggestionsEnabled));
            if (storedOnboardingVersion !== resolvedOnboardingVersion) fire(db.setMeta('onboardingVersion', resolvedOnboardingVersion));
            if (aiSettingsMigration.shouldPersistSchemaVersion) {
                fire(db.setMeta('aiSettingsSchemaVersion', aiSettingsMigration.schemaVersion));
            }
            set({
                hydrated: true,
                onboardingVersion: resolvedOnboardingVersion,
                characters,
                groups,
                rooms,
                usageRecords,
                themeMode: resolvedTheme.mode,
                themePalette: resolvedTheme.palette,
                defaultViewMode: resolvedDefaultViewMode,
                vnTypingSpeed: resolvedVnTypingSpeed,
                keyboardShortcuts: resolvedKeyboardShortcuts,
                ...resolvedModelDefaults,
                conversationCompressionEnabled: resolvedConversationCompressionEnabled,
                generateTitleOnFirstReply: resolvedGenerateTitleOnFirstReply,
                replySuggestionsEnabled: resolvedReplySuggestionsEnabled,
                fullJsonDebugEnabled: fullJsonDebugEnabled === true,
                detailedErrorLoggingEnabled: detailedErrorLoggingEnabled === true,
                memoryInspectorEnabled: memoryInspectorEnabled === true,
                summaryInspectorEnabled: summaryInspectorEnabled === true,
                fullJsonDebugLogs: [],
                currentRoomId: resolvedCurrentRoomId,
            });
        },

        completeOnboarding: () => {
            set({ onboardingVersion: CURRENT_ONBOARDING_VERSION });
            fire(db.setMeta('onboardingVersion', CURRENT_ONBOARDING_VERSION));
        },

        resetApplication: async () => {
            nextRoomLoadSequence();
            await waitForModelDefaultsWrites();
            await db.resetAll();
            nextRoomLoadSequence();
            clearThemeCache();
            set({
                onboardingVersion: 0,
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
                characters: [],
                groups: [],
                rooms: [],
                currentRoomId: null,
                usageRecords: [],
            });
        },
    };
}
