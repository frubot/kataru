import { useCallback } from 'react';

import type { AiApiConfig } from '../../lib/aiApi';
import {
    buildPromptRequestMessages,
    requestRoomTitleWithRetry,
} from '../../lib/chatAuxiliaryClient';
import type { Room, SituationParticipant } from '../../lib/store';

type UseRoomTitleGenerationOptions = {
    groupCharacters?: SituationParticipant[] | null;
    model: string;
    getAiApiConfig: () => AiApiConfig;
    getRoom: (roomId: string) => Room | null | undefined;
    updateRoomName: (roomId: string, name: string) => void;
};

export function useRoomTitleGeneration({
    groupCharacters,
    model,
    getAiApiConfig,
    getRoom,
    updateRoomName,
}: UseRoomTitleGenerationOptions) {
    return useCallback(async (roomId: string, originalRoomName: string) => {
        const latestRoom = getRoom(roomId);
        if (
            latestRoom?.id !== roomId
            || latestRoom.secretMode === true
            || latestRoom.name !== originalRoomName
        ) return;

        const messages = buildPromptRequestMessages(latestRoom.messages, groupCharacters);
        if (!messages.some((message) => message.role === 'assistant')) return;

        try {
            const title = await requestRoomTitleWithRetry({
                messages,
                model: model.trim(),
                aiApiConfig: getAiApiConfig(),
            });
            if (!title || title === originalRoomName) return;

            const roomBeforeUpdate = getRoom(roomId);
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
        }
    }, [getAiApiConfig, getRoom, groupCharacters, model, updateRoomName]);
}
