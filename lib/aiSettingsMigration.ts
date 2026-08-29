export type MigratableAiApiType = 'openrouter' | 'openai-compatible' | 'anthropic';

export interface MigratableModelDefaults {
    summaryModel: string;
    defaultChatModel: string;
    defaultDirectorModel: string;
    defaultAutoGenerationModel: string;
    titleGenerationModel: string;
    replySuggestionModel: string;
    defaultImageModel: string;
    expressionDetectionModel: string;
    memoryExtractionModel: string;
    memoryEmbeddingModel: string;
}

export type MigratableModelDefaultsByApiType = Record<MigratableAiApiType, MigratableModelDefaults>;

export interface AiSettingsMigrationInput {
    canonicalAiApiType: unknown;
    legacyAiProvider: unknown;
    canonicalModelDefaultsByApiType: unknown;
    legacyModelDefaultsByProvider: unknown;
    legacyModelDefaults?: MigratableModelDefaults;
    defaultAiApiType: MigratableAiApiType;
    defaultModelDefaultsByApiType: MigratableModelDefaultsByApiType;
    storedSchemaVersion: unknown;
    currentSchemaVersion: number;
}

export interface AiSettingsMigrationResult {
    aiApiType: MigratableAiApiType;
    modelDefaultsByApiType: MigratableModelDefaultsByApiType;
    schemaVersion: number;
    shouldPersistAiApiType: boolean;
    shouldPersistModelDefaultsByApiType: boolean;
    shouldPersistSchemaVersion: boolean;
}

const API_TYPES: readonly MigratableAiApiType[] = [
    'openrouter',
    'openai-compatible',
    'anthropic',
];

const MODEL_FIELDS: readonly (keyof MigratableModelDefaults)[] = [
    'summaryModel',
    'defaultChatModel',
    'defaultDirectorModel',
    'defaultAutoGenerationModel',
    'titleGenerationModel',
    'replySuggestionModel',
    'defaultImageModel',
    'expressionDetectionModel',
    'memoryExtractionModel',
    'memoryEmbeddingModel',
];

function isApiType(value: unknown): value is MigratableAiApiType {
    return API_TYPES.includes(value as MigratableAiApiType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeModelDefaults(
    value: unknown,
    fallback: MigratableModelDefaults,
): MigratableModelDefaults {
    const record = isRecord(value) ? value : {};
    return Object.fromEntries(MODEL_FIELDS.map((field) => [
        field,
        typeof record[field] === 'string' && record[field].trim()
            ? record[field].trim()
            : fallback[field],
    ])) as unknown as MigratableModelDefaults;
}

function mergeModelDefaultsSources(primary: unknown, legacy: unknown): unknown {
    const primaryRecord = isRecord(primary) ? primary : {};
    const legacyRecord = isRecord(legacy) ? legacy : {};
    return Object.fromEntries(API_TYPES.map((apiType) => {
        const primaryDefaults = primaryRecord[apiType];
        const legacyDefaults = legacyRecord[apiType];
        return [
            apiType,
            isRecord(primaryDefaults)
                ? {
                    ...(isRecord(legacyDefaults) ? legacyDefaults : {}),
                    ...primaryDefaults,
                }
                : legacyDefaults,
        ];
    }));
}

function normalizeModelDefaultsByApiType(
    value: unknown,
    fallbackByApiType: MigratableModelDefaultsByApiType,
    legacyFallback?: MigratableModelDefaults,
): MigratableModelDefaultsByApiType {
    const record = isRecord(value) ? value : {};
    return Object.fromEntries(API_TYPES.map((apiType) => [
        apiType,
        normalizeModelDefaults(
            record[apiType],
            legacyFallback ?? fallbackByApiType[apiType],
        ),
    ])) as MigratableModelDefaultsByApiType;
}

function jsonEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function resolveAiSettingsMigration(
    input: AiSettingsMigrationInput,
): AiSettingsMigrationResult {
    const aiApiType = isApiType(input.canonicalAiApiType)
        ? input.canonicalAiApiType
        : isApiType(input.legacyAiProvider)
            ? input.legacyAiProvider
            : input.defaultAiApiType;
    const modelDefaultsByApiType = normalizeModelDefaultsByApiType(
        mergeModelDefaultsSources(
            input.canonicalModelDefaultsByApiType,
            input.legacyModelDefaultsByProvider,
        ),
        input.defaultModelDefaultsByApiType,
        input.legacyModelDefaults,
    );
    const storedSchemaVersion = typeof input.storedSchemaVersion === 'number'
        && Number.isFinite(input.storedSchemaVersion)
        ? Math.floor(input.storedSchemaVersion)
        : 0;
    const schemaVersion = Math.max(input.currentSchemaVersion, storedSchemaVersion);

    return {
        aiApiType,
        modelDefaultsByApiType,
        schemaVersion,
        shouldPersistAiApiType: !isApiType(input.canonicalAiApiType)
            || input.canonicalAiApiType !== aiApiType,
        shouldPersistModelDefaultsByApiType: !jsonEqual(
            input.canonicalModelDefaultsByApiType,
            modelDefaultsByApiType,
        ),
        shouldPersistSchemaVersion: input.storedSchemaVersion !== schemaVersion,
    };
}
