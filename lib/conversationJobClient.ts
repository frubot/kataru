import { throwChatRequestError } from './chatErrors';

export type ConversationJobPreviewTurn = {
    turnIndex: number;
    content: string;
    characterId?: string;
    characterName?: string;
    formattedMessages?: string[];
    expression?: string;
    complete: boolean;
};

export type ConversationJobStatus<TResult> = {
    jobId: string;
    roomId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    result?: TResult;
    partialResult?: TResult;
    error?: string;
    preview?: {
        content: string;
        characterId?: string;
        characterName?: string;
        formattedMessages?: string[];
        expression?: string;
        turns?: ConversationJobPreviewTurn[];
    };
};

export async function submitConversationJob<TResult>(
    payload: unknown,
    signal: AbortSignal,
): Promise<ConversationJobStatus<TResult>> {
    const response = await fetch('/api/conversation/jobs', {
        method: 'POST',
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
    const response = await fetch(
        `/api/conversation/jobs/${encodeURIComponent(jobId)}`,
        { credentials: 'same-origin', signal },
    );
    if (!response.ok) await throwChatRequestError(response, 0, 'poll');
    return response.json() as Promise<ConversationJobStatus<TResult>>;
}

export async function listConversationJobs<TResult>(): Promise<ConversationJobStatus<TResult>[]> {
    const response = await fetch('/api/conversation/jobs', { credentials: 'same-origin' });
    if (!response.ok) await throwChatRequestError(response, 0, 'list');
    const data = await response.json() as { jobs?: ConversationJobStatus<TResult>[] };
    return data.jobs ?? [];
}

export async function cancelConversationJob(jobId: string): Promise<'completed' | 'cancelled'> {
    const response = await fetch(
        `/api/conversation/jobs/${encodeURIComponent(jobId)}`,
        { method: 'DELETE', credentials: 'same-origin', keepalive: true },
    );
    if (!response.ok) await throwChatRequestError(response, 0, 'cancel');
    const job = await response.json() as ConversationJobStatus<unknown>;
    return job.status === 'completed' ? 'completed' : 'cancelled';
}
