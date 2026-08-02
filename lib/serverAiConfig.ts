export type AiConfigSource = 'default' | 'stored' | 'environment';

export interface ApiKeyStatus {
    configured: boolean;
    source: AiConfigSource | null;
    editable: boolean;
}

export interface ServerAiConfigStatus {
    openrouter: ApiKeyStatus;
    openai: {
        baseUrl: string;
        baseUrlSource: AiConfigSource;
        baseUrlEditable: boolean;
        apiKey: ApiKeyStatus;
    };
    secretStoreAvailable: boolean;
}

function isSource(value: unknown): value is AiConfigSource {
    return value === 'default' || value === 'stored' || value === 'environment';
}

function isApiKeyStatus(value: unknown): value is ApiKeyStatus {
    if (!value || typeof value !== 'object') return false;
    const status = value as Record<string, unknown>;
    return typeof status.configured === 'boolean'
        && (status.source === null || isSource(status.source))
        && typeof status.editable === 'boolean';
}

function isServerAiConfigStatus(value: unknown): value is ServerAiConfigStatus {
    if (!value || typeof value !== 'object') return false;
    const status = value as Record<string, unknown>;
    if (!isApiKeyStatus(status.openrouter) || typeof status.secretStoreAvailable !== 'boolean') {
        return false;
    }
    if (!status.openai || typeof status.openai !== 'object') return false;
    const openai = status.openai as Record<string, unknown>;
    return typeof openai.baseUrl === 'string'
        && isSource(openai.baseUrlSource)
        && typeof openai.baseUrlEditable === 'boolean'
        && isApiKeyStatus(openai.apiKey);
}

async function requestConfig(path: string, init?: RequestInit): Promise<ServerAiConfigStatus> {
    const response = await fetch(path, {
        ...init,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: init?.body
            ? { 'Content-Type': 'application/json', ...init.headers }
            : init?.headers,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const message = body && typeof body === 'object' && 'error' in body
            && typeof body.error === 'string'
            ? body.error
            : 'AI接続設定を更新できませんでした。';
        throw new Error(message);
    }
    if (!isServerAiConfigStatus(body)) {
        throw new Error('AI接続設定の応答形式が不正です。');
    }
    return body;
}

export function getServerAiConfig(): Promise<ServerAiConfigStatus> {
    return requestConfig('/api/ai/config');
}

export function setOpenRouterApiKey(apiKey: string): Promise<ServerAiConfigStatus> {
    return requestConfig('/api/ai/config/openrouter', {
        method: 'PUT',
        body: JSON.stringify({ apiKey }),
    });
}

export function deleteOpenRouterApiKey(): Promise<ServerAiConfigStatus> {
    return requestConfig('/api/ai/config/openrouter', { method: 'DELETE' });
}

export function setOpenAiConfig(input: {
    baseUrl?: string;
    apiKey?: string;
}): Promise<ServerAiConfigStatus> {
    return requestConfig('/api/ai/config/openai', {
        method: 'PUT',
        body: JSON.stringify(input),
    });
}

export function deleteOpenAiApiKey(): Promise<ServerAiConfigStatus> {
    return requestConfig('/api/ai/config/openai/api-key', { method: 'DELETE' });
}
