import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { preloadVisualNovelImages } from '../lib/visualNovelImagePreload';

class TestImage {
    static instances: TestImage[] = [];
    src = '';
    decoding = 'auto';
    fetchPriority = 'auto';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor() {
        TestImage.instances.push(this);
    }
}

const cleanups: (() => void)[] = [];

function preload(sources: string[], visibleSources: string[] = []) {
    const cancel = preloadVisualNovelImages(sources, visibleSources);
    cleanups.push(cancel);
    return cancel;
}

beforeEach(() => {
    TestImage.instances = [];
    vi.stubGlobal('Image', TestImage);
});

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('visual novel image preloading', () => {
    test('waits for both visible images, then warms unique variants two at a time', () => {
        const asset = `asset:${'a'.repeat(64)}`;
        preload(
            [asset, 'variant-1.png', 'variant-2.png', 'variant-1.png', 'variant-3.png'],
            [asset, 'background.png'],
        );

        const images = TestImage.instances;
        expect(images.map((image) => image.src)).toEqual([
            `/api/assets/${'a'.repeat(64)}`, 'background.png',
        ]);
        expect(images.every((image) => image.fetchPriority === 'high')).toBe(true);
        images[0].onload?.();
        expect(images).toHaveLength(2);
        images[1].onload?.();

        expect(images.slice(2).map((image) => image.src)).toEqual(['variant-1.png', 'variant-2.png']);
        expect(images.slice(2).every((image) => image.fetchPriority === 'low')).toBe(true);
        images[2].onload?.();
        expect(images[4].src).toBe('variant-3.png');
        images[3].onload?.();
        images[4].onload?.();
        expect(images).toHaveLength(5);
    });

    test('cancels old requests and queued work when the visible scene changes', () => {
        const cancel = preload(['old-1.png', 'old-2.png', 'old-3.png'], ['current.png']);
        const images = TestImage.instances;
        images[0].onload?.();
        const lateLoad = images[1].onload;
        cancel();
        lateLoad?.();

        expect(images).toHaveLength(3);
        expect(images.slice(1).every((image) => image.src === '' && image.onload === null)).toBe(true);

        // A remembered image can have been evicted from the browser's actual cache.
        const cancelNext = preload(['next-1.png'], ['current.png']);
        expect(images[3].src).toBe('current.png');
        expect(images).toHaveLength(4);
        const lateVisibleLoad = images[3].onload;
        cancelNext();
        lateVisibleLoad?.();
        expect(images).toHaveLength(4);
    });

    test('errors and timeouts release the queue without caching failed downloads', () => {
        vi.useFakeTimers();
        preload(['failed.png', 'timed-out.png', 'loaded.png'], ['broken-visible.png']);
        const images = TestImage.instances;
        images[0].onerror?.();
        expect(images).toHaveLength(3);
        images[1].onerror?.();
        expect(images[3].src).toBe('loaded.png');
        images[3].onload?.();
        vi.runAllTimers();
        expect(images[2].src).toBe('');

        preload(['failed.png', 'timed-out.png', 'loaded.png']);
        expect(images.slice(4).map((image) => image.src)).toEqual(['failed.png', 'timed-out.png']);
    });
});
