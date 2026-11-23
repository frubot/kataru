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

function assetOf(char: string): string {
    return `asset:${char.repeat(64)}`;
}

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
        const asset = assetOf('a');
        preload(
            [asset, assetOf('1'), assetOf('2'), assetOf('1'), assetOf('3')],
            [asset, assetOf('b')],
        );

        const images = TestImage.instances;
        expect(images.map((image) => image.src)).toEqual([
            `/api/assets/${'a'.repeat(64)}`, `/api/assets/${'b'.repeat(64)}`,
        ]);
        expect(images.every((image) => image.fetchPriority === 'high')).toBe(true);
        images[0].onload?.();
        expect(images).toHaveLength(2);
        images[1].onload?.();

        expect(images.slice(2).map((image) => image.src)).toEqual([
            `/api/assets/${'1'.repeat(64)}`,
            `/api/assets/${'2'.repeat(64)}`,
        ]);
        expect(images.slice(2).every((image) => image.fetchPriority === 'low')).toBe(true);
        images[2].onload?.();
        expect(images[4].src).toBe(`/api/assets/${'3'.repeat(64)}`);
        images[3].onload?.();
        images[4].onload?.();
        expect(images).toHaveLength(5);
    });

    test('cancels old requests and queued work when the visible scene changes', () => {
        const cancel = preload([assetOf('4'), assetOf('5'), assetOf('6')], [assetOf('c')]);
        const images = TestImage.instances;
        images[0].onload?.();
        const lateLoad = images[1].onload;
        cancel();
        lateLoad?.();

        expect(images).toHaveLength(3);
        expect(images.slice(1).every((image) => image.src === '' && image.onload === null)).toBe(true);

        // A remembered image can have been evicted from the browser's actual cache.
        const cancelNext = preload([assetOf('d')], [assetOf('c')]);
        expect(images[3].src).toBe(`/api/assets/${'c'.repeat(64)}`);
        expect(images).toHaveLength(4);
        const lateVisibleLoad = images[3].onload;
        cancelNext();
        lateVisibleLoad?.();
        expect(images).toHaveLength(4);
    });

    test('errors and timeouts release the queue without caching failed downloads', () => {
        vi.useFakeTimers();
        preload([assetOf('7'), assetOf('8'), assetOf('9')], [assetOf('b')]);
        const images = TestImage.instances;
        images[0].onerror?.();
        expect(images).toHaveLength(3);
        images[1].onerror?.();
        expect(images[3].src).toBe(`/api/assets/${'9'.repeat(64)}`);
        images[3].onload?.();
        vi.runAllTimers();
        expect(images[2].src).toBe('');

        preload([assetOf('7'), assetOf('8'), assetOf('9')]);
        expect(images.slice(4).map((image) => image.src)).toEqual([
            `/api/assets/${'7'.repeat(64)}`,
            `/api/assets/${'8'.repeat(64)}`,
        ]);
    });

    test('does not preload references outside the allowlist', () => {
        preload(
            ['https://attacker.example/leak.png', '//attacker.example/x.png', 'relative.png'],
            ['https://attacker.example/visible.png'],
        );

        expect(TestImage.instances).toHaveLength(0);
    });
});
