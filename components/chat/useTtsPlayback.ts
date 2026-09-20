import { useCallback, useEffect, useRef } from 'react';

import { useStore } from '@/lib/store';
import { buildSpeechSegments, isTtsProfilePlayable, resolveTtsProfile } from '@/lib/tts';
import {
    clearAllTts,
    clearTtsRoom,
    enqueueTtsPlayback,
    prefetchTtsAudio,
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

/** ゲームモードで表示中の1ページ分。keyには typing key（utteranceKeyベース）を
 * 渡すこと。プレビュー→保存済みメッセージの差し替えでも安定し、二重読み上げを
 * 防げる。finalはページ本文がこれ以上伸びないことを示す。 */
export type VisualNovelTtsItem = {
    key: string;
    role: 'user' | 'assistant';
    content: string;
    characterId?: string;
    final: boolean;
};

type TtsResolveResult = { params: TtsRequestParams } | { reason: 'unconfigured' | 'empty' };

type UseTtsPlaybackParams = {
    roomId: string | undefined;
    messages: TtsPlaybackMessage[];
    isLoading: boolean;
    isRoomHistoryLoading?: boolean;
    notify?: (message: string) => void;
    /** ゲームモード中はtrue。メッセージ単位の自動再生を止め、ページ単位の
     * 読み上げに切り替える。 */
    visualNovelMode?: boolean;
    /** 現在表示中のページ。nullのとき（ログ表示中など）は何も読まない。 */
    visualNovelItem?: VisualNovelTtsItem | null;
    /** 次に表示されるページ。finalになり次第、音声だけ事前生成してページ送りの
     * 待ち時間を消す。 */
    visualNovelNextItem?: VisualNovelTtsItem | null;
};

export function useTtsPlayback({
    roomId,
    messages,
    isLoading,
    isRoomHistoryLoading,
    notify,
    visualNovelMode = false,
    visualNovelItem = null,
    visualNovelNextItem = null,
}: UseTtsPlaybackParams) {
    const ttsAutoPlay = useStore((state) => state.ttsAutoPlay);
    const seenIdsRef = useRef<Set<string>>(new Set());
    const baselineReadyRef = useRef(false);
    const vnBaselineReadyRef = useRef(false);
    const vnSpokenKeysRef = useRef<Set<string>>(new Set());
    const prevGeneratingRef = useRef(false);
    const notifyRef = useRef(notify);
    const messagesRef = useRef(messages);

    useEffect(() => {
        notifyRef.current = notify;
    }, [notify]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    const resolveRequest = useCallback((
        cacheKey: string,
        content: string,
        characterId?: string,
    ): TtsResolveResult | null => {
        if (!roomId) return null;
        const state = useStore.getState();
        const room = state.rooms.find((candidate) => candidate.id === roomId);
        const speakerCharacterId = characterId ?? (room?.groupId ? undefined : room?.characterId);
        const speaker = state.characters.find((candidate) => candidate.id === speakerCharacterId);
        const profile = resolveTtsProfile(state, speaker);
        if (!isTtsProfilePlayable(profile)) return { reason: 'unconfigured' };
        const segments = buildSpeechSegments(content, state.ttsActionCaption);
        if (segments.length === 0) return { reason: 'empty' };
        return {
            params: {
                roomId,
                messageId: cacheKey,
                segments,
                profile,
                aiApiConfig: { ...state.getAiApiConfig(), connectionId: profile.connectionId },
            },
        };
    }, [roomId]);

    useEffect(() => {
        seenIdsRef.current.clear();
        baselineReadyRef.current = false;
        vnBaselineReadyRef.current = false;
        vnSpokenKeysRef.current.clear();
        clearAllTts();
    }, [roomId]);

    useEffect(() => {
        const wasGenerating = prevGeneratingRef.current;
        prevGeneratingRef.current = isLoading;
        if (roomId && isLoading && !wasGenerating) {
            clearTtsRoom(roomId);
            // 再生成でページキーが再利用されても読み上げられるよう、読み上げ済み
            // マークも消す。差し替え前の表示中ページだけ再シードして誤再生を防ぐ。
            vnSpokenKeysRef.current.clear();
            if (visualNovelItem) vnSpokenKeysRef.current.add(visualNovelItem.key);
        }
    }, [roomId, isLoading, visualNovelItem]);

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
            // ゲームモードではページ単位の読み上げが担当する。メッセージ単位では
            // 読まないが、通常モードへ戻った時の遡及再生を防ぐためseenには積む。
            if (!ttsAutoPlay || visualNovelMode) continue;
            const result = resolveRequest(message.id, message.content, message.characterId);
            if (result && 'params' in result) enqueueTtsPlayback(result.params);
        }
    }, [roomId, messages, isLoading, isRoomHistoryLoading, ttsAutoPlay, visualNovelMode, resolveRequest]);

    useEffect(() => {
        if (!roomId || !visualNovelMode || isRoomHistoryLoading) return;
        const item = visualNovelItem;
        if (!vnBaselineReadyRef.current) {
            vnBaselineReadyRef.current = true;
            // 既に表示済みのページは読まない。生成中に未確定のページが表示されて
            // いる場合は新規応答の一部なので、確定後に読み上げ対象へ残す。
            if (item && (!isLoading || item.final)) {
                vnSpokenKeysRef.current.add(item.key);
            }
        }
        if (!ttsAutoPlay || !item || item.role !== 'assistant' || !item.final) return;
        if (vnSpokenKeysRef.current.has(item.key)) return;
        vnSpokenKeysRef.current.add(item.key);
        const result = resolveRequest(item.key, item.content, item.characterId);
        // ページ送りはユーザー操作なので、前のページの音声を切って即時再生する。
        if (result && 'params' in result) void requestTtsPlayback(result.params).catch(() => {});
    }, [roomId, visualNovelMode, visualNovelItem, isLoading, isRoomHistoryLoading, ttsAutoPlay, resolveRequest]);

    useEffect(() => {
        // 次ページの音声を表示前に生成しておき、ページ送りの待ちをなくす。
        if (!roomId || !visualNovelMode || !ttsAutoPlay) return;
        const item = visualNovelNextItem;
        if (!item || item.role !== 'assistant' || !item.final) return;
        const result = resolveRequest(item.key, item.content, item.characterId);
        if (result && 'params' in result) prefetchTtsAudio(result.params);
    }, [roomId, visualNovelMode, visualNovelNextItem, ttsAutoPlay, resolveRequest]);

    useEffect(() => () => stopTtsPlayback(), []);

    const play = useCallback((cacheKey: string, content: string, characterId?: string) => {
        const result = resolveRequest(cacheKey, content, characterId);
        if (!result) return;
        if ('reason' in result) {
            notifyRef.current?.(
                result.reason === 'unconfigured'
                    ? '読み上げの音声設定を確認してください。'
                    : '読み上げる内容がありません。',
            );
            return;
        }
        void requestTtsPlayback(result.params).catch((error: unknown) => {
            notifyRef.current?.(
                error instanceof Error && error.message
                    ? error.message
                    : '読み上げに失敗しました。',
            );
        });
    }, [resolveRequest]);

    const playMessage = useCallback((messageId: string) => {
        const message = messagesRef.current.find((candidate) => candidate.id === messageId);
        if (!message) return;
        seenIdsRef.current.add(message.id);
        play(message.id, message.content, message.characterId);
    }, [play]);

    const playVisualNovelItem = useCallback((item: VisualNovelTtsItem) => {
        if (item.role !== 'assistant') return;
        vnSpokenKeysRef.current.add(item.key);
        play(item.key, item.content, item.characterId);
    }, [play]);

    return { playMessage, playVisualNovelItem };
}
