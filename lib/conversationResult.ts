import type { ExtractedMemoryUpdate } from './chatMemoryCandidates';
import type { DebugLogUsage } from './store/types';

export type ConversationAssistantMessage = {
    id: string;
    role: 'assistant';
    content: string;
    characterId: string;
    expression?: string;
    motion?: string;
    toCharacterIds?: string[];
    usedMemoryIds?: string[];
    timestamp: number;
    continuesPrevious?: boolean;
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
        reasoning?: string;
        secondJson?: string;
        httpStatus?: number;
        elapsedMs?: number;
        errorName?: string;
        /** 1回目の生成のトークン数・コスト・スループット。 */
        usage?: DebugLogUsage;
        /** 2回目の生成（指揮役の追加呼び出しなど）の同じ内訳。 */
        secondUsage?: DebugLogUsage;
    }>;
    summary?: {
        text: string;
        checkpointUserMessageId?: string;
        keepCount: number;
    } | null;
    memoryCandidates?: ExtractedMemoryUpdate[];
    usedMemoryIds?: string[];
};
