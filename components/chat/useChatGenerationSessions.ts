import { useCallback, useEffect, useRef, useState } from 'react';

import { generateId } from '@/lib/id';

export type ChatGenerationSession = {
    id: number;
    roomId: string;
    jobId: string;
    cancelled: boolean;
    detached: boolean;
    controller: AbortController | null;
    generationBaselineMessageIds?: string[];
    /** 「続きを生成」時に連結対象となる直前アシスタントメッセージのid。 */
    continuationBaseMessageId?: string;
};

type CancelledConversationJob = {
    jobId: string;
    status: string;
    partialResult?: unknown;
};

type UseChatGenerationSessionsOptions = {
    cancelRemote: (jobId: string) => Promise<CancelledConversationJob>;
    onCancelError: (error: unknown) => void;
    onCancelled?: (roomId: string, job: CancelledConversationJob) => void;
};

export function useChatGenerationSessions({
    cancelRemote,
    onCancelError,
    onCancelled,
}: UseChatGenerationSessionsOptions) {
    const [activeRoomIds, setActiveRoomIds] = useState<Set<string>>(() => new Set());
    const sessionsRef = useRef<Map<string, ChatGenerationSession>>(new Map());
    const sequenceRef = useRef(0);
    const cancelRemoteRef = useRef(cancelRemote);
    const onCancelErrorRef = useRef(onCancelError);
    const onCancelledRef = useRef(onCancelled);

    useEffect(() => {
        cancelRemoteRef.current = cancelRemote;
        onCancelErrorRef.current = onCancelError;
        onCancelledRef.current = onCancelled;
    }, [cancelRemote, onCancelError, onCancelled]);

    const setRoomActive = useCallback((roomId: string, active: boolean) => {
        setActiveRoomIds((current) => {
            const next = new Set(current);
            if (active) {
                next.add(roomId);
            } else {
                next.delete(roomId);
            }
            return next;
        });
    }, []);

    const startSession = useCallback((roomId: string, jobId = generateId()): ChatGenerationSession => {
        const previousSession = sessionsRef.current.get(roomId);
        if (previousSession) {
            previousSession.cancelled = true;
            previousSession.controller?.abort();
        }

        const session: ChatGenerationSession = {
            id: sequenceRef.current + 1,
            roomId,
            jobId,
            cancelled: false,
            detached: false,
            controller: null,
        };
        sequenceRef.current = session.id;
        sessionsRef.current.set(roomId, session);
        setRoomActive(roomId, true);
        return session;
    }, [setRoomActive]);

    const isSessionActive = useCallback((session: ChatGenerationSession): boolean => {
        return sessionsRef.current.get(session.roomId) === session && !session.cancelled;
    }, []);

    const hasSession = useCallback((roomId: string): boolean => {
        return sessionsRef.current.has(roomId);
    }, []);

    const attachController = useCallback((session: ChatGenerationSession, controller: AbortController): boolean => {
        if (!isSessionActive(session)) {
            controller.abort();
            return false;
        }
        session.controller = controller;
        return true;
    }, [isSessionActive]);

    const clearController = useCallback((session: ChatGenerationSession, controller: AbortController) => {
        if (session.controller === controller) {
            session.controller = null;
        }
    }, []);

    const finishSession = useCallback((session: ChatGenerationSession) => {
        if (sessionsRef.current.get(session.roomId) === session) {
            sessionsRef.current.delete(session.roomId);
            setRoomActive(session.roomId, false);
        }
        session.controller = null;
    }, [setRoomActive]);

    /**
     * 部屋の生成を止める。止めた（または既に完了していた）ジョブの状態で
     * 解決する。停止に失敗した場合や生成が無い場合は null。
     */
    const cancelSession = useCallback((roomId: string): Promise<CancelledConversationJob | null> => {
        const session = sessionsRef.current.get(roomId);
        if (!session) return Promise.resolve(null);

        return cancelRemoteRef.current(session.jobId)
            .then((job) => {
                if (job.status === 'completed') return job;
                session.cancelled = true;
                session.controller?.abort();
                session.controller = null;
                if (sessionsRef.current.get(roomId) === session) {
                    sessionsRef.current.delete(roomId);
                    setRoomActive(roomId, false);
                }
                onCancelledRef.current?.(roomId, job);
                return job;
            })
            .catch((error) => {
                onCancelErrorRef.current(error);
                return null;
            });
    }, [setRoomActive]);

    useEffect(() => {
        const sessions = sessionsRef.current;
        return () => {
            for (const session of sessions.values()) {
                session.detached = true;
                session.cancelled = true;
                session.controller?.abort();
                session.controller = null;
            }
            sessions.clear();
        };
    }, []);

    return {
        activeRoomIds,
        startSession,
        finishSession,
        cancelSession,
        isSessionActive,
        hasSession,
        attachController,
        clearController,
    };
}
