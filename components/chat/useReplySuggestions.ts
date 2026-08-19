import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { AiApiConfig } from '../../lib/aiApi';
import {
    buildPromptRequestMessages,
    requestReplySuggestions,
} from '../../lib/chatAuxiliaryClient';
import type { Character, Room, SituationParticipant } from '../../lib/store';

export type ReplySuggestionState = {
    roomId: string;
    sourceMessageId: string;
    suggestions: string[];
    loading: boolean;
};

type UseReplySuggestionsOptions = {
    room: Room | null;
    character: Character | null;
    groupCharacters?: SituationParticipant[] | null;
    isGroupRoom: boolean;
    enabled: boolean;
    model: string;
    situationPrompt?: string;
    isLoading: boolean;
    isSummarizing: boolean;
    isTypewriterActive: boolean;
    getAiApiConfig: () => AiApiConfig;
    setRoomReplySuggestions: (
        roomId: string,
        replySuggestions?: Room['replySuggestions'],
    ) => void;
};

type UseReplySuggestionsResult = {
    state: ReplySuggestionState | null;
    setState: Dispatch<SetStateAction<ReplySuggestionState | null>>;
};

export function useReplySuggestions({
    room,
    character,
    groupCharacters,
    isGroupRoom,
    enabled,
    model,
    situationPrompt,
    isLoading,
    isSummarizing,
    isTypewriterActive,
    getAiApiConfig,
    setRoomReplySuggestions,
}: UseReplySuggestionsOptions): UseReplySuggestionsResult {
    const [state, setState] = useState<ReplySuggestionState | null>(null);
    const requestKeyRef = useRef<string | null>(null);
    const controllerRef = useRef<AbortController | null>(null);
    const roomId = room?.id;
    const latestMessage = useMemo(() => {
        const visibleMessages = room?.messages.filter((message) => !message.archived) ?? [];
        return visibleMessages[visibleMessages.length - 1];
    }, [room?.messages]);
    const savedState = useMemo<ReplySuggestionState | null>(() => {
        const saved = room?.replySuggestions;
        if (
            !saved
            || !roomId
            || latestMessage?.role !== 'assistant'
            || saved.sourceMessageId !== latestMessage.id
            || !Array.isArray(saved.suggestions)
        ) return null;
        const suggestions = saved.suggestions
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map((value) => value.trim());
        if (suggestions.length !== 3) return null;
        return { roomId, sourceMessageId: saved.sourceMessageId, suggestions, loading: false };
    }, [latestMessage, room?.replySuggestions, roomId]);
    const messages = useMemo(
        () => buildPromptRequestMessages(room?.messages ?? [], groupCharacters).slice(-20),
        [groupCharacters, room?.messages],
    );
    const protagonistPrompt = useMemo(() => {
        const participants = isGroupRoom ? groupCharacters ?? [] : character ? [character] : [];
        const seen = new Set<string>();
        return participants.flatMap((participant) => {
            const prompt = participant.protagonistPrompt?.trim();
            if (!prompt || seen.has(prompt)) return [];
            seen.add(prompt);
            return [`${participant.name}から見た主人公:\n${prompt}`];
        }).join('\n\n');
    }, [character, groupCharacters, isGroupRoom]);

    useEffect(() => {
        const canGenerate = enabled
            && roomId != null
            && latestMessage?.role === 'assistant'
            && !isLoading
            && !isSummarizing
            && !isTypewriterActive;
        if (!canGenerate || !roomId || !latestMessage) {
            if (!enabled || latestMessage?.role !== 'assistant') {
                requestKeyRef.current = null;
                setState((current) => current ? null : current);
            }
            return;
        }

        const sourceMessageId = latestMessage.id;
        const requestKey = `${roomId}:${sourceMessageId}`;
        if (savedState) {
            requestKeyRef.current = requestKey;
            setState((current) => {
                if (
                    current?.roomId === savedState.roomId
                    && current.sourceMessageId === savedState.sourceMessageId
                    && !current.loading
                    && current.suggestions.length === savedState.suggestions.length
                    && current.suggestions.every((suggestion, index) =>
                        suggestion === savedState.suggestions[index]
                    )
                ) return current;
                return savedState;
            });
            return;
        }
        if (requestKeyRef.current === requestKey) return;
        requestKeyRef.current = requestKey;
        const controller = new AbortController();
        controllerRef.current = controller;
        const timeoutId = setTimeout(() => {
            controller.abort();
            if (controllerRef.current === controller) {
                setState((current) =>
                    current?.roomId === roomId && current.sourceMessageId === sourceMessageId
                        ? null
                        : current
                );
            }
        }, 60_000);
        let settled = false;
        setState({ roomId, sourceMessageId, suggestions: [], loading: true });

        void requestReplySuggestions({
            messages,
            model: model.trim(),
            protagonistPrompt,
            situationPrompt,
            aiApiConfig: getAiApiConfig(),
        }, controller.signal)
            .then((suggestions) => {
                if (
                    controller.signal.aborted
                    || controllerRef.current !== controller
                    || suggestions.length !== 3
                ) return;
                setRoomReplySuggestions(roomId, { sourceMessageId, suggestions });
                setState((current) =>
                    current?.roomId === roomId && current.sourceMessageId === sourceMessageId
                        ? { ...current, suggestions, loading: false }
                        : current
                );
            })
            .catch((error) => {
                if (error instanceof Error && error.name === 'AbortError') return;
                if (controllerRef.current !== controller) return;
                console.warn('Reply suggestion generation failed:', error);
                setState((current) =>
                    current?.roomId === roomId && current.sourceMessageId === sourceMessageId
                        ? null
                        : current
                );
            })
            .finally(() => {
                settled = true;
                clearTimeout(timeoutId);
                if (controllerRef.current === controller) controllerRef.current = null;
            });

        return () => {
            clearTimeout(timeoutId);
            controller.abort();
            if (controllerRef.current === controller) controllerRef.current = null;
            if (!settled && requestKeyRef.current === requestKey) requestKeyRef.current = null;
        };
    }, [
        enabled,
        getAiApiConfig,
        isLoading,
        isSummarizing,
        isTypewriterActive,
        latestMessage,
        messages,
        model,
        protagonistPrompt,
        roomId,
        savedState,
        setRoomReplySuggestions,
        situationPrompt,
    ]);

    return { state, setState };
}
