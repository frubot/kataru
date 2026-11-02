import { throwChatRequestError } from './chatErrors';
import { fetchWithTransientRetry } from './fetchRetry';

export type ConversationJobPreviewTurn = {
    turnIndex: number;
    content: string;
    characterId?: string;
    characterName?: string;
    formattedMessages?: string[];
    /**
     * メッセージモード: まだSSL/TLSではなく、JSON文字列が閉じた＝確定済みの
     * バブル本文のリスト。末尾の未完成分は含まれず `content` 側にだけ現れる。
     */
    confirmedMessages?: string[];
    expression?: string;
    motion?: string;
    complete: boolean;
};

export type ConversationJobStatus<TResult> = {
    jobId: string;
    roomId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    generationMode?: 'reply' | 'continue';
    result?: TResult;
    partialResult?: TResult;
    error?: string;
    preview?: {
        content: string;
        characterId?: string;
        characterName?: string;
        formattedMessages?: string[];
        expression?: string;
        motion?: string;
        turns?: ConversationJobPreviewTurn[];
    };
};

export async function submitConversationJob<TResult>(
    payload: unknown,
    signal: AbortSignal,
): Promise<ConversationJobStatus<TResult>> {
    const response = await fetchWithTransientRetry('/api/conversation/jobs', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
    });
    if (!response.ok) await throwChatRequestError(response, 0, 'submit');
    return response.json() as Promise<ConversationJobStatus<TResult>>;
}

export async function getConversationJob<TResult>(
    jobId: string,
    signal: AbortSignal,
): Promise<ConversationJobStatus<TResult>> {
    const response = await fetchWithTransientRetry(
        `/api/conversation/jobs/${encodeURIComponent(jobId)}`,
        { cache: 'no-store', credentials: 'same-origin', signal },
    );
    if (!response.ok) await throwChatRequestError(response, 0, 'poll');
    return response.json() as Promise<ConversationJobStatus<TResult>>;
}

export async function listConversationJobs<TResult>(): Promise<ConversationJobStatus<TResult>[]> {
    const response = await fetchWithTransientRetry('/api/conversation/jobs', {
        cache: 'no-store',
        credentials: 'same-origin',
    });
    if (!response.ok) await throwChatRequestError(response, 0, 'list');
    const data = await response.json() as { jobs?: ConversationJobStatus<TResult>[] };
    return data.jobs ?? [];
}

export async function cancelConversationJob(
    jobId: string,
): Promise<ConversationJobStatus<unknown>> {
    const response = await fetchWithTransientRetry(
        `/api/conversation/jobs/${encodeURIComponent(jobId)}`,
        {
            method: 'DELETE',
            cache: 'no-store',
            credentials: 'same-origin',
            keepalive: true,
        },
    );
    if (!response.ok) await throwChatRequestError(response, 0, 'cancel');
    return response.json() as Promise<ConversationJobStatus<unknown>>;
}

/**
 * ルームを離れるときに、そのルームの未反映の発言を記憶へまとめて反映するよう頼む。
 * 結果は待たない。ページを閉じるときも届くよう keepalive で送り、
 * 本文が keepalive の上限を超えて送れなかったときは通常の送信でやり直す。
 */
export function requestMemoryFlush(payload: unknown): void {
    const body = JSON.stringify(payload);
    const send = (keepalive: boolean) => fetch('/api/conversation/memory-flush', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive,
    });
    send(true)
        .catch(() => send(false))
        .catch((error: unknown) => {
            console.warn('Memory flush request failed:', error);
        });
}
