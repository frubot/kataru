import { useCallback, useEffect, useRef } from 'react';

import { useStore } from '@/lib/store';
import { buildSpeechText, isTtsProfilePlayable, resolveTtsProfile } from '@/lib/tts';
import {
    clearAllTts,
    clearTtsRoom,
    enqueueTtsPlayback,
    requestTtsPlayback,
    stopTtsPlayback,
} from '@/lib/ttsPlayer';
import type { TtsRequestParams } from '@/lib/ttsPlayer';

type TtsPlaybackMessage = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    characterId?: string;
    archived?: boolean;
};

type UseTtsPlaybackParams = {
    roomId: string | undefined;
    messages: TtsPlaybackMessage[];
    isLoading: boolean;
    isRoomHistoryLoading?: boolean;
    notify?: (message: string) => void;
};

export function useTtsPlayback({ roomId, messages, isLoading, isRoomHistoryLoading, notify }: UseTtsPlaybackParams) {
    const ttsAutoPlay = useStore((state) => state.ttsAutoPlay);
    const seenIdsRef = useRef<Set<string>>(new Set());
    const baselineReadyRef = useRef(false);
    const prevGeneratingRef = useRef(false);
    const notifyRef = useRef(notify);
    const messagesRef = useRef(messages);

    useEffect(() => {
        notifyRef.current = notify;
    }, [notify]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    const buildTtsRequest = useCallback((message: TtsPlaybackMessage): TtsRequestParams | null => {
        if (!roomId) return null;
        const state = useStore.getState();
        const room = state.rooms.find((candidate) => candidate.id === roomId);
        const speakerCharacterId = message.characterId ?? (room?.groupId ? undefined : room?.characterId);
        const speaker = state.characters.find((candidate) => candidate.id === speakerCharacterId);
        const profile = resolveTtsProfile(state, speaker);
        if (!isTtsProfilePlayable(profile)) return null;
        const text = buildSpeechText(message.content);
        if (!text) return null;
        return {
            roomId,
            messageId: message.id,
            text,
            profile,
            aiApiConfig: { ...state.getAiApiConfig(), connectionId: profile.connectionId },
        };
    }, [roomId]);

    useEffect(() => {
        seenIdsRef.current.clear();
        baselineReadyRef.current = false;
        clearAllTts();
    }, [roomId]);

    useEffect(() => {
        const wasGenerating = prevGeneratingRef.current;
        prevGeneratingRef.current = isLoading;
        if (roomId && isLoading && !wasGenerating) {
            clearTtsRoom(roomId);
        }
    }, [roomId, isLoading]);

    useEffect(() => {
        // 履歴の非同期ロードが終わるまでbaselineを確定させない。ロード済み
        // メッセージを新規扱いして全履歴を再生しないため。
        if (!roomId || isLoading || isRoomHistoryLoading) return;
        if (!baselineReadyRef.current) {
            baselineReadyRef.current = true;
            for (const message of messages) {
                if (message.role === 'assistant') seenIdsRef.current.add(message.id);
            }
            return;
        }
        for (const message of messages) {
            if (message.role !== 'assistant' || message.archived) continue;
            if (seenIdsRef.current.has(message.id)) continue;
            seenIdsRef.current.add(message.id);
            if (!ttsAutoPlay) continue;
            const request = buildTtsRequest(message);
            if (request) enqueueTtsPlayback(request);
        }
    }, [roomId, messages, isLoading, isRoomHistoryLoading, ttsAutoPlay, buildTtsRequest]);

    useEffect(() => () => stopTtsPlayback(), []);

    const playMessage = useCallback((messageId: string) => {
        if (!roomId) return;
        const message = messagesRef.current.find((candidate) => candidate.id === messageId);
        if (!message) return;
        seenIdsRef.current.add(message.id);
        const state = useStore.getState();
        const room = state.rooms.find((candidate) => candidate.id === roomId);
        const speakerCharacterId = message.characterId ?? (room?.groupId ? undefined : room?.characterId);
        const speaker = state.characters.find((candidate) => candidate.id === speakerCharacterId);
        const profile = resolveTtsProfile(state, speaker);
        if (!isTtsProfilePlayable(profile)) {
            notifyRef.current?.('読み上げの音声設定を確認してください。');
            return;
        }
        const text = buildSpeechText(message.content);
        if (!text) {
            notifyRef.current?.('読み上げる内容がありません。');
            return;
        }
        requestTtsPlayback({
            roomId,
            messageId: message.id,
            text,
            profile,
            aiApiConfig: { ...state.getAiApiConfig(), connectionId: profile.connectionId },
        }).catch((error: unknown) => {
            notifyRef.current?.(
                error instanceof Error && error.message
                    ? error.message
                    : '読み上げに失敗しました。',
            );
        });
    }, [roomId]);

    return { playMessage };
}
