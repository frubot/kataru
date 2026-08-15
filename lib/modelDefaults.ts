import type { AiApiType } from './aiApi';

export const DEFAULT_SUMMARY_MODEL = 'z-ai/glm-5.2';
export const DEFAULT_CHAT_MODEL = 'z-ai/glm-5.2';
export const DEFAULT_DIRECTOR_MODEL = 'deepseek/deepseek-v4-flash';
export const DEFAULT_AUTO_GENERATION_MODEL = 'z-ai/glm-5.2';
export const DEFAULT_TITLE_GENERATION_MODEL = 'deepseek/deepseek-v4-flash';
export const DEFAULT_REPLY_SUGGESTION_MODEL = 'deepseek/deepseek-v4-flash';
export const DEFAULT_IMAGE_MODEL = 'bytedance-seed/seedream-4.5';
export const DEFAULT_MEMORY_EXTRACTION_MODEL = 'deepseek/deepseek-v4-flash';
export const DEFAULT_MEMORY_EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';
export const DEFAULT_ANTHROPIC_TEXT_MODEL = 'claude-sonnet-4-6';

export interface ModelDefaults {
    summaryModel: string;
    defaultChatModel: string;
    defaultDirectorModel: string;
    defaultAutoGenerationModel: string;
    titleGenerationModel: string;
    replySuggestionModel: string;
    defaultImageModel: string;
    memoryExtractionModel: string;
    memoryEmbeddingModel: string;
}

export type ModelDefaultsByApiType = Record<AiApiType, ModelDefaults>;

export const DEFAULT_MODEL_DEFAULTS: ModelDefaults = {
    summaryModel: DEFAULT_SUMMARY_MODEL,
    defaultChatModel: DEFAULT_CHAT_MODEL,
    defaultDirectorModel: DEFAULT_DIRECTOR_MODEL,
    defaultAutoGenerationModel: DEFAULT_AUTO_GENERATION_MODEL,
    titleGenerationModel: DEFAULT_TITLE_GENERATION_MODEL,
    replySuggestionModel: DEFAULT_REPLY_SUGGESTION_MODEL,
    defaultImageModel: DEFAULT_IMAGE_MODEL,
    memoryExtractionModel: DEFAULT_MEMORY_EXTRACTION_MODEL,
    memoryEmbeddingModel: DEFAULT_MEMORY_EMBEDDING_MODEL,
};

const AI_API_TYPES: readonly AiApiType[] = ['openrouter', 'openai-compatible', 'anthropic'];

export const DEFAULT_MODEL_DEFAULTS_BY_API_TYPE: ModelDefaultsByApiType = {
    openrouter: DEFAULT_MODEL_DEFAULTS,
    'openai-compatible': DEFAULT_MODEL_DEFAULTS,
    anthropic: {
        ...DEFAULT_MODEL_DEFAULTS,
        summaryModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        defaultChatModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        defaultDirectorModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        defaultAutoGenerationModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        titleGenerationModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        replySuggestionModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
        memoryExtractionModel: DEFAULT_ANTHROPIC_TEXT_MODEL,
    },
};

export function getDefaultModelDefaults(apiType: AiApiType): ModelDefaults {
    return DEFAULT_MODEL_DEFAULTS_BY_API_TYPE[apiType];
}

function normalizeModelName(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function normalizeModelDefaults(value: unknown, fallback: ModelDefaults = DEFAULT_MODEL_DEFAULTS): ModelDefaults {
    const record = value && typeof value === 'object'
        ? value as Record<string, unknown>
        : {};
    return {
        summaryModel: normalizeModelName(record.summaryModel, fallback.summaryModel),
        defaultChatModel: normalizeModelName(record.defaultChatModel, fallback.defaultChatModel),
        defaultDirectorModel: normalizeModelName(record.defaultDirectorModel, fallback.defaultDirectorModel),
        defaultAutoGenerationModel: normalizeModelName(record.defaultAutoGenerationModel, fallback.defaultAutoGenerationModel),
        titleGenerationModel: normalizeModelName(record.titleGenerationModel, fallback.titleGenerationModel),
        replySuggestionModel: normalizeModelName(record.replySuggestionModel, fallback.replySuggestionModel),
        defaultImageModel: normalizeModelName(record.defaultImageModel, fallback.defaultImageModel),
        memoryExtractionModel: normalizeModelName(record.memoryExtractionModel, fallback.memoryExtractionModel),
        memoryEmbeddingModel: normalizeModelName(record.memoryEmbeddingModel, fallback.memoryEmbeddingModel),
    };
}

export function normalizeModelDefaultsByApiType(
    value: unknown,
    fallback?: ModelDefaults,
): ModelDefaultsByApiType {
    const record = value && typeof value === 'object'
        ? value as Partial<Record<AiApiType, unknown>>
        : {};
    return Object.fromEntries(
        AI_API_TYPES.map((apiType) => [
            apiType,
            normalizeModelDefaults(record[apiType], fallback ?? getDefaultModelDefaults(apiType)),
        ]),
    ) as ModelDefaultsByApiType;
}
