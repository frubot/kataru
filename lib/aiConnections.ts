import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
    isAiConnectionKind,
    normalizeOpenRouterIgnoredProviders,
    type AiConnectionKind,
} from './aiApi';
import { clearAvailableModelsCache } from './availableModels';
import { clearAvailableProvidersCache } from './availableProviders';

export type AiConnectionSecretSource = 'stored' | 'environment';
export type AiConnectionBaseUrlSource = 'default' | 'stored' | 'environment';

export interface AiConnectionApiKeyStatus {
    configured: boolean;
    source: AiConnectionSecretSource | null;
    editable: boolean;
}

export interface AiConnectionStatus {
    id: string;
    name: string;
    kind: AiConnectionKind;
    baseUrl: string | null;
    baseUrlSource: AiConnectionBaseUrlSource | null;
    baseUrlEditable: boolean;
    apiKey: AiConnectionApiKeyStatus;
    builtin: boolean;
    editable: boolean;
    deletable: boolean;
    embeddingsEnabled: boolean;
    imageGenerationEnabled: boolean;
    ttsEnabled: boolean;
    ignoredProviders: string[];
}

export interface AiConnectionsResponse {
    connections: AiConnectionStatus[];
    secretStoreAvailable: boolean;
}

export interface CreateAiConnectionInput {
    name: string;
    kind: AiConnectionKind;
    baseUrl?: string;
    apiKey?: string;
    embeddingsEnabled?: boolean;
    imageGenerationEnabled?: boolean;
    ttsEnabled?: boolean;
    ignoredProviders?: string[];
}

export interface UpdateAiConnectionInput {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    clearApiKey?: boolean;
    embeddingsEnabled?: boolean;
    imageGenerationEnabled?: boolean;
    ttsEnabled?: boolean;
    ignoredProviders?: string[];
}

const CONNECTIONS_ENDPOINT = '/api/ai/connections';

function isSecretSource(value: unknown): value is AiConnectionSecretSource {
    return value === 'stored' || value === 'environment';
}

function isBaseUrlSource(value: unknown): value is AiConnectionBaseUrlSource {
    return value === 'default' || value === 'stored' || value === 'environment';
}

function isApiKeyStatus(value: unknown): value is AiConnectionApiKeyStatus {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const status = value as Record<string, unknown>;
    return typeof status.configured === 'boolean'
        && (status.source === null || isSecretSource(status.source))
        && typeof status.editable === 'boolean';
}

export function isAiConnectionStatus(value: unknown): value is AiConnectionStatus {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const connection = value as Record<string, unknown>;
    if (typeof connection.id !== 'string' || connection.id.length === 0) return false;
    if (typeof connection.name !== 'string') return false;
    if (!isAiConnectionKind(connection.kind)) return false;
    if (connection.baseUrl !== null && typeof connection.baseUrl !== 'string') return false;
    if (connection.baseUrlSource !== null && !isBaseUrlSource(connection.baseUrlSource)) return false;
    if (typeof connection.baseUrlEditable !== 'boolean') return false;
    if (!isApiKeyStatus(connection.apiKey)) return false;
    if (typeof connection.builtin !== 'boolean'
        || typeof connection.editable !== 'boolean'
        || typeof connection.deletable !== 'boolean') return false;
    if (typeof connection.embeddingsEnabled !== 'boolean'
        || typeof connection.imageGenerationEnabled !== 'boolean'
        || typeof connection.ttsEnabled !== 'boolean') return false;
    return Array.isArray(connection.ignoredProviders)
        && connection.ignoredProviders.every((provider) => typeof provider === 'string');
}

function isAiConnectionsResponse(value: unknown): value is AiConnectionsResponse {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const response = value as Record<string, unknown>;
    return typeof response.secretStoreAvailable === 'boolean'
        && Array.isArray(response.connections)
        && response.connections.every(isAiConnectionStatus);
}

async function requestConnections(path: string, init?: RequestInit): Promise<AiConnectionsResponse> {
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
    if (!isAiConnectionsResponse(body)) {
        throw new Error('AI接続設定の応答形式が不正です。');
    }
    return body;
}

type AiConnectionsSnapshot = {
    connections: AiConnectionStatus[];
    secretStoreAvailable: boolean;
    loading: boolean;
    loaded: boolean;
    error: string | null;
};

const EMPTY_SNAPSHOT: AiConnectionsSnapshot = {
    connections: [],
    secretStoreAvailable: false,
    loading: false,
    loaded: false,
    error: null,
};

let snapshot: AiConnectionsSnapshot = EMPTY_SNAPSHOT;
let inflightRequest: Promise<AiConnectionsResponse> | null = null;
let requestGeneration = 0;
const listeners = new Set<() => void>();

function emitSnapshot(next: AiConnectionsSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
}

function subscribeAiConnections(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getAiConnectionsSnapshot(): AiConnectionsSnapshot {
    return snapshot;
}

function toResponse(state: AiConnectionsSnapshot): AiConnectionsResponse {
    return {
        connections: state.connections,
        secretStoreAvailable: state.secretStoreAvailable,
    };
}

function applyConnectionsResponse(response: AiConnectionsResponse): AiConnectionsResponse {
    emitSnapshot({
        connections: response.connections,
        secretStoreAvailable: response.secretStoreAvailable,
        loading: false,
        loaded: true,
        error: null,
    });
    return response;
}

function connectionErrorMessage(error: unknown): string {
    return error instanceof Error && error.message
        ? error.message
        : 'AI接続設定を取得できませんでした。';
}

export function getAiConnections(options: { force?: boolean } = {}): Promise<AiConnectionsResponse> {
    if (!options.force) {
        if (snapshot.loaded && !snapshot.error) return Promise.resolve(toResponse(snapshot));
        if (inflightRequest) return inflightRequest;
    }
    const generation = ++requestGeneration;
    emitSnapshot({ ...snapshot, loading: true, error: null });
    const request = requestConnections(CONNECTIONS_ENDPOINT)
        .then((response) => {
            if (generation === requestGeneration) applyConnectionsResponse(response);
            return response;
        })
        .catch((error: unknown) => {
            if (generation === requestGeneration) {
                emitSnapshot({ ...snapshot, loading: false, loaded: true, error: connectionErrorMessage(error) });
            }
            throw error;
        })
        .finally(() => {
            if (inflightRequest === request) inflightRequest = null;
        });
    inflightRequest = request;
    return request;
}

function applyMutationResponse(response: AiConnectionsResponse): AiConnectionsResponse {
    // Invalidate any in-flight list request so a stale response cannot
    // overwrite the fresher list the mutation just returned.
    requestGeneration += 1;
    applyConnectionsResponse(response);
    // Connection settings (baseUrl/apiKey/ignoredProviders) change what the
    // models/providers endpoints return.
    clearAvailableModelsCache();
    clearAvailableProvidersCache();
    return response;
}

export async function createAiConnection(input: CreateAiConnectionInput): Promise<AiConnectionsResponse> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new Error('接続名を入力してください。');
    if (!isAiConnectionKind(input.kind)) throw new Error('接続種別が不正です。');
    const body: Record<string, unknown> = {
        name,
        kind: input.kind,
        ...(typeof input.baseUrl === 'string' && input.baseUrl.trim()
            ? { baseUrl: input.baseUrl.trim() }
            : {}),
        ...(typeof input.apiKey === 'string' && input.apiKey.trim()
            ? { apiKey: input.apiKey.trim() }
            : {}),
        ...(typeof input.embeddingsEnabled === 'boolean'
            ? { embeddingsEnabled: input.embeddingsEnabled }
            : {}),
        ...(typeof input.imageGenerationEnabled === 'boolean'
            ? { imageGenerationEnabled: input.imageGenerationEnabled }
            : {}),
        ...(typeof input.ttsEnabled === 'boolean'
            ? { ttsEnabled: input.ttsEnabled }
            : {}),
        ...(input.ignoredProviders !== undefined
            ? { ignoredProviders: normalizeOpenRouterIgnoredProviders(input.ignoredProviders) }
            : {}),
    };
    return applyMutationResponse(await requestConnections(CONNECTIONS_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify(body),
    }));
}

export async function updateAiConnection(
    id: string,
    input: UpdateAiConnectionInput,
): Promise<AiConnectionsResponse> {
    const connectionId = id.trim();
    if (!connectionId) throw new Error('接続IDが不正です。');
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw new Error('接続名を入力してください。');
        body.name = name;
    }
    if (input.baseUrl !== undefined) body.baseUrl = input.baseUrl.trim();
    if (input.clearApiKey === true) {
        body.clearApiKey = true;
    } else if (input.apiKey !== undefined) {
        const apiKey = input.apiKey.trim();
        if (apiKey) body.apiKey = apiKey;
    }
    if (input.embeddingsEnabled !== undefined) body.embeddingsEnabled = input.embeddingsEnabled === true;
    if (input.imageGenerationEnabled !== undefined) body.imageGenerationEnabled = input.imageGenerationEnabled === true;
    if (input.ttsEnabled !== undefined) body.ttsEnabled = input.ttsEnabled === true;
    if (input.ignoredProviders !== undefined) {
        body.ignoredProviders = normalizeOpenRouterIgnoredProviders(input.ignoredProviders);
    }
    return applyMutationResponse(await requestConnections(
        `${CONNECTIONS_ENDPOINT}/${encodeURIComponent(connectionId)}`,
        { method: 'PUT', body: JSON.stringify(body) },
    ));
}

export async function deleteAiConnection(id: string): Promise<AiConnectionsResponse> {
    const connectionId = id.trim();
    if (!connectionId) throw new Error('接続IDが不正です。');
    return applyMutationResponse(await requestConnections(
        `${CONNECTIONS_ENDPOINT}/${encodeURIComponent(connectionId)}`,
        { method: 'DELETE' },
    ));
}

export function clearAiConnectionsCache(): void {
    requestGeneration += 1;
    inflightRequest = null;
    emitSnapshot(EMPTY_SNAPSHOT);
}

export interface UseAiConnectionsResult {
    connections: AiConnectionStatus[];
    secretStoreAvailable: boolean;
    loading: boolean;
    error: string | null;
    reload: () => Promise<void>;
}

/** Shared connection list for React components. All subscribers see the same
 * cached snapshot; `reload()` forces a refetch. */
export function useAiConnections(): UseAiConnectionsResult {
    const current = useSyncExternalStore(
        subscribeAiConnections,
        getAiConnectionsSnapshot,
        getAiConnectionsSnapshot,
    );
    const { loaded, loading } = current;
    useEffect(() => {
        if (!loaded && !loading) void getAiConnections().catch(() => undefined);
    }, [loaded, loading]);
    const reload = useCallback(async () => {
        await getAiConnections({ force: true }).catch(() => undefined);
    }, []);
    return {
        connections: current.connections,
        secretStoreAvailable: current.secretStoreAvailable,
        loading: current.loading,
        error: current.error,
        reload,
    };
}
