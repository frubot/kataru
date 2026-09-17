export interface AvailableProvider {
    slug: string;
    name: string;
}

interface ProvidersResponse {
    data: AvailableProvider[];
}

const providerCache = new Map<string, AvailableProvider[]>();
const pendingRequests = new Map<string, Promise<AvailableProvider[]>>();
const keyGenerations = new Map<string, number>();
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

async function requestAvailableProviders(connectionId: string): Promise<AvailableProvider[]> {
    const response = await fetch('/api/ai/providers', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiApiConfig: { connectionId } }),
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
    connectionId: string,
    options: { force?: boolean } = {},
): Promise<AvailableProvider[]> {
    if (options.force) {
        keyGenerations.set(connectionId, (keyGenerations.get(connectionId) ?? 0) + 1);
        providerCache.delete(connectionId);
        pendingRequests.delete(connectionId);
    }
    const cached = providerCache.get(connectionId);
    if (cached) return Promise.resolve(cached);
    const pending = pendingRequests.get(connectionId);
    if (pending) return pending;

    const requestGeneration = cacheGeneration;
    const requestKeyGeneration = keyGenerations.get(connectionId) ?? 0;
    const request = requestAvailableProviders(connectionId)
        .then((providers) => {
            if (
                requestGeneration === cacheGeneration
                && requestKeyGeneration === (keyGenerations.get(connectionId) ?? 0)
            ) {
                providerCache.set(connectionId, providers);
            }
            return providers;
        })
        .finally(() => {
            if (pendingRequests.get(connectionId) === request) {
                pendingRequests.delete(connectionId);
            }
        });
    pendingRequests.set(connectionId, request);
    return request;
}

export function clearAvailableProvidersCache(): void {
    cacheGeneration += 1;
    providerCache.clear();
    pendingRequests.clear();
    keyGenerations.clear();
}
