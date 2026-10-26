import type { AiConnectionKind } from './aiApi';

/** A model on a named AI connection. `connectionId` is the server-side
 * connection id (`openrouter` / `openai-compatible` / `anthropic` for the
 * built-ins, `cx_*` for custom connections). `model` may be empty, which means
 * the connection is chosen but its model is not picked yet. Both fields are
 * empty for a role that has no usable connection at all. */
export interface ModelRef {
    connectionId: string;
    model: string;
}

/** A role with neither a connection nor a model selected. */
export function emptyModelRef(): ModelRef {
    return { connectionId: '', model: '' };
}

export function isEmptyModelRef(ref: ModelRef | null | undefined): boolean {
    return !ref || (!ref.connectionId.trim() && !ref.model.trim());
}

/** OpenRouterの `reasoning.effort` に対応する推論レベル。'none' は推論なし。 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'none';

export const REASONING_EFFORT_OPTIONS: readonly { value: ReasoningEffort; label: string }[] = [
    { value: 'none', label: 'なし' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
    return value === 'none' || value === 'low' || value === 'medium' || value === 'high';
}

/** The connection used when a stored value does not name one. */
export const DEFAULT_CONNECTION_ID = 'openrouter';

export const DEFAULT_SUMMARY_MODEL = 'google/gemma-4-31b-it';
export const DEFAULT_CHAT_MODEL = 'z-ai/glm-5.2';
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

/** Shape check that tolerates an unset selection: a chosen connection whose
 * model the user has not picked yet, or an empty ref for a role no configured
 * connection can serve. */
export function isModelRefShape(value: unknown): value is ModelRef {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.model === 'string'
        && typeof record.connectionId === 'string';
}

/** A complete selection: both a connection and a model were picked. */
export function isModelRef(value: unknown): value is ModelRef {
    if (!isModelRefShape(value)) return false;
    return value.model.trim().length > 0 && value.connectionId.trim().length > 0;
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
        // `connectionId` が文字列で明示されていれば、空文字でもそのまま採用する。
        // 空文字は「利用できる接続が無い」を表し、ここでフォールバック
        // （既定はOpenRouter）を復活させると、未設定の接続を設定済みとして
        // 扱ってしまう。
        const connectionId = typeof record.connectionId === 'string'
            ? record.connectionId.trim()
            : typeof record.aiApiType === 'string' && record.aiApiType.trim()
                ? record.aiApiType.trim()
                : fallback.connectionId;
        // `model` が文字列で明示されていれば、空文字でもそのまま採用する。
        // 空文字は「接続だけ決めてモデルは未選択」を表し、ここでフォールバック
        // （既定はOpenRouterのモデル名）を復活させると、別の接続に OpenRouter の
        // モデル名が載ってしまう。
        const model = typeof record.model === 'string'
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

/** The connection fields the default-model rebase needs. `AiConnectionStatus`
 * satisfies this structurally. */
export interface RebaseConnection {
    id: string;
    kind: AiConnectionKind;
    apiKey: { configured: boolean };
    baseUrlSource: 'default' | 'stored' | 'environment' | null;
    embeddingsEnabled: boolean;
    imageGenerationEnabled: boolean;
}

/** What a role needs from its connection. */
type RoleCapability = 'text' | 'image' | 'embeddings' | 'decisions';

const ROLE_CAPABILITIES: Record<ModelRoleKey, RoleCapability> = {
    summaryModel: 'text',
    defaultChatModel: 'text',
    defaultAutoGenerationModel: 'text',
    titleGenerationModel: 'text',
    replySuggestionModel: 'text',
    defaultImageModel: 'image',
    expressionDetectionModel: 'text',
    memoryGateModel: 'decisions',
    memoryExtractionModel: 'text',
    memoryEmbeddingModel: 'embeddings',
};

/** Which connection kinds to try first for a capability. OpenRouter serves
 * everything, so it wins whenever it is configured. */
const CAPABILITY_KIND_ORDER: Record<RoleCapability, readonly AiConnectionKind[]> = {
    text: ['openrouter', 'anthropic', 'openai-compatible'],
    image: ['openrouter', 'openai-compatible'],
    embeddings: ['openrouter', 'openai-compatible'],
    decisions: ['openrouter', 'typesafe'],
};

/** Whether a connection can serve requests without further configuration.
 * Everything in the status list is already "configured" on the server side,
 * but a built-in can be listed for a stored name or base URL without a key. */
function isConfiguredConnection(connection: RebaseConnection): boolean {
    switch (connection.kind) {
        case 'voicevox':
        case 'irodori':
            return false;
        case 'openai-compatible':
            // ローカルやLANの互換サーバーはAPIキー無しでも動く。
            return connection.apiKey.configured
                || connection.baseUrlSource === 'stored'
                || connection.baseUrlSource === 'environment';
        default:
            return connection.apiKey.configured;
    }
}

function supportsCapability(connection: RebaseConnection, capability: RoleCapability): boolean {
    switch (connection.kind) {
        case 'openrouter':
            return true;
        case 'anthropic':
            return capability === 'text';
        case 'typesafe':
            return capability === 'decisions';
        case 'openai-compatible':
            return capability === 'text'
                || (capability === 'image' && connection.imageGenerationEnabled)
                || (capability === 'embeddings' && connection.embeddingsEnabled);
        default:
            return false;
    }
}

function pickConnection(
    capability: RoleCapability,
    connections: readonly RebaseConnection[],
): RebaseConnection | null {
    for (const kind of CAPABILITY_KIND_ORDER[capability]) {
        const candidates = connections.filter((connection) => (
            connection.kind === kind && supportsCapability(connection, capability)
        ));
        if (candidates.length === 0) continue;
        // 組み込み接続（id と kind が同じ）を優先し、無ければ先頭。
        return candidates.find((connection) => connection.id === kind) ?? candidates[0];
    }
    return null;
}

/** The model name to use on `connection` for `role`. Only names we know the
 * connection serves are filled in; a compatible server's catalog is
 * server-specific, so its model stays unset for the user to choose. */
function modelForConnection(role: ModelRoleKey, connection: RebaseConnection): string {
    switch (connection.kind) {
        case 'openrouter':
            return DEFAULT_MODEL_DEFAULTS[role].model;
        case 'anthropic':
            return DEFAULT_ANTHROPIC_TEXT_MODEL;
        case 'typesafe':
            return 'jev-latest';
        default:
            return '';
    }
}

export interface ModelDefaultsRebaseResult {
    defaults: ModelDefaults;
    changedRoles: ModelRoleKey[];
}

/** Re-points every role whose connection is not configured at a connection
 * that can serve the role, keeping an explicit user choice untouched.
 *
 * The built-in defaults name OpenRouter. Without an OpenRouter key those refs
 * can never run, so they are moved onto a configured connection (OpenRouter
 * first, then the best local/other option). A role no configured connection can
 * serve — image generation or memory search with only Anthropic, or every role
 * before any connection is configured — is cleared to an empty ref rather than
 * left pointing at OpenRouter's default. That keeps the settings screen honest:
 * it shows an unset role instead of a model the app cannot run. */
export function rebaseModelDefaults(
    defaults: ModelDefaults,
    connections: readonly RebaseConnection[],
): ModelDefaultsRebaseResult {
    const configured = connections.filter(isConfiguredConnection);
    const next = { ...defaults };
    const changedRoles: ModelRoleKey[] = [];
    for (const role of MODEL_DEFAULT_FIELDS) {
        const current = defaults[role];
        if (current.connectionId
            && configured.some((connection) => connection.id === current.connectionId)) {
            continue;
        }
        const target = pickConnection(ROLE_CAPABILITIES[role], configured);
        const rebased = target
            ? { connectionId: target.id, model: modelForConnection(role, target) }
            : emptyModelRef();
        if (modelRefsEqual(current, rebased)) continue;
        next[role] = rebased;
        changedRoles.push(role);
    }
    return changedRoles.length === 0
        ? { defaults, changedRoles }
        : { defaults: next, changedRoles };
}
