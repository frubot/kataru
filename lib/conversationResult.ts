import type { ExtractedMemoryUpdate } from './chatMemoryCandidates';

export type ConversationAssistantMessage = {
    id: string;
    role: 'assistant';
    content: string;
    characterId: string;
    expression?: string;
    toCharacterIds?: string[];
    usedMemoryIds?: string[];
    timestamp: number;
};

export type RustTurnResponse = {
    messages?: ConversationAssistantMessage[];
    usages?: Array<{
        characterId: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cost: number;
    }>;
    fullJsonLogs?: Array<{
        characterId: string;
        characterName: string;
        model?: string;
        status: 'success' | 'error';
        source: string;
        prompt?: string;
        json: string;
        httpStatus?: number;
        elapsedMs?: number;
        errorName?: string;
    }>;
    summary?: {
        text: string;
        checkpointUserMessageId?: string;
        keepCount: number;
    } | null;
    memoryCandidates?: ExtractedMemoryUpdate[];
    usedMemoryIds?: string[];
};
