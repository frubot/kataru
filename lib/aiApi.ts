import {
    DEFAULT_CONNECTION_ID,
    getDefaultModelDefaults,
    MODEL_DEFAULT_FIELDS,
    normalizeModelDefaults,
    type ModelDefaults,
} from './modelDefaults';

export { DEFAULT_ANTHROPIC_TEXT_MODEL } from './modelDefaults';
export {
    DEFAULT_CONNECTION_ID,
    isModelRef,
    modelRefConnectionId,
    modelRefModel,
    modelRefsEqual,
    normalizeModelRef,
    serializeModelRef,
    type ModelRef,
} from './modelDefaults';

/** The kind of API a connection speaks. Built-in connections use the same
 * value as their connection id. */
export type AiConnectionKind = 'openrouter' | 'openai-compatible' | 'anthropic';

/** 互換エイリアス。組み込み接続の id と同じ値を取る。 */
export type AiApiType = AiConnectionKind;

export const AI_CONNECTION_KIND_LABELS: Record<AiConnectionKind, string> = {
    openrouter: 'OpenRouter',
    'openai-compatible': 'OpenAI / 互換API',
    anthropic: 'Anthropic / 互換API',
};

/** 互換エイリアス。 */
export const AI_API_TYPE_LABELS = AI_CONNECTION_KIND_LABELS;

export const DEFAULT_AI_API_TYPE: AiApiType = DEFAULT_CONNECTION_ID;

export function isAiConnectionKind(value: unknown): value is AiConnectionKind {
    return value === 'openrouter' || value === 'openai-compatible' || value === 'anthropic';
}

/** 互換エイリアス。 */
export const isAiApiType = isAiConnectionKind;

/** Per-request AI settings. The server resolves the actual endpoint and
 * credentials from the named connection. */
export interface AiApiConfig {
    /** Connection id for the request. Omitted when each model field carries
     * its own `connectionId`. */
    connectionId?: string;
    modelDefaults: ModelDefaults;
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
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const connectionId = typeof record.connectionId === 'string' && record.connectionId.trim()
        ? record.connectionId.trim()
        : isAiConnectionKind(record.aiApiType)
            ? record.aiApiType
            : isAiConnectionKind(record.aiProvider)
                ? record.aiProvider
                : undefined;
    // 文字列だけのモデル指定はこのリクエストの接続上のモデルとして解釈する。
    const fallback = getDefaultModelDefaults();
    if (connectionId) {
        for (const field of MODEL_DEFAULT_FIELDS) {
            fallback[field] = { ...fallback[field], connectionId };
        }
    }
    return {
        ...(connectionId ? { connectionId } : {}),
        modelDefaults: normalizeModelDefaults(
            record.modelDefaults ?? record.modelDefaultsByProvider,
            fallback,
        ),
    };
}
