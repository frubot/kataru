import { useEffect, useMemo } from 'react';
import { resolveStoredImageUrl } from '@/lib/imageSource';
import type { Character } from '@/lib/store';
import { getVisualNovelPreloadCandidates } from '@/lib/visualNovelPresentation';

const MAX_COMPLETED_PRELOADS = 128;
const MAX_IN_FLIGHT_PRELOADS = 24;
const PRELOAD_TIMEOUT_MS = 30_000;

type InFlightPreload = {
    image: HTMLImageElement;
    timeout: ReturnType<typeof setTimeout>;
};

const completedPreloads = new Map<string, true>();
const inFlightPreloads = new Map<string, InFlightPreload>();

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

function finishPreload(cacheKey: string) {
    const preload = inFlightPreloads.get(cacheKey);
    if (!preload) return;
    clearTimeout(preload.timeout);
    preload.image.onload = null;
    preload.image.onerror = null;
    inFlightPreloads.delete(cacheKey);
    rememberCompleted(cacheKey);
}

export function preloadVisualNovelImages(sources: readonly string[]) {
    if (typeof Image === 'undefined') return;

    for (const source of sources) {
        const resolvedSource = resolveStoredImageUrl(source);
        const cacheKey = getPreloadCacheKey(resolvedSource);
        if (completedPreloads.has(cacheKey) || inFlightPreloads.has(cacheKey)) continue;
        if (inFlightPreloads.size >= MAX_IN_FLIGHT_PRELOADS) break;

        const image = new Image();
        image.decoding = 'async';
        image.onload = () => finishPreload(cacheKey);
        image.onerror = () => finishPreload(cacheKey);
        const timeout = setTimeout(() => {
            const preload = inFlightPreloads.get(cacheKey);
            if (!preload) return;
            preload.image.onload = null;
            preload.image.onerror = null;
            preload.image.src = '';
            inFlightPreloads.delete(cacheKey);
        }, PRELOAD_TIMEOUT_MS);
        inFlightPreloads.set(cacheKey, { image, timeout });
        image.src = resolvedSource;
    }
}

export function useVisualNovelImagePreload({
    character,
    costumeName,
    currentImage,
}: {
    character: Character | null;
    costumeName: string;
    currentImage: string | null;
}) {
    const candidates = useMemo(
        () => getVisualNovelPreloadCandidates(character, costumeName, currentImage),
        [character, costumeName, currentImage],
    );

    useEffect(() => {
        if (candidates.length === 0) return;
        const timeout = setTimeout(() => preloadVisualNovelImages(candidates), 0);
        return () => clearTimeout(timeout);
    }, [candidates]);
}
