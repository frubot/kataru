import type { AiConnectionStatus } from './aiConnections';

export interface AvailableModel {
    id: string;
    name: string;
}

export type ModelOutputModality = 'text' | 'image' | 'embeddings' | 'decisions';

interface ModelsResponse {
    data: AvailableModel[];
}

const modelCache = new Map<string, AvailableModel[]>();
const pendingRequests = new Map<string, Promise<AvailableModel[]>>();
const keyGenerations = new Map<string, number>();
let cacheGeneration = 0;

function cacheKey(connectionId: string, outputModality: ModelOutputModality): string {
    return JSON.stringify([connectionId, outputModality]);
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

async function requestAvailableModels(
    connectionId: string,
    outputModality: ModelOutputModality,
    forceRefresh: boolean,
): Promise<AvailableModel[]> {
    const response = await fetch('/api/ai/models', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            aiApiConfig: { connectionId },
            outputModality,
            forceRefresh,
        }),
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
    connectionId: string,
    outputModality: ModelOutputModality,
    options: { force?: boolean } = {},
): Promise<AvailableModel[]> {
    const key = cacheKey(connectionId, outputModality);
    if (options.force) {
        keyGenerations.set(key, (keyGenerations.get(key) ?? 0) + 1);
        modelCache.delete(key);
        pendingRequests.delete(key);
    }
    const cached = modelCache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = pendingRequests.get(key);
    if (pending) return pending;

    const requestGeneration = cacheGeneration;
    const requestKeyGeneration = keyGenerations.get(key) ?? 0;
    const request = requestAvailableModels(connectionId, outputModality, options.force === true)
        .then((models) => {
            if (
                requestGeneration === cacheGeneration
                && requestKeyGeneration === (keyGenerations.get(key) ?? 0)
            ) {
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
    keyGenerations.clear();
}

export type AiConnectionModelsResult =
    | { connection: AiConnectionStatus; models: AvailableModel[] }
    | { connection: AiConnectionStatus; error: string };

/** Whether listing models for this connection can possibly succeed without
 * asking the server: either a credential is configured, or it is an
 * OpenAI-compatible endpoint pointed at a non-default base URL (keyless local
 * servers). */
export function canListModels(connection: AiConnectionStatus): boolean {
    if (connection.apiKey.configured) return true;
    return connection.kind === 'openai-compatible'
        && typeof connection.baseUrl === 'string'
        && connection.baseUrl.trim().length > 0
        && connection.baseUrlSource !== 'default';
}

/** Lists models across multiple connections in parallel. A failure on one
 * connection produces an `error` entry for that connection only. */
export async function getAvailableModelsForConnections(
    connections: AiConnectionStatus[],
    outputModality: ModelOutputModality,
    options: { force?: boolean } = {},
): Promise<AiConnectionModelsResult[]> {
    return Promise.all(connections.map(async (connection): Promise<AiConnectionModelsResult> => {
        if (!canListModels(connection)) {
            return { connection, error: 'APIキーが設定されていません。' };
        }
        try {
            const models = await getAvailableModels(connection.id, outputModality, options);
            return { connection, models };
        } catch (error) {
            return {
                connection,
                error: error instanceof Error && error.message
                    ? error.message
                    : '利用可能なモデルを取得できませんでした。',
            };
        }
    }));
}
