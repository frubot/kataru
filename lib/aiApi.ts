import { getDefaultModelDefaults, MODEL_DEFAULT_FIELDS, normalizeModelDefaults, type ModelDefaults, type ModelRoleKey } from './modelDefaults';

export { DEFAULT_ANTHROPIC_TEXT_MODEL } from './modelDefaults';

export type AiApiType = 'openrouter' | 'openai-compatible' | 'anthropic';

/** Per-role service overrides. Keys are `ModelDefaults` field names; an absent
 * entry means the role follows the global `aiApiType`. */
export type RoleApiTypes = Partial<Record<ModelRoleKey, AiApiType>>;

export interface AiApiConfig {
    aiApiType: AiApiType;
    openRouterIgnoredProviders: string[];
    openAiCompatibleBaseUrl: string;
    openAiCompatibleEmbeddingsEnabled: boolean;
    openAiCompatibleImageGenerationEnabled: boolean;
    modelDefaults: ModelDefaults;
    roleApiTypes?: RoleApiTypes;
}

export const DEFAULT_AI_API_TYPE: AiApiType = 'openrouter';
export const DEFAULT_OPENROUTER_IGNORED_PROVIDERS: string[] = [];
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED = true;
export const DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED = false;

export function isAiApiType(value: unknown): value is AiApiType {
    return value === 'openrouter' || value === 'openai-compatible' || value === 'anthropic';
}

export const AI_API_TYPE_LABELS: Record<AiApiType, string> = {
    openrouter: 'OpenRouter',
    'openai-compatible': 'OpenAI / 互換API',
    anthropic: 'Anthropic / 互換API',
};

export function normalizeRoleApiTypes(value: unknown): RoleApiTypes {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const result: RoleApiTypes = {};
    for (const field of MODEL_DEFAULT_FIELDS) {
        if (isAiApiType(record[field])) result[field] = record[field];
    }
    return result;
}

/** The service a role effectively runs on after applying its override. */
export function resolveRoleApiType(config: AiApiConfig, role: ModelRoleKey): AiApiType {
    return config.roleApiTypes?.[role] ?? config.aiApiType;
}

/** Returns a copy of the config pinned to `aiApiType` — used to list models
 * for a service other than the global one. */
export function aiApiConfigForType(config: AiApiConfig, aiApiType: AiApiType): AiApiConfig {
    return { ...config, aiApiType };
}

/** Whether `feature` can run on `apiType` under this config. */
export function supportsAiApiFeature(
    config: AiApiConfig,
    apiType: AiApiType,
    feature: 'embeddings' | 'imageGeneration',
): boolean {
    if (apiType === 'anthropic') return false;
    if (apiType !== 'openai-compatible') return true;
    return feature === 'embeddings'
        ? config.openAiCompatibleEmbeddingsEnabled
        : config.openAiCompatibleImageGenerationEnabled;
}

export function normalizeOpenAiCompatibleBaseUrl(value: unknown): string {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return (trimmed || DEFAULT_OPENAI_COMPATIBLE_BASE_URL).replace(/\/+$/, '');
}

export function normalizeOpenRouterIgnoredProviders(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && entry.length <= 128))]
        .slice(0, 256);
}

export function normalizeAiApiConfig(value: unknown): AiApiConfig {
    const record = value && typeof value === 'object'
        ? value as Record<string, unknown>
        : {};
    const aiApiType = isAiApiType(record.aiApiType)
        ? record.aiApiType
        : isAiApiType(record.aiProvider)
            ? record.aiProvider
            : DEFAULT_AI_API_TYPE;
    return {
        aiApiType,
        openRouterIgnoredProviders: normalizeOpenRouterIgnoredProviders(record.openRouterIgnoredProviders),
        openAiCompatibleBaseUrl: normalizeOpenAiCompatibleBaseUrl(record.openAiCompatibleBaseUrl),
        openAiCompatibleEmbeddingsEnabled: typeof record.openAiCompatibleEmbeddingsEnabled === 'boolean'
            ? record.openAiCompatibleEmbeddingsEnabled
            : DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED,
        openAiCompatibleImageGenerationEnabled: typeof record.openAiCompatibleImageGenerationEnabled === 'boolean'
            ? record.openAiCompatibleImageGenerationEnabled
            : DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED,
        modelDefaults: normalizeModelDefaults(
            record.modelDefaults ?? record.modelDefaultsByProvider,
            getDefaultModelDefaults(aiApiType),
        ),
        roleApiTypes: normalizeRoleApiTypes(record.roleApiTypes),
    };
}

export function isOpenAiCompatibleFeatureEnabled(config: AiApiConfig, feature: 'embeddings' | 'imageGeneration'): boolean {
    return supportsAiApiFeature(config, config.aiApiType, feature);
}
