import { afterEach, expect, test, vi } from 'vitest';
import * as db from '../lib/db';
import { useStore, type Message, type Room } from '../lib/store';
import {
    buildSituationVisualNovelRoomItems,
    createSituationVisualNovelPresentationState,
} from '../lib/situationVisualNovelPresentation';

const initialState = useStore.getState();
afterEach(() => {
    vi.restoreAllMocks();
    useStore.setState(initialState, true);
});

function room(id: string): Room {
    return { id, characterId: 'actor', name: id, messages: [], createdAt: 1, updatedAt: 1 };
}

test('reopens with the last assistant response only after saved history is ready', async () => {
    const messages: Message[] = [
        { id: 'old', role: 'assistant', content: '以前の応答', timestamp: 1 },
        { id: 'user', role: 'user', content: '続きは？', timestamp: 2 },
        { id: 'latest', role: 'assistant', content: '最後の応答', timestamp: 3 },
    ];
    let resolveHistory!: (messages: Message[]) => void;
    vi.spyOn(db, 'getMessagesByRoom').mockReturnValue(new Promise((resolve) => { resolveHistory = resolve; }));
    vi.spyOn(db, 'setMeta').mockResolvedValue(undefined);
    useStore.setState({ rooms: [room('saved')] });

    const loading = useStore.getState().setCurrentRoom('saved');
    expect(useStore.getState().loadingRoomHistoryId).toBe('saved');
    resolveHistory(messages);
    await loading;

    expect(useStore.getState().loadingRoomHistoryId).toBeNull();
    const restored = useStore.getState().getCurrentRoom()!;
    const presentation = createSituationVisualNovelPresentationState({
        hasRoomHistory: restored.messages.length > 0,
        priorItems: [],
        roomItems: buildSituationVisualNovelRoomItems(restored.messages),
        isLoading: false,
    });
    expect(presentation.current?.id).toBe('latest');
    expect(presentation.pending).toEqual([]);
    expect(presentation.animateCurrent).toBe(false);
});

test('an older room load cannot clear the next room loading state', async () => {
    const resolvers = new Map<string, (messages: Message[]) => void>();
    vi.spyOn(db, 'getMessagesByRoom').mockImplementation((id) => new Promise((resolve) => { resolvers.set(id, resolve); }));
    vi.spyOn(db, 'setMeta').mockResolvedValue(undefined);
    useStore.setState({ rooms: [room('a'), room('b')] });
    const first = useStore.getState().setCurrentRoom('a');
    const second = useStore.getState().setCurrentRoom('b');
    resolvers.get('a')!([]);
    await first;
    expect(useStore.getState().loadingRoomHistoryId).toBe('b');
    resolvers.get('b')!([]);
    await second;
    expect(useStore.getState().loadingRoomHistoryId).toBeNull();
    expect(useStore.getState().currentRoomId).toBe('b');
});
