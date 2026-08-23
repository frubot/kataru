import type { Character, Message, SituationPriorMessage } from './store/types';
import type { ConversationJobPreviewTurn } from './conversationJobClient';
import { splitVisualNovelMessage } from './visualNovelPresentation';

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
    pageCount?: number;
};

export type SituationVisualNovelPresentationState = {
    current: SituationVisualNovelItem | null;
    pending: SituationVisualNovelItem[];
    locked: boolean;
    currentComplete: boolean;
    animateCurrent: boolean;
    phase: 'intro' | 'conversation';
    sceneCharacterId?: string;
    sceneExpression?: string;
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
    const pages = splitVisualNovelMessage(item.content);
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
            ...(message.role === 'assistant' ? { characterId: message.actorId } : {}),
        }));
}

export function buildSituationVisualNovelRoomItems(messages: Message[]): SituationVisualNovelItem[] {
    return messages
        .filter((message) => (
            message.role === 'assistant'
            && !message.archived
            && message.content.trim()
        ))
        .flatMap((message) => paginateSituationVisualNovelItem({
            key: `room:${message.id}`,
            id: message.id,
            source: 'room' as const,
            role: message.role,
            content: message.content,
            characterId: message.characterId,
            expression: message.expression,
        }));
}

export function buildSituationVisualNovelPreviewItems(
    jobId: string | undefined,
    turns: ConversationJobPreviewTurn[] | undefined,
): SituationVisualNovelItem[] {
    if (!jobId || !turns) return [];
    return turns
        .filter((turn) => turn.content.trim())
        .flatMap((turn) => {
            const item: SituationVisualNovelItem = {
                key: `preview:${jobId}:${turn.turnIndex}`,
                id: `${jobId}:${turn.turnIndex}`,
                source: 'preview' as const,
                role: 'assistant' as const,
                content: turn.content,
                characterId: turn.characterId,
                characterName: turn.characterName,
                expression: turn.expression,
                previewTurnIndex: turn.turnIndex,
                streamingComplete: turn.complete,
            };
            return turn.complete ? paginateSituationVisualNovelItem(item) : [item];
        });
}

function sceneFromItems(items: SituationVisualNovelItem[]): {
    sceneCharacterId?: string;
    sceneExpression?: string;
} {
    for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item.role !== 'assistant') continue;
        return {
            sceneCharacterId: item.characterId,
            sceneExpression: item.expression,
        };
    }
    return {
        sceneCharacterId: undefined,
        sceneExpression: undefined,
    };
}

function showItem(
    state: SituationVisualNovelPresentationState,
    item: SituationVisualNovelItem,
    animateCurrent: boolean,
): SituationVisualNovelPresentationState {
    const streaming = item.source === 'preview';
    const itemComplete = streaming ? item.streamingComplete === true : !animateCurrent;
    const shouldAnimate = !streaming && animateCurrent;
    if (item.role !== 'assistant') {
        return {
            ...state,
            current: item,
            currentComplete: itemComplete,
            animateCurrent: shouldAnimate,
        };
    }
    return {
        ...state,
        current: item,
        currentComplete: itemComplete,
        animateCurrent: shouldAnimate,
        sceneCharacterId: item.characterId,
        sceneExpression: item.expression,
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
    if (!current || current.source !== 'preview') {
        return { ...state, current, pending };
    }
    return {
        ...state,
        current,
        pending,
        currentComplete: current.streamingComplete === true,
        animateCurrent: false,
        sceneCharacterId: current.characterId,
        sceneExpression: current.expression,
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
        sceneCharacterId: current.role === 'assistant'
            ? current.characterId
            : state.sceneCharacterId,
        sceneExpression: current.role === 'assistant'
            ? current.expression
            : state.sceneExpression,
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
            phase: 'intro',
        }, current, true);
    }

    return {
        current: null,
        pending: [],
        locked: isLoading,
        currentComplete: true,
        animateCurrent: false,
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
        phase: 'conversation',
    };
}

export function completeSituationVisualNovelItem(
    state: SituationVisualNovelPresentationState,
    itemKey: string,
): SituationVisualNovelPresentationState {
    if (state.current?.key !== itemKey || state.currentComplete) return state;
    return {
        ...state,
        currentComplete: true,
        animateCurrent: false,
    };
}

export function advanceSituationVisualNovelPresentation(
    state: SituationVisualNovelPresentationState,
    isLoading: boolean,
): SituationVisualNovelPresentationState {
    if (!state.locked || !state.currentComplete) return state;
    if (state.pending.length > 0) {
        const [current, ...pending] = state.pending;
        return showItem({ ...state, pending }, current, true);
    }
    if (isLoading) {
        return {
            ...state,
            current: null,
            currentComplete: true,
            animateCurrent: false,
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
            ...scene,
        };
    }
    return nextState;
}
