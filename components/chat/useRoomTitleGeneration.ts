import { useCallback } from 'react';

import type { AiApiConfig } from '../../lib/aiApi';
import {
    buildPromptRequestMessages,
    requestRoomTitle,
} from '../../lib/chatAuxiliaryClient';
import type { Room, SituationParticipant } from '../../lib/store';

type UseRoomTitleGenerationOptions = {
    groupCharacters?: SituationParticipant[] | null;
    model: string;
    getAiApiConfig: () => AiApiConfig;
    getCurrentRoom: () => Room | null | undefined;
    updateRoomName: (roomId: string, name: string) => void;
};

export function useRoomTitleGeneration({
    groupCharacters,
    model,
    getAiApiConfig,
    getCurrentRoom,
    updateRoomName,
}: UseRoomTitleGenerationOptions) {
    return useCallback(async (roomId: string, originalRoomName: string) => {
        const latestRoom = getCurrentRoom();
        if (
            latestRoom?.id !== roomId
            || latestRoom.secretMode === true
            || latestRoom.name !== originalRoomName
        ) return;

        const messages = buildPromptRequestMessages(latestRoom.messages, groupCharacters);
        if (!messages.some((message) => message.role === 'assistant')) return;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60_000);
        try {
            const title = await requestRoomTitle({
                messages,
                model: model.trim(),
                aiApiConfig: getAiApiConfig(),
            }, controller.signal);
            if (!title || title === originalRoomName) return;

            const roomBeforeUpdate = getCurrentRoom();
            if (
                roomBeforeUpdate?.id !== roomId
                || roomBeforeUpdate.secretMode === true
                || roomBeforeUpdate.name !== originalRoomName
            ) return;
            updateRoomName(roomId, title);
        } catch (error) {
            if (!(error instanceof Error && error.name === 'AbortError')) {
                console.warn('Room title generation failed:', error);
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }, [getAiApiConfig, getCurrentRoom, groupCharacters, model, updateRoomName]);
}
