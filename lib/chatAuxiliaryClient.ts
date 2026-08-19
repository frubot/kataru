import type { AiApiConfig } from './aiApi';
import type { Message, SituationParticipant } from './store';

export type PromptRequestMessage = {
    role: 'user' | 'assistant';
    content: string;
    name?: string;
};

export function buildPromptRequestMessages(
    messages: Message[],
    groupCharacters?: SituationParticipant[] | null,
): PromptRequestMessage[] {
    const nameById = new Map((groupCharacters ?? []).map((participant) => [participant.id, participant.name]));
    return messages
        .filter((message) => !message.archived && message.content.trim())
        .map((message) => {
            const name = message.role === 'assistant' && message.characterId
                ? nameById.get(message.characterId)
                : undefined;
            return {
                role: message.role,
                content: message.content,
                ...(name ? { name } : {}),
            };
        });
}

export async function requestRoomTitle(
    input: {
        messages: PromptRequestMessage[];
        model: string;
        aiApiConfig: AiApiConfig;
    },
    signal: AbortSignal,
): Promise<string | null> {
    const response = await fetch('/api/generate-title', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal,
    });
    if (!response.ok) return null;
    const data = await response.json() as { title?: unknown };
    return typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
}

export async function requestReplySuggestions(
    input: {
        messages: PromptRequestMessage[];
        model: string;
        protagonistPrompt: string;
        situationPrompt?: string;
        aiApiConfig: AiApiConfig;
    },
    signal: AbortSignal,
): Promise<string[]> {
    const response = await fetch('/api/generate-reply-suggestions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal,
    });
    if (!response.ok) throw new Error(`Reply suggestion request failed (${response.status})`);
    const data = await response.json() as { suggestions?: unknown };
    return Array.isArray(data.suggestions)
        ? data.suggestions
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map((value) => value.trim())
        : [];
}
