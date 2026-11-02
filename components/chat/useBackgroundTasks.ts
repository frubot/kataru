import { useEffect, useRef, useState } from 'react';
import {
    fetchBackgroundTasks,
    takeNewlyFinishedTasks,
    type BackgroundTask,
} from '@/lib/backgroundTasks';
import type { FullJsonDebugLog, Room } from '@/lib/store';
import { toFullJsonDebugLog } from './applyConversationResult';

/** 実行中のタスクがあるときの問い合わせ間隔。 */
const ACTIVE_POLL_MS = 1_500;
/** 何も動いていないときの問い合わせ間隔。 */
const IDLE_POLL_MS = 5_000;

// ChatWindow が作り直されても同じタスクのログを二重に取り込まないよう、画面全体で1つ持つ。
const importedTaskIds = new Set<string>();

export type BackgroundTaskSnapshot = {
    tasks: BackgroundTask[];
    /** 最後に一覧を受け取った時刻。実行中タスクの経過時間に使う。 */
    checkedAt: number;
};

const EMPTY_SNAPSHOT: BackgroundTaskSnapshot = { tasks: [], checkedAt: 0 };

type UseBackgroundTasksOptions = {
    enabled: boolean;
    addFullJsonDebugLog: (log: Omit<FullJsonDebugLog, 'id' | 'createdAt'>) => void;
    getRooms: () => Room[];
};

/**
 * デバッグログが有効な間、サーバーの裏で走るタスクを問い合わせる。
 * 終わったタスクのプロンプトと出力はデバッグログへ取り込む。
 */
export function useBackgroundTasks({
    enabled,
    addFullJsonDebugLog,
    getRooms,
}: UseBackgroundTasksOptions): BackgroundTaskSnapshot {
    const [snapshot, setSnapshot] = useState<BackgroundTaskSnapshot>(EMPTY_SNAPSHOT);
    const latest = useRef({ addFullJsonDebugLog, getRooms });
    useEffect(() => {
        latest.current = { addFullJsonDebugLog, getRooms };
    }, [addFullJsonDebugLog, getRooms]);

    useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;

        const importLogs = (finished: BackgroundTask[]) => {
            const rooms = latest.current.getRooms();
            for (const task of finished) {
                const roomName = rooms.find((room) => room.id === task.roomId)?.name ?? '';
                for (const log of task.fullJsonLogs ?? []) {
                    const entry = toFullJsonDebugLog(log, { id: task.roomId, name: roomName });
                    if (entry) latest.current.addFullJsonDebugLog(entry);
                }
            }
        };

        const poll = async () => {
            let running = false;
            if (typeof document === 'undefined' || !document.hidden) {
                try {
                    const next = await fetchBackgroundTasks(controller.signal);
                    if (controller.signal.aborted) return;
                    setSnapshot({ tasks: next, checkedAt: Date.now() });
                    importLogs(takeNewlyFinishedTasks(next, importedTaskIds));
                    running = next.some((task) => task.status === 'running');
                } catch (error) {
                    if (controller.signal.aborted) return;
                    console.warn('Background task polling failed:', error);
                }
            }
            timer = setTimeout(poll, running ? ACTIVE_POLL_MS : IDLE_POLL_MS);
        };
        void poll();

        return () => {
            controller.abort();
            if (timer) clearTimeout(timer);
            setSnapshot(EMPTY_SNAPSHOT);
        };
    }, [enabled]);

    return snapshot;
}
