import { afterEach, describe, expect, test, vi } from 'vitest';

import { putRoom, touchMemories } from '../lib/db';
import { fetchWithTransientRetry } from '../lib/fetchRetry';

function successfulStorageResponse(): Response {
    return new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('fetchWithTransientRetry', () => {
    test('retries a Safari-style transient fetch failure', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new TypeError('Load failed'))
            .mockResolvedValueOnce(new Response('ok'));
        vi.stubGlobal('fetch', fetchMock);

        const response = await fetchWithTransientRetry('/api/test', {}, [0]);

        expect(await response.text()).toBe('ok');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('does not retry a request explicitly aborted by the caller', async () => {
        const controller = new AbortController();
        const error = new DOMException('Request aborted', 'AbortError');
        const fetchMock = vi.fn().mockRejectedValue(error);
        vi.stubGlobal('fetch', fetchMock);
        controller.abort(error);

        await expect(fetchWithTransientRetry(
            '/api/test',
            { signal: controller.signal },
            [0, 0],
        )).rejects.toBe(error);
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});

describe('storage retry policy', () => {
    test('retries an idempotent room write and disables HTTP caching', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new TypeError('Load failed'))
            .mockResolvedValueOnce(successfulStorageResponse());
        vi.stubGlobal('fetch', fetchMock);

        await putRoom({
            id: 'room-1',
            characterId: 'character-1',
            name: 'Room',
            createdAt: 1,
            updatedAt: 1,
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenLastCalledWith('/api/storage', expect.objectContaining({
            cache: 'no-store',
        }));
    });

    test('does not retry the non-idempotent memory usage increment', async () => {
        const error = new TypeError('Load failed');
        const fetchMock = vi.fn().mockRejectedValue(error);
        vi.stubGlobal('fetch', fetchMock);

        await expect(touchMemories(['memory-1'], 123)).rejects.toBe(error);
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});
