import type { Character, Message, SituationPriorMessage } from './store/types';
import type { ConversationJobPreviewTurn } from './conversationJobClient';
import {
    splitStreamingVisualNovelMessage,
    getStreamingVisualNovelVisibleContent,
    updateStreamingVisualNovelPagination,
    type StreamingVisualNovelPagination,
} from './visualNovelPresentation';

export type SituationVisualNovelItem = {
    key: string;
    id: string;
    source: 'prior' | 'room' | 'preview';
    role: 'user' | 'assistant';
    content: string;
    characterId?: string;
    characterName?: string;
    expression?: string;
    previewTurnIndex?: number;
    streamingComplete?: boolean;
    pageIndex?: number;
    utteranceKey?: string;
    bufferedContent?: string;
    pageCount?: number;
    pagination?: StreamingVisualNovelPagination;
};

export type SituationVisualNovelPresentationState = {
    current: SituationVisualNovelItem | null;
    pending: SituationVisualNovelItem[];
    locked: boolean;
    currentComplete: boolean;
    animateCurrent: boolean;
    waitingForNextPage: boolean;
    phase: 'intro' | 'conversation';
    sceneCharacterId?: string;
    sceneExpression?: string;
    sceneExpressions?: Record<string, string | undefined>;
};

type InitialPresentationInput = {
    hasRoomHistory: boolean;
    priorItems: SituationVisualNovelItem[];
    roomItems: SituationVisualNovelItem[];
    isLoading: boolean;
};

type SituationVisualNovelInitialCharacter = Pick<Character, 'id' | 'expressions'>;

function paginateSituationVisualNovelItem(
    item: SituationVisualNovelItem,
): SituationVisualNovelItem[] {
    const pages = splitStreamingVisualNovelMessage(item.content, true).map((page) => page.content);
    if (pages.length <= 1) return [item];
    return pages.map((content, pageIndex) => ({
        ...item,
        key: pageIndex === 0 ? item.key : `${item.key}:page:${pageIndex}`,
        content,
        pageIndex,
        pageCount: pages.length,
    }));
}

export function resolveSituationVisualNovelInitialCharacterId(
    priorMessages: SituationPriorMessage[],
    characters: SituationVisualNovelInitialCharacter[],
): string | undefined {
    const hasPortrait = (character: SituationVisualNovelInitialCharacter) => (
        character.expressions?.some((expression) => expression.image.trim()) === true
    );
    const openingMessage = priorMessages.find(
        (message): message is Extract<SituationPriorMessage, { role: 'assistant' }> => (
            message.role === 'assistant' && !!message.content.trim()
        ),
    );
    const openingCharacter = characters.find(
        (character) => character.id === openingMessage?.actorId,
    );
    if (openingCharacter && hasPortrait(openingCharacter)) {
        return openingCharacter.id;
    }

    const characterWithPortrait = characters.find(hasPortrait);
    return characterWithPortrait?.id ?? openingCharacter?.id ?? characters[0]?.id;
}

export function buildSituationVisualNovelPriorItems(
    messages: SituationPriorMessage[],
): SituationVisualNovelItem[] {
    return messages
        .filter((message) => message.content.trim())
        .flatMap((message) => paginateSituationVisualNovelItem({
            key: `prior:${message.id}`,
            id: message.id,
            source: 'prior' as const,
            role: message.role,
            content: message.content,
            ...(message.role === 'assistant' ? {
                characterId: message.actorId,
                expression: message.expression,
            } : {}),
        }));
}

export function buildSituationVisualNovelRoomItems(
    messages: Message[],
    previewItems: SituationVisualNovelItem[] = [],
    responseMessages: Message[] = messages,
): SituationVisualNovelItem[] {
    const responseIds = responseMessages.filter((message) => message.role === 'assistant' && !message.archived)
        .map((message) => message.id);
    const previewByMessageId = new Map(previewItems.map((item) => [
        responseIds[item.previewTurnIndex ?? 0], item,
    ]));
    return messages
        .filter((message) => (
            message.role === 'assistant'
            && !message.archived
            && message.content.trim()
        ))
        .flatMap((message) => {
            const item: SituationVisualNovelItem = {
                key: `room:${message.id}`,
                id: message.id,
                source: 'room' as const,
                role: message.role,
                content: message.content,
                characterId: message.characterId,
                expression: message.expression,
            };
            const preview = previewByMessageId.get(message.id);
            item.utteranceKey = preview?.utteranceKey;
            const previous = preview?.pagination;
            if (!previous) return paginateSituationVisualNovelItem(item);
            const pagination = updateStreamingVisualNovelPagination(message.content, true, previous);
            return pagination.pages.map((page, pageIndex) => ({
                ...item,
                key: pageIndex === 0 ? item.key : `${item.key}:page:${pageIndex}`,
                content: page.content,
                pageIndex,
                pageCount: pagination.pages.length,
                pagination,
            }));
        });
}

export function getSituationVisualNovelResponseMessages(
    messages: Message[],
    generationBaselineMessageIds?: string[],
): Message[] {
    if (generationBaselineMessageIds) {
        const baselineIds = new Set(generationBaselineMessageIds);
        return messages.filter((message) => !baselineIds.has(message.id));
    }
    const lastUserIndex = messages.findLastIndex((message) => (
        message.role === 'user'
        && !message.archived
        && message.content.trim()
    ));
    return messages.slice(lastUserIndex + 1);
}

export function buildSituationVisualNovelPreviewItems(
    jobId: string | undefined,
    turns: ConversationJobPreviewTurn[] | undefined,
    previousItems: SituationVisualNovelItem[] = [],
): SituationVisualNovelItem[] {
    if (!jobId || !turns) return [];
    return turns
        .filter((turn) => turn.content.trim() || turn.expression)
        .flatMap((turn) => {
            const id = `${jobId}:${turn.turnIndex}`;
            const previous = previousItems.find((item) => item.id === id)?.pagination;
            const pagination = updateStreamingVisualNovelPagination(turn.content, turn.complete, previous);
            const pages = pagination.pages.length > 0
                ? pagination.pages
                : [{ content: '', complete: false }];
            return pages.map((page, pageIndex) => ({
                key: `preview:${jobId}:${turn.turnIndex}${pageIndex === 0 ? '' : `:page:${pageIndex}`}`,
                id,
                source: 'preview' as const,
                role: 'assistant' as const,
                content: page.complete ? page.content : getStreamingVisualNovelVisibleContent(page.content),
                bufferedContent: page.content,
                utteranceKey: `preview:${id}`,
                characterId: turn.characterId,
                characterName: turn.characterName,
                expression: turn.expression,
                previewTurnIndex: turn.turnIndex,
                streamingComplete: page.complete,
                pageIndex,
                pageCount: pagination.pages.length,
                pagination,
            }));
        });
}

function sceneFromItems(items: SituationVisualNovelItem[]): {
    sceneCharacterId?: string;
    sceneExpression?: string;
    sceneExpressions?: Record<string, string | undefined>;
} {
    let sceneCharacterId: string | undefined;
    let sceneExpression: string | undefined;
    const sceneExpressions: Record<string, string | undefined> = {};
    for (const item of items) {
        if (item.role !== 'assistant') continue;
        if (item.characterId) {
            sceneExpressions[item.characterId] = item.expression ?? sceneExpressions[item.characterId];
        }
        sceneCharacterId = item.characterId;
        sceneExpression = item.expression;
    }
    return {
        sceneCharacterId,
        sceneExpression,
        sceneExpressions,
    };
}

export function getSituationVisualNovelTypingKey(item: SituationVisualNovelItem): string {
    return item.utteranceKey ? `${item.utteranceKey}:page:${item.pageIndex ?? 0}` : item.key;
}

function syncCurrentTyping(state: SituationVisualNovelPresentationState, item: SituationVisualNovelItem) {
    const animateCurrent = state.animateCurrent || item.content !== state.current?.content;
    return {
        animateCurrent,
        currentComplete: !animateCurrent && (item.source !== 'preview' || item.streamingComplete === true),
    };
}

function sceneForVisibleItem(state: SituationVisualNovelPresentationState, item: SituationVisualNovelItem) {
    // Metadata can arrive before the first displayable sentence. Keep the previous
    // portrait until dialogue begins, which is also when the character bounces.
    if (item.role !== 'assistant' || (item.source === 'preview' && !item.content.trim())) {
        return { sceneCharacterId: state.sceneCharacterId, sceneExpression: state.sceneExpression };
    }
    const sceneExpressions = item.characterId
        ? {
            ...state.sceneExpressions,
            [item.characterId]: item.expression ?? state.sceneExpressions?.[item.characterId],
        }
        : state.sceneExpressions;
    return {
        sceneCharacterId: item.characterId,
        sceneExpression: item.expression ?? (item.characterId === state.sceneCharacterId ? state.sceneExpression : undefined),
        sceneExpressions,
    };
}

function showItem(
    state: SituationVisualNovelPresentationState,
    item: SituationVisualNovelItem,
    animateCurrent: boolean,
): SituationVisualNovelPresentationState {
    const itemComplete = !animateCurrent && (item.source !== 'preview' || item.streamingComplete === true);
    if (item.role !== 'assistant') {
        return {
            ...state,
            current: item,
            currentComplete: itemComplete,
            animateCurrent,
            waitingForNextPage: false,
        };
    }
    return {
        ...state,
        current: item,
        currentComplete: itemComplete,
        animateCurrent,
        waitingForNextPage: false,
        ...sceneForVisibleItem(state, item),
    };
}

export function syncSituationVisualNovelPreviewItems(
    state: SituationVisualNovelPresentationState,
    previewItems: SituationVisualNovelItem[],
): SituationVisualNovelPresentationState {
    const byKey = new Map(previewItems.map((item) => [item.key, item]));
    const update = (item: SituationVisualNovelItem): SituationVisualNovelItem => (
        item.source === 'preview' ? byKey.get(item.key) ?? item : item
    );
    const current = state.current ? update(state.current) : null;
    const pending = state.pending.map(update);
    if (state.waitingForNextPage && pending[0]?.content.trim()) {
        return showItem({ ...state, pending: pending.slice(1) }, pending[0], true);
    }
    if (!current || current.source !== 'preview') {
        return { ...state, current, pending };
    }
    return {
        ...state,
        current,
        pending,
        ...syncCurrentTyping(state, current),
        ...sceneForVisibleItem(state, current),
    };
}

export function finishSituationVisualNovelPreviewItems(
    state: SituationVisualNovelPresentationState,
): SituationVisualNovelPresentationState {
    const finish = (item: SituationVisualNovelItem): SituationVisualNovelItem => (
        item.source === 'preview' ? { ...item, content: item.bufferedContent ?? item.content, streamingComplete: true } : item
    );
    const current = state.current ? finish(state.current) : null;
    const pending = state.pending.map(finish);
    if (state.waitingForNextPage && pending[0]?.content.trim()) {
        return showItem({ ...state, pending: pending.slice(1) }, pending[0], true);
    }
    return {
        ...state,
        current,
        pending,
        ...(current?.source === 'preview' ? syncCurrentTyping(state, current) : {}),
        ...(current ? sceneForVisibleItem(state, current) : {}),
        waitingForNextPage: false,
    };
}

export function reconcileSituationVisualNovelPreviewItems(
    state: SituationVisualNovelPresentationState,
    replacements: Map<string, SituationVisualNovelItem>,
): SituationVisualNovelPresentationState {
    const replace = (item: SituationVisualNovelItem): SituationVisualNovelItem => (
        item.source === 'preview' ? replacements.get(item.key) ?? item : item
    );
    const current = state.current ? replace(state.current) : null;
    const pending = state.pending.map(replace);
    if (!current || current.source === 'preview') {
        return { ...state, current, pending };
    }
    return {
        ...state,
        current,
        pending,
        ...(state.current?.source === 'preview' ? syncCurrentTyping(state, current) : {}),
        ...sceneForVisibleItem(state, current),
    };
}

export function createSituationVisualNovelPresentationState({
    hasRoomHistory,
    priorItems,
    roomItems,
    isLoading,
}: InitialPresentationInput): SituationVisualNovelPresentationState {
    if (hasRoomHistory) {
        const current = roomItems.at(-1) ?? null;
        const scene = sceneFromItems([...priorItems, ...roomItems]);
        return {
            current,
            pending: [],
            locked: isLoading,
            currentComplete: true,
            animateCurrent: false,
            waitingForNextPage: false,
            phase: 'conversation',
            ...scene,
        };
    }

    if (priorItems.length > 0) {
        const [current, ...pending] = priorItems;
        return showItem({
            current: null,
            pending,
            locked: true,
            currentComplete: false,
            animateCurrent: true,
            waitingForNextPage: false,
            phase: 'intro',
        }, current, true);
    }

    return {
        current: null,
        pending: [],
        locked: isLoading,
        currentComplete: true,
        animateCurrent: false,
        waitingForNextPage: false,
        phase: 'conversation',
    };
}

export function appendSituationVisualNovelItems(
    state: SituationVisualNovelPresentationState,
    items: SituationVisualNovelItem[],
): SituationVisualNovelPresentationState {
    if (items.length === 0) return state;
    const nextState = {
        ...state,
        locked: true,
        phase: 'conversation' as const,
    };
    if (state.waitingForNextPage && state.pending.length === 0 && items[0].content.trim()) {
        const [current, ...pending] = items;
        return showItem({ ...nextState, pending: [...state.pending, ...pending] }, current, true);
    }
    if (state.current && state.locked) {
        return {
            ...nextState,
            pending: [...state.pending, ...items],
        };
    }

    const [current, ...pending] = items;
    return showItem({
        ...nextState,
        pending: [...state.pending, ...pending],
    }, current, true);
}

export function beginSituationVisualNovelResponse(
    state: SituationVisualNovelPresentationState,
): SituationVisualNovelPresentationState {
    return {
        ...state,
        current: null,
        pending: [],
        locked: true,
        currentComplete: true,
        animateCurrent: false,
        waitingForNextPage: false,
        phase: 'conversation',
    };
}

export function completeSituationVisualNovelItem(
    state: SituationVisualNovelPresentationState,
    itemKey: string,
    revealedContent?: string,
): SituationVisualNovelPresentationState {
    if (state.current?.key !== itemKey || state.currentComplete) return state;
    if (revealedContent !== undefined && state.current.content !== revealedContent) return state;
    return {
        ...state,
        currentComplete: state.current.source !== 'preview' || state.current.streamingComplete === true,
        animateCurrent: false,
    };
}

export function advanceSituationVisualNovelPresentation(
    state: SituationVisualNovelPresentationState,
    isLoading: boolean,
): SituationVisualNovelPresentationState {
    if (!state.locked || !state.currentComplete) return state;
    if (state.pending.length > 0 && state.pending[0].content.trim()) {
        const [current, ...pending] = state.pending;
        return showItem({ ...state, pending }, current, true);
    }
    if (isLoading) {
        return {
            ...state,
            currentComplete: true,
            animateCurrent: false,
            waitingForNextPage: true,
        };
    }
    return state;
}

export function lockSituationVisualNovelPresentation(
    state: SituationVisualNovelPresentationState,
): SituationVisualNovelPresentationState {
    if (state.locked) return state;
    return { ...state, locked: true };
}

export function unlockSituationVisualNovelPresentation(
    state: SituationVisualNovelPresentationState,
    isLoading: boolean,
): SituationVisualNovelPresentationState {
    if (
        !state.locked
        || isLoading
        || !state.currentComplete
        || state.pending.length > 0
    ) {
        return state;
    }
    return { ...state, locked: false };
}

export function syncSituationVisualNovelRoomItems(
    state: SituationVisualNovelPresentationState,
    params: {
        hasRoomHistory: boolean;
        priorItems: SituationVisualNovelItem[];
        roomItems: SituationVisualNovelItem[];
        isLoading: boolean;
    },
): SituationVisualNovelPresentationState {
    const roomKeys = new Set(params.roomItems.map((item) => item.key));
    const pending = state.pending.filter((item) => item.source !== 'room' || roomKeys.has(item.key));
    const currentRemoved = state.current?.source === 'room' && !roomKeys.has(state.current.key);

    if (currentRemoved) {
        const fallbackItems = params.roomItems.length > 0
            ? [...params.priorItems, ...params.roomItems]
            : params.hasRoomHistory
                ? []
                : params.priorItems;
        const current = params.isLoading ? null : fallbackItems.at(-1) ?? null;
        const scene = sceneFromItems(fallbackItems);
        return {
            current,
            pending: [],
            locked: params.isLoading,
            currentComplete: true,
            animateCurrent: false,
            waitingForNextPage: false,
            phase: 'conversation',
            ...scene,
        };
    }

    let nextState = { ...state, pending };
    if (!state.locked && pending.length === 0 && !params.isLoading) {
        const idleItems = params.roomItems.length > 0
            ? [...params.priorItems, ...params.roomItems]
            : params.hasRoomHistory
                ? []
                : params.priorItems;
        const current = idleItems.at(-1) ?? state.current;
        const scene = sceneFromItems(idleItems);
        nextState = {
            ...nextState,
            current,
            currentComplete: true,
            animateCurrent: false,
            waitingForNextPage: false,
            ...scene,
        };
    }
    return nextState;
}
