import { describe, expect, test, vi } from 'vitest';
import type { Situation, StoreGet, StoreSet } from '../lib/store/types';
import { persistGroup } from '../lib/store/persistence';

vi.mock('../lib/db', () => ({
    putGroup: vi.fn(async (group: Situation): Promise<Situation> => ({
        ...group,
        actors: group.actors.map((actor) => (actor.type === 'temporary'
            ? { ...actor, icon: 'asset:stored-icon' }
            : actor)),
    })),
}));

const group = (icon: string): Situation => ({
    id: 'situation-1',
    name: 'Scene',
    actors: [{
        id: 'actor-1',
        type: 'temporary',
        name: 'Temp',
        systemPrompt: '',
        icon,
    }],
    director: { enabled: true, model: 'model', maxAutoTurns: 3, stopPolicy: 'max-turns' },
    memoryMode: 'off',
    createdAt: 1,
    updatedAt: 1,
});

function fakeStore(initial: Situation[]) {
    let state: { groups: Situation[] } = { groups: initial };
    const set = ((partial: unknown) => {
        const patch = typeof partial === 'function'
            ? (partial as (current: typeof state) => Partial<typeof state>)(state)
            : (partial as Partial<typeof state>);
        state = { ...state, ...patch };
    }) as unknown as StoreSet;
    const get = (() => state) as unknown as StoreGet;
    return { set, get, state: () => state };
}

describe('persistGroup', () => {
    test('replaces the submitted group with the stored asset references', async () => {
        const submitted = group('data:image/png;base64,aW1hZ2U=');
        const store = fakeStore([submitted]);

        await persistGroup(store.set, store.get, submitted);

        const [stored] = store.state().groups;
        expect(stored).not.toBe(submitted);
        expect(stored.actors[0]).toMatchObject({ icon: 'asset:stored-icon' });
    });

    test('does not overwrite a newer edit that landed while saving', async () => {
        const submitted = group('data:image/png;base64,aW1hZ2U=');
        const edited = { ...group('data:image/png;base64,bmV3'), name: 'Edited' };
        const store = fakeStore([edited]);

        await persistGroup(store.set, store.get, submitted);

        expect(store.state().groups[0]).toBe(edited);
    });
});
