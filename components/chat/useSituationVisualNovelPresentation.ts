import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message, SituationPriorMessage } from '@/lib/store';
import type { ChatStreamingPreview } from '@/lib/chatMessagePresentation';
import type { SituationVisualNovelItem } from '@/lib/situationVisualNovelPresentation';
import {
    advanceSituationVisualNovelPresentation,
    appendSituationVisualNovelItems,
    beginSituationVisualNovelResponse,
    buildSituationVisualNovelPriorItems,
    buildSituationVisualNovelPreviewItems,
    buildSituationVisualNovelRoomItems,
    completeSituationVisualNovelItem,
    createSituationVisualNovelPresentationState,
    finishSituationVisualNovelPreviewItems,
    getSituationVisualNovelResponseMessages,
    lockSituationVisualNovelPresentation,
    reconcileSituationVisualNovelPreviewItems,
    syncSituationVisualNovelPreviewItems,
    syncSituationVisualNovelRoomItems,
    unlockSituationVisualNovelPresentation,
} from '@/lib/situationVisualNovelPresentation';
import { useTypewriterAdvance } from './useChatKeyboard';

type UseSituationVisualNovelPresentationOptions = {
    active: boolean;
    roomId?: string;
    situationId?: string;
    messages: Message[];
    priorMessages: SituationPriorMessage[];
    streamingPreview: ChatStreamingPreview | null;
    isLoading: boolean;
    isTypewriterActive: boolean;
    playTypewriter: (messageId: string, content: string) => Promise<void>;
    stopTypewriter: (revealFull: boolean) => boolean;
    onStreamingPreviewConsumed: (jobId: string) => void;
};

function groupSituationItemsByMessage(items: SituationVisualNovelItem[]): SituationVisualNovelItem[][] {
    const groups: SituationVisualNovelItem[][] = [];
    for (const item of items) {
        const current = groups.at(-1);
        if (current?.[0]?.id === item.id) current.push(item);
        else groups.push([item]);
    }
    return groups;
}

export function useSituationVisualNovelPresentation({
    active,
    roomId,
    situationId,
    messages,
    priorMessages,
    streamingPreview,
    isLoading,
    isTypewriterActive,
    playTypewriter,
    stopTypewriter,
    onStreamingPreviewConsumed,
}: UseSituationVisualNovelPresentationOptions) {
    const priorItems = useMemo(
        () => buildSituationVisualNovelPriorItems(priorMessages),
        [priorMessages],
    );
    const roomItems = useMemo(
        () => buildSituationVisualNovelRoomItems(messages),
        [messages],
    );
    const activeStreamingPreview = streamingPreview?.roomId === roomId
        ? streamingPreview
        : null;
    const currentRoundAssistantItems = useMemo(() => {
        return buildSituationVisualNovelRoomItems(getSituationVisualNovelResponseMessages(
            messages,
            activeStreamingPreview?.generationBaselineMessageIds,
        ));
    }, [activeStreamingPreview?.generationBaselineMessageIds, messages]);
    const previewItems = useMemo(
        () => buildSituationVisualNovelPreviewItems(
            activeStreamingPreview?.jobId,
            activeStreamingPreview?.turns,
        ),
        [activeStreamingPreview?.jobId, activeStreamingPreview?.turns],
    );
    const priorSignature = useMemo(
        () => JSON.stringify(priorItems.map((item) => [
            item.key,
            item.role,
            item.content,
            item.characterId,
        ])),
        [priorItems],
    );
    const hasRoomHistory = messages.length > 0;
    const isLoadingRef = useRef(isLoading);
    const messagesRef = useRef(messages);
    const priorItemsRef = useRef(priorItems);
    const roomItemsRef = useRef(roomItems);
    const seenRoomMessageIdsRef = useRef<Set<string>>(new Set());
    const seenPreviewKeysRef = useRef<Set<string>>(new Set());
    const canAdvanceRef = useRef(false);
    const [state, setState] = useState(() => createSituationVisualNovelPresentationState({
        hasRoomHistory,
        priorItems,
        roomItems,
        isLoading,
    }));

    useLayoutEffect(() => {
        isLoadingRef.current = isLoading;
        messagesRef.current = messages;
        priorItemsRef.current = priorItems;
        roomItemsRef.current = roomItems;
    }, [isLoading, messages, priorItems, roomItems]);

    useLayoutEffect(() => {
        stopTypewriter(false);
        seenRoomMessageIdsRef.current = new Set(messagesRef.current.map((message) => message.id));
        seenPreviewKeysRef.current = new Set();
        if (!active || !roomId) {
            setState(createSituationVisualNovelPresentationState({
                hasRoomHistory: false,
                priorItems: [],
                roomItems: [],
                isLoading: false,
            }));
            return;
        }
        setState(createSituationVisualNovelPresentationState({
            hasRoomHistory: messagesRef.current.length > 0,
            priorItems: priorItemsRef.current,
            roomItems: roomItemsRef.current,
            isLoading: isLoadingRef.current,
        }));
    }, [active, priorSignature, roomId, situationId, stopTypewriter]);

    useEffect(() => {
        if (!active || !roomId) return;
        const unseenIds = messages
            .filter((message) => !seenRoomMessageIdsRef.current.has(message.id))
            .map((message) => message.id);
        for (const messageId of unseenIds) seenRoomMessageIdsRef.current.add(messageId);

        const unseenIdSet = new Set(unseenIds);
        const hasUnseenUserMessage = messages.some((message) => (
            unseenIdSet.has(message.id)
            && message.role === 'user'
            && !message.archived
            && !!message.content.trim()
        ));
        const responseItemGroups = groupSituationItemsByMessage(currentRoundAssistantItems);
        const previewCoveredRoomKeys = new Set(previewItems.flatMap((previewItem) => {
            const roomItem = responseItemGroups[previewItem.previewTurnIndex ?? 0]?.[
                previewItem.pageIndex ?? 0
            ];
            return roomItem ? [roomItem.key] : [];
        }));
        const appendedItems = roomItems.filter((item) => (
            unseenIdSet.has(item.id) && !previewCoveredRoomKeys.has(item.key)
        ));
        setState((current) => {
            const waiting = hasUnseenUserMessage
                ? beginSituationVisualNovelResponse(current)
                : current;
            const appended = appendSituationVisualNovelItems(waiting, appendedItems);
            return syncSituationVisualNovelRoomItems(appended, {
                hasRoomHistory,
                priorItems,
                roomItems,
                isLoading,
            });
        });
    }, [
        active,
        currentRoundAssistantItems,
        hasRoomHistory,
        isLoading,
        messages,
        previewItems,
        priorItems,
        roomId,
        roomItems,
    ]);

    useEffect(() => {
        if (!active || !roomId || previewItems.length === 0) return;
        const unseenPreviewItems = previewItems.filter(
            (item) => !seenPreviewKeysRef.current.has(item.key),
        );
        for (const item of unseenPreviewItems) seenPreviewKeysRef.current.add(item.key);
        setState((current) => syncSituationVisualNovelPreviewItems(
            appendSituationVisualNovelItems(current, unseenPreviewItems),
            previewItems,
        ));
    }, [active, previewItems, roomId]);

    useEffect(() => {
        if (!active || !activeStreamingPreview || previewItems.length === 0) return;
        const responseItemGroups = groupSituationItemsByMessage(currentRoundAssistantItems);
        const replacements = new Map(previewItems.flatMap((previewItem) => {
            const roomItem = responseItemGroups[previewItem.previewTurnIndex ?? 0]?.[
                previewItem.pageIndex ?? 0
            ];
            return roomItem ? [[previewItem.key, roomItem] as const] : [];
        }));
        if (replacements.size === 0) return;
        setState((current) => reconcileSituationVisualNovelPreviewItems(current, replacements));
        if (!isLoading && replacements.size === previewItems.length) {
            onStreamingPreviewConsumed(activeStreamingPreview.jobId);
        }
    }, [
        active,
        activeStreamingPreview,
        currentRoundAssistantItems,
        isLoading,
        onStreamingPreviewConsumed,
        previewItems,
    ]);

    useEffect(() => {
        if (!active || isLoading || activeStreamingPreview) return;
        setState(finishSituationVisualNovelPreviewItems);
    }, [active, activeStreamingPreview, isLoading]);

    useEffect(() => {
        if (!active || !isLoading) return;
        setState(lockSituationVisualNovelPresentation);
    }, [active, isLoading]);

    const currentItem = state.current;
    const animateCurrent = state.animateCurrent;
    const currentComplete = state.currentComplete;
    useEffect(() => {
        if (!active || !currentItem || !animateCurrent || currentComplete) return;
        const item = currentItem;
        let cancelled = false;
        void playTypewriter(item.key, item.content).then(() => {
            if (cancelled) return;
            setState((current) => completeSituationVisualNovelItem(current, item.key));
        });
        return () => {
            cancelled = true;
        };
    }, [active, animateCurrent, currentComplete, currentItem, playTypewriter]);

    useEffect(() => {
        if (!active) return;
        setState((current) => syncSituationVisualNovelRoomItems(
            unlockSituationVisualNovelPresentation(current, isLoading),
            {
                hasRoomHistory,
                priorItems,
                roomItems,
                isLoading,
            },
        ));
    }, [
        active,
        hasRoomHistory,
        isLoading,
        priorItems,
        roomItems,
        state.currentComplete,
        state.pending.length,
    ]);

    const advanceDialogue = useCallback(() => {
        if (!active) return;
        if (stopTypewriter(true)) return;
        setState((current) => advanceSituationVisualNovelPresentation(current, isLoadingRef.current));
    }, [active, stopTypewriter]);

    const canAdvance = active
        && state.locked
        && !state.waitingForNextPage
        && state.current != null
        && state.currentComplete
        && (state.pending.length > 0 || isLoading);
    useEffect(() => {
        canAdvanceRef.current = canAdvance && !isTypewriterActive;
    }, [canAdvance, isTypewriterActive]);
    useTypewriterAdvance({
        activeRef: canAdvanceRef,
        onAdvance: advanceDialogue,
    });

    return {
        ...state,
        canAdvance,
        isWaitingForResponse: active && state.locked && state.current == null && isLoading,
        advanceDialogue,
    };
}
