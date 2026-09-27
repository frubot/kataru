import { useEffect, useState, useSyncExternalStore } from 'react';

import { getAvailableModels } from './availableModels';
import * as db from './db';
import type { ModelRef } from './modelDefaults';

/** Models the user marked as transparent-capable, persisted as
 * `connectionId/modelId` keys under this meta key. OpenAI-compatible
 * endpoints expose no capability discovery, so the mark is the declaration. */
const MARKED_MODELS_META_KEY = 'transparentImageModels';

let markedModels = new Set<string>();
let markedModelsLoaded = false;
let markedModelsLoadPromise: Promise<void> | null = null;
let markedModelsWriteQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function markedModelKey(connectionId: string, modelId: string): string {
    return `${connectionId}/${modelId}`;
}

function subscribeMarkedModels(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function emitMarkedModels(): void {
    for (const listener of listeners) listener();
}

function ensureMarkedModelsLoaded(): void {
    if (markedModelsLoaded || markedModelsLoadPromise) return;
    markedModelsLoadPromise = db
        .getMeta<unknown>(MARKED_MODELS_META_KEY)
        .then((stored) => {
            markedModels = new Set(
                Array.isArray(stored)
                    ? stored.filter((value): value is string => typeof value === 'string')
                    : [],
            );
            markedModelsLoaded = true;
            emitMarkedModels();
        })
        .catch((error) => console.error('[db]', error));
}

function setModelMarked(connectionId: string, modelId: string, marked: boolean): void {
    const key = markedModelKey(connectionId, modelId);
    if (markedModels.has(key) === marked) return;
    const next = new Set(markedModels);
    if (marked) {
        next.add(key);
    } else {
        next.delete(key);
    }
    markedModels = next;
    emitMarkedModels();
    markedModelsWriteQueue = markedModelsWriteQueue
        .catch(() => undefined)
        .then(() => db.setMeta(MARKED_MODELS_META_KEY, [...markedModels].sort()));
    markedModelsWriteQueue.catch((error) => console.error('[db]', error));
}

export interface TransparentImageBackgroundSupport {
    /** The model can produce transparent backgrounds: either advertised by
     * the image-model catalog or marked by the user. */
    supported: boolean;
    /** The user marked this model as transparent-capable. */
    marked: boolean;
    setMarked: (marked: boolean) => void;
}

/** Transparent-background support for the selected image model. `supported`
 * combines the catalog capability flag with the user's own mark; both fall
 * back to false when the catalog is unavailable so callers degrade to
 * chroma-key transparency. */
export function useTransparentImageBackground(model: ModelRef | null): TransparentImageBackgroundSupport {
    const [catalogSupported, setCatalogSupported] = useState(false);
    const connectionId = model?.connectionId.trim() ?? '';
    const modelId = model?.model.trim() ?? '';
    useEffect(() => {
        ensureMarkedModelsLoaded();
        if (!connectionId || !modelId) {
            setCatalogSupported(false);
            return;
        }
        let cancelled = false;
        getAvailableModels(connectionId, 'image')
            .then((models) => {
                if (cancelled) return;
                setCatalogSupported(models.some(
                    (entry) => entry.id === modelId && entry.supportsTransparentBackground === true,
                ));
            })
            .catch(() => {
                if (!cancelled) setCatalogSupported(false);
            });
        return () => {
            cancelled = true;
        };
    }, [connectionId, modelId]);
    const marked = useSyncExternalStore(
        subscribeMarkedModels,
        () => Boolean(connectionId && modelId && markedModels.has(markedModelKey(connectionId, modelId))),
    );
    return {
        supported: catalogSupported || marked,
        marked,
        setMarked: (value) => {
            if (!connectionId || !modelId) return;
            setModelMarked(connectionId, modelId, value);
        },
    };
}
