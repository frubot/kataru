import { resolveStoredImageUrl } from './imageSource';

const MAX_COMPLETED_PRELOADS = 128;
const MAX_IN_FLIGHT_PRELOADS = 2;
const PRELOAD_TIMEOUT_MS = 30_000;

const completedPreloads = new Map<string, true>();

function getPreloadCacheKey(source: string): string {
    if (source.length < 512) return source;

    // Do not retain full legacy data URLs in the bounded completion cache.
    let firstHash = 0x811c9dc5;
    let secondHash = 0x9e3779b9;
    for (let index = 0; index < source.length; index++) {
        const code = source.charCodeAt(index);
        firstHash = Math.imul(firstHash ^ code, 0x01000193);
        secondHash = Math.imul(secondHash ^ code, 0x5bd1e995);
    }
    return `inline:${source.length}:${(firstHash >>> 0).toString(16)}:${(secondHash >>> 0).toString(16)}`;
}

function rememberCompleted(cacheKey: string) {
    completedPreloads.delete(cacheKey);
    completedPreloads.set(cacheKey, true);
    while (completedPreloads.size > MAX_COMPLETED_PRELOADS) {
        const oldest = completedPreloads.keys().next().value;
        if (oldest == null) break;
        completedPreloads.delete(oldest);
    }
}

export function preloadVisualNovelImages(
    sources: readonly string[],
    visibleSources: readonly (string | null | undefined)[] = [],
): () => void {
    if (typeof Image === 'undefined' || sources.length === 0) return () => {};

    const visible = new Set(
        visibleSources.filter((source): source is string => !!source).map(resolveStoredImageUrl),
    );
    const queue = [...new Set(sources.map(resolveStoredImageUrl))].filter(
        (source) => source && !visible.has(source) && !completedPreloads.has(getPreloadCacheKey(source)),
    );
    if (queue.length === 0) return () => {};

    const cancellations = new Set<() => void>();
    let cancelled = false;
    let remainingVisible = visible.size;
    let nextIndex = 0;
    let activePreloads = 0;

    function load(source: string, priority: 'high' | 'low', onComplete: () => void) {
        const image = new Image();
        image.decoding = 'async';
        image.fetchPriority = priority;
        let finished = false;

        const cleanup = () => {
            clearTimeout(timeout);
            image.onload = null;
            image.onerror = null;
            cancellations.delete(cancel);
        };
        const finish = (loaded: boolean) => {
            if (finished || cancelled) return;
            finished = true;
            cleanup();
            if (loaded) {
                rememberCompleted(getPreloadCacheKey(source));
            } else {
                image.src = '';
            }
            onComplete();
        };
        const cancel = () => {
            finished = true;
            cleanup();
            image.src = '';
        };
        const timeout = setTimeout(() => finish(false), PRELOAD_TIMEOUT_MS);
        image.onload = () => finish(true);
        image.onerror = () => finish(false);
        cancellations.add(cancel);
        image.src = source;
    }

    function drainQueue() {
        if (cancelled || remainingVisible > 0) return;
        while (activePreloads < MAX_IN_FLIGHT_PRELOADS && nextIndex < queue.length) {
            const source = queue[nextIndex++];
            if (completedPreloads.has(getPreloadCacheKey(source))) continue;
            activePreloads++;
            load(source, 'low', () => {
                activePreloads--;
                drainQueue();
            });
        }
    }

    // Observe the same URLs used by the visible <img> elements before warming variants.
    // Even a previously completed image may have been evicted from the browser cache.
    for (const source of visible) {
        load(source, 'high', () => {
            remainingVisible--;
            drainQueue();
        });
    }
    drainQueue();

    return () => {
        cancelled = true;
        for (const cancel of cancellations) cancel();
    };
}
