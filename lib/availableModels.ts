import type { AiProviderConfig } from './aiProvider';

export interface AvailableModel {
    id: string;
    name: string;
}

interface ModelsResponse {
    data: AvailableModel[];
}

const modelCache = new Map<string, AvailableModel[]>();
const pendingRequests = new Map<string, Promise<AvailableModel[]>>();
let cacheGeneration = 0;

function cacheKey(config: AiProviderConfig): string {
    return JSON.stringify([
        config.aiProvider,
        config.openAiCompatibleBaseUrl,
    ]);
}

function isModelsResponse(value: unknown): value is ModelsResponse {
    if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)) {
        return false;
    }
    return value.data.every((model) => Boolean(
        model
        && typeof model === 'object'
        && 'id' in model
        && typeof model.id === 'string'
        && 'name' in model
        && typeof model.name === 'string',
    ));
}

async function requestAvailableModels(config: AiProviderConfig): Promise<AvailableModel[]> {
    const response = await fetch('/api/ai/models', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiProviderConfig: config }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const message = body && typeof body === 'object' && 'error' in body
            && typeof body.error === 'string'
            ? body.error
            : '利用可能なモデルを取得できませんでした。';
        throw new Error(message);
    }
    if (!isModelsResponse(body)) {
        throw new Error('モデル一覧の応答形式が不正です。');
    }
    return body.data;
}

export function getAvailableModels(
    config: AiProviderConfig,
    options: { force?: boolean } = {},
): Promise<AvailableModel[]> {
    const key = cacheKey(config);
    if (options.force) {
        cacheGeneration += 1;
        modelCache.delete(key);
        pendingRequests.delete(key);
    }
    const cached = modelCache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = pendingRequests.get(key);
    if (pending) return pending;

    const requestGeneration = cacheGeneration;
    const request = requestAvailableModels(config)
        .then((models) => {
            if (requestGeneration === cacheGeneration) {
                modelCache.set(key, models);
            }
            return models;
        })
        .finally(() => {
            if (pendingRequests.get(key) === request) {
                pendingRequests.delete(key);
            }
        });
    pendingRequests.set(key, request);
    return request;
}

export function clearAvailableModelsCache(): void {
    cacheGeneration += 1;
    modelCache.clear();
    pendingRequests.clear();
}
