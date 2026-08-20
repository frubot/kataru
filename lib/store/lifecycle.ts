import {
    DEFAULT_AI_API_TYPE,
    DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED,
    DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED,
    DEFAULT_OPENROUTER_IGNORED_PROVIDERS,
    normalizeOpenAiCompatibleBaseUrl,
    normalizeOpenRouterIgnoredProviders,
    type AiApiType,
} from '../aiApi';
import { resolveAiSettingsMigration } from '../aiSettingsMigration';
import * as db from '../db';
import {
    DEFAULT_AUTO_GENERATION_MODEL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_DIRECTOR_MODEL,
    DEFAULT_IMAGE_MODEL,
    DEFAULT_MEMORY_EMBEDDING_MODEL,
    DEFAULT_MEMORY_EXTRACTION_MODEL,
    DEFAULT_MODEL_DEFAULTS_BY_API_TYPE,
    DEFAULT_REPLY_SUGGESTION_MODEL,
    DEFAULT_SUMMARY_MODEL,
    DEFAULT_TITLE_GENERATION_MODEL,
    normalizeModelDefaultsByApiType,
    type ModelDefaults,
    type ModelDefaultsByApiType,
} from '../modelDefaults';
import { normalizeCharacters } from './characters';
import { fire, nextRoomLoadSequence, toStoredRoom } from './persistence';
import {
    clearThemeCache,
    DEFAULT_THEME_SELECTION,
    DEFAULT_VN_TYPING_SPEED,
    isVnTypingSpeed,
    persistModelDefaultsByApiType,
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
    VnTypingSpeed,
} from './types';

export const CURRENT_ONBOARDING_VERSION = 1;
export const CURRENT_AI_SETTINGS_SCHEMA_VERSION = 2;

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
            const [loadedCharacters, storedGroups, storedRooms, usageRecords, themeMode, themePalette, currentRoomId, vnTypingSpeed, fullJsonDebugEnabled, detailedErrorLoggingEnabled, storedSummaryModel, storedDefaultChatModel, storedDefaultDirectorModel, storedDefaultAutoGenerationModel, storedTitleGenerationModel, storedDefaultImageModel, storedMemoryExtractionModel, storedMemoryEmbeddingModel, storedModelDefaultsByApiType, storedLegacyModelDefaultsByProvider, storedGenerateTitleOnFirstReply, storedReplySuggestionsEnabled, storedAiApiType, storedLegacyAiProvider, storedOpenRouterIgnoredProviders, storedOpenAiCompatibleBaseUrl, storedOpenAiCompatibleEmbeddingsEnabled, storedOpenAiCompatibleImageGenerationEnabled, legacyOpenAiCompatibleApiKey, storedOnboardingVersion, storedAiSettingsSchemaVersion] = await Promise.all([
                db.getAllCharacters(),
                db.getAllGroups(),
                db.getAllRooms(),
                db.getAllUsageRecords(),
                db.getMeta<ThemeMode>('themeMode'),
                db.getMeta<ThemePalette>('themePalette'),
                db.getMeta<string | null>('currentRoomId'),
                db.getMeta<VnTypingSpeed>('vnTypingSpeed'),
                db.getMeta<boolean>('fullJsonDebugEnabled'),
                db.getMeta<boolean>('detailedErrorLoggingEnabled'),
                db.getMeta<string>('summaryModel'),
                db.getMeta<string>('defaultChatModel'),
                db.getMeta<string>('defaultDirectorModel'),
                db.getMeta<string>('defaultAutoGenerationModel'),
                db.getMeta<string>('titleGenerationModel'),
                db.getMeta<string>('defaultImageModel'),
                db.getMeta<string>('memoryExtractionModel'),
                db.getMeta<string>('memoryEmbeddingModel'),
                db.getMeta<ModelDefaultsByApiType>('modelDefaultsByApiType'),
                db.getMeta<unknown>('modelDefaultsByProvider'),
                db.getMeta<boolean>('generateTitleOnFirstReply'),
                db.getMeta<boolean>('replySuggestionsEnabled'),
                db.getMeta<AiApiType>('aiApiType'),
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
            const legacyModelDefaults: ModelDefaults = {
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
                defaultAiApiType: DEFAULT_AI_API_TYPE,
                defaultModelDefaultsByApiType: DEFAULT_MODEL_DEFAULTS_BY_API_TYPE,
                storedSchemaVersion: storedAiSettingsSchemaVersion,
                currentSchemaVersion: CURRENT_AI_SETTINGS_SCHEMA_VERSION,
            });
            const resolvedAiApiType = aiSettingsMigration.aiApiType;
            const modelDefaultsByApiType = aiSettingsMigration.modelDefaultsByApiType;
            const activeModelDefaults = modelDefaultsByApiType[resolvedAiApiType];
            const characters = normalizeCharacters(loadedCharacters, activeModelDefaults.defaultChatModel);
            const changedCharacters = characters.filter((character, index) => character !== loadedCharacters[index]);
            if (changedCharacters.length > 0) {
                await Promise.all(changedCharacters.map((character) => db.putCharacter(character)));
            }
            const normalized = normalizeGroupData({
                characters,
                groups: storedGroups,
                rooms: storedRooms.map((r) => ({ ...r, messages: [] })),
                fallbackModel: activeModelDefaults.defaultChatModel,
                directorFallbackModel: activeModelDefaults.defaultDirectorModel,
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
            if (themeMode !== resolvedTheme.mode) fire(db.setMeta('themeMode', resolvedTheme.mode));
            if (themePalette !== resolvedTheme.palette) fire(db.setMeta('themePalette', resolvedTheme.palette));
            if (vnTypingSpeed !== resolvedVnTypingSpeed) fire(db.setMeta('vnTypingSpeed', resolvedVnTypingSpeed));
            const resolvedGenerateTitleOnFirstReply = storedGenerateTitleOnFirstReply === true;
            const resolvedReplySuggestionsEnabled = storedReplySuggestionsEnabled === true;
            const resolvedOpenRouterIgnoredProviders = normalizeOpenRouterIgnoredProviders(storedOpenRouterIgnoredProviders);
            const resolvedOpenAiCompatibleBaseUrl = normalizeOpenAiCompatibleBaseUrl(storedOpenAiCompatibleBaseUrl);
            const resolvedOpenAiCompatibleEmbeddingsEnabled = typeof storedOpenAiCompatibleEmbeddingsEnabled === 'boolean'
                ? storedOpenAiCompatibleEmbeddingsEnabled
                : DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED;
            const resolvedOpenAiCompatibleImageGenerationEnabled = typeof storedOpenAiCompatibleImageGenerationEnabled === 'boolean'
                ? storedOpenAiCompatibleImageGenerationEnabled
                : DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED;
            const hasExistingContent = loadedCharacters.length > 0 || storedGroups.length > 0 || storedRooms.length > 0;
            const normalizedOnboardingVersion = typeof storedOnboardingVersion === 'number' && Number.isFinite(storedOnboardingVersion)
                ? Math.max(0, Math.floor(storedOnboardingVersion))
                : 0;
            const resolvedOnboardingVersion = hasExistingContent
                ? Math.max(normalizedOnboardingVersion, CURRENT_ONBOARDING_VERSION)
                : normalizedOnboardingVersion;
            if (aiSettingsMigration.shouldPersistModelDefaultsByApiType) {
                persistModelDefaultsByApiType(modelDefaultsByApiType);
            }
            if (storedGenerateTitleOnFirstReply !== resolvedGenerateTitleOnFirstReply) fire(db.setMeta('generateTitleOnFirstReply', resolvedGenerateTitleOnFirstReply));
            if (storedReplySuggestionsEnabled !== resolvedReplySuggestionsEnabled) fire(db.setMeta('replySuggestionsEnabled', resolvedReplySuggestionsEnabled));
            if (aiSettingsMigration.shouldPersistAiApiType) {
                fire(db.setMeta('aiApiType', resolvedAiApiType));
            }
            if (JSON.stringify(storedOpenRouterIgnoredProviders) !== JSON.stringify(resolvedOpenRouterIgnoredProviders)) {
                fire(db.setMeta('openRouterIgnoredProviders', resolvedOpenRouterIgnoredProviders));
            }
            if (storedOpenAiCompatibleBaseUrl !== resolvedOpenAiCompatibleBaseUrl) fire(db.setMeta('openAiCompatibleBaseUrl', resolvedOpenAiCompatibleBaseUrl));
            if (storedOpenAiCompatibleEmbeddingsEnabled !== resolvedOpenAiCompatibleEmbeddingsEnabled) fire(db.setMeta('openAiCompatibleEmbeddingsEnabled', resolvedOpenAiCompatibleEmbeddingsEnabled));
            if (storedOpenAiCompatibleImageGenerationEnabled !== resolvedOpenAiCompatibleImageGenerationEnabled) fire(db.setMeta('openAiCompatibleImageGenerationEnabled', resolvedOpenAiCompatibleImageGenerationEnabled));
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
                vnTypingSpeed: resolvedVnTypingSpeed,
                ...activeModelDefaults,
                modelDefaultsByApiType,
                generateTitleOnFirstReply: resolvedGenerateTitleOnFirstReply,
                replySuggestionsEnabled: resolvedReplySuggestionsEnabled,
                aiApiType: resolvedAiApiType,
                openRouterIgnoredProviders: resolvedOpenRouterIgnoredProviders,
                openAiCompatibleBaseUrl: resolvedOpenAiCompatibleBaseUrl,
                openAiCompatibleEmbeddingsEnabled: resolvedOpenAiCompatibleEmbeddingsEnabled,
                openAiCompatibleImageGenerationEnabled: resolvedOpenAiCompatibleImageGenerationEnabled,
                fullJsonDebugEnabled: fullJsonDebugEnabled === true,
                detailedErrorLoggingEnabled: detailedErrorLoggingEnabled === true,
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
                vnTypingSpeed: DEFAULT_VN_TYPING_SPEED,
                summaryModel: DEFAULT_SUMMARY_MODEL,
                defaultChatModel: DEFAULT_CHAT_MODEL,
                defaultDirectorModel: DEFAULT_DIRECTOR_MODEL,
                defaultAutoGenerationModel: DEFAULT_AUTO_GENERATION_MODEL,
                titleGenerationModel: DEFAULT_TITLE_GENERATION_MODEL,
                replySuggestionModel: DEFAULT_REPLY_SUGGESTION_MODEL,
                defaultImageModel: DEFAULT_IMAGE_MODEL,
                memoryExtractionModel: DEFAULT_MEMORY_EXTRACTION_MODEL,
                memoryEmbeddingModel: DEFAULT_MEMORY_EMBEDDING_MODEL,
                modelDefaultsByApiType: normalizeModelDefaultsByApiType(undefined),
                generateTitleOnFirstReply: false,
                replySuggestionsEnabled: false,
                aiApiType: DEFAULT_AI_API_TYPE,
                openRouterIgnoredProviders: DEFAULT_OPENROUTER_IGNORED_PROVIDERS,
                openAiCompatibleBaseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
                openAiCompatibleEmbeddingsEnabled: DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED,
                openAiCompatibleImageGenerationEnabled: DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED,
                fullJsonDebugEnabled: false,
                detailedErrorLoggingEnabled: false,
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
