import type { AiApiConfig } from './aiApi';

export interface AvailableProvider {
    slug: string;
    name: string;
}

interface ProvidersResponse {
    data: AvailableProvider[];
}

let providerCache: AvailableProvider[] | null = null;
let pendingRequest: Promise<AvailableProvider[]> | null = null;
let cacheGeneration = 0;

function isProvidersResponse(value: unknown): value is ProvidersResponse {
    if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)) {
        return false;
    }
    return value.data.every((provider) => Boolean(
        provider
        && typeof provider === 'object'
        && 'slug' in provider
        && typeof provider.slug === 'string'
        && 'name' in provider
        && typeof provider.name === 'string',
    ));
}

async function requestAvailableProviders(config: AiApiConfig): Promise<AvailableProvider[]> {
    const response = await fetch('/api/ai/providers', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiApiConfig: config }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const message = body && typeof body === 'object' && 'error' in body
            && typeof body.error === 'string'
            ? body.error
            : 'プロバイダー一覧を取得できませんでした。';
        throw new Error(message);
    }
    if (!isProvidersResponse(body)) {
        throw new Error('プロバイダー一覧の応答形式が不正です。');
    }
    return body.data;
}

export function getAvailableProviders(
    config: AiApiConfig,
    options: { force?: boolean } = {},
): Promise<AvailableProvider[]> {
    if (options.force) {
        cacheGeneration += 1;
        providerCache = null;
        pendingRequest = null;
    }
    if (providerCache) return Promise.resolve(providerCache);
    if (pendingRequest) return pendingRequest;

    const requestGeneration = cacheGeneration;
    const request = requestAvailableProviders(config)
        .then((providers) => {
            if (requestGeneration === cacheGeneration) providerCache = providers;
            return providers;
        })
        .finally(() => {
            if (pendingRequest === request) pendingRequest = null;
        });
    pendingRequest = request;
    return request;
}

export function clearAvailableProvidersCache(): void {
    cacheGeneration += 1;
    providerCache = null;
    pendingRequest = null;
}
