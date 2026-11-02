import type { RustTurnResponse } from './conversationResult';

/** 返信のあとにサーバーの裏で走るタスク（記憶の抽出など）。 */
export type BackgroundTask = {
    id: string;
    kind: 'memory-extraction' | 'memory-batch' | (string & {});
    /** なぜ走ったか（「ターン後」「ルーム離脱」など）。 */
    reason: string;
    roomId: string;
    characterId: string;
    characterName: string;
    status: 'running' | 'completed' | 'failed';
    /** 実行中は進み具合、完了後は処理件数。 */
    detail?: string | null;
    error?: string | null;
    startedAt: number;
    finishedAt?: number | null;
    fullJsonLogs?: NonNullable<RustTurnResponse['fullJsonLogs']>;
};

export async function fetchBackgroundTasks(signal: AbortSignal): Promise<BackgroundTask[]> {
    const response = await fetch('/api/conversation/background-tasks', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
    });
    if (!response.ok) throw new Error(`Background task request failed (${response.status})`);
    const data = await response.json() as { tasks?: unknown };
    return Array.isArray(data.tasks) ? data.tasks as BackgroundTask[] : [];
}

export function backgroundTaskKindLabel(kind: string): string {
    switch (kind) {
        case 'memory-extraction':
            return '記憶の抽出';
        case 'memory-batch':
            return '記憶のバッチ抽出';
        default:
            return kind;
    }
}

/**
 * 一覧のうち、まだ取り込んでいない終了済みタスクを古い順に返し、取り込み済みとして覚える。
 * 実行中のタスクはログが揃っていないので、終わるまで待つ。
 */
export function takeNewlyFinishedTasks(
    tasks: readonly BackgroundTask[],
    importedTaskIds: Set<string>,
): BackgroundTask[] {
    const finished = tasks
        .filter((task) => task.status !== 'running' && !importedTaskIds.has(task.id))
        .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
    for (const task of finished) importedTaskIds.add(task.id);
    return finished;
}
