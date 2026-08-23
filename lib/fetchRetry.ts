const DEFAULT_RETRY_DELAYS_MS = [150, 600];

function isAbortRequested(signal: AbortSignal | null | undefined): boolean {
    return signal?.aborted === true;
}

export function isTransientFetchError(error: unknown): boolean {
    if (error instanceof TypeError) return true;
    if (typeof DOMException === 'undefined' || !(error instanceof DOMException)) return false;
    return ['AbortError', 'NetworkError', 'TimeoutError'].includes(error.name);
}

function waitForRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
        if (isAbortRequested(signal)) {
            reject(signal?.reason ?? new DOMException('Request aborted', 'AbortError'));
            return;
        }

        const handleAbort = () => {
            clearTimeout(timeout);
            reject(signal?.reason ?? new DOMException('Request aborted', 'AbortError'));
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', handleAbort);
            resolve();
        }, delayMs);
        signal?.addEventListener('abort', handleAbort, { once: true });
    });
}

export async function fetchWithTransientRetry(
    input: RequestInfo | URL,
    init: RequestInit = {},
    retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await fetch(input, init);
        } catch (error) {
            if (
                isAbortRequested(init.signal)
                || !isTransientFetchError(error)
                || attempt >= retryDelaysMs.length
            ) {
                throw error;
            }
            await waitForRetry(retryDelaysMs[attempt], init.signal);
        }
    }
}
