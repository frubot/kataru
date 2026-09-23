/** A model on a named AI connection. `connectionId` is the server-side
 * connection id (`openrouter` / `openai-compatible` / `anthropic` for the
 * built-ins, `cx_*` for custom connections). */
export interface ModelRef {
    connectionId: string;
    model: string;
}

/** The connection used when a stored value does not name one. */
export const DEFAULT_CONNECTION_ID = 'openrouter';

export const DEFAULT_SUMMARY_MODEL = 'google/gemma-4-31b-it';
export const DEFAULT_CHAT_MODEL = 'z-ai/glm-5.2';
export const DEFAULT_DIRECTOR_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const DEFAULT_AUTO_GENERATION_MODEL = 'z-ai/glm-5.3-flash';
export const DEFAULT_TITLE_GENERATION_MODEL = 'google/gemma-4-31b-it';
export const DEFAULT_REPLY_SUGGESTION_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const DEFAULT_IMAGE_MODEL = 'x-ai/grok-imagine-image-2.0';
export const DEFAULT_EXPRESSION_DETECTION_MODEL = 'google/gemma-4-31b-it';
export const DEFAULT_MEMORY_GATE_MODEL = '~typesafe/jev-latest';
export const DEFAULT_MEMORY_EXTRACTION_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const DEFAULT_MEMORY_EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';
export const DEFAULT_ANTHROPIC_TEXT_MODEL = 'claude-sonnet-4-6';

export interface ModelDefaults {
    summaryModel: ModelRef;
    defaultChatModel: ModelRef;
    defaultDirectorModel: ModelRef;
    defaultAutoGenerationModel: ModelRef;
    titleGenerationModel: ModelRef;
    replySuggestionModel: ModelRef;
    defaultImageModel: ModelRef;
    expressionDetectionModel: ModelRef;
    memoryGateModel: ModelRef;
    memoryExtractionModel: ModelRef;
    memoryEmbeddingModel: ModelRef;
}

export type ModelRoleKey = keyof ModelDefaults;

export const MODEL_DEFAULT_FIELDS: readonly ModelRoleKey[] = [
    'summaryModel',
    'defaultChatModel',
    'defaultDirectorModel',
    'defaultAutoGenerationModel',
    'titleGenerationModel',
    'replySuggestionModel',
    'defaultImageModel',
    'expressionDetectionModel',
    'memoryGateModel',
    'memoryExtractionModel',
    'memoryEmbeddingModel',
];

function defaultModelRef(model: string): ModelRef {
    return { connectionId: DEFAULT_CONNECTION_ID, model };
}

export const DEFAULT_MODEL_DEFAULTS: ModelDefaults = {
    summaryModel: defaultModelRef(DEFAULT_SUMMARY_MODEL),
    defaultChatModel: defaultModelRef(DEFAULT_CHAT_MODEL),
    defaultDirectorModel: defaultModelRef(DEFAULT_DIRECTOR_MODEL),
    defaultAutoGenerationModel: defaultModelRef(DEFAULT_AUTO_GENERATION_MODEL),
    titleGenerationModel: defaultModelRef(DEFAULT_TITLE_GENERATION_MODEL),
    replySuggestionModel: defaultModelRef(DEFAULT_REPLY_SUGGESTION_MODEL),
    defaultImageModel: defaultModelRef(DEFAULT_IMAGE_MODEL),
    expressionDetectionModel: defaultModelRef(DEFAULT_EXPRESSION_DETECTION_MODEL),
    memoryGateModel: defaultModelRef(DEFAULT_MEMORY_GATE_MODEL),
    memoryExtractionModel: defaultModelRef(DEFAULT_MEMORY_EXTRACTION_MODEL),
    memoryEmbeddingModel: defaultModelRef(DEFAULT_MEMORY_EMBEDDING_MODEL),
};

export function getDefaultModelDefaults(): ModelDefaults {
    return { ...DEFAULT_MODEL_DEFAULTS };
}

export function isModelRef(value: unknown): value is ModelRef {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.model === 'string'
        && record.model.trim().length > 0
        && typeof record.connectionId === 'string'
        && record.connectionId.trim().length > 0;
}

/** Normalizes a stored/requested model selection into a `ModelRef`.
 * Accepts a plain model name string, `{ model, connectionId }`, or the legacy
 * `{ model, aiApiType }` shape (the old `aiApiType` values are the built-in
 * connection ids). */
export function normalizeModelRef(value: unknown, fallback: ModelRef): ModelRef {
    if (typeof value === 'string') {
        const model = value.trim();
        return model
            ? { connectionId: fallback.connectionId, model }
            : { ...fallback };
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const connectionId = typeof record.connectionId === 'string' && record.connectionId.trim()
            ? record.connectionId.trim()
            : typeof record.aiApiType === 'string' && record.aiApiType.trim()
                ? record.aiApiType.trim()
                : fallback.connectionId;
        const model = typeof record.model === 'string' && record.model.trim()
            ? record.model.trim()
            : fallback.model;
        return { connectionId, model };
    }
    return { ...fallback };
}

/** The request-body shape for a model field: `{ model, connectionId }`. */
export function serializeModelRef(ref: ModelRef): { model: string; connectionId: string } {
    return { model: ref.model, connectionId: ref.connectionId };
}

export function modelRefModel(ref: ModelRef): string {
    return ref.model;
}

export function modelRefConnectionId(ref: ModelRef): string {
    return ref.connectionId;
}

export function modelRefsEqual(left: ModelRef, right: ModelRef): boolean {
    return left.model === right.model && left.connectionId === right.connectionId;
}

/** Jev (System One) ids: bare `jev-*` names on TypeSafe connections and
 * `typesafe/*` slugs — `~typesafe/*` for the redirecting alias — on
 * OpenRouter. Jev models are only served by the decisions API, so a ref
 * pointing at one implies the TypeSafe engine. */
const JEV_MODEL_PATTERN = /^(?:jev(?:-|$)|~?typesafe\/)/;

export function isJevModelRef(ref: ModelRef | null | undefined): boolean {
    if (!ref) return false;
    return ref.connectionId === 'typesafe' || JEV_MODEL_PATTERN.test(ref.model.trim());
}

export function normalizeModelDefaults(
    value: unknown,
    fallback: ModelDefaults = DEFAULT_MODEL_DEFAULTS,
): ModelDefaults {
    const record = value && typeof value === 'object'
        ? value as Record<string, unknown>
        : {};
    return {
        summaryModel: normalizeModelRef(record.summaryModel, fallback.summaryModel),
        defaultChatModel: normalizeModelRef(record.defaultChatModel, fallback.defaultChatModel),
        defaultDirectorModel: normalizeModelRef(record.defaultDirectorModel, fallback.defaultDirectorModel),
        defaultAutoGenerationModel: normalizeModelRef(record.defaultAutoGenerationModel, fallback.defaultAutoGenerationModel),
        titleGenerationModel: normalizeModelRef(record.titleGenerationModel, fallback.titleGenerationModel),
        replySuggestionModel: normalizeModelRef(record.replySuggestionModel, fallback.replySuggestionModel),
        defaultImageModel: normalizeModelRef(record.defaultImageModel, fallback.defaultImageModel),
        expressionDetectionModel: normalizeModelRef(record.expressionDetectionModel, fallback.expressionDetectionModel),
        memoryGateModel: normalizeModelRef(record.memoryGateModel, fallback.memoryGateModel),
        memoryExtractionModel: normalizeModelRef(record.memoryExtractionModel, fallback.memoryExtractionModel),
        memoryEmbeddingModel: normalizeModelRef(record.memoryEmbeddingModel, fallback.memoryEmbeddingModel),
    };
}
