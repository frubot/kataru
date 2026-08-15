import { getDefaultModelDefaults, normalizeModelDefaults, type ModelDefaults } from './modelDefaults';

export { DEFAULT_ANTHROPIC_TEXT_MODEL } from './modelDefaults';

export type AiApiType = 'openrouter' | 'openai-compatible' | 'anthropic';

export interface AiApiConfig {
    aiApiType: AiApiType;
    openAiCompatibleBaseUrl: string;
    openAiCompatibleEmbeddingsEnabled: boolean;
    openAiCompatibleImageGenerationEnabled: boolean;
    modelDefaults: ModelDefaults;
}

export const DEFAULT_AI_API_TYPE: AiApiType = 'openrouter';
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED = true;
export const DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED = false;

export function isAiApiType(value: unknown): value is AiApiType {
    return value === 'openrouter' || value === 'openai-compatible' || value === 'anthropic';
}

export function normalizeOpenAiCompatibleBaseUrl(value: unknown): string {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return (trimmed || DEFAULT_OPENAI_COMPATIBLE_BASE_URL).replace(/\/+$/, '');
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
    };
}

export function isOpenAiCompatibleFeatureEnabled(config: AiApiConfig, feature: 'embeddings' | 'imageGeneration'): boolean {
    if (config.aiApiType === 'anthropic') return false;
    if (config.aiApiType !== 'openai-compatible') return true;
    if (feature === 'embeddings') return config.openAiCompatibleEmbeddingsEnabled;
    return config.openAiCompatibleImageGenerationEnabled;
}
