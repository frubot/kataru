export type FinalPromptMessage = {
    role: string;
    content: unknown;
    [key: string]: unknown;
};

export type PromptTokenPart = {
    label: string;
    estimatedTokens: number;
};

export type PromptTokenBreakdown = {
    systemBlocks: PromptTokenPart[];
    history: PromptTokenPart;
    summary: PromptTokenPart;
    memory: PromptTokenPart;
    totalEstimatedTokens: number;
};

export type PromptInspectionSnapshot = {
    id: string;
    characterId: string;
    characterName: string;
    model?: string;
    source: string;
    capturedAt: number;
    messages: FinalPromptMessage[];
    breakdown: PromptTokenBreakdown;
};

export type PromptInspectionsByRoom = Record<string, PromptInspectionSnapshot[]>;

export const PROMPT_INSPECTION_HISTORY_LIMIT = 20;

type PromptLog = {
    characterId: string;
    characterName: string;
    model?: string;
    source: string;
    prompt?: string;
};

function contentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    try {
        return JSON.stringify(content);
    } catch {
        return String(content);
    }
}

/**
 * Provider tokenizers are model-specific. This intentionally estimates only message content,
 * using separate ratios for CJK characters and other text; the UI labels it as an estimate.
 */
export function estimatePromptTokens(value: string): number {
    const text = value.trim();
    if (!text) return 0;
    let cjk = 0;
    let other = 0;
    for (const character of text) {
        if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    return Math.max(1, Math.ceil(cjk / 1.7 + other / 4));
}

export function parseFinalPromptMessages(prompt: string): FinalPromptMessage[] | null {
    try {
        const parsed = JSON.parse(prompt) as unknown;
        if (!Array.isArray(parsed)) return null;
        const messages = parsed.filter((value): value is Record<string, unknown> => (
            !!value && typeof value === 'object' && !Array.isArray(value)
        )).map((value) => ({
            ...value,
            role: typeof value.role === 'string' ? value.role : 'unknown',
            content: value.content,
        }));
        return messages.length === parsed.length ? messages : null;
    } catch {
        return null;
    }
}

type SystemSection = {
    label: string;
    text: string;
    category: 'system' | 'summary' | 'memory';
};

export function splitSystemPromptSections(systemPrompt: string): SystemSection[] {
    const headings = [...systemPrompt.matchAll(/^(#{1,6})\s+(.+)$/gm)];
    if (headings.length === 0) {
        return systemPrompt.trim()
            ? [{ label: 'システムプロンプト', text: systemPrompt, category: 'system' }]
            : [];
    }
    const sections: SystemSection[] = [];
    if ((headings[0].index ?? 0) > 0) {
        const preamble = systemPrompt.slice(0, headings[0].index).trim();
        if (preamble) sections.push({ label: 'システム冒頭', text: preamble, category: 'system' });
    }
    headings.forEach((heading, index) => {
        const start = heading.index ?? 0;
        const end = index + 1 < headings.length ? headings[index + 1].index ?? systemPrompt.length : systemPrompt.length;
        const label = heading[2].trim();
        const category = label.includes('これまでの会話の要約')
            ? 'summary'
            : label.includes('関連するメモリ')
                ? 'memory'
                : 'system';
        sections.push({ label, text: systemPrompt.slice(start, end).trim(), category });
    });
    return sections;
}

export function buildPromptTokenBreakdown(messages: FinalPromptMessage[]): PromptTokenBreakdown {
    const systemText = messages
        .filter((message) => message.role === 'system')
        .map((message) => contentText(message.content))
        .join('\n');
    const sections = splitSystemPromptSections(systemText);
    const systemBlocks = sections
        .filter((section) => section.category === 'system')
        .map((section) => ({
            label: section.label,
            estimatedTokens: estimatePromptTokens(section.text),
        }));
    const summaryTokens = sections
        .filter((section) => section.category === 'summary')
        .reduce((total, section) => total + estimatePromptTokens(section.text), 0);
    const memoryTokens = sections
        .filter((section) => section.category === 'memory')
        .reduce((total, section) => total + estimatePromptTokens(section.text), 0);
    const historyTokens = messages
        .filter((message) => message.role !== 'system')
        .reduce((total, message) => total + estimatePromptTokens(contentText(message.content)), 0);
    const totalEstimatedTokens = systemBlocks.reduce((total, part) => total + part.estimatedTokens, 0)
        + summaryTokens
        + memoryTokens
        + historyTokens;
    return {
        systemBlocks,
        history: { label: '会話履歴', estimatedTokens: historyTokens },
        summary: { label: '要約', estimatedTokens: summaryTokens },
        memory: { label: 'メモリ', estimatedTokens: memoryTokens },
        totalEstimatedTokens,
    };
}

export function createPromptInspectionSnapshots(
    logs: PromptLog[] | undefined,
    capturedAt = Date.now(),
    keyPrefix = 'prompt',
): PromptInspectionSnapshot[] {
    return (logs ?? []).flatMap((log, index) => {
        if (!log.prompt?.trim()) return [];
        const messages = parseFinalPromptMessages(log.prompt);
        if (!messages) return [];
        return [{
            id: `${keyPrefix}-${capturedAt}-${index}-${log.characterId}-${log.source}`,
            characterId: log.characterId,
            characterName: log.characterName,
            model: log.model,
            source: log.source,
            capturedAt,
            messages,
            breakdown: buildPromptTokenBreakdown(messages),
        }];
    });
}

export function boundPromptInspectionHistory(
    history: PromptInspectionsByRoom,
    activeRoomIds: Iterable<string>,
    limit = PROMPT_INSPECTION_HISTORY_LIMIT,
): PromptInspectionsByRoom {
    const activeRooms = new Set(activeRoomIds);
    const seenIds = new Set<string>();
    const candidates = Object.entries(history)
        .filter(([roomId]) => activeRooms.has(roomId))
        .flatMap(([roomId, snapshots]) => snapshots.map((snapshot) => ({ roomId, snapshot })))
        .filter(({ snapshot }) => {
            if (seenIds.has(snapshot.id)) return false;
            seenIds.add(snapshot.id);
            return true;
        })
        .sort((left, right) => right.snapshot.capturedAt - left.snapshot.capturedAt)
        .slice(0, Math.max(0, Math.floor(limit)));
    return candidates.reduce<PromptInspectionsByRoom>((bounded, { roomId, snapshot }) => {
        (bounded[roomId] ??= []).push(snapshot);
        return bounded;
    }, {});
}

export function mergePromptInspectionSnapshots(
    history: PromptInspectionsByRoom,
    roomId: string,
    snapshots: PromptInspectionSnapshot[],
    activeRoomIds: Iterable<string>,
    limit = PROMPT_INSPECTION_HISTORY_LIMIT,
): PromptInspectionsByRoom {
    const capturedIds = new Set(snapshots.map((snapshot) => snapshot.id));
    const merged = {
        ...history,
        [roomId]: [
            ...snapshots.slice().reverse(),
            ...(history[roomId] ?? []).filter((snapshot) => !capturedIds.has(snapshot.id)),
        ],
    };
    return boundPromptInspectionHistory(merged, activeRoomIds, limit);
}
