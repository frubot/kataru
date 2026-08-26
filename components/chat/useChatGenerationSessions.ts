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
};

type UseChatGenerationSessionsOptions = {
    cancelRemote: (jobId: string) => Promise<'completed' | 'cancelled'>;
    onCancelError: (error: unknown) => void;
};

export function useChatGenerationSessions({
    cancelRemote,
    onCancelError,
}: UseChatGenerationSessionsOptions) {
    const [activeRoomIds, setActiveRoomIds] = useState<Set<string>>(() => new Set());
    const sessionsRef = useRef<Map<string, ChatGenerationSession>>(new Map());
    const sequenceRef = useRef(0);
    const cancelRemoteRef = useRef(cancelRemote);
    const onCancelErrorRef = useRef(onCancelError);

    useEffect(() => {
        cancelRemoteRef.current = cancelRemote;
        onCancelErrorRef.current = onCancelError;
    }, [cancelRemote, onCancelError]);

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

    const cancelSession = useCallback((roomId: string) => {
        const session = sessionsRef.current.get(roomId);
        if (!session) return;

        void cancelRemoteRef.current(session.jobId)
            .then((status) => {
                if (status === 'completed') return;
                session.cancelled = true;
                session.controller?.abort();
                session.controller = null;
                if (sessionsRef.current.get(roomId) === session) {
                    sessionsRef.current.delete(roomId);
                    setRoomActive(roomId, false);
                }
            })
            .catch((error) => {
                onCancelErrorRef.current(error);
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
